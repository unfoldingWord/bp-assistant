// Editor delivery (delivery: 'editor') — translate results stay on the bot,
// never touch Door43, and are served to bible-editor via
// GET /api/pipeline/{jobId}/output?file=… allowlisted by the done
// checkpoint's output[] manifest.
'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

// Must be set BEFORE requiring src modules (CSKILLBP_DIR is read at require time).
process.env.CSKILLBP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-delivery-'));
process.env.BT_API_TOKEN = 'test-editor-token';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  StartBodySchema,
  handleStatusRequest,
  handleOutputRequest,
} = require('../src/api/pipeline');
const { setCheckpoint, getCheckpoint, clearCheckpoint } = require('../src/pipeline-checkpoints');
const { runTsvDelivery, runArticleDelivery } = require('../src/translate-pipeline');

const CSKILLBP_DIR = process.env.CSKILLBP_DIR;
const TOKEN = process.env.BT_API_TOKEN;
const AUTH = { authorization: `Bearer ${TOKEN}` };

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function mockRes() {
  return {
    statusCode: null,
    headers: {},
    body: null,
    headersSent: false,
    setHeader(k, v) { this.headers[k] = v; },
    removeHeader(k) { delete this.headers[k]; },
    writeHead(status, hdrs) { this.statusCode = status; Object.assign(this.headers, hdrs || {}); this.headersSent = true; },
    end(b) { this.body = b; },
  };
}

const req = (headers = {}) => ({ headers });
const jsonBody = (res) => JSON.parse(String(res.body));

// ---------------------------------------------------------------------------
// StartBodySchema — delivery enum
// ---------------------------------------------------------------------------

test('StartBodySchema — accepts delivery editor, path and branch on translate', () => {
  for (const delivery of ['editor', 'path', 'branch']) {
    const r = StartBodySchema.safeParse({
      pipelineType: 'translate', book: 'OBA', startChapter: 1,
      username: 'u', sessionKey: 'k',
      options: { targetLang: 'ar', delivery },
    });
    assert.equal(r.success, true, `delivery "${delivery}" should be accepted`);
  }
});

test('StartBodySchema — rejects unknown delivery value and delivery on non-translate', () => {
  const bad = StartBodySchema.safeParse({
    pipelineType: 'translate', book: 'OBA', startChapter: 1,
    username: 'u', sessionKey: 'k',
    options: { targetLang: 'ar', delivery: 'mystery' },
  });
  assert.equal(bad.success, false);
  const wrongType = StartBodySchema.safeParse({
    pipelineType: 'notes', book: 'OBA', startChapter: 1,
    username: 'u', sessionKey: 'k',
    options: { delivery: 'editor' },
  });
  assert.equal(wrongType.success, false);
});

// ---------------------------------------------------------------------------
// GET /api/pipeline/{jobId}/output — handleOutputRequest
// ---------------------------------------------------------------------------

const OUT_SESSION = 'edout';
const OUT_SCOPE = { book: 'OBA', startChapter: 1, endChapter: 1, verseStart: null, verseEnd: null };
const OUT_CKPT_ID = { sessionKey: OUT_SESSION, pipelineType: 'translate', scope: OUT_SCOPE };
const OUT_JOB_ID = 'edout__translate__OBA_1_1_na_na';
const TSV_BYTES = 'Reference\tID\tTags\tQuote\tOccurrence\tQuestion\tResponse\n1:1\tab12\t\t\t0\tسؤال\tجواب\n';

function seedOutputCheckpoint() {
  const outDirAbs = path.join(CSKILLBP_DIR, 'tmp', 'translate-ar-OBA-1-1-cafe1234', 'out');
  fs.mkdirSync(outDirAbs, { recursive: true });
  fs.writeFileSync(path.join(outDirAbs, 'tq_OBA.tsv'), TSV_BYTES, 'utf8');
  setCheckpoint(OUT_CKPT_ID, {
    state: 'done',
    current: { chapter: 1, skill: 'tq-translator', status: 'done' },
    outDir: path.relative(CSKILLBP_DIR, outDirAbs),
    output: [
      { delivery: 'editor', type: 'tq', repo: 'BSOJ/ar_tq', path: 'tq_OBA.tsv', file: 'tq_OBA.tsv' },
      { delivery: 'editor', type: 'report', file: 'translate-report-1-1.json' },
    ],
  });
  return outDirAbs;
}

test('output endpoint — 401 without auth', async (t) => {
  seedOutputCheckpoint();
  t.after(() => clearCheckpoint(OUT_CKPT_ID));
  const res = mockRes();
  await handleOutputRequest(req({}), res, OUT_JOB_ID, 'tq_OBA.tsv');
  assert.equal(res.statusCode, 401);
  assert.equal(jsonBody(res).error, 'unauthorized');
});

test('output endpoint — 200 with correct bytes + content type for a manifest file', async (t) => {
  seedOutputCheckpoint();
  t.after(() => clearCheckpoint(OUT_CKPT_ID));
  const res = mockRes();
  await handleOutputRequest(req(AUTH), res, OUT_JOB_ID, 'tq_OBA.tsv');
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'text/tab-separated-values; charset=utf-8');
  assert.equal(String(res.body), TSV_BYTES);
});

test('output endpoint — 404 for unknown jobId, file not in manifest, missing file, traversal', async (t) => {
  seedOutputCheckpoint();
  t.after(() => clearCheckpoint(OUT_CKPT_ID));

  // Unknown jobId.
  let res = mockRes();
  await handleOutputRequest(req(AUTH), res, 'nosuch__translate__OBA_1_1_na_na', 'tq_OBA.tsv');
  assert.equal(res.statusCode, 404);
  assert.equal(jsonBody(res).error, 'not_found');

  // File not in the manifest (traversal attempt included — allowlist blocks it).
  for (const file of ['other.tsv', '../checkpoint.json', '..\\checkpoint.json', '']) {
    res = mockRes();
    await handleOutputRequest(req(AUTH), res, OUT_JOB_ID, file);
    assert.equal(res.statusCode, 404, `file=${JSON.stringify(file)} should 404`);
  }

  // In the manifest but missing on disk (e.g. swept): report file was never written.
  res = mockRes();
  await handleOutputRequest(req(AUTH), res, OUT_JOB_ID, 'translate-report-1-1.json');
  assert.equal(res.statusCode, 404);
});

test('output endpoint — containment check rejects a poisoned manifest entry', async (t) => {
  const outDirAbs = seedOutputCheckpoint();
  // Poison the checkpoint with a manifest entry that escapes CSKILLBP_DIR.
  setCheckpoint(OUT_CKPT_ID, {
    outDir: path.relative(CSKILLBP_DIR, outDirAbs),
    output: [{ delivery: 'editor', type: 'tq', repo: 'x/y', path: 'e', file: '../../../../etc/hosts' }],
  });
  t.after(() => clearCheckpoint(OUT_CKPT_ID));
  const res = mockRes();
  await handleOutputRequest(req(AUTH), res, OUT_JOB_ID, '../../../../etc/hosts');
  assert.equal(res.statusCode, 404);
});

test('output endpoint — 404 when checkpoint is not done', async (t) => {
  seedOutputCheckpoint();
  setCheckpoint(OUT_CKPT_ID, { state: 'running' });
  t.after(() => clearCheckpoint(OUT_CKPT_ID));
  const res = mockRes();
  await handleOutputRequest(req(AUTH), res, OUT_JOB_ID, 'tq_OBA.tsv');
  assert.equal(res.statusCode, 404);
});

// ---------------------------------------------------------------------------
// Status serialization — output[] must pass through the checkpoint
// ---------------------------------------------------------------------------

test('status endpoint — serialized checkpoint includes the output manifest', async (t) => {
  seedOutputCheckpoint();
  t.after(() => clearCheckpoint(OUT_CKPT_ID));
  const res = mockRes();
  await handleStatusRequest(req(AUTH), res, OUT_JOB_ID);
  assert.equal(res.statusCode, 200);
  const body = jsonBody(res);
  assert.equal(body.state, 'done');
  assert.ok(Array.isArray(body.output), 'status must pass through cp.output');
  assert.equal(body.output.length, 2);
  assert.equal(body.output[0].delivery, 'editor');
  assert.equal(body.output[0].file, 'tq_OBA.tsv');
});

// ---------------------------------------------------------------------------
// runTsvDelivery — delivery 'editor'
// ---------------------------------------------------------------------------

function tsvParams(overrides = {}) {
  return {
    resourceType: 'tq',
    family: 'tsv',
    skill: 'tq-translator',
    pushType: 'tq',
    book: 'OBA',
    startChapter: 1,
    endChapter: 1,
    verseStart: null,
    verseEnd: null,
    rowIds: null,
    mergeMode: 'range',
    targetLang: 'ar',
    targetLangName: 'Arabic',
    sourceLang: 'en',
    sourceLangName: 'English',
    direction: 'rtl',
    targetOrg: 'BSOJ',
    repoName: 'ar_tq',
    sourceRef: 'unfoldingWord/en_tq@master',
    contextRef: 'BSOJ/translation-context@master',
    contextRefExplicit: false,
    writeContextBack: false, // skip context write-back (network) in tests
    jobId: null,
    model: 'opus',
    delivery: 'editor',
    branchOnly: true,
    ...overrides,
  };
}

const fakeReport = () => ({ checks: { warningCount: 0 }, runId: 'run-1' });

test('runTsvDelivery — editor delivery never pushes and records the manifest checkpoint', async (t) => {
  const params = tsvParams();
  const sessionKey = 'edtsv';
  const scope = { book: 'OBA', startChapter: 1, endChapter: 1, verseStart: null, verseEnd: null };
  const ckptId = { sessionKey, pipelineType: 'translate', scope };
  t.after(() => clearCheckpoint(ckptId));
  const workDir = path.join(CSKILLBP_DIR, 'tmp', 'translate-ar-OBA-1-1-deadbeef');

  const pushCalls = [];
  const posts = [];
  const result = await runTsvDelivery({
    params, ckptId, scope, workDir, runHash: 'deadbeef', label: 'OBA 1 TQ → Arabic',
    username: 'tester', post: async (msg) => { posts.push(msg); },
  }, {
    translateImpl: async () => ({
      sourceRows: [{ ID: 'ab12' }], targetRows: [{ ID: 'ab12' }],
      report: fakeReport(), bookText: TSV_BYTES, pack: { hasContent: false },
    }),
    pushImpl: async (...args) => { pushCalls.push(args); return { success: true }; },
  });

  assert.equal(pushCalls.length, 0, 'door43Push must NEVER be called for editor delivery');
  assert.equal(result.delivery, 'editor');

  // Files landed under out/.
  const outDir = path.join(workDir, 'out');
  assert.equal(fs.readFileSync(path.join(outDir, 'tq_OBA.tsv'), 'utf8'), TSV_BYTES);
  assert.ok(fs.existsSync(path.join(outDir, 'translate-report-1-1.json')));

  // Done checkpoint carries outDir + manifest.
  const cp = getCheckpoint(ckptId);
  assert.equal(cp.state, 'done');
  assert.equal(cp.current.status, 'done');
  assert.equal(path.normalize(cp.outDir), path.normalize(path.relative(CSKILLBP_DIR, outDir)));
  assert.deepEqual(cp.output, [
    { delivery: 'editor', type: 'tq', repo: 'BSOJ/ar_tq', path: 'tq_OBA.tsv', file: 'tq_OBA.tsv' },
    { delivery: 'editor', type: 'report', file: 'translate-report-1-1.json' },
  ]);

  // Zulip message announces editor delivery.
  assert.equal(posts.length, 1);
  assert.match(posts[0], /Delivered to bible-editor as drafts/);
});

test('runTsvDelivery — branch delivery still pushes; path delivery does not', async (t) => {
  for (const [delivery, expectedPushes] of [['branch', 1], ['path', 0]]) {
    const params = tsvParams({ delivery });
    const sessionKey = `edtsv-${delivery}`;
    const scope = { book: 'OBA', startChapter: 1, endChapter: 1, verseStart: null, verseEnd: null };
    const ckptId = { sessionKey, pipelineType: 'translate', scope };
    t.after(() => clearCheckpoint(ckptId));
    const workDir = path.join(CSKILLBP_DIR, 'tmp', `translate-ar-OBA-1-1-${delivery}0000`);

    const pushCalls = [];
    const result = await runTsvDelivery({
      params, ckptId, scope, workDir, runHash: 'feedf00d', label: 'OBA 1 TQ → Arabic',
      username: 'tester', post: async () => {},
    }, {
      translateImpl: async () => ({
        sourceRows: [], targetRows: [], report: fakeReport(), bookText: TSV_BYTES, pack: { hasContent: false },
      }),
      pushImpl: async () => { pushCalls.push(1); return { success: true, branchUrl: 'https://x/b' }; },
    });

    assert.equal(pushCalls.length, expectedPushes, `${delivery} push count`);
    assert.equal(result.delivery, delivery);
    // Book file is written unconditionally in every mode.
    assert.ok(fs.existsSync(path.join(workDir, 'out', 'tq_OBA.tsv')));
    // Non-editor deliveries must not record a manifest.
    const cp = getCheckpoint(ckptId);
    assert.equal(cp.state, 'done');
    assert.equal(cp.output, undefined);
    assert.equal(cp.outDir, undefined);
  }
});

// ---------------------------------------------------------------------------
// runArticleDelivery — delivery 'editor' with nested article paths
// ---------------------------------------------------------------------------

test('runArticleDelivery — editor delivery stages nested files, no push, manifest per file', async (t) => {
  const params = tsvParams({
    resourceType: 'tw', family: 'article', skill: 'tw-translator',
    book: null, articleId: 'kt/god', articleUrl: null,
    repoName: 'ar_tw', delivery: 'editor',
  });
  const sessionKey = 'edart';
  const scope = { book: 'TWX', startChapter: 1, endChapter: 1, verseStart: null, verseEnd: null };
  const ckptId = { sessionKey, pipelineType: 'translate', scope };
  t.after(() => clearCheckpoint(ckptId));
  const workDir = path.join(CSKILLBP_DIR, 'tmp', 'translate-ar-tw-a-kt_god-abcd1234');

  const pushCalls = [];
  const result = await runArticleDelivery({
    params, ckptId, scope, workDir, runHash: 'abcd1234', label: 'tw kt/god → Arabic',
    username: 'tester', post: async () => {},
  }, {
    translateImpl: async () => ({
      articleId: 'kt/god',
      files: [{ path: 'bible/kt/god.md', markdown: '# الله\n', checks: { ok: true, violations: [] } }],
      report: fakeReport(),
      pack: { hasContent: false },
    }),
    pushImpl: async () => { pushCalls.push(1); return { success: true }; },
  });

  assert.equal(pushCalls.length, 0, 'door43Push must NEVER be called for editor delivery');
  assert.equal(result.delivery, 'editor');

  const outDir = path.join(workDir, 'out');
  assert.equal(fs.readFileSync(path.join(outDir, 'bible', 'kt', 'god.md'), 'utf8'), '# الله\n');

  const cp = getCheckpoint(ckptId);
  assert.equal(cp.state, 'done');
  assert.equal(path.normalize(cp.outDir), path.normalize(path.relative(CSKILLBP_DIR, outDir)));
  assert.deepEqual(cp.output, [
    { delivery: 'editor', type: 'tw', repo: 'BSOJ/ar_tw', path: 'bible/kt/god.md', file: 'bible/kt/god.md' },
    { delivery: 'editor', type: 'report', file: 'translate-report-kt_god.json' },
  ]);

  // The nested manifest file round-trips through the output endpoint.
  const jobId = 'edart__translate__TWX_1_1_na_na';
  const res = mockRes();
  await handleOutputRequest(req(AUTH), res, jobId, 'bible/kt/god.md');
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'text/markdown; charset=utf-8');
  assert.equal(String(res.body), '# الله\n');
});
