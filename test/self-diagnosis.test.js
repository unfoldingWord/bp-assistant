'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RAW_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'self-diagnosis-raw-'));
process.env.SELF_DIAGNOSIS_RAW_DIR = RAW_DIR;

const {
  dispatchSelfDiagnosis,
  buildFingerprint,
  classifyRepo,
  extractDiagnosisJson,
  repairAgentJson,
  looksLikeDiagnosisAttempt,
  appendFingerprintMarker,
  FINGERPRINT_PREFIX,
} = require('../src/self-diagnosis');

// Parity tests against the source-of-truth fingerprint algorithm in
// bp-assistant-auto-issue-handler. The sibling repo is only required when
// developing both repos side-by-side; in CI / fresh checkouts it may not
// exist, so load it lazily and skip those tests rather than crashing the
// whole file.
let vendoredBuildFingerprint = null;
let vendoredClassifyRepo = null;
try {
  ({
    buildFingerprint: vendoredBuildFingerprint,
    classifyRepo: vendoredClassifyRepo,
  } = require('../../bp-assistant-auto-issue-handler/src/pipeline-failure-handler'));
} catch (err) {
  if (err && err.code !== 'MODULE_NOT_FOUND') throw err;
}
const VENDORED_AVAILABLE = vendoredBuildFingerprint !== null;

function makePsa1Event(overrides = {}) {
  return {
    timestamp: '2026-04-29T19:46:01.000Z',
    source: 'tqs-pipeline',
    pipelineType: 'tqs',
    scope: 'PSA 1',
    phase: 'status',
    severity: 'error',
    message: '**PSA 1** failed: expected output file missing: output/tq/PSA/PSA-001.tsv',
    ...overrides,
  };
}

function createGithubFetchStub({ existingByMarker = null, captureCalls = {} } = {}) {
  captureCalls.searchCount = 0;
  captureCalls.createCount = 0;
  captureCalls.lastCreateBody = null;
  return async (url, init = {}) => {
    const method = init.method || 'GET';
    if (typeof url === 'string' && url.includes('/search/issues')) {
      captureCalls.searchCount += 1;
      const q = decodeURIComponent(new URL(url).searchParams.get('q') || '');
      const matchesMarker = existingByMarker && q.includes(existingByMarker.marker);
      const items = matchesMarker ? [existingByMarker.issue] : [];
      return {
        ok: true,
        status: 200,
        async json() { return { items }; },
        async text() { return JSON.stringify({ items }); },
      };
    }
    if (method === 'POST' && /\/repos\/unfoldingWord\/[^/]+\/issues$/.test(url)) {
      captureCalls.createCount += 1;
      captureCalls.lastCreateBody = JSON.parse(init.body);
      const repo = url.match(/\/repos\/unfoldingWord\/([^/]+)\/issues$/)[1];
      const created = {
        number: 999,
        html_url: `https://github.com/unfoldingWord/${repo}/issues/999`,
        title: captureCalls.lastCreateBody.title,
        body: captureCalls.lastCreateBody.body,
      };
      return {
        ok: true,
        status: 201,
        async json() { return created; },
        async text() { return JSON.stringify(created); },
      };
    }
    return {
      ok: false,
      status: 404,
      async json() { return {}; },
      async text() { return ''; },
    };
  };
}

function makeRunClaudeStub(rawOutput) {
  return async () => ({
    subtype: 'success',
    result: rawOutput,
    usage: { input_tokens: 100, output_tokens: 200 },
  });
}

const VALID_AGENT_OUTPUT = `\`\`\`json
{
  "repo": "bp-assistant",
  "title": "Pipeline failure: tqs PSA 1 — missing output file",
  "body": "## Summary\\nThe TQS pipeline for PSA 1 failed because the writer reported success but the expected file was not produced.\\n\\n## Failure signal\\n` +
  `Scope PSA 1, phase status, message: expected output file missing.\\n\\n## Investigation\\nRead src/tqs-pipeline.js around line 220 — confirms the missing-output guard fires after runClaude returns success.\\n\\n` +
  `## Likely root cause\\nThe writer agent returned success without writing the output file.\\n\\n## Suggested fix\\nAdd a writer-side post-condition assertion or retry the writer with stricter prompting.",
  "labels": ["bug", "pipeline-failure"],
  "classification": "skills"
}
\`\`\``;

test('buildFingerprint matches the vendored auto-issue-handler implementation', { skip: !VENDORED_AVAILABLE }, () => {
  const event = makePsa1Event();
  assert.equal(buildFingerprint(event), vendoredBuildFingerprint(event));
});

test('classifyRepo matches the vendored auto-issue-handler implementation (default)', { skip: !VENDORED_AVAILABLE }, () => {
  const event = makePsa1Event();
  const ours = classifyRepo(event);
  const theirs = vendoredClassifyRepo(event);
  // Ours returns short repo name; theirs returns "org/name"
  assert.equal(`unfoldingWord/${ours}`, theirs);
});

test('classifyRepo routes tn-writer failures to bp-assistant-skills', () => {
  const event = makePsa1Event({ message: 'tn-writer failed for ROM 5: invalid TSV', pipelineType: 'notes' });
  assert.equal(classifyRepo(event), 'bp-assistant-skills');
});

test('extractDiagnosisJson parses fenced JSON from agent output', () => {
  const parsed = extractDiagnosisJson(VALID_AGENT_OUTPUT);
  assert.equal(parsed.repo, 'bp-assistant');
  assert.match(parsed.title, /Pipeline failure: tqs PSA 1/);
  assert.match(parsed.body, /## Summary/);
  assert.deepEqual(parsed.labels, ['bug', 'pipeline-failure']);
  assert.equal(parsed.classification, 'skills');
});

test('extractDiagnosisJson repairs unescaped newlines inside string values', () => {
  // Body has literal newlines instead of \n escapes — the most common mode
  // we've seen the diagnosis agent emit.
  const broken = `\`\`\`json
{
  "repo": "bp-assistant-skills",
  "title": "Pipeline failure: tqs PSA 6 — bad chapter padding",
  "body": "## Summary
A real newline is inside this string, which technically violates JSON.

## Failure signal
something broke",
  "labels": ["bug", "pipeline-failure"],
  "classification": "skills"
}
\`\`\``;
  const parsed = extractDiagnosisJson(broken);
  assert.equal(parsed.repo, 'bp-assistant-skills');
  assert.match(parsed.body, /## Summary/);
  assert.match(parsed.body, /## Failure signal/);
});

test('repairAgentJson fixes unescaped newlines in strings without touching whitespace between fields', () => {
  const broken = `{\n  "a": "line1\nline2",\n  "b": 3\n}`;
  const repaired = repairAgentJson(broken);
  const parsed = JSON.parse(repaired);
  assert.equal(parsed.a, 'line1\nline2');
  assert.equal(parsed.b, 3);
});

test('repairAgentJson strips trailing commas', () => {
  const broken = '{"a": 1, "b": [1, 2, 3,], }';
  assert.deepEqual(JSON.parse(repairAgentJson(broken)), { a: 1, b: [1, 2, 3] });
});

test('looksLikeDiagnosisAttempt distinguishes agent JSON from arbitrary text', () => {
  assert.equal(looksLikeDiagnosisAttempt('not even close to JSON'), false);
  assert.equal(looksLikeDiagnosisAttempt('{ "repo": "bp-assistant", "title": "x" }'), true);
  assert.equal(looksLikeDiagnosisAttempt('```json\n{\n  "title": "x"\n}\n```'), true);
  assert.equal(looksLikeDiagnosisAttempt(''), false);
  assert.equal(looksLikeDiagnosisAttempt(null), false);
});

test('extractDiagnosisJson rejects invalid repo', () => {
  const bad = `\`\`\`json
{ "repo": "evil-repo", "title": "x", "body": "y" }
\`\`\``;
  assert.throws(() => extractDiagnosisJson(bad), /invalid repo/);
});

test('appendFingerprintMarker appends an HTML comment marker', () => {
  const body = '## Summary\nSomething broke.';
  const result = appendFingerprintMarker(body, 'abc123');
  assert.match(result, /<!-- pipeline-failure-fingerprint: abc123 -->/);
});

test('dispatchSelfDiagnosis creates a GitHub issue with fingerprint marker on first call', async () => {
  const event = makePsa1Event();
  const calls = {};
  const fetchImpl = createGithubFetchStub({ captureCalls: calls });
  const adminStatusEvents = [];

  const result = await dispatchSelfDiagnosis({
    event,
    runClaudeImpl: makeRunClaudeStub(VALID_AGENT_OUTPUT),
    fetchImpl,
    readSecretImpl: () => 'fake-token',
    readAdminStatusImpl: () => [event],
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, 'created');
  assert.equal(calls.searchCount, 1);
  assert.equal(calls.createCount, 1);
  assert.match(calls.lastCreateBody.body, /pipeline-failure-fingerprint:/);
  assert.equal(calls.lastCreateBody.title.length <= 120, true);
});

test('dispatchSelfDiagnosis is idempotent — reuses existing issue with matching fingerprint', async () => {
  const event = makePsa1Event();
  const fingerprint = buildFingerprint(event);
  const marker = `${FINGERPRINT_PREFIX} ${fingerprint}`;
  const existing = {
    number: 7,
    html_url: 'https://github.com/unfoldingWord/bp-assistant/issues/7',
    title: 'Pipeline failure: tqs PSA 1',
    body: `body... <!-- ${marker} -->`,
  };
  const calls = {};
  const fetchImpl = createGithubFetchStub({
    existingByMarker: { marker, issue: existing },
    captureCalls: calls,
  });
  let claudeWasCalled = false;
  const runClaudeImpl = async () => {
    claudeWasCalled = true;
    return { subtype: 'success', result: VALID_AGENT_OUTPUT };
  };

  const result = await dispatchSelfDiagnosis({
    event,
    runClaudeImpl,
    fetchImpl,
    readSecretImpl: () => 'fake-token',
    readAdminStatusImpl: () => [event],
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, 'reused');
  assert.equal(calls.createCount, 0);
  assert.equal(claudeWasCalled, false, 'should not invoke the agent if the issue already exists');
});

test('dispatchSelfDiagnosis fails gracefully when github_token is missing', async () => {
  const event = makePsa1Event();
  const result = await dispatchSelfDiagnosis({
    event,
    runClaudeImpl: makeRunClaudeStub(VALID_AGENT_OUTPUT),
    fetchImpl: () => { throw new Error('should not be called'); },
    readSecretImpl: () => null,
    readAdminStatusImpl: () => [],
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /github_token/);
});

test('dispatchSelfDiagnosis fails gracefully when the agent returns garbage', async () => {
  const event = makePsa1Event();
  const calls = {};
  const fetchImpl = createGithubFetchStub({ captureCalls: calls });
  const result = await dispatchSelfDiagnosis({
    event,
    runClaudeImpl: makeRunClaudeStub('not even close to JSON'),
    fetchImpl,
    readSecretImpl: () => 'fake-token',
    readAdminStatusImpl: () => [],
  });
  assert.equal(result.ok, false);
  assert.equal(calls.createCount, 0);
});

test('dispatchSelfDiagnosis returns invalid-event for missing message', async () => {
  const result = await dispatchSelfDiagnosis({ event: { severity: 'error' } });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid-event');
});

test('dispatchSelfDiagnosis files a fallback issue when JSON parse fails on diagnosis-shaped output', async () => {
  // Truncated / unparseable but clearly a diagnosis attempt — mirrors the
  // PSA 6 failure mode we hit in production.
  const brokenRaw = `\`\`\`json
{
  "repo": "bp-assistant-skills",
  "title": "Pipeline failure: tqs PSA 6 — tq-writer uses 2-digit chapter padding instead of 3-digit",
  "body": "## Summary
A real newline that breaks JSON parsing.

## Failure signal
something happened`;
  const event = makePsa1Event();
  const calls = {};
  const fetchImpl = createGithubFetchStub({ captureCalls: calls });
  const result = await dispatchSelfDiagnosis({
    event,
    runClaudeImpl: makeRunClaudeStub(brokenRaw),
    fetchImpl,
    readSecretImpl: () => 'fake-token',
    readAdminStatusImpl: () => [event],
  });
  // It might either repair successfully OR fall back. Both are acceptable
  // outcomes — the contract is that an issue gets filed.
  assert.equal(result.ok, true);
  assert.equal(calls.createCount, 1);
  assert.match(calls.lastCreateBody.body, /pipeline-failure-fingerprint:/);
  if (result.action === 'created-fallback') {
    assert.match(calls.lastCreateBody.title, /diagnosis JSON parse failed/);
    assert.match(calls.lastCreateBody.body, /Raw diagnosis agent output/);
    assert.match(calls.lastCreateBody.body, /tq-writer uses 2-digit chapter padding/);
    assert.ok(
      calls.lastCreateBody.labels.includes('self-diagnosis-parse-failure'),
      'fallback issue should carry the self-diagnosis-parse-failure label',
    );
    // Raw output should also have been persisted to disk for inspection.
    const files = fs.readdirSync(RAW_DIR);
    assert.ok(files.length > 0, 'expected raw output to be persisted on parse failure');
  }
});

test('dispatchSelfDiagnosis files an issue when diagnosis subtype is non-success but text is diagnosis-shaped', async () => {
  const brokenRaw = `\`\`\`json
{
  "repo": "bp-assistant",
  "title": "Pipeline failure: tqs PSA 7 — writer used noncanonical chapter filename",
  "body": "## Summary
newline that breaks strict JSON parse.

## Failure signal
writer produced PSA-07.tsv"
}`;
  const event = makePsa1Event({ scope: 'PSA 7' });
  const calls = {};
  const fetchImpl = createGithubFetchStub({ captureCalls: calls });
  const runClaudeImpl = async () => ({
    subtype: 'error',
    result: brokenRaw,
    error: 'tool failure',
  });

  const result = await dispatchSelfDiagnosis({
    event,
    runClaudeImpl,
    fetchImpl,
    readSecretImpl: () => 'fake-token',
    readAdminStatusImpl: () => [event],
  });

  assert.equal(result.ok, true);
  assert.equal(calls.createCount, 1);
});

test('dispatchSelfDiagnosis fails with subtype details when diagnosis subtype is non-success and no usable text', async () => {
  const event = makePsa1Event({ scope: 'PSA 7' });
  const calls = {};
  const fetchImpl = createGithubFetchStub({ captureCalls: calls });
  const runClaudeImpl = async () => ({
    subtype: 'error',
    result: '',
    error: 'no result available',
  });

  const result = await dispatchSelfDiagnosis({
    event,
    runClaudeImpl,
    fetchImpl,
    readSecretImpl: () => 'fake-token',
    readAdminStatusImpl: () => [event],
  });

  assert.equal(result.ok, false);
  assert.equal(calls.createCount, 0);
  assert.match(result.reason, /subtype=error/);
});
