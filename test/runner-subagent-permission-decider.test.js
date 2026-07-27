'use strict';

// Regression guard for issue #271 (EZK 19, 2026-07-24): the deterministic sub-agent
// permission decider must be installed even when a run opts into bypassPermissions.
//
// #243 added `decideToolPermission` as the SDK `canUseTool` callback specifically
// because the auto-mode model classifier mass-denies allowlisted tools under an opus
// fan-out (#195/#235/#238/#242). But it registered the decider in the `else` of the
// bypassPermissions branch, making the two mutually exclusive — so pipeline align
// runs, which pass bypassPermissions:true and are exactly the fan-out that provokes
// the classifier, ran with NEITHER protection.
//
// `permissionMode` is per-agent (SDK AgentDefinition.permissionMode), so setting it on
// the top-level query does not reach spawned Task/Agent children. EZK 19 shows the
// split precisely: the align coordinator's own calls succeeded for 19s, then 6.3s
// after the second sub-agent spawn the CHILDREN's calls began being denied with the
// CLI's canned "STOP and wait" text — 16 in a row — and the chapter banked nothing.
// Every one of those calls is an `allow` under decideToolPermission.

const test = require('node:test');
const assert = require('node:assert');

const { buildOptions, decideToolPermission } = require('../src/claude-runner');

// The exact tool calls EZK 19 had denied, read off the durable run log
// (/data/run-logs/2026-07-24/193612-p8jsp2-EZK-19-align-all-parallel.jsonl).
const EZK_19_DENIED_CALLS = [
  ['Read', { file_path: '/data/workspace/output/AI-UST/EZK/EZK-19.usfm' }],
  ['Read', { file_path: '/data/workspace/output/AI-UST/hints/EZK-19.json' }],
  ['Read', { file_path: '/data/workspace/output/AI-ULT/EZK/EZK-19.usfm' }],
  ['Glob', { pattern: 'output/AI-ULT/EZK/*.usfm' }],
  ['TaskOutput', { task_id: 'a211a52033469691a', block: true, timeout: 300000 }],
  ['Agent', { description: 'Align EZK 19 ULT', subagent_type: 'general-purpose' }],
  ['mcp__workspace-tools__read_usfm_chapter', { file: 'data/hebrew_bible/26-EZK.usfm', chapter: 19 }],
  ['Bash', { command: "node /app/src/workspace-tools-cli.js read_usfm_chapter '{\"file\":\"data/hebrew_bible/26-EZK.usfm\",\"chapter\":19}'" }],
  ['Bash', { command: "node /app/src/workspace-tools-cli.js read_usfm_chapter '{\"file\":\"output/AI-ULT/EZK/EZK-19.usfm\",\"chapter\":19}'" }],
];

test('every call EZK 19 had denied is allowed by the deterministic decider', () => {
  for (const [tool, input] of EZK_19_DENIED_CALLS) {
    const decision = decideToolPermission(tool, input);
    assert.equal(
      decision.behavior,
      'allow',
      `${tool} ${JSON.stringify(input).slice(0, 70)} should be allowed, got ${decision.behavior}: ${decision.message || ''}`
    );
  }
});

test('canUseTool is registered even when bypassPermissions is set (#271)', () => {
  const options = buildOptions({ cwd: '/data/workspace', bypassPermissions: true, enableBash: true });
  assert.equal(options.permissionMode, 'bypassPermissions', 'parent should still bypass for speed');
  assert.equal(options.allowDangerouslySkipPermissions, true);
  assert.equal(
    typeof options.canUseTool,
    'function',
    'a callback must ALSO be installed — permissionMode does not reach spawned children'
  );
});

// The regression guard that matters most. The first attempt at #271 handed bypass runs
// the RESTRICTIVE decideToolPermission allowlist. Replaying the 50 distinct Bash
// commands from EZK 19's SUCCESSFUL initial-pipeline run through it denies 45 —
// mkdir -p, awk, sed, cp, python3, for/until polling loops, pipes, && — every one of
// which is legitimate today and works precisely because bypass runs carry no decider.
// That would have broken initial-pipeline far worse than the align bug being fixed.
// A bypass run's goal is not to restrict anything; it is to guarantee nothing is
// spuriously DENIED. So its callback must allow unconditionally.
test('bypass runs allow-all — they must NOT inherit the restrictive Bash allowlist (#271)', async () => {
  const options = buildOptions({ cwd: '/data/workspace', bypassPermissions: true, enableBash: true });
  const REAL_INITIAL_PIPELINE_COMMANDS = [
    'mkdir -p tmp/pipeline-EZK-19 output/AI-ULT/EZK && echo "dirs created"',
    "awk '/^\\\\c 19$/{f=1} /^\\\\c 20$/{f=0} f' data/hebrew_bible/26-EZK.usfm",
    'cp output/issues/EZK/EZK-19.tsv tmp/pipeline-EZK-19/merged_issues.tsv',
    'i=0; until [ -s tmp/pipeline-EZK-19/wave3_challenges.tsv ] || [ $i -ge 30 ]; do sleep 10; i=$((i+1)); done',
    'python3 -c "import json; json.load(open(\'output/AI-UST/hints/EZK/EZK-19.json\'))"',
    "cd /data/workspace; sed -n '95,135p' .claude/skills/issue-identification/figs-metonymy.md",
    'ls output/issues/*/ 2>/dev/null | head',
  ];
  for (const command of REAL_INITIAL_PIPELINE_COMMANDS) {
    const decision = await options.canUseTool('Bash', { command });
    assert.equal(
      decision.behavior,
      'allow',
      `bypass runs must not refuse a command that works today: ${command.slice(0, 60)}`
    );
  }
  // Non-Bash tools too — nothing is restricted on a run that declared itself trusted.
  assert.equal((await options.canUseTool('Write', { file_path: '/data/workspace/x' })).behavior, 'allow');
});

test('canUseTool is still registered on non-bypass runs', () => {
  const options = buildOptions({ cwd: '/data/workspace', bypassPermissions: false });
  assert.notEqual(options.permissionMode, 'bypassPermissions');
  assert.equal(typeof options.canUseTool, 'function');
});

test('the BP_NO_BYPASS kill switch drops the bypass but keeps the decider', () => {
  const prev = process.env.BP_NO_BYPASS;
  process.env.BP_NO_BYPASS = '1';
  try {
    const options = buildOptions({ cwd: '/data/workspace', bypassPermissions: true });
    assert.notEqual(options.permissionMode, 'bypassPermissions', 'kill switch must revert the bypass');
    assert.equal(typeof options.canUseTool, 'function', 'the decider must survive the kill switch');
  } finally {
    if (prev === undefined) delete process.env.BP_NO_BYPASS;
    else process.env.BP_NO_BYPASS = prev;
  }
});

test('non-bypass runs route through the restrictive decideToolPermission', async () => {
  const options = buildOptions({ cwd: '/data/workspace', bypassPermissions: false, enableBash: true });
  // Allowed: a wholesale-granted tool.
  const allowed = await options.canUseTool('Read', { file_path: '/data/workspace/output/AI-ULT/EZK/EZK-19.usfm' });
  assert.equal(allowed.behavior, 'allow');
  // Denied: raw shell outside the allow-list. The message must redirect rather than
  // carry the CLI's canned "STOP and wait" text, which is what halts sub-agents.
  const denied = await options.canUseTool('Bash', { command: 'mkdir -p /data/workspace/tmp/x && ls' });
  assert.equal(denied.behavior, 'deny');
  assert.doesNotMatch(denied.message, /STOP what you are doing and wait/i);
  assert.match(denied.message, /workspace-tools CLI wrapper|continue with the task/i);
});

// 2026-07-27 (ZEC 12): the #271 fix above became a no-op. The SDK now shadows
// `canUseTool` on bypassPermissions runs and says so on every query —
// "[CLAUDE_SDK_CAN_USE_TOOL_SHADOWED] ... To gate every tool call, use a PreToolUse
// hook instead." ZEC 12 then reproduced EZK 19 exactly: the align coordinator's own
// calls succeeded 20:29:39-20:29:56, then the two children's Bash and Read were denied
// with the canned "STOP and wait" text at 20:29:59/20:30:00 and the wall fired. So the
// allow-all must ride a PreToolUse hook, which does run for children.
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

test('bypass runs install a PreToolUse allow-all hook (canUseTool is shadowed)', async () => {
  const options = buildOptions({ cwd: '/data/workspace', bypassPermissions: true, enableBash: true });
  const outputs = await runPreToolUse(options, {
    tool_name: 'Read',
    tool_input: { file_path: '/data/workspace/output/AI-UST/ZEC/ZEC-12.usfm' },
  });
  const decisions = outputs
    .map((o) => o && o.hookSpecificOutput && o.hookSpecificOutput.permissionDecision)
    .filter(Boolean);
  assert.deepEqual(decisions, ['allow'], 'exactly one hook must decide, and it must allow');
});

test('the bypass allow-all hook covers every tool the wall denied', async () => {
  const options = buildOptions({ cwd: '/data/workspace', bypassPermissions: true, enableBash: true });
  for (const [tool, input] of EZK_19_DENIED_CALLS) {
    const outputs = await runPreToolUse(options, { tool_name: tool, tool_input: input });
    const allowed = outputs.some(
      (o) => o && o.hookSpecificOutput && o.hookSpecificOutput.permissionDecision === 'allow'
    );
    assert.ok(allowed, `${tool} must be allowed by the PreToolUse hook`);
  }
});

// The allow-all must not swallow the model-resolver's input rewrite: the resolver is
// ordered first and returns `updatedInput`, the allow-all returns only a decision.
test('the allow-all hook composes with the model-resolver rewrite', async () => {
  const prev = process.env.BP_SUBAGENT_SPAWN_INTERVAL_MS;
  process.env.BP_SUBAGENT_SPAWN_INTERVAL_MS = '0';
  try {
    const options = buildOptions({ cwd: '/data/workspace', bypassPermissions: true });
    const outputs = await runPreToolUse(options, {
      tool_name: 'Agent',
      tool_input: { description: 'ULT alignment ZEC 12', model: 'high' },
    });
    const rewrite = outputs.find((o) => o && o.hookSpecificOutput && o.hookSpecificOutput.updatedInput);
    assert.ok(rewrite, 'the model resolver must still emit its updatedInput');
    assert.notEqual(rewrite.hookSpecificOutput.updatedInput.model, 'high', 'tier should resolve to a model');
    const allowed = outputs.some(
      (o) => o && o.hookSpecificOutput && o.hookSpecificOutput.permissionDecision === 'allow'
    );
    assert.ok(allowed, 'the allow-all must still decide on the same call');
  } finally {
    if (prev === undefined) delete process.env.BP_SUBAGENT_SPAWN_INTERVAL_MS;
    else process.env.BP_SUBAGENT_SPAWN_INTERVAL_MS = prev;
  }
});

test('non-bypass runs get NO allow-all hook — the restrictive decider still bounds them', async () => {
  const options = buildOptions({ cwd: '/data/workspace', bypassPermissions: false, enableBash: true });
  const outputs = await runPreToolUse(options, { tool_name: 'Bash', tool_input: { command: 'rm -rf /' } });
  const decided = outputs.some(
    (o) => o && o.hookSpecificOutput && o.hookSpecificOutput.permissionDecision
  );
  assert.equal(decided, false, 'a non-bypass run must not carry a blanket allow');
});

test('BP_NO_BYPASS=1 also drops the allow-all hook', async () => {
  const prev = process.env.BP_NO_BYPASS;
  process.env.BP_NO_BYPASS = '1';
  try {
    const options = buildOptions({ cwd: '/data/workspace', bypassPermissions: true, enableBash: true });
    const outputs = await runPreToolUse(options, { tool_name: 'Read', tool_input: { file_path: '/data/workspace/x' } });
    const decided = outputs.some(
      (o) => o && o.hookSpecificOutput && o.hookSpecificOutput.permissionDecision
    );
    assert.equal(decided, false, 'the kill switch must revert to classifier-mediated auto');
  } finally {
    if (prev === undefined) delete process.env.BP_NO_BYPASS;
    else process.env.BP_NO_BYPASS = prev;
  }
});
