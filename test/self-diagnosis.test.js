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
  buildContextSummary,
  buildGuardrailStopDiagnosis,
  buildAlignMissingOutputDiagnosis,
  isAlignMissingOutput,
  buildAlignTransportClosedDiagnosis,
  isAlignTransportClosed,
  buildAlignPermissionStallDiagnosis,
  isAlignPermissionStall,
  buildMultiAgentPermissionStallDiagnosis,
  isMultiAgentPermissionStall,
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

test('dispatchSelfDiagnosis files a templated incomplete-diagnosis issue when subtype is non-success and no usable text', async () => {
  const event = makePsa1Event({ scope: 'PSA 7' });
  const calls = {};
  const fetchImpl = createGithubFetchStub({ captureCalls: calls });
  const runClaudeImpl = async () => ({
    subtype: 'timeout',
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

  // The originating failure must NOT be dropped: an issue is filed even though
  // the agent produced no parseable output.
  assert.equal(result.ok, true);
  assert.equal(calls.createCount, 1);
  assert.ok(calls.lastCreateBody.labels.includes('self-diagnosis-incomplete'));
  assert.match(calls.lastCreateBody.title, /self-diagnosis incomplete \(timeout\)/);
  assert.match(calls.lastCreateBody.body, /subtype=`timeout`/);
  assert.match(calls.lastCreateBody.body, /pipeline-failure-fingerprint:/);
});

test('dispatchSelfDiagnosis short-circuits a guardrail-stop without invoking the agent', async () => {
  const event = makePsa1Event({
    pipelineType: 'notes',
    scope: 'ZEC 6',
    message: 'Chapter ZEC 6 failed at **tn-quality-check** after 3212.7s',
  });
  const calls = {};
  const fetchImpl = createGithubFetchStub({ captureCalls: calls });
  let claudeWasCalled = false;
  const runClaudeImpl = async () => { claudeWasCalled = true; return { subtype: 'success', result: VALID_AGENT_OUTPUT }; };

  const result = await dispatchSelfDiagnosis({
    event,
    errorText: 'Skill that failed: tn-quality-check\nGuardrail stop: repeated tool errors (string_not_found, consecutive=17, repeats=25)',
    checkpoint: { state: 'failed', skillOutputs: { '6': { 'tn-writer': 'output/notes/ZEC/ZEC-06.tsv' } } },
    runClaudeImpl,
    fetchImpl,
    readSecretImpl: () => 'fake-token',
    readAdminStatusImpl: () => [event],
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, 'created-guardrail');
  assert.equal(claudeWasCalled, false, 'a known guardrail stop must not invoke the diagnosis agent');
  assert.equal(calls.createCount, 1);
  assert.ok(calls.lastCreateBody.labels.includes('guardrail-stop'));
  assert.match(calls.lastCreateBody.body, /pipeline-failure-fingerprint:/);
});

test('buildContextSummary surfaces the absolute notes path so the agent does not hunt', () => {
  const event = makePsa1Event({ pipelineType: 'notes', scope: 'ZEC 6' });
  const checkpoint = { state: 'failed', skillOutputs: { '6': { 'tn-writer': 'output/notes/ZEC/ZEC-06.tsv' } } };
  const summary = buildContextSummary(event, [], checkpoint, 'err', '/data/workspace');
  assert.match(summary, /Working directory/);
  assert.match(summary, /CSKILLBP_DIR\): \/data\/workspace/);
  assert.match(summary, /\/data\/workspace\/output\/notes\/ZEC\/ZEC-06\.tsv/);
});

test('buildGuardrailStopDiagnosis returns a templated issue tagged guardrail-stop', () => {
  const event = makePsa1Event({ pipelineType: 'notes', scope: 'ZEC 6' });
  const d = buildGuardrailStopDiagnosis(event, 'some context');
  assert.ok(d.title.length <= 120);
  assert.ok(d.labels.includes('guardrail-stop'));
  assert.equal(d.classification, 'guardrail-stop');
  assert.match(d.body, /guardrail/i);
});

test('isAlignMissingOutput matches the align-all-parallel missing-output signature', () => {
  assert.equal(
    isAlignMissingOutput('**align-all-parallel** failed for AMO 5 at 2026-07-01T23:34:53.134Z — AMO 5 — ULT: no aligned output found || UST: no aligned output found'),
    true,
  );
  assert.equal(
    isAlignMissingOutput('AMO 5 — ULT: no aligned output found'),
    true,
    'align + no-aligned-output-found alone is enough — the failure message may omit the phase name',
  );
  // Guardrail stops still get their own template — no double-match.
  assert.equal(
    isAlignMissingOutput('Guardrail stop: repeated tool errors (string_not_found, consecutive=17)'),
    false,
  );
  // Unrelated failures don't match.
  assert.equal(
    isAlignMissingOutput('**PSA 1** failed: expected output file missing: output/tq/PSA/PSA-001.tsv'),
    false,
  );
  assert.equal(isAlignMissingOutput(''), false);
  assert.equal(isAlignMissingOutput(null), false);
  assert.equal(isAlignMissingOutput(undefined), false);
});

test('isAlignMissingOutput matches on checkpoint errorKind (missing_output + incomplete_coverage)', () => {
  // missing_output on the align phase — matches regardless of message text.
  assert.equal(
    isAlignMissingOutput('AMO 5 failed', { current: { skill: 'align-all-parallel', errorKind: 'missing_output' } }),
    true,
  );
  // incomplete_coverage (partial salvage) — message text lacks "no aligned output
  // found", so ONLY the errorKind path can catch it. This is the #179 follow-up gap.
  assert.equal(
    isAlignMissingOutput('AMO 5 — ULT: covers 13/27 verses, missing 1-14', { current: { skill: 'align-all-parallel', errorKind: 'incomplete_coverage' } }),
    true,
  );
  // missing_output is NOT align-exclusive: the notes/generate phase uses it too.
  // Must not short-circuit to the align template for a non-align phase.
  assert.equal(
    isAlignMissingOutput('PSA 1 — expected output file missing', { current: { skill: 'tn-writer', errorKind: 'missing_output' } }),
    false,
  );
  // A partial-coverage message with no checkpoint does NOT match (text fallback
  // only knows the "no aligned output found" phrase).
  assert.equal(
    isAlignMissingOutput('AMO 5 — ULT: covers 13/27 verses, missing 1-14'),
    false,
  );
});

test('buildAlignMissingOutputDiagnosis returns a templated issue tagged align-missing-output', () => {
  const event = makePsa1Event({
    pipelineType: 'generate',
    scope: 'AMO 5',
    phase: 'align',
    message: '**align-all-parallel** failed for AMO 5 — AMO 5 — ULT: no aligned output found || UST: no aligned output found',
  });
  const d = buildAlignMissingOutputDiagnosis(event, 'some context');
  assert.ok(d.title.length <= 120);
  assert.match(d.title, /align: no aligned output found/);
  assert.ok(d.labels.includes('align-missing-output'));
  assert.equal(d.classification, 'align-missing-output');
  assert.match(d.body, /salvageAlignedFromMappingJson/);
  assert.match(d.body, /tmp\/alignments/);
});

test('buildAlignMissingOutputDiagnosis reflects partial coverage for incomplete_coverage', () => {
  const event = makePsa1Event({
    pipelineType: 'generate',
    scope: 'AMO 5',
    phase: 'align',
    message: '**align-all-parallel** failed for AMO 5 — AMO 5 — ULT: covers 13/27 verses, missing 1-14',
  });
  const d = buildAlignMissingOutputDiagnosis(event, 'some context', 'incomplete_coverage');
  assert.match(d.title, /align: incomplete aligned output/);
  assert.match(d.body, /partial verse coverage/);
  assert.equal(d.classification, 'align-missing-output');
});

test('dispatchSelfDiagnosis short-circuits an align "no aligned output found" without invoking the agent', async () => {
  const event = makePsa1Event({
    pipelineType: 'generate',
    scope: 'AMO 5',
    phase: 'align',
    message: '**align-all-parallel** failed for AMO 5 at 2026-07-01T23:34:53.134Z — AMO 5 — ULT: no aligned output found || UST: no aligned output found',
  });
  const calls = {};
  const fetchImpl = createGithubFetchStub({ captureCalls: calls });
  let claudeWasCalled = false;
  const runClaudeImpl = async () => { claudeWasCalled = true; return { subtype: 'success', result: VALID_AGENT_OUTPUT }; };

  const result = await dispatchSelfDiagnosis({
    event,
    errorText: 'Phase: align-all-parallel\nChapter: AMO 5\nAMO 5 — ULT: no aligned output found || UST: no aligned output found',
    checkpoint: { state: 'failed', current: { skill: 'align-all-parallel', errorKind: 'missing_output' }, resume: { chapter: 5, skill: 'align-all-parallel' } },
    runClaudeImpl,
    fetchImpl,
    readSecretImpl: () => 'fake-token',
    readAdminStatusImpl: () => [event],
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, 'created-align-missing-output');
  assert.equal(claudeWasCalled, false, 'a known align missing-output stop must not invoke the diagnosis agent');
  assert.equal(calls.createCount, 1);
  assert.ok(calls.lastCreateBody.labels.includes('align-missing-output'));
  assert.match(calls.lastCreateBody.title, /align: no aligned output found/);
  assert.match(calls.lastCreateBody.body, /pipeline-failure-fingerprint:/);
});

test('isAlignTransportClosed matches the align-all-parallel MCP-transport-closed signature', () => {
  assert.equal(
    isAlignTransportClosed('**align-all-parallel** failed for JER 33 at 2026-07-02T19:31:00.000Z — JER 33 — align-all-parallel aborted: workspace-tools MCP transport closed (Stream closed) before aligned USFM was produced'),
    true,
  );
  assert.equal(
    isAlignTransportClosed('Phase: align-all-parallel\nChapter: JER 33\nStream closed'),
    true,
    'align phase + "Stream closed" is enough',
  );
  // Missing-output stops keep their own template — a "no aligned output found"
  // summary without a transport signal must NOT match this one.
  assert.equal(
    isAlignTransportClosed('AMO 5 — ULT: no aligned output found'),
    false,
  );
  // "Stream closed" outside an align context doesn't match (avoids stealing other
  // phases' diagnoses).
  assert.equal(
    isAlignTransportClosed('tn-writer failed: Stream closed'),
    false,
  );
  assert.equal(isAlignTransportClosed(''), false);
  assert.equal(isAlignTransportClosed(null), false);
  assert.equal(isAlignTransportClosed(undefined), false);
});

test('buildAlignTransportClosedDiagnosis returns a templated issue tagged align-transport-closed', () => {
  const event = makePsa1Event({
    pipelineType: 'generate',
    scope: 'JER 33',
    phase: 'align',
    message: '**align-all-parallel** failed for JER 33 — workspace-tools MCP transport closed (Stream closed)',
  });
  const d = buildAlignTransportClosedDiagnosis(event, 'some context');
  assert.ok(d.title.length <= 120);
  assert.match(d.title, /align: MCP transport closed/);
  assert.ok(d.labels.includes('align-transport-closed'));
  assert.equal(d.classification, 'align-transport-closed');
  assert.match(d.body, /salvageAlignedFromMappingJson/);
  assert.match(d.body, /Stream closed/);
});

test('dispatchSelfDiagnosis short-circuits an align "Stream closed" transport failure without invoking the agent', async () => {
  const event = makePsa1Event({
    pipelineType: 'generate',
    scope: 'JER 33',
    phase: 'align',
    message: '**align-all-parallel** failed for JER 33 at 2026-07-02T19:31:00.000Z — JER 33 — align-all-parallel aborted: workspace-tools MCP transport closed (Stream closed) before aligned USFM was produced',
  });
  const calls = {};
  const fetchImpl = createGithubFetchStub({ captureCalls: calls });
  let claudeWasCalled = false;
  const runClaudeImpl = async () => { claudeWasCalled = true; return { subtype: 'success', result: VALID_AGENT_OUTPUT }; };

  const result = await dispatchSelfDiagnosis({
    event,
    errorText: 'Phase: align-all-parallel\nChapter: JER 33\nworkspace-tools MCP transport closed (Stream closed)',
    checkpoint: { state: 'failed', current: { errorKind: 'mcp_transport_closed' }, resume: { chapter: 33, skill: 'align-all-parallel' } },
    runClaudeImpl,
    fetchImpl,
    readSecretImpl: () => 'fake-token',
    readAdminStatusImpl: () => [event],
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, 'created-align-transport-closed');
  assert.equal(claudeWasCalled, false, 'a known MCP-transport-closed stop must not invoke the diagnosis agent');
  assert.equal(calls.createCount, 1);
  assert.ok(calls.lastCreateBody.labels.includes('align-transport-closed'));
  assert.match(calls.lastCreateBody.title, /align: MCP transport closed/);
  assert.match(calls.lastCreateBody.body, /pipeline-failure-fingerprint:/);
});

test('isAlignPermissionStall matches the align-all-parallel permission-denial-stall signature', () => {
  // errorKind on an align-phase checkpoint is enough (message text may be absent).
  assert.equal(
    isAlignPermissionStall('', { current: { errorKind: 'permission_stall', skill: 'align-all-parallel' } }),
    true,
  );
  // Enriched summary text is enough on its own.
  assert.equal(
    isAlignPermissionStall('**align-all-parallel** failed for EZK 16 — EZK 16 — align-all-parallel aborted: sub-agent tool calls were auto-denied in headless mode (permission stall, "STOP what you are doing and wait")'),
    true,
  );
  assert.equal(
    isAlignPermissionStall("Phase: align-all-parallel\nChapter: EZK 16\nThe user doesn't want to take this action"),
    true,
  );
  // A missing-output summary without a permission signal must NOT match this one.
  assert.equal(isAlignPermissionStall('AMO 5 — ULT: no aligned output found'), false);
  // permission_stall errorKind on a NON-align skill must not be stolen by this one.
  assert.equal(
    isAlignPermissionStall('', { current: { errorKind: 'permission_stall', skill: 'tn-writer' } }),
    false,
  );
  // A permission signal outside an align context doesn't match.
  assert.equal(isAlignPermissionStall('tn-writer failed: STOP what you are doing and wait for the user'), false);
  assert.equal(isAlignPermissionStall(''), false);
  assert.equal(isAlignPermissionStall(null), false);
  assert.equal(isAlignPermissionStall(undefined), false);
});

test('buildAlignPermissionStallDiagnosis returns a templated issue tagged align-permission-stall', () => {
  const event = makePsa1Event({
    pipelineType: 'generate',
    scope: 'EZK 16',
    phase: 'align',
    message: '**align-all-parallel** failed for EZK 16 — permission stall (auto-denied, "STOP and wait")',
  });
  const d = buildAlignPermissionStallDiagnosis(event, 'some context');
  assert.ok(d.title.length <= 120);
  assert.match(d.title, /align: permission-denial stall/);
  assert.ok(d.labels.includes('align-permission-stall'));
  assert.equal(d.classification, 'align-permission-stall');
  assert.match(d.body, /allowed-tools/);
  assert.match(d.body, /workspace-tools-cli\.js/);
});

test('dispatchSelfDiagnosis short-circuits an align permission-denial stall without invoking the agent', async () => {
  const event = makePsa1Event({
    pipelineType: 'generate',
    scope: 'EZK 16',
    phase: 'align',
    message: '**align-all-parallel** failed for EZK 16 at 2026-07-21T12:00:00.000Z — EZK 16 — align-all-parallel aborted: sub-agent tool calls were auto-denied in headless mode (permission stall, "STOP what you are doing and wait")',
  });
  const calls = {};
  const fetchImpl = createGithubFetchStub({ captureCalls: calls });
  let claudeWasCalled = false;
  const runClaudeImpl = async () => { claudeWasCalled = true; return { subtype: 'success', result: VALID_AGENT_OUTPUT }; };

  const result = await dispatchSelfDiagnosis({
    event,
    errorText: 'Phase: align-all-parallel\nChapter: EZK 16\npermission stall (auto-denied)',
    checkpoint: { state: 'failed', current: { errorKind: 'permission_stall', skill: 'align-all-parallel' }, resume: { chapter: 16, skill: 'align-all-parallel' } },
    runClaudeImpl,
    fetchImpl,
    readSecretImpl: () => 'fake-token',
    readAdminStatusImpl: () => [event],
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, 'created-align-permission-stall');
  assert.equal(claudeWasCalled, false, 'a known permission-denial stall must not invoke the diagnosis agent');
  assert.equal(calls.createCount, 1);
  assert.ok(calls.lastCreateBody.labels.includes('align-permission-stall'));
  assert.match(calls.lastCreateBody.title, /align: permission-denial stall/);
  assert.match(calls.lastCreateBody.body, /pipeline-failure-fingerprint:/);
});

test('isMultiAgentPermissionStall matches a permission stall on the fan-out notes skills (#289)', () => {
  // errorKind + skill on the checkpoint is enough (message text may lack the skill name).
  assert.equal(
    isMultiAgentPermissionStall('', { current: { errorKind: 'permission_stall', skill: 'deep-issue-id' } }),
    true,
  );
  assert.equal(
    isMultiAgentPermissionStall('', { current: { errorKind: 'permission_stall', skill: 'tn-writer' } }),
    true,
  );
  assert.equal(
    isMultiAgentPermissionStall('', { current: { errorKind: 'permission_stall', skill: 'post-edit-review' } }),
    true,
  );
  // Enriched summary text alone is enough when it names both the signal and the skill.
  assert.equal(
    isMultiAgentPermissionStall('**deep-issue-id** failed for DAN 5: permission-denial stall — tool calls were auto-denied ("STOP what you are doing and wait")'),
    true,
  );
  // A permission signal with no fan-out skill named must NOT match.
  assert.equal(isMultiAgentPermissionStall('STOP what you are doing and wait for the user'), false);
  // A fan-out skill named with no permission signal must NOT match.
  assert.equal(isMultiAgentPermissionStall('deep-issue-id failed for DAN 5: expected output file missing'), false);
  // A non-fan-out skill permission stall stays with the LLM diagnosis agent.
  assert.equal(
    isMultiAgentPermissionStall('', { current: { errorKind: 'permission_stall', skill: 'chapter-intro' } }),
    false,
  );
  // A different errorKind on a fan-out skill must NOT match.
  assert.equal(
    isMultiAgentPermissionStall('', { current: { errorKind: 'missing_output', skill: 'deep-issue-id' } }),
    false,
  );
  assert.equal(isMultiAgentPermissionStall(''), false);
  assert.equal(isMultiAgentPermissionStall(null), false);
  assert.equal(isMultiAgentPermissionStall(undefined), false);
});

test('buildMultiAgentPermissionStallDiagnosis pins the repo to bp-assistant and names the skill (#289)', () => {
  const event = makePsa1Event({
    pipelineType: 'notes',
    scope: 'DAN 5',
    phase: 'status',
    // Deliberately names tn-writer: classifyRepo would route this to the skills repo,
    // but a permission stall is always app-side permission/bypass infrastructure.
    message: '**tn-writer** failed for DAN 5: permission-denial stall (auto-denied, "STOP and wait")',
  });
  const d = buildMultiAgentPermissionStallDiagnosis(event, 'some context', 'tn-writer');
  assert.ok(d.title.length <= 120);
  assert.match(d.title, /tn-writer: permission-denial stall/);
  assert.equal(d.repo, 'bp-assistant', 'permission stalls are app-side infra, never skills prose');
  assert.ok(d.labels.includes('multi-agent-permission-stall'));
  assert.equal(d.classification, 'multi-agent-permission-stall');
  assert.match(d.body, /BP_NO_BYPASS/);
  assert.match(d.body, /bypassAllowAllMatcher/);
});

test('dispatchSelfDiagnosis short-circuits a deep-issue-id permission stall without invoking the agent (#289)', async () => {
  // DAN 5, 2026-07-28: the notes pipeline routed to deep-issue-id, whose Wave-2
  // analysts were auto-denied. The diagnosis agent fans out too and would hit the
  // same wall, so this must be templated rather than investigated by an LLM.
  const event = makePsa1Event({
    pipelineType: 'notes',
    scope: 'DAN 5',
    phase: 'status',
    message: 'Chapter DAN 5 failed at **deep-issue-id** after 512.8s',
  });
  const calls = {};
  const fetchImpl = createGithubFetchStub({ captureCalls: calls });
  let claudeWasCalled = false;
  const runClaudeImpl = async () => { claudeWasCalled = true; return { subtype: 'success', result: VALID_AGENT_OUTPUT }; };

  const result = await dispatchSelfDiagnosis({
    event,
    errorText: '**deep-issue-id** failed for DAN 5: permission-denial stall — tool calls were auto-denied ("STOP what you are doing and wait") and nothing productive followed for the whole stall window. (512.1s)',
    checkpoint: { state: 'failed', current: { errorKind: 'permission_stall', skill: 'deep-issue-id' }, resume: { chapter: 5, skill: 'deep-issue-id' } },
    runClaudeImpl,
    fetchImpl,
    readSecretImpl: () => 'fake-token',
    readAdminStatusImpl: () => [event],
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, 'created-multi-agent-permission-stall');
  assert.equal(claudeWasCalled, false, 'a known permission-denial stall must not invoke the diagnosis agent');
  assert.equal(calls.createCount, 1);
  assert.ok(calls.lastCreateBody.labels.includes('multi-agent-permission-stall'));
  assert.match(calls.lastCreateBody.title, /deep-issue-id: permission-denial stall/);
  assert.match(calls.lastCreateBody.body, /pipeline-failure-fingerprint:/);
});

test('an align permission stall still wins over the multi-agent template (#289 keeps #235 intact)', async () => {
  // align-all-parallel is not in MULTI_AGENT_FANOUT_SKILLS and is checked first, so the
  // pre-existing align template must keep its dispatch precedence unchanged.
  const event = makePsa1Event({
    pipelineType: 'generate',
    scope: 'EZK 16',
    phase: 'align',
    message: '**align-all-parallel** failed for EZK 16 — permission stall (auto-denied, "STOP and wait")',
  });
  const calls = {};
  const fetchImpl = createGithubFetchStub({ captureCalls: calls });
  let claudeWasCalled = false;
  const runClaudeImpl = async () => { claudeWasCalled = true; return { subtype: 'success', result: VALID_AGENT_OUTPUT }; };

  const result = await dispatchSelfDiagnosis({
    event,
    errorText: 'Phase: align-all-parallel\nChapter: EZK 16\npermission stall (auto-denied)',
    checkpoint: { state: 'failed', current: { errorKind: 'permission_stall', skill: 'align-all-parallel' }, resume: { chapter: 16, skill: 'align-all-parallel' } },
    runClaudeImpl,
    fetchImpl,
    readSecretImpl: () => 'fake-token',
    readAdminStatusImpl: () => [event],
  });

  assert.equal(result.action, 'created-align-permission-stall');
  assert.equal(claudeWasCalled, false);
});

test('permission stall with PARTIAL salvage coverage still routes to the permission-stall template (#238)', async () => {
  // #238 regression shape: the align run permission-stalled, then salvage recovered
  // partial coverage, so the summary text is coverage-shaped ("covers N/M verses")
  // with no permission wording. The checkpoint errorKind must make the
  // permission-stall branch win over the generic align-missing-output one.
  const event = makePsa1Event({
    pipelineType: 'generate',
    scope: 'EZK 16',
    phase: 'align',
    message: '**align-all-parallel** failed for EZK 16 — EZK 16 — ULT: covers 24/63 verses, missing 4-6, 9-10 || UST: covers 2/63 verses, missing 2-8, 10-63',
  });
  const calls = {};
  const fetchImpl = createGithubFetchStub({ captureCalls: calls });
  let claudeWasCalled = false;
  const runClaudeImpl = async () => { claudeWasCalled = true; return { subtype: 'success', result: VALID_AGENT_OUTPUT }; };

  const result = await dispatchSelfDiagnosis({
    event,
    errorText: 'Phase: align-all-parallel\nChapter: EZK 16\nEZK 16 — ULT: covers 24/63 verses, missing 4-6, 9-10',
    checkpoint: { state: 'failed', current: { errorKind: 'permission_stall', skill: 'align-all-parallel', validationSummary: 'EZK 16 — ULT: covers 24/63 verses' }, resume: { chapter: 16, skill: 'align-all-parallel' } },
    runClaudeImpl,
    fetchImpl,
    readSecretImpl: () => 'fake-token',
    readAdminStatusImpl: () => [event],
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, 'created-align-permission-stall', 'permission_stall errorKind must beat the coverage-derived signature');
  assert.equal(claudeWasCalled, false);
  assert.match(calls.lastCreateBody.title, /align: permission-denial stall/);
});

test('dispatchSelfDiagnosis short-circuits a partial-salvage incomplete_coverage without invoking the agent', async () => {
  // Partial salvage: message text lacks "no aligned output found", so this can
  // only be caught via the checkpoint errorKind (the #179 follow-up gap).
  const event = makePsa1Event({
    pipelineType: 'generate',
    scope: 'AMO 5',
    phase: 'align',
    message: '**align-all-parallel** failed for AMO 5 — AMO 5 — ULT: covers 13/27 verses, missing 1-14',
  });
  const calls = {};
  const fetchImpl = createGithubFetchStub({ captureCalls: calls });
  let claudeWasCalled = false;
  const runClaudeImpl = async () => { claudeWasCalled = true; return { subtype: 'success', result: VALID_AGENT_OUTPUT }; };

  const result = await dispatchSelfDiagnosis({
    event,
    errorText: 'Phase: align-all-parallel\nChapter: AMO 5\nAMO 5 — ULT: covers 13/27 verses, missing 1-14',
    checkpoint: { state: 'failed', current: { skill: 'align-all-parallel', errorKind: 'incomplete_coverage' }, resume: { chapter: 5, skill: 'align-all-parallel' } },
    runClaudeImpl,
    fetchImpl,
    readSecretImpl: () => 'fake-token',
    readAdminStatusImpl: () => [event],
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, 'created-align-missing-output');
  assert.equal(claudeWasCalled, false, 'partial-salvage incomplete_coverage must not invoke the diagnosis agent');
  assert.match(calls.lastCreateBody.title, /align: incomplete aligned output/);
});
