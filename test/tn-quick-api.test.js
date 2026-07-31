// tn-quick API — body schema and prompt assembly (no live model calls).
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  BodySchema,
  buildSystemPrompt,
  loadPackCached,
  TN_QUICK_STYLE,
  PACK_CACHE_TTL_MS,
} = require('../src/api/tn-quick');

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

describe('BodySchema', () => {
  test('accepts a minimal valid payload and defaults model', () => {
    const r = BodySchema.safeParse(validBody);
    assert.equal(r.success, true);
    assert.equal(r.data.model, 'sonnet');
    assert.equal(r.data.contextRef, undefined);
  });

  test('accepts contextRef / targetLang / direction', () => {
    const r = BodySchema.safeParse({
      ...validBody,
      contextRef: 'BSOJ/translation-context@master',
      targetLang: 'es-419',
      direction: 'ltr',
    });
    assert.equal(r.success, true);
    assert.equal(r.data.contextRef, 'BSOJ/translation-context@master');
    assert.equal(r.data.targetLang, 'es-419');
  });

  test('accepts a contextRef pinned to a sha', () => {
    const sha = 'a'.repeat(40);
    const r = BodySchema.safeParse({ ...validBody, contextRef: `BSOJ/translation-context@${sha}` });
    assert.equal(r.success, true);
  });

  test('rejects a malformed contextRef', () => {
    for (const bad of ['not-a-ref', 'org/repo', 'org@ref', 'org/repo@', 'org /repo@master']) {
      const r = BodySchema.safeParse({ ...validBody, contextRef: bad });
      assert.equal(r.success, false, `expected rejection for ${JSON.stringify(bad)}`);
    }
  });

  test('rejects a malformed targetLang and an unknown direction', () => {
    assert.equal(BodySchema.safeParse({ ...validBody, targetLang: 'Spanish' }).success, false);
    assert.equal(BodySchema.safeParse({ ...validBody, direction: 'ttb' }).success, false);
  });

  // Regression for #319: an unknown field used to be silently stripped, so a
  // client sending preferences got a confident 200 that ignored them.
  test('is strict — unknown top-level fields fail loudly', () => {
    const r = BodySchema.safeParse({ ...validBody, preferences: { register: 'formal' } });
    assert.equal(r.success, false);
    assert.equal(r.error.issues.some((i) => i.code === 'unrecognized_keys'), true);
  });
});

describe('buildSystemPrompt', () => {
  const pack = {
    hasContent: true,
    register: 'formal',
    brief: 'Translate for a rural audience with limited schooling.',
    instructions: 'Never use the divine name in a note.',
    standards: null,
    // Post-parse status vocab (parseTermsCsv normalizes approved → preferred).
    terms: [
      { source: 'covenant', target: 'pacto', status: 'preferred' },
      { source: 'grace', target: 'gracia vieja', status: 'forbidden', replacement: 'gracia' },
    ],
  };

  test('returns the bare style rules when no pack is supplied', () => {
    assert.equal(buildSystemPrompt({ pack: null }), TN_QUICK_STYLE);
  });

  test('returns the bare style rules for an empty pack', () => {
    assert.equal(buildSystemPrompt({ pack: { hasContent: false } }), TN_QUICK_STYLE);
  });

  test('prepends style rules and appends the org preferences', () => {
    const sys = buildSystemPrompt({ pack, targetLang: 'es-419' });
    assert.equal(sys.startsWith(TN_QUICK_STYLE), true, 'style rules must come first');
    assert.match(sys, /Formality register/);
    assert.match(sys, /formal/);
    assert.match(sys, /Translation brief/);
    assert.match(sys, /rural audience/);
    assert.match(sys, /Standing instructions/);
    assert.match(sys, /divine name/);
    assert.match(sys, /HARD CONSTRAINTS/);
    assert.match(sys, /"covenant" → "pacto"/);
    assert.match(sys, /FORBIDDEN/);
    assert.match(sys, /do NOT override the output/);
  });

  test('names the language and defaults direction from the code', () => {
    assert.match(buildSystemPrompt({ pack, targetLang: 'es-419' }), /Latin American Spanish \(es-419, left-to-right\)/);
    assert.match(buildSystemPrompt({ pack, targetLang: 'ar' }), /Arabic \(ar, right-to-left\)/);
  });

  test('an explicit direction overrides the default', () => {
    assert.match(buildSystemPrompt({ pack, targetLang: 'ar', direction: 'ltr' }), /\(ar, left-to-right\)/);
  });

  test('defaults to English when no targetLang is given', () => {
    assert.match(buildSystemPrompt({ pack }), /English \(en, left-to-right\)/);
  });
});

describe('loadPackCached', () => {
  test('loads once, then serves from cache within the TTL', async () => {
    let calls = 0;
    const loader = async () => { calls++; return { hasContent: true, sha: 'deadbeef' }; };
    const ref = 'CacheOrg/translation-context@master';
    const a = await loadPackCached(ref, { now: 1000, loader });
    const b = await loadPackCached(ref, { now: 1000 + PACK_CACHE_TTL_MS - 1, loader });
    assert.equal(calls, 1);
    assert.equal(a, b);
  });

  test('reloads once the TTL has elapsed', async () => {
    let calls = 0;
    const loader = async () => { calls++; return { hasContent: true, sha: `sha${calls}` }; };
    const ref = 'TtlOrg/translation-context@master';
    await loadPackCached(ref, { now: 1000, loader });
    const second = await loadPackCached(ref, { now: 1000 + PACK_CACHE_TTL_MS + 1, loader });
    assert.equal(calls, 2);
    assert.equal(second.sha, 'sha2');
  });

  test('caches per contextRef, not globally', async () => {
    let calls = 0;
    const loader = async (ref) => { calls++; return { hasContent: true, sha: ref }; };
    const one = await loadPackCached('OrgA/translation-context@master', { now: 2000, loader });
    const two = await loadPackCached('OrgB/translation-context@master', { now: 2000, loader });
    assert.equal(calls, 2);
    assert.notEqual(one.sha, two.sha);
  });

  test('propagates loader failures so the caller can degrade', async () => {
    const loader = async () => { throw new Error('HTTP 500'); };
    await assert.rejects(
      () => loadPackCached('BadOrg/translation-context@master', { now: 3000, loader }),
      /HTTP 500/,
    );
  });
});
