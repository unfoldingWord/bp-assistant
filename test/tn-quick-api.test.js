// tn-quick API — body schema, contextRef validation, and system-prompt
// assembly (no live model calls).
'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  BodySchema,
  buildSystemPrompt,
  buildUserMessage,
  formatReference,
  checkAtFit,
  extractAlternateTranslations,
  BOOK_FULL_NAMES,
  TN_QUICK_STYLE,
  TN_QUICK_PACK_FRAME,
} = require('../src/api/tn-quick');
const { BOOK_NUMBERS } = require('../src/api-runner/verse-data');
const { loadQuickPack, _resetForTests } = require('../src/lib/quick-context');

const textSide = {
  selection: 'the wicked surround the righteous',
  verse: 'Therefore the law is paralyzed, and justice never goes out.',
  context: { prev5: ['a'], next5: ['b'] },
};

const validBody = {
  ref: { book: 'HAB', chapter: 1, verse: 4 },
  issueType: 'figs-metaphor',
  ult: textSide,
  ust: textSide,
  hebrewGuess: 'רָשָׁע',
};

describe('BodySchema — baseline editor payload', () => {
  test('accepts a minimal valid payload and defaults model', () => {
    const r = BodySchema.safeParse(validBody);
    assert.equal(r.success, true);
    assert.equal(r.data.model, 'sonnet');
    assert.equal(r.data.contextRef, undefined);
  });
});

describe('BodySchema — contextRef / targetLang / direction', () => {
  test('accepts a branch-pinned contextRef', () => {
    const r = BodySchema.safeParse({ ...validBody, contextRef: 'BSOJ/translation-context@master' });
    assert.equal(r.success, true);
    assert.equal(r.data.contextRef, 'BSOJ/translation-context@master');
  });

  test('accepts a sha-pinned contextRef, targetLang, and direction', () => {
    const sha = 'a'.repeat(40);
    const r = BodySchema.safeParse({
      ...validBody,
      contextRef: `BSOJ/translation-context@${sha}`,
      targetLang: 'es-419',
      direction: 'ltr',
    });
    assert.equal(r.success, true);
  });

  test('rejects a contextRef with no org/repo slash', () => {
    const r = BodySchema.safeParse({ ...validBody, contextRef: 'no-slash@master' });
    assert.equal(r.success, false);
  });

  test('rejects a contextRef with no @ref', () => {
    const r = BodySchema.safeParse({ ...validBody, contextRef: 'org/repo' });
    assert.equal(r.success, false);
  });

  test('rejects a contextRef containing whitespace', () => {
    const r = BodySchema.safeParse({ ...validBody, contextRef: 'org /repo@master' });
    assert.equal(r.success, false);
  });

  test('rejects a contextRef with disallowed characters in org/repo', () => {
    for (const bad of [
      'org#hash/repo@master',
      'org/repo?query@master',
      'org%2Fslash/repo@master',
      '../../repo@master',
      'org/repo/../evil@master',
    ]) {
      const r = BodySchema.safeParse({ ...validBody, contextRef: bad });
      assert.equal(r.success, false, `expected rejection for ${JSON.stringify(bad)}`);
    }
  });

  test('rejects a local-directory contextRef without CONTEXT_PACK_ALLOW_LOCAL', () => {
    delete process.env.CONTEXT_PACK_ALLOW_LOCAL;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnq-local-'));
    const r = BodySchema.safeParse({ ...validBody, contextRef: dir });
    assert.equal(r.success, false);
  });

  test('accepts a local-directory contextRef when CONTEXT_PACK_ALLOW_LOCAL=1', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnq-local-'));
    process.env.CONTEXT_PACK_ALLOW_LOCAL = '1';
    try {
      const r = BodySchema.safeParse({ ...validBody, contextRef: dir });
      assert.equal(r.success, true);
    } finally {
      delete process.env.CONTEXT_PACK_ALLOW_LOCAL;
    }
  });

  test('rejects a malformed targetLang and an unknown direction', () => {
    assert.equal(BodySchema.safeParse({ ...validBody, targetLang: 'Spanish' }).success, false);
    assert.equal(BodySchema.safeParse({ ...validBody, direction: 'ttb' }).success, false);
  });
});

describe('BodySchema — strict', () => {
  test('rejects an unknown top-level field', () => {
    const r = BodySchema.safeParse({ ...validBody, preferences: { register: 'formal' } });
    assert.equal(r.success, false);
    assert.equal(r.error.issues.some((i) => i.code === 'unrecognized_keys'), true);
  });

  test('rejects an unknown nested field in ref', () => {
    const r = BodySchema.safeParse({ ...validBody, ref: { ...validBody.ref, extra: 1 } });
    assert.equal(r.success, false);
  });

  test('rejects an unknown nested field in ult.context', () => {
    const r = BodySchema.safeParse({
      ...validBody,
      ult: { ...textSide, context: { ...textSide.context, extra: 1 } },
    });
    assert.equal(r.success, false);
  });

  test('rejects an unknown nested field in ult', () => {
    const r = BodySchema.safeParse({ ...validBody, ult: { ...textSide, extra: 1 } });
    assert.equal(r.success, false);
  });
});

function writeFixturePack(dir) {
  fs.mkdirSync(path.join(dir, 'terminology'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.yaml'), 'format: 1\nlanguage: ar\ndirection: rtl\n');
  fs.writeFileSync(path.join(dir, 'brief.md'), '# Brief\n\n**Register:** formal\n\nTranslate simply.');
  fs.writeFileSync(path.join(dir, 'terminology', 'terms.csv'),
    'concept_id,source_term,target_term,status,replacement,comment,tw_link\n'
    + 'names/yhwh,Yahweh,يهوه,preferred,,,\n'
    + 'kt/lord,Lord,السيد,forbidden,الرب,,\n'
    + 'names/tetragram,YHWH,,do_not_translate,,,\n'
    + 'kt/covenant,covenant,عهد,admitted,,,\n');
}

describe('buildSystemPrompt', () => {
  test('returns the bare style rules when no pack is supplied', () => {
    assert.equal(buildSystemPrompt({ pack: null }), TN_QUICK_STYLE);
  });

  test('assembles forbidden/do-not-translate terminology only (no "preferred" or "admitted" bucket) with a local fixture pack', async () => {
    _resetForTests();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnq-pack-'));
    writeFixturePack(dir);
    const { pack, warning } = await loadQuickPack(dir, {});
    assert.equal(warning, null);
    assert.ok(pack);

    const system = buildSystemPrompt({
      pack, targetLang: 'ar', targetLangName: 'Arabic', direction: 'rtl',
    });
    assert.match(system, /^You draft a single English translation note/);
    assert.match(system, /# Translation context/);
    assert.match(system, /## Translation brief/);
    // "preferred" is target-language guidance for the translate pipeline, not
    // for an English note — tn-quick excludes it, so the HARD CONSTRAINTS
    // section (which is rendered from the preferred bucket) does not appear.
    assert.doesNotMatch(system, /## Terminology — HARD CONSTRAINTS/);
    assert.match(system, /## Terminology — FORBIDDEN/);
    assert.doesNotMatch(system, /## Terminology — admitted/);
  });

  test('omits all terminology sections when the pack only has "preferred" terms', async () => {
    _resetForTests();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnq-pack-preferred-only-'));
    fs.mkdirSync(path.join(dir, 'terminology'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.yaml'), 'format: 1\nlanguage: ar\ndirection: rtl\n');
    fs.writeFileSync(path.join(dir, 'brief.md'), '# Brief\n\n**Register:** formal\n\nTranslate simply.');
    fs.writeFileSync(path.join(dir, 'terminology', 'terms.csv'),
      'concept_id,source_term,target_term,status,replacement,comment,tw_link\n'
      + 'names/yhwh,Yahweh,يهوه,preferred,,,\n');
    const { pack, warning } = await loadQuickPack(dir, {});
    assert.equal(warning, null);
    assert.ok(pack);

    const system = buildSystemPrompt({
      pack, targetLang: 'ar', targetLangName: 'Arabic', direction: 'rtl',
    });
    assert.doesNotMatch(system, /## Terminology — HARD CONSTRAINTS/);
    assert.doesNotMatch(system, /## Terminology — FORBIDDEN/);
  });

  test('frames the pack as background so a target-language pack cannot flip the note language', async () => {
    _resetForTests();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnq-pack-frame-'));
    writeFixturePack(dir);
    const { pack } = await loadQuickPack(dir, {});
    const system = buildSystemPrompt({
      pack, targetLang: 'ar', targetLangName: 'Arabic', direction: 'rtl',
    });
    assert.ok(system.includes(TN_QUICK_PACK_FRAME), 'reconciliation frame present');
    // The frame must sit between the style rules and the pack, so it governs
    // how the pack that follows is read.
    assert.ok(
      system.indexOf(TN_QUICK_STYLE) < system.indexOf(TN_QUICK_PACK_FRAME)
        && system.indexOf(TN_QUICK_PACK_FRAME) < system.indexOf('# Translation context'),
      'frame is ordered after the style rules and before the pack',
    );
    // No frame when there is no pack to reconcile against.
    assert.ok(!buildSystemPrompt({ pack: null }).includes(TN_QUICK_PACK_FRAME));
  });
});

describe('TN_QUICK_STYLE — speaker identification (#358)', () => {
  test('names no specific book, so a single-shot call cannot anchor on one', () => {
    assert.doesNotMatch(TN_QUICK_STYLE, /Habakkuk/);
  });

  test('tells the model to derive the speaker from the reference', () => {
    assert.match(TN_QUICK_STYLE, /Reference line/);
    assert.match(TN_QUICK_STYLE, /traditional author/);
    assert.match(TN_QUICK_STYLE, /superscription/);
  });
});

describe('formatReference — book-name expansion (#358)', () => {
  test('spells out the full book name after the code', () => {
    assert.equal(formatReference({ book: 'JER', chapter: 24, verse: 5 }), 'JER 24:5 (Jeremiah)');
    assert.equal(formatReference({ book: 'PSA', chapter: 23, verse: 1 }), 'PSA 23:1 (Psalms)');
    assert.equal(formatReference({ book: '1SA', chapter: 1, verse: 1 }), '1SA 1:1 (1 Samuel)');
  });

  test('uppercases a lowercase code', () => {
    assert.equal(formatReference({ book: 'hab', chapter: 1, verse: 4 }), 'HAB 1:4 (Habakkuk)');
  });

  test('falls back to the bare code for an unknown book rather than throwing', () => {
    assert.equal(formatReference({ book: 'ZZZ', chapter: 1, verse: 1 }), 'ZZZ 1:1');
  });

  test('covers exactly the book codes the endpoint accepts', () => {
    assert.deepEqual(Object.keys(BOOK_FULL_NAMES).sort(), Object.keys(BOOK_NUMBERS).sort());
  });
});

describe('buildUserMessage', () => {
  const templateInfo = { templates: [{ id: 't1', text: 'SPEAKER is speaking of X as if it were Y' }] };

  test('the Reference line carries the full book name', () => {
    const msg = buildUserMessage({
      body: { ...validBody, ref: { book: 'JER', chapter: 24, verse: 5 } },
      templateInfo,
      hebrewQuote: 'רָשָׁע',
    });
    assert.match(msg, /^Reference: JER 24:5 \(Jeremiah\)$/m);
  });

  test('still emits the phrases, templates, and both context blocks', () => {
    const msg = buildUserMessage({ body: validBody, templateInfo, hebrewQuote: 'רָשָׁע' });
    assert.match(msg, /ULT support phrase: "the wicked surround the righteous"/);
    assert.match(msg, /UST parallel phrase: /);
    assert.match(msg, /ULT v\. 4 \[TARGET VERSE\]: /);
    assert.match(msg, /UST v\. 4 \[TARGET VERSE\]: /);
    assert.match(msg, /SPEAKER is speaking of X as if it were Y/);
  });
});

describe('extractAlternateTranslations', () => {
  test('finds a single bracketed AT', () => {
    assert.deepEqual(
      extractAlternateTranslations('He is speaking of X as if it were Y. Alternate translation: [he traveled]'),
      ['he traveled'],
    );
  });

  test('finds both options when a note offers two', () => {
    assert.deepEqual(extractAlternateTranslations('Alternate translation: [a] or [b]'), ['a', 'b']);
  });

  test('finds ATs across multiple lines', () => {
    assert.deepEqual(
      extractAlternateTranslations('Alternate translation: [x]\nAlternate translation: [y]'),
      ['x', 'y'],
    );
  });

  test('returns nothing for a note with no AT, and never throws on empty input', () => {
    assert.deepEqual(extractAlternateTranslations('These two phrases mean basically the same thing.'), []);
    assert.deepEqual(extractAlternateTranslations(''), []);
    assert.deepEqual(extractAlternateTranslations(undefined), []);
  });
});

describe('checkAtFit — drop-in check (#359)', () => {
  test('a clean drop-in produces no warnings', () => {
    assert.deepEqual(checkAtFit({
      noteText: 'Alternate translation: [in my suffering]',
      verse: 'And in my distress I called to Yahweh.',
      selection: 'in my distress',
    }), []);
  });

  test('a note with no AT is never warned about', () => {
    assert.deepEqual(checkAtFit({
      noteText: 'These two phrases mean basically the same thing.',
      verse: 'And he went to the city.',
      selection: 'he went',
    }), []);
  });

  test('warns when the selected phrase is not in the verse', () => {
    const w = checkAtFit({
      noteText: 'Alternate translation: [he traveled]',
      verse: 'And he went to the city.',
      selection: 'a phrase from some other verse',
    });
    assert.equal(w.length, 1);
    assert.match(w[0], /^at_fit_unverified: /);
  });

  test('warns when substitution leaves the verse starting with a lowercase word', () => {
    const w = checkAtFit({
      noteText: 'Alternate translation: [he traveled]',
      verse: 'And he went to the city.',
      selection: 'And he went',
    });
    assert.equal(w.length, 1);
    assert.match(w[0], /^at_fit_capitalization: /);
  });

  test('warns on terminal punctuation inside the brackets, but not on an ellipsis', () => {
    const punct = checkAtFit({
      noteText: 'Alternate translation: [he traveled.]',
      verse: 'And he went to the city.',
      selection: 'he went',
    });
    assert.equal(punct.length, 1);
    assert.match(punct[0], /^at_fit_punctuation: /);

    assert.deepEqual(checkAtFit({
      noteText: 'Alternate translation: [he traveled…]',
      verse: 'And he went to the city.',
      selection: 'he went',
    }), []);
  });

  test('warns on a doubled space introduced by the substitution', () => {
    const w = checkAtFit({
      noteText: 'Alternate translation: [he  traveled]',
      verse: 'And he went to the city.',
      selection: 'he went',
    });
    assert.equal(w.length, 1);
    assert.match(w[0], /^at_fit_spacing: /);
  });

  test('degrades quietly when the verse or selection is missing', () => {
    const note = 'Alternate translation: [he traveled]';
    assert.deepEqual(checkAtFit({ noteText: note, verse: '', selection: 'he went' }), []);
    assert.deepEqual(checkAtFit({ noteText: note, verse: 'And he went.', selection: '' }), []);
  });
});

describe('loadQuickPack — degrade semantics', () => {
  test('never throws; a load failure returns { pack: null, warning }', async () => {
    _resetForTests();
    const { pack, warning } = await loadQuickPack('BSOJ/translation-context@notahex', {
      fetchImpl: async () => { throw new Error('network down'); },
    });
    assert.equal(pack, null);
    assert.match(warning, /^context_pack_unavailable:/);
  });

  test('an empty pack (no content files) degrades with a warning', async () => {
    _resetForTests();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnq-empty-'));
    const { pack, warning } = await loadQuickPack(dir, {});
    assert.equal(pack, null);
    assert.match(warning, /^context_pack_unavailable:/);
  });
});
