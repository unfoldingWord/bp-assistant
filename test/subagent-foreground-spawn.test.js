'use strict';

// subagent-foreground-spawn.test.js
//
// The align "permission wall" (JER 48, 2026-09-04 — issue #373). 64
// align-all-parallel runs over 30 days, no exception: every run whose Agent
// spawns came back "Async agent launched successfully" (CLI 2.1.250 launches
// async when `run_in_background` is omitted) had its coordinator end its turn
// seconds later and was then denied session-wide from ~35s on — children and the
// coordinator's re-wake turn alike, PreToolUse hooks never consulted — and every
// run whose spawns carried `run_in_background: false` ran its 8–20 minutes with
// zero denials. The spawn hook in buildOptions forces the flag to false when the
// call site opts in (`foregroundSubagents`, set by the align runs); it is the
// only choke point before a spawn (skill prose is ignored). It stays off for
// skills whose coordinator supervises background agents by design.

const test = require('node:test');
const assert = require('node:assert');

const { buildOptions } = require('../src/claude-runner');

// The spawn hook is the last PreToolUse matcher buildOptions installs on a
// non-bypass run (bypass runs append the allow-all matcher after it).
function spawnHook(options) {
  const matchers = options.hooks.PreToolUse;
  return matchers[matchers.length - 1].hooks[0];
}

function withEnv(name, value, fn) {
  const prev = process.env[name];
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
  return Promise.resolve().then(fn).finally(() => {
    if (prev === undefined) delete process.env[name]; else process.env[name] = prev;
  });
}

test('JER 48: an Agent spawn with run_in_background omitted is forced to the foreground', async () => {
  await withEnv('BP_ALLOW_BACKGROUND_SUBAGENTS', undefined, async () => {
    const hook = spawnHook(buildOptions({ foregroundSubagents: true }));
    const out = await hook({ tool_name: 'Agent', tool_input: { description: 'ULT align JER 48 v1-16', subagent_type: 'general-purpose', prompt: 'Read the file ...' } });
    assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(out.hookSpecificOutput.updatedInput.run_in_background, false);
    // Everything else on the spawn survives untouched.
    assert.equal(out.hookSpecificOutput.updatedInput.subagent_type, 'general-purpose');
    assert.equal(out.hookSpecificOutput.updatedInput.prompt, 'Read the file ...');
  });
});

test('an explicit run_in_background: true is overridden to false', async () => {
  await withEnv('BP_ALLOW_BACKGROUND_SUBAGENTS', undefined, async () => {
    const hook = spawnHook(buildOptions({ foregroundSubagents: true }));
    const out = await hook({ tool_name: 'Task', tool_input: { prompt: 'batch', run_in_background: true } });
    assert.equal(out.hookSpecificOutput.updatedInput.run_in_background, false);
  });
});

test('a spawn that already says run_in_background: false is left alone', async () => {
  await withEnv('BP_ALLOW_BACKGROUND_SUBAGENTS', undefined, async () => {
    const hook = spawnHook(buildOptions({ foregroundSubagents: true }));
    const out = await hook({ tool_name: 'Agent', tool_input: { prompt: 'batch', run_in_background: false } });
    assert.deepEqual(out, {});
  });
});

test('the foreground rewrite composes with the difficulty->model rewrite in one updatedInput', async () => {
  await withEnv('BP_ALLOW_BACKGROUND_SUBAGENTS', undefined, async () => {
    const hook = spawnHook(buildOptions({ foregroundSubagents: true }));
    const out = await hook({ tool_name: 'Agent', tool_input: { prompt: 'batch', model: 'medium' } });
    const u = out.hookSpecificOutput.updatedInput;
    assert.equal(u.run_in_background, false);
    assert.notEqual(u.model, 'medium', 'the difficulty tier is still resolved to a concrete model');
  });
});

// initial-pipeline spawns ult-gen / analysts / challenger / ust-gen as background
// agents minutes apart and keeps its coordinator polling TaskList and trading
// SendMessage with them; the same day's run did exactly that with 5 background
// spawns and zero denials over 53 minutes. Forcing those synchronous would block
// the coordinator on a child that is waiting to hear from it, so the rewrite is
// opt-in per call site and OFF by default.
test('with foregroundSubagents unset (initial-pipeline and every other skill), spawns are left as written', async () => {
  // Two spawns through one hook: disable the 8s spawn pacing so the test stays fast.
  await withEnv('BP_SUBAGENT_SPAWN_INTERVAL_MS', '0', () => withEnv('BP_ALLOW_BACKGROUND_SUBAGENTS', undefined, async () => {
    const hook = spawnHook(buildOptions({}));
    const out = await hook({ tool_name: 'Agent', tool_input: { prompt: 'Generate ULT for JER 48', run_in_background: true, subagent_type: 'general-purpose' } });
    assert.deepEqual(out, {});
    const omitted = await hook({ tool_name: 'Agent', tool_input: { prompt: 'Structure analyst JER 48', subagent_type: 'issue-identification' } });
    assert.deepEqual(omitted, {});
  }));
});

test('BP_ALLOW_BACKGROUND_SUBAGENTS=1 restores the old behavior (kill switch)', async () => {
  await withEnv('BP_ALLOW_BACKGROUND_SUBAGENTS', '1', async () => {
    const hook = spawnHook(buildOptions({ foregroundSubagents: true }));
    const out = await hook({ tool_name: 'Agent', tool_input: { prompt: 'batch', run_in_background: true } });
    assert.deepEqual(out, {});
  });
});

test('non-spawn tools are untouched', async () => {
  const hook = spawnHook(buildOptions({ foregroundSubagents: true }));
  assert.deepEqual(await hook({ tool_name: 'Bash', tool_input: { command: 'ls', run_in_background: true } }), {});
});
