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
  TN_QUICK_STYLE,
  TN_QUICK_PACK_FRAME,
  checkAtFit,
  extractAlternateTranslations,
} = require('../src/api/tn-quick');
const { BOOK_NUMBERS, BOOK_NAMES } = require('../src/api-runner/verse-data');
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

describe('BodySchema — REDO fields (priorDraft / sourceGuidance)', () => {
  test('accepts priorDraft and sourceGuidance', () => {
    const r = BodySchema.safeParse({
      ...validBody,
      priorDraft: 'Habakkuk speaks of the wicked as if they were a besieging army.',
      sourceGuidance: 'Explain the siege image; keep the AT active.',
    });
    assert.equal(r.success, true);
    assert.equal(r.data.sourceGuidance, 'Explain the siege image; keep the AT active.');
  });

  test('both are optional — a fresh draft omits them', () => {
    const r = BodySchema.safeParse(validBody);
    assert.equal(r.success, true);
    assert.equal(r.data.priorDraft, undefined);
    assert.equal(r.data.sourceGuidance, undefined);
  });

  test('rejects empty or oversized values', () => {
    assert.equal(BodySchema.safeParse({ ...validBody, priorDraft: '' }).success, false);
    assert.equal(BodySchema.safeParse({ ...validBody, sourceGuidance: '' }).success, false);
    assert.equal(BodySchema.safeParse({ ...validBody, priorDraft: 'x'.repeat(4001) }).success, false);
    assert.equal(BodySchema.safeParse({ ...validBody, sourceGuidance: 'x'.repeat(4001) }).success, false);
  });
});

const templateInfo = { templates: [{ id: 't1', text: 'speaking of X as if it were Y' }] };

describe('buildUserMessage — REDO block', () => {
  test('a fresh draft adds no redraft framing', () => {
    const msg = buildUserMessage({ body: BodySchema.parse(validBody), templateInfo, hebrewQuote: 'רָשָׁע' });
    assert.equal(msg.includes('REDRAFT'), false);
    assert.equal(msg.includes('Prior draft of this note'), false);
    assert.equal(msg.includes('Guidance points from the source note'), false);
    assert.match(msg, /Draft ONE translation note/);
  });

  test('carries the prior draft and guidance, and asks to match register/length', () => {
    const body = BodySchema.parse({
      ...validBody,
      priorDraft: 'PRIOR_DRAFT_SENTINEL',
      sourceGuidance: 'SOURCE_GUIDANCE_SENTINEL',
    });
    const msg = buildUserMessage({ body, templateInfo, hebrewQuote: 'רָשָׁע' });
    assert.match(msg, /PRIOR_DRAFT_SENTINEL/);
    assert.match(msg, /SOURCE_GUIDANCE_SENTINEL/);
    assert.match(msg, /MUST survive the redraft/);
    assert.match(msg, /register, depth, and length/);
    // The verse context must still precede the redraft framing.
    assert.ok(msg.indexOf('UST context') < msg.indexOf('REDRAFT'));
  });

  test('either field alone is enough to trigger the redraft framing', () => {
    const onlyGuidance = buildUserMessage({
      body: BodySchema.parse({ ...validBody, sourceGuidance: 'G_ONLY' }),
      templateInfo,
      hebrewQuote: 'רָשָׁע',
    });
    assert.match(onlyGuidance, /G_ONLY/);
    assert.match(onlyGuidance, /REDRAFT/);
    assert.equal(onlyGuidance.includes('Prior draft of this note'), false);

    const onlyPrior = buildUserMessage({
      body: BodySchema.parse({ ...validBody, priorDraft: 'P_ONLY' }),
      templateInfo,
      hebrewQuote: 'רָשָׁע',
    });
    assert.match(onlyPrior, /P_ONLY/);
    assert.match(onlyPrior, /REDRAFT/);
    assert.equal(onlyPrior.includes('Guidance points from the source note'), false);
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

// Regression: the style guide used to name Habakkuk twice (as the first
// "Author References" example and in the "Here" Rule counter-example). In a
// single-shot call those were the only book names in the prompt, so the model
// anchored on them and named Habakkuk as the speaker while working in other
// books. See issue #358.
describe('speaker attribution — no book anchors in the prompt', () => {
  const OTHER_BOOKS = Object.values(BOOK_NAMES).filter((n) => n !== 'Psalms');

  // Word-boundary matching, so "Quotation Marks" is not read as the book Mark.
  // A few book names are also ordinary English words (Mark, Job, Acts, Song);
  // if legitimate prose ever trips this, reword the prose rather than naming a
  // book — a book name in the style guide is exactly what caused #358.
  test('TN_QUICK_STYLE names no specific book or its author', () => {
    for (const name of OTHER_BOOKS) {
      assert.ok(
        !new RegExp(`\\b${name}\\b`).test(TN_QUICK_STYLE),
        `TN_QUICK_STYLE must not name a specific book (found "${name}") — it anchors the speaker`,
      );
    }
    assert.ok(!/\bMoses\b/.test(TN_QUICK_STYLE), 'no book-specific author names');
  });

  test('TN_QUICK_STYLE tells the model to derive the author from the Reference line', () => {
    assert.match(TN_QUICK_STYLE, /Reference line/);
    assert.match(TN_QUICK_STYLE, /traditional author/);
  });

  test('Psalms guidance survives (psalmist rules are book-specific on purpose)', () => {
    assert.match(TN_QUICK_STYLE, /the psalmist/);
  });
});

describe('buildUserMessage — Reference line', () => {
  const templateInfo = { templates: [{ id: 'figs-metaphor', text: 'SPEAKER speaks of X...' }] };

  function refLine(book, chapter, verse) {
    const body = BodySchema.parse({
      ...validBody,
      ref: { book, chapter, verse },
    });
    const msg = buildUserMessage({ body, templateInfo, hebrewQuote: 'רָשָׁע' });
    return msg.split('\n')[0];
  }

  test('spells out the book name alongside the code', () => {
    assert.equal(refLine('JER', 24, 5), 'Reference: JER 24:5 (Jeremiah)');
  });

  test('lowercase book codes are upcased and still resolve a name', () => {
    assert.equal(refLine('hab', 1, 4), 'Reference: HAB 1:4 (Habakkuk)');
  });

  test('numbered books use the spaced display form', () => {
    assert.equal(refLine('1SA', 3, 1), 'Reference: 1SA 3:1 (1 Samuel)');
  });

  test('an unknown code degrades to the bare code rather than throwing', () => {
    assert.equal(refLine('ZZZ', 1, 1), 'Reference: ZZZ 1:1');
  });
});

describe('BOOK_NAMES', () => {
  test('covers exactly the codes BOOK_NUMBERS accepts', () => {
    assert.deepEqual(Object.keys(BOOK_NAMES).sort(), Object.keys(BOOK_NUMBERS).sort());
  });
});
