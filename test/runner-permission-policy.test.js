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
  injectSubagentDenialFallback,
  SUBAGENT_DENIAL_FALLBACK_MARKER,
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

test('bypassPermissions opts the run out of the auto-mode classifier', () => {
  const o = buildOptions({ bypassPermissions: true });
  assert.equal(o.permissionMode, 'bypassPermissions');
  assert.equal(o.allowDangerouslySkipPermissions, true);
  assert.equal(o.canUseTool, undefined, 'bypass runs need no permission callback');
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

// --- Sub-agent denial-fallback injection (issue #249) ---

test('injectSubagentDenialFallback prepends the STOP-and-wait fallback instruction', () => {
  const original = 'Align verses 1-14 of NUM 34.';
  const injected = injectSubagentDenialFallback(original);
  assert.ok(injected.includes(SUBAGENT_DENIAL_FALLBACK_MARKER), 'marker present');
  assert.ok(injected.includes('DO NOT stop'), 'tells sub-agent not to stop');
  assert.ok(injected.includes('mcp__workspace-tools__'), 'names workspace-tools MCP fallback');
  assert.ok(injected.includes('workspace-tools-cli.js'), 'names CLI wrapper fallback');
  assert.ok(injected.endsWith(original), 'original prompt is preserved at the end');
});

test('injectSubagentDenialFallback is idempotent (does not re-inject when marker present)', () => {
  const original = 'Align verses 15-29 of NUM 34.';
  const once = injectSubagentDenialFallback(original);
  const twice = injectSubagentDenialFallback(once);
  assert.equal(once, twice, 'second injection is a no-op');
  const markerCount = twice.split(SUBAGENT_DENIAL_FALLBACK_MARKER).length - 1;
  assert.equal(markerCount, 1, 'exactly one marker after double-inject');
});

test('injectSubagentDenialFallback handles empty / non-string prompts safely', () => {
  const emptyInjected = injectSubagentDenialFallback('');
  assert.ok(emptyInjected.includes(SUBAGENT_DENIAL_FALLBACK_MARKER));
  const nullInjected = injectSubagentDenialFallback(null);
  assert.ok(nullInjected.includes(SUBAGENT_DENIAL_FALLBACK_MARKER));
});

test('buildOptions wires a PreToolUse hook that injects the denial-fallback into Task spawns', async () => {
  const o = buildOptions({});
  const matcher = o.hooks.PreToolUse[o.hooks.PreToolUse.length - 1];
  const hook = matcher.hooks[0];
  const out = await hook({ tool_name: 'Task', tool_input: { prompt: 'do the thing', model: 'sonnet' } });
  assert.ok(out.hookSpecificOutput, 'hook returns an update');
  assert.ok(
    out.hookSpecificOutput.updatedInput.prompt.includes(SUBAGENT_DENIAL_FALLBACK_MARKER),
    'sub-agent prompt is prefixed with the denial-fallback marker'
  );
  assert.ok(
    out.hookSpecificOutput.updatedInput.prompt.endsWith('do the thing'),
    'original prompt content is preserved'
  );
});

test('buildOptions PreToolUse hook is a no-op for non-Task tool calls', async () => {
  const o = buildOptions({});
  const matcher = o.hooks.PreToolUse[o.hooks.PreToolUse.length - 1];
  const hook = matcher.hooks[0];
  const out = await hook({ tool_name: 'Read', tool_input: { file_path: '/x' } });
  assert.deepEqual(out, {}, 'no update for non-Task/Agent tool calls');
});

test('buildOptions PreToolUse hook skips injection when kill-switch is set', async () => {
  process.env.BP_DISABLE_SUBAGENT_DENIAL_FALLBACK = '1';
  try {
    const o = buildOptions({});
    const matcher = o.hooks.PreToolUse[o.hooks.PreToolUse.length - 1];
    const hook = matcher.hooks[0];
    // prompt is present but must NOT be mutated when the kill-switch is on.
    // (Model resolution can still fire if a difficulty tier was used.)
    const out = await hook({ tool_name: 'Task', tool_input: { prompt: 'do the thing' } });
    assert.deepEqual(out, {}, 'kill switch prevents denial-fallback injection');
  } finally {
    delete process.env.BP_DISABLE_SUBAGENT_DENIAL_FALLBACK;
  }
});

test('buildOptions PreToolUse hook does not double-inject on nested Task spawns', async () => {
  const o = buildOptions({});
  const matcher = o.hooks.PreToolUse[o.hooks.PreToolUse.length - 1];
  const hook = matcher.hooks[0];
  const alreadyInjected = injectSubagentDenialFallback('nested work');
  const out = await hook({ tool_name: 'Task', tool_input: { prompt: alreadyInjected } });
  assert.deepEqual(out, {}, 'already-injected prompts are left alone');
});
