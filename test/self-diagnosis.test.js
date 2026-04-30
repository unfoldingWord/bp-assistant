'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  dispatchSelfDiagnosis,
  buildFingerprint,
  classifyRepo,
  extractDiagnosisJson,
  appendFingerprintMarker,
  FINGERPRINT_PREFIX,
} = require('../src/self-diagnosis');

const {
  buildFingerprint: vendoredBuildFingerprint,
  classifyRepo: vendoredClassifyRepo,
} = require('../../bp-assistant-auto-issue-handler/src/pipeline-failure-handler');

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

test('buildFingerprint matches the vendored auto-issue-handler implementation', () => {
  const event = makePsa1Event();
  assert.equal(buildFingerprint(event), vendoredBuildFingerprint(event));
});

test('classifyRepo matches the vendored auto-issue-handler implementation (default)', () => {
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
