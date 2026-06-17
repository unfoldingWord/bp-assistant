const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseJobId,
  StartBodySchema,
  buildApiJobId,
} = require('../src/api/pipeline');
const {
  getExpectedOutputs,
  buildStagingBranch,
  PIPELINE_OUTPUT_TYPES,
  REPO_MAP,
} = require('../src/api/pipeline-output');

// ---------------------------------------------------------------------------
// jobId round-trip
// ---------------------------------------------------------------------------

test('buildApiJobId / parseJobId — round-trip for single chapter', () => {
  const apiSessionKey = 'bible-editor-123-abc';
  const scope = { book: 'PSA', startChapter: 1, endChapter: 1, verseStart: null, verseEnd: null };
  const jobId = buildApiJobId({ apiSessionKey, pipelineType: 'notes', scope });

  const parsed = parseJobId(jobId);
  assert.ok(parsed, 'parseJobId returned null');
  assert.equal(parsed.pipelineType, 'notes');
  assert.deepEqual(parsed.scope, scope);
  // sessionKey is the API control thread ("stream-<channel>-<topic>"),
  // sanitized — NOT the caller's apiSessionKey. This is what the pipeline
  // writes its checkpoint under, so /api/pipeline/:jobId status lookups match.
  assert.match(parsed.sessionKey, /^stream_/);
  assert.match(parsed.sessionKey, /Bot_testing/);
  assert.doesNotMatch(parsed.sessionKey, /bible_editor/);
});

test('buildApiJobId — jobId is independent of apiSessionKey (control-thread identity)', () => {
  // API runs adopt the shared control thread as their sessionKey, so two
  // callers requesting the same scope get the same jobId/checkpoint. Dedup is
  // by (control-thread, scope); idempotency on the work itself is preserved.
  const scope = { book: 'ZEC', startChapter: 7, endChapter: 7, verseStart: null, verseEnd: null };
  const a = buildApiJobId({ apiSessionKey: 'editor-AAA', pipelineType: 'notes', scope });
  const b = buildApiJobId({ apiSessionKey: 'editor-BBB', pipelineType: 'notes', scope });
  assert.equal(a, b);
});

test('parseJobId — round-trip with chapter range', () => {
  const apiSessionKey = 'editor-uuid-deadbeef';
  const scope = { book: 'GEN', startChapter: 1, endChapter: 5, verseStart: null, verseEnd: null };
  const jobId = buildApiJobId({ apiSessionKey, pipelineType: 'generate', scope });
  const parsed = parseJobId(jobId);
  assert.deepEqual(parsed.scope, scope);
  assert.equal(parsed.pipelineType, 'generate');
});

test('parseJobId — round-trip with verse range', () => {
  const apiSessionKey = 'verse-range-test';
  const scope = { book: 'PSA', startChapter: 23, endChapter: 23, verseStart: 1, verseEnd: 6 };
  const jobId = buildApiJobId({ apiSessionKey, pipelineType: 'tqs', scope });
  const parsed = parseJobId(jobId);
  assert.deepEqual(parsed.scope, scope);
  assert.equal(parsed.pipelineType, 'tqs');
});

test('parseJobId — rejects malformed inputs', () => {
  assert.equal(parseJobId(''), null);
  assert.equal(parseJobId('not-a-job-id'), null);
  assert.equal(parseJobId('only__two'), null);
  assert.equal(parseJobId('a__b__c__d'), null);
  assert.equal(parseJobId('foo__notes__PSA_1_1_na'), null);              // scope only 4 parts
  assert.equal(parseJobId('foo__unknown_type__PSA_1_1_na_na'), null);   // bad pipelineType
  assert.equal(parseJobId('foo__notes__PSA_x_1_na_na'), null);          // non-numeric chapter
  assert.equal(parseJobId(null), null);
  assert.equal(parseJobId(undefined), null);
});

// ---------------------------------------------------------------------------
// StartBodySchema
// ---------------------------------------------------------------------------

test('StartBodySchema — accepts a minimal valid payload', () => {
  const r = StartBodySchema.safeParse({
    pipelineType: 'notes',
    book: 'PSA',
    startChapter: 1,
    username: 'stephen-wunrow',
    sessionKey: 'bible-editor/abc/123',
  });
  assert.equal(r.success, true);
});

test('StartBodySchema — rejects sessionKey containing "__"', () => {
  const r = StartBodySchema.safeParse({
    pipelineType: 'notes',
    book: 'PSA',
    startChapter: 1,
    username: 'stephen-wunrow',
    sessionKey: 'evil__separator',
  });
  assert.equal(r.success, false);
});

test('StartBodySchema — rejects sessionKey that collapses to "__" via sanitization', () => {
  // Two consecutive non-alphanumeric chars (e.g. `//`) sanitize to `__`,
  // which would corrupt jobId parsing. Must reject.
  const r = StartBodySchema.safeParse({
    pipelineType: 'notes',
    book: 'PSA',
    startChapter: 1,
    username: 'stephen-wunrow',
    sessionKey: 'a//b',
  });
  assert.equal(r.success, false);
});

test('StartBodySchema — rejects bad book code, bad pipelineType, missing username', () => {
  const r1 = StartBodySchema.safeParse({
    pipelineType: 'notes', book: 'PSALM', startChapter: 1, username: 'u', sessionKey: 'k',
  });
  assert.equal(r1.success, false);
  const r2 = StartBodySchema.safeParse({
    pipelineType: 'unknown', book: 'PSA', startChapter: 1, username: 'u', sessionKey: 'k',
  });
  assert.equal(r2.success, false);
  const r3 = StartBodySchema.safeParse({
    pipelineType: 'notes', book: 'PSA', startChapter: 1, sessionKey: 'k',
  });
  assert.equal(r3.success, false);
});

test('StartBodySchema — accepts options.model', () => {
  const r = StartBodySchema.safeParse({
    pipelineType: 'generate', book: 'PSA', startChapter: 1, endChapter: 2,
    username: 'u', sessionKey: 'k', options: { model: 'opus' },
  });
  assert.equal(r.success, true);
});

// ---------------------------------------------------------------------------
// getExpectedOutputs
// ---------------------------------------------------------------------------

test('getExpectedOutputs — generate produces ULT + UST refs', () => {
  const out = getExpectedOutputs('generate', 'PSA');
  assert.equal(out.length, 2);
  const types = out.map((o) => o.type).sort();
  assert.deepEqual(types, ['ult', 'ust']);
  const ult = out.find((o) => o.type === 'ult');
  assert.equal(ult.repo, 'unfoldingWord/en_ult');
  assert.equal(ult.branch, 'master');
  assert.equal(ult.path, '19-PSA.usfm');
  assert.equal(ult.rawUrl, 'https://git.door43.org/unfoldingWord/en_ult/raw/branch/master/19-PSA.usfm');
});

test('getExpectedOutputs — notes produces one tn ref with whole-book TSV', () => {
  const out = getExpectedOutputs('notes', 'GEN');
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'tn');
  assert.equal(out[0].repo, 'unfoldingWord/en_tn');
  assert.equal(out[0].path, 'tn_GEN.tsv');
  assert.equal(out[0].rawUrl, 'https://git.door43.org/unfoldingWord/en_tn/raw/branch/master/tn_GEN.tsv');
});

test('getExpectedOutputs — tqs produces one tq ref', () => {
  const out = getExpectedOutputs('tqs', 'HAB');
  assert.equal(out.length, 1);
  assert.equal(out[0].path, 'tq_HAB.tsv');
});

test('getExpectedOutputs — rejects unknown pipelineType', () => {
  assert.throws(() => getExpectedOutputs('mystery', 'PSA'));
});

test('getExpectedOutputs — rejects unknown book in generate (book number lookup)', () => {
  assert.throws(() => getExpectedOutputs('generate', 'XYZ'));
});

// ---------------------------------------------------------------------------
// buildStagingBranch — must match pipeline-utils' buildBranchName
// ---------------------------------------------------------------------------

test('buildStagingBranch — PSA uses 3-digit padding', () => {
  assert.equal(buildStagingBranch('PSA', 30, 30), 'AI-PSA-030');
  assert.equal(buildStagingBranch('PSA', 1, 1), 'AI-PSA-001');
  assert.equal(buildStagingBranch('PSA', 1, 5), 'AI-PSA-001-005');
});

test('buildStagingBranch — non-PSA books use 2-digit padding', () => {
  assert.equal(buildStagingBranch('GEN', 1, 1), 'AI-GEN-01');
  assert.equal(buildStagingBranch('ISA', 33, 33), 'AI-ISA-33');
  assert.equal(buildStagingBranch('ISA', 33, 34), 'AI-ISA-33-34');
});

// ---------------------------------------------------------------------------
// Sanity — constants line up
// ---------------------------------------------------------------------------

test('PIPELINE_OUTPUT_TYPES — all referenced types exist in REPO_MAP', () => {
  for (const [, types] of Object.entries(PIPELINE_OUTPUT_TYPES)) {
    for (const t of types) {
      assert.ok(REPO_MAP[t], `REPO_MAP missing entry for ${t}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Options → synthetic content flags
// ---------------------------------------------------------------------------

const { buildApiContentFlags } = require('../src/router');

test('buildApiContentFlags — generate, no options → no flags', () => {
  assert.deepEqual(buildApiContentFlags('generate', {}), []);
  assert.deepEqual(buildApiContentFlags('generate', undefined), []);
});

test('buildApiContentFlags — generate, ULT-only contentTypes → "ULT" flag', () => {
  assert.deepEqual(buildApiContentFlags('generate', { contentTypes: ['ult'] }), ['ULT']);
  assert.deepEqual(buildApiContentFlags('generate', { contentTypes: ['ust'] }), ['UST']);
});

test('buildApiContentFlags — generate, both contentTypes → no restriction flag', () => {
  assert.deepEqual(buildApiContentFlags('generate', { contentTypes: ['ult', 'ust'] }), []);
});

test('buildApiContentFlags — generate, noAlign → --no-align', () => {
  assert.deepEqual(buildApiContentFlags('generate', { noAlign: true }), ['--no-align']);
});

test('buildApiContentFlags — generate, alignOnly → --align-only', () => {
  assert.deepEqual(buildApiContentFlags('generate', { alignOnly: true }), ['--align-only']);
});

test('buildApiContentFlags — generate, textOnly → --text-only', () => {
  assert.deepEqual(buildApiContentFlags('generate', { textOnly: true }), ['--text-only']);
});

test('buildApiContentFlags — generate, combined ULT + no-align + fresh', () => {
  const f = buildApiContentFlags('generate', { contentTypes: ['ult'], noAlign: true, fresh: true });
  assert.deepEqual(f, ['ULT', '--no-align', '--fresh']);
});

test('buildApiContentFlags — notes, noIntro + pauseBeforeATs', () => {
  assert.deepEqual(
    buildApiContentFlags('notes', { noIntro: true, pauseBeforeATs: true }),
    ['--no-intro', '--pause-before-ats'],
  );
});

test('buildApiContentFlags — notes ignores generate-only flags', () => {
  // Schema-level validation rejects these for notes, but the builder must also
  // be tolerant: silently drop generate-only flags rather than emit them.
  assert.deepEqual(buildApiContentFlags('notes', { contentTypes: ['ult'], noAlign: true }), []);
});

test('buildApiContentFlags — tqs, fresh', () => {
  assert.deepEqual(buildApiContentFlags('tqs', { fresh: true }), ['--fresh']);
});

// ---------------------------------------------------------------------------
// StartBodySchema — option validation
// ---------------------------------------------------------------------------

test('StartBodySchema — accepts options.contentTypes for generate', () => {
  const r = StartBodySchema.safeParse({
    pipelineType: 'generate', book: 'PSA', startChapter: 1,
    username: 'u', sessionKey: 'k',
    options: { contentTypes: ['ult'] },
  });
  assert.equal(r.success, true);
});

test('StartBodySchema — rejects generate-only options on notes', () => {
  const r = StartBodySchema.safeParse({
    pipelineType: 'notes', book: 'PSA', startChapter: 1,
    username: 'u', sessionKey: 'k',
    options: { contentTypes: ['ult'] },
  });
  assert.equal(r.success, false);
});

test('StartBodySchema — rejects notes-only options on generate', () => {
  const r = StartBodySchema.safeParse({
    pipelineType: 'generate', book: 'PSA', startChapter: 1,
    username: 'u', sessionKey: 'k',
    options: { noIntro: true },
  });
  assert.equal(r.success, false);
});

test('StartBodySchema — rejects mutually-exclusive align flags', () => {
  const r = StartBodySchema.safeParse({
    pipelineType: 'generate', book: 'PSA', startChapter: 1,
    username: 'u', sessionKey: 'k',
    options: { noAlign: true, alignOnly: true },
  });
  assert.equal(r.success, false);
});

test('StartBodySchema — rejects unknown options keys (strict)', () => {
  const r = StartBodySchema.safeParse({
    pipelineType: 'generate', book: 'PSA', startChapter: 1,
    username: 'u', sessionKey: 'k',
    options: { mysteryFlag: true },
  });
  assert.equal(r.success, false);
});

test('StartBodySchema — accepts fresh on any pipeline type', () => {
  for (const pt of ['generate', 'notes', 'tqs']) {
    const r = StartBodySchema.safeParse({
      pipelineType: pt, book: 'PSA', startChapter: 1,
      username: 'u', sessionKey: 'k',
      options: { fresh: true },
    });
    assert.equal(r.success, true, `${pt} should accept fresh`);
  }
});

// ---------------------------------------------------------------------------
// StartBodySchema — hints
// ---------------------------------------------------------------------------

const VALID_HINT = {
  rowId: 'ab12',
  verse: 7,
  quote: 'מֵרֵעֵהוּ',
  supportReference: 'rc://*/ta/man/translate/figs-metaphor',
  seed: 'Could be either view.',
};

test('StartBodySchema — accepts options.hints on notes pipeline', () => {
  const r = StartBodySchema.safeParse({
    pipelineType: 'notes', book: 'ZEC', startChapter: 7,
    username: 'u', sessionKey: 'k',
    options: { hints: [VALID_HINT] },
  });
  assert.equal(r.success, true);
});

test('StartBodySchema — accepts hints with null seed and null supportReference', () => {
  const r = StartBodySchema.safeParse({
    pipelineType: 'notes', book: 'ZEC', startChapter: 7,
    username: 'u', sessionKey: 'k',
    options: { hints: [{ ...VALID_HINT, seed: null, supportReference: null }] },
  });
  assert.equal(r.success, true);
});

test('StartBodySchema — accepts empty hint.quote', () => {
  const r = StartBodySchema.safeParse({
    pipelineType: 'notes', book: 'ZEC', startChapter: 7,
    username: 'u', sessionKey: 'k',
    options: { hints: [{ ...VALID_HINT, quote: '' }] },
  });
  assert.equal(r.success, true);
});

test('StartBodySchema — accepts empty quote when seed is present (general note)', () => {
  const r = StartBodySchema.safeParse({
    pipelineType: 'notes', book: 'ZEC', startChapter: 7,
    username: 'u', sessionKey: 'k',
    options: { hints: [{ ...VALID_HINT, quote: '', seed: 'General background on this verse.' }] },
  });
  assert.equal(r.success, true);
});

test('StartBodySchema — rejects hint with both quote and seed empty', () => {
  for (const seed of ['', '   ', null]) {
    const r = StartBodySchema.safeParse({
      pipelineType: 'notes', book: 'ZEC', startChapter: 7,
      username: 'u', sessionKey: 'k',
      options: { hints: [{ ...VALID_HINT, quote: '', seed }] },
    });
    assert.equal(r.success, false, `quote:'' + seed:${JSON.stringify(seed)} should fail`);
    const issue = r.error.issues.find((i) => i.path.join('.') === 'options.hints.0.seed');
    assert.ok(issue, 'expected an issue on options.hints.0.seed');
  }
});

test('StartBodySchema — rejects hints on generate and tqs pipelines', () => {
  for (const pt of ['generate', 'tqs']) {
    const r = StartBodySchema.safeParse({
      pipelineType: pt, book: 'ZEC', startChapter: 7,
      username: 'u', sessionKey: 'k',
      options: { hints: [VALID_HINT] },
    });
    assert.equal(r.success, false, `${pt} should reject hints`);
  }
});

test('StartBodySchema — rejects malformed rowId', () => {
  for (const bad of ['AB12', '12ab', 'abcde', 'ab1', '', 'ab-1']) {
    const r = StartBodySchema.safeParse({
      pipelineType: 'notes', book: 'ZEC', startChapter: 7,
      username: 'u', sessionKey: 'k',
      options: { hints: [{ ...VALID_HINT, rowId: bad }] },
    });
    assert.equal(r.success, false, `rowId="${bad}" should fail`);
  }
});

test('StartBodySchema — rejects duplicate rowIds within a single request', () => {
  const r = StartBodySchema.safeParse({
    pipelineType: 'notes', book: 'ZEC', startChapter: 7,
    username: 'u', sessionKey: 'k',
    options: { hints: [VALID_HINT, { ...VALID_HINT, verse: 9 }] },
  });
  assert.equal(r.success, false);
});

test('StartBodySchema — rejects hints on multi-chapter scope', () => {
  const r = StartBodySchema.safeParse({
    pipelineType: 'notes', book: 'ZEC', startChapter: 7, endChapter: 9,
    username: 'u', sessionKey: 'k',
    options: { hints: [VALID_HINT] },
  });
  assert.equal(r.success, false);
});

test('StartBodySchema — accepts hints when endChapter omitted (defaults to startChapter)', () => {
  const r = StartBodySchema.safeParse({
    pipelineType: 'notes', book: 'ZEC', startChapter: 7,
    username: 'u', sessionKey: 'k',
    options: { hints: [VALID_HINT] },
  });
  assert.equal(r.success, true);
});

test('StartBodySchema — rejects more than 50 hints', () => {
  const many = Array.from({ length: 51 }, (_, i) => ({
    ...VALID_HINT,
    rowId: 'a' + String(i).padStart(3, '0'),
  }));
  const r = StartBodySchema.safeParse({
    pipelineType: 'notes', book: 'ZEC', startChapter: 7,
    username: 'u', sessionKey: 'k',
    options: { hints: many },
  });
  assert.equal(r.success, false);
});

test('StartBodySchema — rejects unknown keys on hint object (strict)', () => {
  const r = StartBodySchema.safeParse({
    pipelineType: 'notes', book: 'ZEC', startChapter: 7,
    username: 'u', sessionKey: 'k',
    options: { hints: [{ ...VALID_HINT, mysteryField: 'oops' }] },
  });
  assert.equal(r.success, false);
});
