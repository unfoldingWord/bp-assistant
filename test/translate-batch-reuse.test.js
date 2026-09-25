// Regression tests for the batch-reuse cache identity (issue #392).
//
// The work dir is the cache key: buildRunHash() on the API route, `--out` for
// scripts/translate-dry-run.js. Neither encodes the scripture refs rendered
// into the pack, nor the pack's resolved sha (contextRef is hashed as a ref
// STRING, so `org/repo@master` at two commits keys identically). Without the
// identity gate a re-run after changing --literal, or after instructions.md
// moved under the same branch ref, reports success while returning batches
// translated under the OLD context.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const core = require('../src/lib/translate-core');
const { serializeTnTsv } = require('../src/lib/tn-tsv');

function tmpWorkDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'reuse-identity-'));
}

const IDENTITY = {
  contextRef: 'BSOJ/translation-context@master',
  contextSha: 'a'.repeat(40),
  scriptureRefs: {
    sourceLiteralRef: 'unfoldingWord/en_ult@master',
    sourceSimplifiedRef: 'unfoldingWord/en_ust@master',
    targetLiteralRef: 'BSOJ/es-419_glt@master',
    targetSimplifiedRef: 'BSOJ/es-419_gst@master',
  },
};

const clone = (o) => JSON.parse(JSON.stringify(o));

test('first run in a fresh work dir reuses nothing and stamps identity.json', () => {
  const dir = tmpWorkDir();
  const res = core.reuseIdentityGate(dir, IDENTITY);
  // Nothing is cached yet, so `reuse` is vacuously true; what matters is the stamp.
  assert.equal(res.reuse, true);
  const stamped = JSON.parse(fs.readFileSync(path.join(dir, 'identity.json'), 'utf8'));
  assert.deepEqual(stamped, IDENTITY);
});

test('a re-run with identical inputs reuses', () => {
  const dir = tmpWorkDir();
  core.reuseIdentityGate(dir, IDENTITY);
  const res = core.reuseIdentityGate(dir, clone(IDENTITY));
  assert.equal(res.reuse, true);
  assert.deepEqual(res.changed, []);
});

test('changing --literal (targetLiteralRef) refuses reuse', () => {
  const dir = tmpWorkDir();
  core.reuseIdentityGate(dir, IDENTITY);
  const next = clone(IDENTITY);
  next.scriptureRefs.targetLiteralRef = 'BSOJ/es-419_glt@v2';
  const res = core.reuseIdentityGate(dir, next);
  assert.equal(res.reuse, false);
  assert.deepEqual(res.changed, ['scriptureRefs.targetLiteralRef']);
});

test('each of the four scripture refs independently invalidates reuse', () => {
  for (const key of ['sourceLiteralRef', 'sourceSimplifiedRef', 'targetLiteralRef', 'targetSimplifiedRef']) {
    const dir = tmpWorkDir();
    core.reuseIdentityGate(dir, IDENTITY);
    const next = clone(IDENTITY);
    next.scriptureRefs[key] = 'someone/else@master';
    const res = core.reuseIdentityGate(dir, next);
    assert.equal(res.reuse, false, `${key} should invalidate reuse`);
    assert.deepEqual(res.changed, [`scriptureRefs.${key}`]);
  }
});

test('same branch contextRef at a new commit refuses reuse (the sha, not the ref, decides)', () => {
  const dir = tmpWorkDir();
  core.reuseIdentityGate(dir, IDENTITY);
  const next = clone(IDENTITY);
  next.contextSha = 'b'.repeat(40); // instructions.md moved under the same @master ref
  const res = core.reuseIdentityGate(dir, next);
  assert.equal(res.reuse, false);
  assert.deepEqual(res.changed, ['contextSha']);
});

test('key order does not affect identity', () => {
  const dir = tmpWorkDir();
  core.reuseIdentityGate(dir, IDENTITY);
  const reordered = {
    scriptureRefs: {
      targetSimplifiedRef: IDENTITY.scriptureRefs.targetSimplifiedRef,
      targetLiteralRef: IDENTITY.scriptureRefs.targetLiteralRef,
      sourceSimplifiedRef: IDENTITY.scriptureRefs.sourceSimplifiedRef,
      sourceLiteralRef: IDENTITY.scriptureRefs.sourceLiteralRef,
    },
    contextSha: IDENTITY.contextSha,
    contextRef: IDENTITY.contextRef,
  };
  assert.equal(core.reuseIdentityGate(dir, reordered).reuse, true);
});

test('a work dir predating the gate is grandfathered in, then stamped', () => {
  const dir = tmpWorkDir();
  fs.writeFileSync(path.join(dir, 'batch-01-out.tsv'), 'stale\n', 'utf8');
  // No identity.json: re-translating every in-flight batch of a resumed run
  // would be expensive and buys no safety, so reuse is allowed once.
  assert.equal(core.reuseIdentityGate(dir, IDENTITY).reuse, true);
  // ...but the stamp now exists, so a later input change is caught.
  const next = clone(IDENTITY);
  next.scriptureRefs.targetLiteralRef = 'BSOJ/es-419_glt@v2';
  assert.equal(core.reuseIdentityGate(dir, next).reuse, false);
});

test('an unreadable identity.json refuses reuse', () => {
  const dir = tmpWorkDir();
  fs.writeFileSync(path.join(dir, 'identity.json'), '{not json', 'utf8');
  const res = core.reuseIdentityGate(dir, IDENTITY);
  assert.equal(res.reuse, false);
  // and it is repaired for next time
  assert.equal(core.reuseIdentityGate(dir, clone(IDENTITY)).reuse, true);
});

test('after a mismatch the new identity is stamped, so the next matching run reuses', () => {
  const dir = tmpWorkDir();
  core.reuseIdentityGate(dir, IDENTITY);
  const next = clone(IDENTITY);
  next.contextSha = 'c'.repeat(40);
  assert.equal(core.reuseIdentityGate(dir, next).reuse, false);
  assert.equal(core.reuseIdentityGate(dir, clone(next)).reuse, true);
});

test('the gate creates the work dir when absent', () => {
  const dir = path.join(tmpWorkDir(), 'nested', 'work');
  assert.equal(core.reuseIdentityGate(dir, IDENTITY).reuse, true);
  assert.ok(fs.existsSync(path.join(dir, 'identity.json')));
});

// ---------------------------------------------------------------------------
// Pipeline wiring: translateChapters() must actually honour the gate.
// translate-pipeline pulls in the bot's runtime deps (dotenv, zulip-js, ...),
// which are not installed in every checkout; skip rather than fail there.
// ---------------------------------------------------------------------------

function loadPipeline() {
  try {
    // Patch context-pack BEFORE translate-pipeline destructures loadContextPack.
    const contextPack = require('../src/lib/context-pack');
    const scriptureVerses = require('../src/lib/scripture-verses');
    const pipeline = require('../src/translate-pipeline');
    return { pipeline, contextPack, scriptureVerses };
  } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND') return null;
    throw e;
  }
}

test('translateChapters re-translates instead of reusing when a scripture ref changes', async (t) => {
  const mods = loadPipeline();
  if (!mods) return t.skip('translate-pipeline runtime deps not installed');
  const { pipeline, contextPack, scriptureVerses } = mods;

  const SRC = 'Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote\n'
    + '1:1\tabc1\t\t\t\t1\tFirst note.\n';

  const origFetch = core.fetchResourceFile;
  const origLoad = contextPack.loadContextPack;
  const origScripture = scriptureVerses.buildScripturePack;
  core.fetchResourceFile = async () => SRC;
  contextPack.loadContextPack = async () => ({ hasContent: true, sha: 'a'.repeat(40), templates: new Map(), terms: [], examples: [] });
  scriptureVerses.buildScripturePack = async () => ({ markdown: '', targetLiteralFound: true, targetSimplifiedFound: true });
  t.after(() => {
    core.fetchResourceFile = origFetch;
    contextPack.loadContextPack = origLoad;
    scriptureVerses.buildScripturePack = origScripture;
  });

  const workDir = tmpWorkDir();
  let calls = 0;
  const runBatchImpl = async ({ files, batchRows }) => {
    calls++;
    const rows = batchRows.map((r) => ({ ...r, Note: `translated#${calls}` }));
    fs.writeFileSync(files.outputFile, serializeTnTsv(rows), 'utf8');
    return { rows, attempts: 1, llmCalls: [] };
  };

  const baseParams = {
    resourceType: 'tn', book: 'tit', startChapter: 1, endChapter: 1,
    sourceRef: 'unfoldingWord/en_tn@master',
    contextRef: 'BSOJ/translation-context@master',
    targetLang: 'es-419', targetLangName: 'Spanish', sourceLangName: 'English',
    direction: 'en->es-419', model: 'sonnet', targetOrg: 'BSOJ', repoName: 'es-419_tn',
    sourceLiteralRef: 'unfoldingWord/en_ult@master',
    sourceSimplifiedRef: 'unfoldingWord/en_ust@master',
    targetLiteralRef: 'BSOJ/es-419_glt@master',
    targetSimplifiedRef: 'BSOJ/es-419_gst@master',
  };

  const logs = [];
  const opts = { workDir, existingTargetText: '', onProgress: (m) => logs.push(m), runBatchImpl };

  await pipeline.translateChapters({ ...baseParams }, opts);
  const afterFirst = calls;
  assert.ok(afterFirst > 0, 'first run must translate');

  // Identical inputs -> every batch reused, no new batch-runner calls.
  logs.length = 0;
  await pipeline.translateChapters({ ...baseParams }, opts);
  assert.equal(calls, afterFirst, 'identical re-run must reuse every batch');
  assert.ok(logs.some((m) => /reused from previous run/.test(m)), 'expected reuse log lines');

  // Different --literal -> no reuse, everything re-translated.
  logs.length = 0;
  await pipeline.translateChapters({ ...baseParams, targetLiteralRef: 'BSOJ/es-419_glt@v2' }, opts);
  assert.ok(calls > afterFirst, 'changed --literal must force re-translation');
  assert.ok(!logs.some((m) => /reused from previous run/.test(m)), 'must log no reuse lines');
  assert.ok(logs.some((m) => /inputs changed since the previous run/.test(m)));
});
