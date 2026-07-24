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
