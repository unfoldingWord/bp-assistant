'use strict';

// Unit tests for the deterministic tool-permission policy (decideToolPermission)
// registered as the SDK canUseTool callback. Context (#195/#235/#238/#242): the
// top-level allowedTools auto-approval does not extend to Task/Agent sub-agents,
// so their tool calls fell to the 'auto'-mode model classifier — which degrades
// under parallel fan-out load and then denies allowlisted tools
// nondeterministically, with a canned "STOP and wait" text agents obey. This
// policy replaces the classifier with a pure allowlist.

const test = require('node:test');
const assert = require('node:assert');

const {
  decideToolPermission,
  decideBashPermission,
  buildOptions,
  BASH_ALLOW_RULES,
  BASH_EXEC_PREFIXES,
  BASH_READONLY_CMDS,
  SUBAGENT_TOOL_ALLOWLIST,
  DEFAULT_BASH_TOOLS,
} = require('../src/claude-runner');

test('core file/orchestration tools are allowed', () => {
  for (const tool of ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Task', 'Agent', 'Skill', 'TaskOutput', 'WebFetch']) {
    const d = decideToolPermission(tool, { x: 1 });
    assert.equal(d.behavior, 'allow', `${tool} must be allowed`);
    assert.deepEqual(d.updatedInput, { x: 1 });
  }
});

test('every tool the pipeline grants (DEFAULT_BASH_TOOLS) is covered by the policy', () => {
  // If a tool is granted to the run but the policy denies it, sub-agents lose
  // it silently — keep the two lists in lockstep.
  for (const tool of DEFAULT_BASH_TOOLS) {
    const d = decideToolPermission(tool, tool === 'Bash' ? { command: 'ls output' } : {});
    assert.equal(d.behavior, 'allow', `${tool} is in DEFAULT_BASH_TOOLS but denied by policy`);
  }
});

test('workspace-tools MCP calls are allowed by prefix', () => {
  assert.equal(decideToolPermission('mcp__workspace-tools__create_aligned_usfm', {}).behavior, 'allow');
  assert.equal(decideToolPermission('mcp__workspace-tools__read_usfm_chapter', {}).behavior, 'allow');
});

test('unknown tools are denied with redirect guidance, never the "STOP and wait" text', () => {
  const d = decideToolPermission('mcp__some-other-server__thing', {});
  assert.equal(d.behavior, 'deny');
  assert.match(d.message, /allowed tool/i);
  assert.doesNotMatch(d.message, /STOP what you are doing|wait for the user/i);
});

test('Bash: CLI wrapper and blessed executables allowed', () => {
  assert.equal(decideBashPermission({ command: "node /app/src/workspace-tools-cli.js merge_aligned_usfm '{\"parts\":[]}'" }).behavior, 'allow');
  assert.equal(decideBashPermission({ command: 'node /app/src/door43-push-cli.js push' }).behavior, 'allow');
  assert.equal(decideBashPermission({ command: 'node .claude/skills/utilities/scripts/validate.mjs x' }).behavior, 'allow');
});

test('Bash: simple read-only commands allowed, prefix is word-bounded', () => {
  assert.equal(decideBashPermission({ command: 'ls output/AI-ULT/EZK' }).behavior, 'allow');
  assert.equal(decideBashPermission({ command: 'ls' }).behavior, 'allow');
  assert.equal(decideBashPermission({ command: 'grep -c zaln output/AI-ULT/EZK/EZK-16-aligned.usfm' }).behavior, 'allow');
  // "lsof" must not ride the "ls" prefix.
  assert.equal(decideBashPermission({ command: 'lsof -i :8080' }).behavior, 'deny');
});

test('Bash: compound commands and substitution are denied with guidance', () => {
  for (const command of [
    'ls output/AI-UST/hints/EZK-16.json 2>/dev/null && echo "HINTS EXIST" || echo "NO HINTS"',
    'cat a.json; rm -rf /',
    'ls `whoami`',
    'ls $(pwd)',
    'node /app/src/workspace-tools-cli.js x && rm -rf /',
  ]) {
    const d = decideBashPermission({ command });
    assert.equal(d.behavior, 'deny', `must deny: ${command}`);
    assert.match(d.message, /workspace-tools-cli|Read\/Glob\/Grep/);
    assert.doesNotMatch(d.message, /STOP what you are doing/i);
  }
});

test('Bash: pipes, redirection, and newline chaining are denied (#243 review finding)', () => {
  for (const command of [
    'ls output | xargs rm -rf output',
    'cat source.usfm > output/target.usfm',
    'grep -c zaln file.usfm >> log.txt',
    'grep pattern < input.txt',
    'ls output\nrm -rf output',
    'node /app/src/workspace-tools-cli.js x | tee /etc/passwd',
  ]) {
    assert.equal(decideBashPermission({ command }).behavior, 'deny', `must deny: ${command}`);
  }
});

test('Bash: the CLI wrapper heredoc stdin form is allowed, including shell chars in the JSON body', () => {
  const heredoc = "node /app/src/workspace-tools-cli.js merge_aligned_usfm - <<'EOF'\n" +
    '{"parts":["a>b","c|d && e"],"note":"contains `ticks` and $(subst) as literal text"}\n' +
    'EOF';
  assert.equal(decideBashPermission({ command: heredoc }).behavior, 'allow');
});

test('Bash: post-heredoc chaining is denied', () => {
  const sneaky = "node /app/src/workspace-tools-cli.js x - <<'EOF'\n{}\nEOF\nrm -rf output";
  assert.equal(decideBashPermission({ command: sneaky }).behavior, 'deny');
  // Heredoc on a read-only command is not a sanctioned form either.
  assert.equal(decideBashPermission({ command: "cat <<'EOF'\nhi\nEOF" }).behavior, 'deny');
});

test('Bash: uncovered verbs (mkdir, rm, curl) are denied', () => {
  for (const command of ['mkdir -p tmp/alignments/x', 'rm tmp/a.json', 'curl http://example.com']) {
    assert.equal(decideBashPermission({ command }).behavior, 'deny', `must deny: ${command}`);
  }
});

test('policy Bash prefixes stay in sync with BASH_ALLOW_RULES', () => {
  // Every Bash(<prefix>:*) rule the CLI auto-approves must also be approved by
  // the canUseTool policy (rules resolve first, but the policy is the fallback
  // authority for sub-agents — a mismatch would deny in children what the rules
  // allow at top level).
  const rulePrefixes = BASH_ALLOW_RULES
    .map((r) => /^Bash\((.*):\*\)$/.exec(r))
    .filter(Boolean)
    .map((m) => m[1]);
  for (const p of rulePrefixes) {
    const covered = BASH_EXEC_PREFIXES.some((e) => p.startsWith(e) || e.startsWith(p))
      || BASH_READONLY_CMDS.includes(p);
    assert.ok(covered, `BASH_ALLOW_RULES prefix "${p}" is not covered by the canUseTool policy`);
  }
});

test('SUBAGENT_TOOL_ALLOWLIST does not drift below the restricted tool profile', () => {
  for (const tool of DEFAULT_BASH_TOOLS.filter((t) => t !== 'Bash')) {
    assert.ok(SUBAGENT_TOOL_ALLOWLIST.has(tool), `${tool} missing from SUBAGENT_TOOL_ALLOWLIST`);
  }
});

// --- buildOptions permission strategy ---

test('bypassPermissions opts the run out of the auto-mode classifier but KEEPS the decider', () => {
  const o = buildOptions({ bypassPermissions: true });
  assert.equal(o.permissionMode, 'bypassPermissions');
  assert.equal(o.allowDangerouslySkipPermissions, true);
  // This assertion used to read `canUseTool === undefined` with the rationale
  // "bypass runs need no permission callback". That was the #271 defect stated as a
  // requirement: `permissionMode` is per-agent (SDK AgentDefinition.permissionMode),
  // so the bypass covers the top-level query only, and spawned Task/Agent children
  // fall back to the load-degraded 'auto' classifier that #243 was written to escape.
  // EZK 19 lost a whole chapter to it — the coordinator's own calls succeeded while
  // all 16 of its children's calls were denied. Both must be installed.
  assert.equal(typeof o.canUseTool, 'function', 'children do not inherit the bypass — keep the decider');
});

test('non-bypass runs stay on auto mode with the deterministic canUseTool fallback', () => {
  const o = buildOptions({});
  assert.equal(o.permissionMode, 'auto');
  assert.equal(o.allowDangerouslySkipPermissions, undefined);
  assert.equal(typeof o.canUseTool, 'function');
});

test('BP_NO_BYPASS kill switch reverts opted-in runs to auto mode', () => {
  process.env.BP_NO_BYPASS = '1';
  try {
    const o = buildOptions({ bypassPermissions: true });
    assert.equal(o.permissionMode, 'auto');
    assert.equal(o.allowDangerouslySkipPermissions, undefined);
    assert.equal(typeof o.canUseTool, 'function');
  } finally {
    delete process.env.BP_NO_BYPASS;
  }
});

test('the canUseTool fallback resolves like the policy (allow Read, deny compound Bash)', async () => {
  const o = buildOptions({});
  const allow = await o.canUseTool('Read', { file_path: '/data/workspace/x' });
  assert.equal(allow.behavior, 'allow');
  const deny = await o.canUseTool('Bash', { command: 'ls a && echo b' });
  assert.equal(deny.behavior, 'deny');
});
