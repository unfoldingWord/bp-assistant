'use strict';

// Unit tests for issue #293 — logging agent_id/agent_type on permission denials.
//
// Six incidents in a row (#235, #238, #268, #271, #287, #289) ended in a
// hypothesis instead of a diagnosis because nothing recorded WHICH agent in the
// session tree (main thread vs a spawned sub-agent) a denial belonged to. The
// SDK's BaseHookInput carries `agent_id`/`agent_type` (present only for
// sub-agent calls, sdk.d.ts:174) alongside `tool_use_id` on PreToolUseHookInput
// (sdk.d.ts:2229-2233) — the SAME hook invocation buildOptions' bypass
// allow-all hook already receives for every tool call in a bypass run. These
// tests cover: capturing that identity at the hook, the run-level fired/with-
// agent-id counters, and classifying a denial's reason text well enough to
// tell our own guard hooks apart from the CLI's canned external refusal.
//
// This is observability only — no test here exercises or asserts a permission
// DECISION change; `buildOptions`'s existing decision tests already cover that
// and are untouched.

const test = require('node:test');
const assert = require('node:assert');

const {
  buildOptions,
  classifyRunnerUserMessage,
  describeDenialAgent,
} = require('../src/claude-runner');

function preToolUseHooks(options) {
  return (options.hooks && options.hooks.PreToolUse) || [];
}

async function runPreToolUse(options, input) {
  const outputs = [];
  for (const matcher of preToolUseHooks(options)) {
    for (const hook of matcher.hooks) outputs.push(await hook(input));
  }
  return outputs;
}

function freshAttribution() {
  return {
    byToolUseId: new Map(),
    lastByToolName: new Map(),
    hookFireCount: 0,
    hookFireWithAgentCount: 0,
    hookRegistered: false,
  };
}

// --- capture at the hook -----------------------------------------------------

test('the bypass allow-all hook captures agent_id/agent_type when present (sub-agent call)', async () => {
  const agentAttribution = freshAttribution();
  const options = buildOptions({ cwd: '/data/workspace', bypassPermissions: true, agentAttribution });
  await runPreToolUse(options, {
    tool_name: 'Read',
    tool_input: { file_path: '/data/workspace/x' },
    tool_use_id: 'toolu_child_1',
    agent_id: 'agent-abc123',
    agent_type: 'general-purpose',
  });
  assert.equal(agentAttribution.hookFireCount, 1);
  assert.equal(agentAttribution.hookFireWithAgentCount, 1);
  const entry = agentAttribution.byToolUseId.get('toolu_child_1');
  assert.deepEqual(entry, { agentId: 'agent-abc123', agentType: 'general-purpose' });
});

test('the hook records a clean absence for a main-thread call — no agent_id, no agent_type', async () => {
  const agentAttribution = freshAttribution();
  const options = buildOptions({ cwd: '/data/workspace', bypassPermissions: true, agentAttribution });
  await runPreToolUse(options, {
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
    tool_use_id: 'toolu_parent_1',
    // No agent_id/agent_type — per sdk.d.ts:174 these are absent for the main
    // thread, even in a bypass/agent session.
  });
  assert.equal(agentAttribution.hookFireCount, 1);
  assert.equal(agentAttribution.hookFireWithAgentCount, 0, 'a main-thread call must not count as an agent firing');
  const entry = agentAttribution.byToolUseId.get('toolu_parent_1');
  assert.deepEqual(entry, { agentId: null, agentType: null }, 'still captured — just with nulls, not omitted');
});

test('the hook still returns the same allow decision — capture is purely additive', async () => {
  const agentAttribution = freshAttribution();
  const options = buildOptions({ cwd: '/data/workspace', bypassPermissions: true, agentAttribution });
  const outputs = await runPreToolUse(options, {
    tool_name: 'Grep', tool_input: {}, tool_use_id: 'toolu_x', agent_id: 'agent-1', agent_type: 'general-purpose',
  });
  const allowed = outputs.some((o) => o && o.hookSpecificOutput && o.hookSpecificOutput.permissionDecision === 'allow');
  assert.ok(allowed);
});

test('buildOptions works with no agentAttribution passed at all (runClaudeStream call shape)', async () => {
  const options = buildOptions({ cwd: '/data/workspace', bypassPermissions: true });
  const outputs = await runPreToolUse(options, { tool_name: 'Read', tool_input: {}, tool_use_id: 'toolu_x' });
  const allowed = outputs.some((o) => o && o.hookSpecificOutput && o.hookSpecificOutput.permissionDecision === 'allow');
  assert.ok(allowed, 'hook must not throw or change behavior without the bag');
});

test('a non-bypass run never registers the hook, so agentAttribution.hookRegistered stays false', () => {
  const agentAttribution = freshAttribution();
  buildOptions({ cwd: '/data/workspace', bypassPermissions: false, agentAttribution });
  assert.equal(agentAttribution.hookRegistered, false);
});

test('a bypass run sets agentAttribution.hookRegistered so the caller can log the summary', () => {
  const agentAttribution = freshAttribution();
  buildOptions({ cwd: '/data/workspace', bypassPermissions: true, agentAttribution });
  assert.equal(agentAttribution.hookRegistered, true);
});

test('BP_NO_BYPASS kill switch also reports hookRegistered=false', () => {
  const prev = process.env.BP_NO_BYPASS;
  process.env.BP_NO_BYPASS = '1';
  try {
    const agentAttribution = freshAttribution();
    buildOptions({ cwd: '/data/workspace', bypassPermissions: true, agentAttribution });
    assert.equal(agentAttribution.hookRegistered, false);
  } finally {
    if (prev === undefined) delete process.env.BP_NO_BYPASS;
    else process.env.BP_NO_BYPASS = prev;
  }
});

// --- denial reason-text classification --------------------------------------

const externalDenialText = (toolUseId) =>
  '{"type":"tool_result","content":"The user doesn\'t want to take this action right now. ' +
  'STOP what you are doing and wait for the user to tell you how to proceed.",' +
  `"is_error":true,"tool_use_id":"${toolUseId}"}`;

const guardHookDenialText = (reason, toolUseId) =>
  `{"type":"tool_result","content":"${reason}","is_error":true,"tool_use_id":"${toolUseId}"}`;

test('classifyRunnerUserMessage tags the CLI canned auto-deny as external_classifier', () => {
  const sig = classifyRunnerUserMessage(externalDenialText('toolu_1'));
  assert.equal(sig.isPermissionDenied, true);
  assert.equal(sig.denialSource, 'external_classifier');
});

test('classifyRunnerUserMessage tags our own guard-hook reason strings as guard_hook', () => {
  // Exact reason strings guard-hooks.js:99/102/108 builds its denials from.
  const reasons = [
    "tool 'Bash' is not permitted in this run",
    "tool 'Bash' is not on the allowlist for this run",
    'write to protected canonical file is not allowed: data/issues_resolved.txt',
  ];
  for (const reason of reasons) {
    const sig = classifyRunnerUserMessage(guardHookDenialText(reason, 'toolu_2'));
    assert.equal(sig.denialSource, 'guard_hook', `expected guard_hook for: ${reason}`);
    // Critically: a guard-hook reason must NOT also read as the external classifier's
    // canned text, or the two sources would be indistinguishable — the exact ambiguity
    // #289 flagged as unresolved.
    assert.equal(sig.isPermissionDenied, false, 'guard-hook reason text is not the canned phrase');
  }
});

test('an ordinary (non-denial) tool_result has no denialSource', () => {
  const sig = classifyRunnerUserMessage('{"type":"tool_result","content":"ok, read 20 lines"}');
  assert.equal(sig.denialSource, null);
});

test('a plain tool_use_error (not a denial) has no denialSource', () => {
  const sig = classifyRunnerUserMessage(
    '{"type":"tool_result","is_error":true,"content":"tool_use_error: String to replace not found"}'
  );
  assert.equal(sig.denialSource, null);
});

// --- describeDenialAgent formatting ------------------------------------------

test('describeDenialAgent reports "unattributed" when no hook data exists at all', () => {
  assert.match(describeDenialAgent({ agentAttributionKind: null }), /unattributed/);
  assert.match(describeDenialAgent(null), /unattributed/);
});

test('describeDenialAgent reports "main thread" for an exact match with no agent_id', () => {
  const desc = describeDenialAgent({ agentAttributionKind: 'exact', agentId: null, agentType: null });
  assert.match(desc, /main thread/);
  assert.match(desc, /\[exact\]/);
});

test('describeDenialAgent names the sub-agent type/id for an exact match with an agent_id', () => {
  const desc = describeDenialAgent({ agentAttributionKind: 'exact', agentId: 'agent-42', agentType: 'general-purpose' });
  assert.match(desc, /sub-agent general-purpose\/agent-42/);
  assert.match(desc, /\[exact\]/);
});

test('describeDenialAgent labels a heuristic fallback distinctly from an exact match', () => {
  const desc = describeDenialAgent({
    agentAttributionKind: 'heuristic_last_seen_for_tool', agentId: 'agent-9', agentType: 'general-purpose',
  });
  assert.match(desc, /\[heuristic_last_seen_for_tool\]/);
  assert.doesNotMatch(desc, /\[exact\]/);
});
