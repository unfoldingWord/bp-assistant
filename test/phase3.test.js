const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createGuardHooks, decidePreToolUse, isProtectedPath, extractPathFromToolInput, isWriteTool,
} = require('../src/guard-hooks');
const { resolveAutoModel } = require('../src/api-runner/provider-config');
const { renderIndex, hashDecisions, buildQuickRefCache } = require('../src/quickref-cache');
const { buildOptions } = require('../src/claude-runner');

// --- guard-hooks -------------------------------------------------------------
test('isProtectedPath matches the canonical files (suffix/basename/SKILL.md regex), not the writable decision CSVs', () => {
  assert.ok(isProtectedPath('data/issues_resolved.txt'));
  assert.ok(isProtectedPath('/abs/skills/data/issues_resolved.txt'));
  assert.ok(isProtectedPath('data/glossary/hebrew_ot_glossary.csv'));
  assert.ok(isProtectedPath('.claude/skills/ULT-gen/SKILL.md'));
  assert.equal(isProtectedPath('data/quick-ref/ult_decisions.csv'), false);
  assert.equal(isProtectedPath('data/glossary/project_glossary.md'), false);
  assert.equal(isProtectedPath(null), false);
});

test('extractPathFromToolInput pulls the path across common tool input shapes', () => {
  assert.equal(extractPathFromToolInput('Write', { file_path: 'a.txt' }), 'a.txt');
  assert.equal(extractPathFromToolInput('Edit', { path: 'b.txt' }), 'b.txt');
  assert.equal(extractPathFromToolInput('NotebookEdit', { notebook_path: 'n.ipynb' }), 'n.ipynb');
  assert.equal(extractPathFromToolInput('Read', {}), null);
});

test('isWriteTool recognizes core editors and MCP write/append tools', () => {
  assert.ok(isWriteTool('Write'));
  assert.ok(isWriteTool('Edit'));
  assert.ok(isWriteTool('mcp__workspace-tools__append_quickref'));
  assert.equal(isWriteTool('Read'), false);
  assert.equal(isWriteTool('mcp__workspace-tools__prepare_compare'), false);
});

test('decidePreToolUse: allowlist, blocklist, and protected-write denial', () => {
  // allowlist: deny anything not listed
  const allowPolicy = { allowedTools: new Set(['Read', 'Grep']) };
  assert.equal(decidePreToolUse({ tool_name: 'Read' }, allowPolicy), require('../src/guard-hooks').decidePreToolUse({ tool_name: 'Read' }, allowPolicy)); // ALLOW sentinel is stable
  assert.equal(decidePreToolUse({ tool_name: 'Read' }, allowPolicy).hookSpecificOutput, undefined);
  const denied = decidePreToolUse({ tool_name: 'Bash' }, allowPolicy);
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  // blocklist
  const blockPolicy = { blockedTools: new Set(['Bash']) };
  assert.equal(decidePreToolUse({ tool_name: 'Bash' }, blockPolicy).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(decidePreToolUse({ tool_name: 'Read' }, blockPolicy).hookSpecificOutput, undefined);
  // protected write
  const w = decidePreToolUse({ tool_name: 'Write', tool_input: { file_path: 'data/issues_resolved.txt' } }, {});
  assert.equal(w.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(w.hookSpecificOutput.permissionDecisionReason, /protected canonical/);
  // writable decision CSV is allowed
  assert.equal(decidePreToolUse({ tool_name: 'Write', tool_input: { file_path: 'data/quick-ref/ult_decisions.csv' } }, {}).hookSpecificOutput, undefined);
});

test('decidePreToolUse blocks MCP writes to protected files (via write-fields) but never blocks reads', () => {
  // MCP write tool targeting a protected file via an `output` field -> deny
  assert.equal(
    decidePreToolUse({ tool_name: 'mcp__workspace-tools__assemble_notes', tool_input: { output: 'data/issues_resolved.txt' } }, {}).hookSpecificOutput.permissionDecision,
    'deny',
  );
  // MCP tool READING a protected file via `input` -> allowed (reads must work)
  assert.equal(
    decidePreToolUse({ tool_name: 'mcp__workspace-tools__some_reader', tool_input: { input: 'data/issues_resolved.txt' } }, {}).hookSpecificOutput,
    undefined,
  );
  // core Read of a protected glossary -> allowed
  assert.equal(
    decidePreToolUse({ tool_name: 'Read', tool_input: { file_path: 'data/glossary/hebrew_ot_glossary.csv' } }, {}).hookSpecificOutput,
    undefined,
  );
});

test('createGuardHooks returns a PreToolUse hook whose callback denies a protected write', async () => {
  const hooks = createGuardHooks({ publish: false });
  assert.ok(Array.isArray(hooks.PreToolUse));
  const cb = hooks.PreToolUse[0].hooks[0];
  const out = await cb({ tool_name: 'Write', tool_input: { file_path: 'data/glossary/hebrew_ot_glossary.csv' } });
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  const ok = await cb({ tool_name: 'Read', tool_input: { file_path: 'x' } });
  assert.equal(ok.hookSpecificOutput, undefined);
  // observeFailures defaults off → no PostToolUseFailure hook
  assert.equal(hooks.PostToolUseFailure, undefined);
  assert.ok(createGuardHooks({ publish: false, observeFailures: true }).PostToolUseFailure);
});

// --- model routing -----------------------------------------------------------
test('resolveAutoModel maps Claude effort tiers to the right model family and honors explicit model', () => {
  // Assert family (robust to the exact deployed version: /config may pin a
  // different Opus/Sonnet/Haiku point release than the repo defaults).
  assert.match(resolveAutoModel('claude', null, 'high'), /opus/);
  assert.match(resolveAutoModel('claude', null, 'xhigh'), /opus/);
  assert.match(resolveAutoModel('claude', null, 'max'), /opus/);
  assert.match(resolveAutoModel('claude', null, 'medium'), /sonnet/);
  assert.match(resolveAutoModel('claude', null, 'low'), /haiku/);
  assert.match(resolveAutoModel('claude', null, 'none'), /haiku/);
  // unset effort -> medium default -> Sonnet
  assert.match(resolveAutoModel('claude', null, undefined), /sonnet/);
  // explicit model/alias always wins: 'opus' with low effort must NOT route to Haiku.
  assert.match(resolveAutoModel('claude', 'opus', 'low'), /opus/);
  // full model id passes through verbatim
  assert.equal(resolveAutoModel('claude', 'claude-sonnet-4-6', 'high'), 'claude-sonnet-4-6');
  // null-safe for a provider without an autoModelByThinking map -> defaultModel
  assert.ok(resolveAutoModel('openai', null, 'high'));
});

// --- memory pilot ------------------------------------------------------------
const SAMPLE = [
  { type: 'quick-ref', resource: 'ult', strong: 'H727', hebrew: 'x', rendering: 'Box', book: 'ALL', context: 'ark', notes: 'cap' },
  { type: 'glossary', resource: 'project_glossary', strong: 'H4869', hebrew: 'y', rendering: 'stronghold', book: 'ALL', context: '', notes: '' },
];

test('hashDecisions is stable and content-sensitive', () => {
  assert.equal(hashDecisions(SAMPLE), hashDecisions([...SAMPLE].reverse()));
  const changed = [{ ...SAMPLE[0], rendering: 'Chest' }, SAMPLE[1]];
  assert.notEqual(hashDecisions(SAMPLE), hashDecisions(changed));
});

test('renderIndex emits the DERIVED header and groups by resource', () => {
  const md = renderIndex(SAMPLE);
  assert.match(md, /DERIVED — do not edit/);
  assert.match(md, /## ult/);
  assert.match(md, /## project_glossary/);
  assert.match(md, /H727[^\n]*→ "Box"/);
});

test('buildQuickRefCache builds then skips when unchanged (content-hash keyed)', () => {
  const store = {};
  const deps = {
    loadHumanDecisions: () => SAMPLE,
    writeFileSync: (p, c) => { store[p] = c; },
    readFileSync: (p) => { if (p in store) return store[p]; throw new Error('enoent'); },
    existsSync: (p) => p in store,
    mkdirSync: () => {},
  };
  const first = buildQuickRefCache({ skillsRoot: '/skills', outDir: '/out', deps });
  assert.equal(first.built, true);
  assert.equal(first.entries, 2);
  const second = buildQuickRefCache({ skillsRoot: '/skills', outDir: '/out', deps });
  assert.equal(second.built, false);
  assert.equal(second.reason, 'unchanged');
});

// --- buildOptions threading (behavior preservation) --------------------------
test('buildOptions threads hooks + compaction additively and is a no-op when unset', () => {
  const SENTINEL = { PreToolUse: [] };
  assert.equal(buildOptions({ model: 'opus', hooks: SENTINEL }).hooks, SENTINEL);
  const withCompact = buildOptions({ model: 'opus', compaction: { enabled: true, window: 5 } });
  assert.equal(withCompact.settings.autoCompactEnabled, true);
  assert.equal(withCompact.settings.autoCompactWindow, 5);
  // unset -> no hooks key, no compaction settings (byte-identical to today)
  const plain = buildOptions({ model: 'opus' });
  assert.equal('hooks' in plain, false);
  assert.equal(plain.settings, undefined);
  // compaction spread-merges with the sandbox settings, not clobbers them
  const both = buildOptions({ model: 'opus', forceNoAutoBashSandbox: true, compaction: { enabled: true } });
  assert.equal(both.settings.sandbox.enabled, true);
  assert.equal(both.settings.autoCompactEnabled, true);
});
