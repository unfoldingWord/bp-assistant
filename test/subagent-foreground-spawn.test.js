'use strict';

// subagent-foreground-spawn.test.js
//
// Background sub-agents are the "permission wall" (JER 48, 2026-09-04 — issue
// #373). 64 align-all-parallel runs over 30 days, no exception: every run whose
// Agent spawns came back "Async agent launched successfully" was denied
// session-wide from ~35s on (children and the coordinator's re-wake turn alike,
// PreToolUse hooks never consulted), and every run whose spawns carried
// `run_in_background: false` ran its 8–20 minutes with zero denials. CLI 2.1.250
// launches async when the flag is omitted, so "the model forgot the flag" was the
// coin flip behind the failures. The spawn hook in buildOptions forces the flag
// to false; it is the only choke point before a spawn (skill prose is ignored).

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
    const hook = spawnHook(buildOptions({}));
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
    const hook = spawnHook(buildOptions({}));
    const out = await hook({ tool_name: 'Task', tool_input: { prompt: 'batch', run_in_background: true } });
    assert.equal(out.hookSpecificOutput.updatedInput.run_in_background, false);
  });
});

test('a spawn that already says run_in_background: false is left alone', async () => {
  await withEnv('BP_ALLOW_BACKGROUND_SUBAGENTS', undefined, async () => {
    const hook = spawnHook(buildOptions({}));
    const out = await hook({ tool_name: 'Agent', tool_input: { prompt: 'batch', run_in_background: false } });
    assert.deepEqual(out, {});
  });
});

test('the foreground rewrite composes with the difficulty->model rewrite in one updatedInput', async () => {
  await withEnv('BP_ALLOW_BACKGROUND_SUBAGENTS', undefined, async () => {
    const hook = spawnHook(buildOptions({}));
    const out = await hook({ tool_name: 'Agent', tool_input: { prompt: 'batch', model: 'medium' } });
    const u = out.hookSpecificOutput.updatedInput;
    assert.equal(u.run_in_background, false);
    assert.notEqual(u.model, 'medium', 'the difficulty tier is still resolved to a concrete model');
  });
});

test('BP_ALLOW_BACKGROUND_SUBAGENTS=1 restores the old behavior (kill switch)', async () => {
  await withEnv('BP_ALLOW_BACKGROUND_SUBAGENTS', '1', async () => {
    const hook = spawnHook(buildOptions({}));
    const out = await hook({ tool_name: 'Agent', tool_input: { prompt: 'batch', run_in_background: true } });
    assert.deepEqual(out, {});
  });
});

test('non-spawn tools are untouched', async () => {
  const hook = spawnHook(buildOptions({}));
  assert.deepEqual(await hook({ tool_name: 'Bash', tool_input: { command: 'ls', run_in_background: true } }), {});
});
