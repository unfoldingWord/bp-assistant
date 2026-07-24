// subagent-spawn-pacing.test.js
//
// Guards the minimum gap between sub-agent spawns. Every observed align lockout
// began within seconds of the SECOND spawn, and only when the two spawns were
// close together (2.4-3.0s on the three AMO 8 failures; initial-pipeline's
// healthy fan-out was 8s apart with zero denials). The gap is enforced in the
// PreToolUse hook because skill prose is not a control surface here — the model
// already ignores align-all-parallel's frontmatter `Task` in favour of `Agent`.

const test = require('node:test');
const assert = require('node:assert');

const { buildOptions } = require('../src/claude-runner');

// The spawn hook is the last PreToolUse matcher buildOptions installs.
function spawnHook(options) {
  const matchers = options.hooks.PreToolUse;
  return matchers[matchers.length - 1].hooks[0];
}

test('the first spawn is not delayed', async () => {
  const o = buildOptions({});
  const hook = spawnHook(o);
  const started = Date.now();
  await hook({ tool_name: 'Agent', tool_input: { prompt: 'align ULT', description: 'first' } });
  assert.ok(Date.now() - started < 200, 'no gap enforced before the first spawn');
});

test('a second spawn inside the window is held until the gap elapses', async () => {
  const prev = process.env.BP_SUBAGENT_SPAWN_INTERVAL_MS;
  process.env.BP_SUBAGENT_SPAWN_INTERVAL_MS = '300';
  try {
    const o = buildOptions({});
    const hook = spawnHook(o);
    await hook({ tool_name: 'Agent', tool_input: { prompt: 'align ULT' } });
    const started = Date.now();
    await hook({ tool_name: 'Agent', tool_input: { prompt: 'align UST' } });
    const waited = Date.now() - started;
    assert.ok(waited >= 250, `second spawn held (waited ${waited}ms, expected >= ~300ms)`);
  } finally {
    if (prev === undefined) delete process.env.BP_SUBAGENT_SPAWN_INTERVAL_MS;
    else process.env.BP_SUBAGENT_SPAWN_INTERVAL_MS = prev;
  }
});

test('pacing applies to Task as well as Agent', async () => {
  const prev = process.env.BP_SUBAGENT_SPAWN_INTERVAL_MS;
  process.env.BP_SUBAGENT_SPAWN_INTERVAL_MS = '300';
  try {
    const o = buildOptions({});
    const hook = spawnHook(o);
    await hook({ tool_name: 'Task', tool_input: { prompt: 'batch 1' } });
    const started = Date.now();
    await hook({ tool_name: 'Task', tool_input: { prompt: 'batch 2' } });
    assert.ok(Date.now() - started >= 250, 'Task spawns are paced too');
  } finally {
    if (prev === undefined) delete process.env.BP_SUBAGENT_SPAWN_INTERVAL_MS;
    else process.env.BP_SUBAGENT_SPAWN_INTERVAL_MS = prev;
  }
});

test('pacing is per-query — a separate run does not inherit the last spawn time', async () => {
  const prev = process.env.BP_SUBAGENT_SPAWN_INTERVAL_MS;
  process.env.BP_SUBAGENT_SPAWN_INTERVAL_MS = '300';
  try {
    const a = spawnHook(buildOptions({}));
    await a({ tool_name: 'Agent', tool_input: { prompt: 'run A spawn' } });
    // A concurrent pipeline must not be delayed by another pipeline's spawn.
    const b = spawnHook(buildOptions({}));
    const started = Date.now();
    await b({ tool_name: 'Agent', tool_input: { prompt: 'run B spawn' } });
    assert.ok(Date.now() - started < 200, 'a different query starts ungated');
  } finally {
    if (prev === undefined) delete process.env.BP_SUBAGENT_SPAWN_INTERVAL_MS;
    else process.env.BP_SUBAGENT_SPAWN_INTERVAL_MS = prev;
  }
});

test('non-spawn tool calls are never delayed', async () => {
  const prev = process.env.BP_SUBAGENT_SPAWN_INTERVAL_MS;
  process.env.BP_SUBAGENT_SPAWN_INTERVAL_MS = '300';
  try {
    const hook = spawnHook(buildOptions({}));
    await hook({ tool_name: 'Agent', tool_input: { prompt: 'spawn' } });
    const started = Date.now();
    await hook({ tool_name: 'Read', tool_input: { file_path: '/x' } });
    await hook({ tool_name: 'Bash', tool_input: { command: 'ls' } });
    assert.ok(Date.now() - started < 200, 'ordinary tool calls bypass the gate');
  } finally {
    if (prev === undefined) delete process.env.BP_SUBAGENT_SPAWN_INTERVAL_MS;
    else process.env.BP_SUBAGENT_SPAWN_INTERVAL_MS = prev;
  }
});

test('BP_SUBAGENT_SPAWN_INTERVAL_MS=0 disables pacing', async () => {
  const prev = process.env.BP_SUBAGENT_SPAWN_INTERVAL_MS;
  process.env.BP_SUBAGENT_SPAWN_INTERVAL_MS = '0';
  try {
    const hook = spawnHook(buildOptions({}));
    await hook({ tool_name: 'Agent', tool_input: { prompt: 'a' } });
    const started = Date.now();
    await hook({ tool_name: 'Agent', tool_input: { prompt: 'b' } });
    assert.ok(Date.now() - started < 200, 'kill switch removes the delay');
  } finally {
    if (prev === undefined) delete process.env.BP_SUBAGENT_SPAWN_INTERVAL_MS;
    else process.env.BP_SUBAGENT_SPAWN_INTERVAL_MS = prev;
  }
});

test('pacing still runs when the spawn needs no model or effort rewrite', async () => {
  // Regression guard: the model-resolver half of this hook returns early when
  // tool_input has no string `model`. Pacing must happen before that return, or
  // the exact spawns that caused the lockout (no model rewrite needed) go unpaced.
  const prev = process.env.BP_SUBAGENT_SPAWN_INTERVAL_MS;
  process.env.BP_SUBAGENT_SPAWN_INTERVAL_MS = '300';
  try {
    const hook = spawnHook(buildOptions({}));
    await hook({ tool_name: 'Agent', tool_input: { prompt: 'no model field' } });
    const started = Date.now();
    await hook({ tool_name: 'Agent', tool_input: { prompt: 'also no model field' } });
    assert.ok(Date.now() - started >= 250, 'paced despite the early return path');
  } finally {
    if (prev === undefined) delete process.env.BP_SUBAGENT_SPAWN_INTERVAL_MS;
    else process.env.BP_SUBAGENT_SPAWN_INTERVAL_MS = prev;
  }
});
