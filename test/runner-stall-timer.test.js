'use strict';

// Runner-level tests for the two permission wall/stall decisions that live INSIDE
// runClaudeOnce (issue #375) rather than in the pure reducer:
//
//   1. the `stallTimer` interval — once the 300s window has elapsed with a denial
//      anchor still unresolved, it asks hasPermissionWallEvidence() whether that
//      silence is an external WALL (transient, caller backs off and retries) or a
//      plain STALL (hard failure); and
//   2. the post-loop annotation — a `result` that arrives while wall evidence is
//      still unresolved is stamped `permissionWallDetected`, before either stall
//      branch gets a chance to stamp `permissionStallDetected` instead.
//
// test/runner-permission-wall.test.js covers the pure pieces (classify / apply /
// assessPermissionStall / hasPermissionWallEvidence) and re-implements the timer's
// decision in a test-side `watchdog()` helper — so swapping the wall and stall
// checks inside the real timer, or dropping the hasPermissionWallEvidence half of
// the post-loop condition, failed nothing. These tests drive the real function.
//
// Mechanism: a scripted async stream stands in for the Agent SDK's query(), with
// node:test fake timers so the 30s poll and the 300s window pass instantly. The
// SDK is pure ESM, so it is injected through __setSdkTestDoubles() rather than the
// require.cache substitution the rest of test/ uses for CJS modules.
//
// The three shapes replayed here come from real run logs:
//   JER 48 (2026-09-04, run log 195534-i8w8f1) — #373
//   EZK 19 (2026-07-24)                        — #271
//   DAN 5                                      — #291

const test = require('node:test');
const { mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RUN_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-stall-timer-'));

// Env must be set before requiring claude-runner: BP_RUN_LOG_DIR and the stall
// window are read at module load.
const ENV_KEYS = ['BP_RUN_LOG_DIR', 'BP_NO_BYPASS', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'];
const ENV_BEFORE = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
process.env.BP_RUN_LOG_DIR = RUN_LOG_DIR;
// Keeps ensureFreshToken() on its no-op path (no credential file read, no network).
process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token-never-used';
delete process.env.BP_NO_BYPASS; // bypassPermissions:true must actually mean bypass

const {
  runClaudeOnce,
  __setSdkTestDoubles,
  PERMISSION_STALL_WINDOW_MS,
  PERMISSION_WALL_DENIAL_LIMIT,
} = require('../src/claude-runner');

// Mirrors PERMISSION_STALL_POLL_MS in src/claude-runner.js (module-private).
const POLL_MS = 30 * 1000;
// Long enough that runClaudeOnce's own timeout never fires in these scenarios —
// every abort under test must come from the stall watchdog, not the deadline.
const NO_TIMEOUT_MS = 60 * 60 * 1000;

test.after(async () => {
  for (const k of ENV_KEYS) {
    if (ENV_BEFORE[k] === undefined) delete process.env[k];
    else process.env[k] = ENV_BEFORE[k];
  }
  // Each run opens a run-log WriteStream, whose open()/write() land on the event
  // loop after the test that created it has returned (and could not run at all
  // while the clock was mocked). Let them settle before removing the directory,
  // or every one of them reports a spurious ENOENT on the way out.
  await new Promise((resolve) => setTimeout(resolve, 50));
  fs.rmSync(RUN_LOG_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// SDK message shapes, byte-compatible with what classifyRunnerUserMessage parses.
// ---------------------------------------------------------------------------

const denialText = (toolUseId) =>
  '{"type":"tool_result","content":"The user doesn\'t want to take this action right now. ' +
  'STOP what you are doing and wait for the user to tell you how to proceed.",' +
  `"is_error":true,"tool_use_id":"${toolUseId}"}`;

const INIT = { type: 'system', subtype: 'init', session_id: 'sess_test_375', tools: ['Read', 'Bash', 'Grep'] };
const toolUse = (id, name) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input: {} }] } });
const denial = (id) => ({ type: 'user', message: { content: denialText(id) } });
const productive = () => ({ type: 'user', message: { content: '{"type":"tool_result","content":"ok, read 20 lines"}' } });
const resultMsg = (overrides = {}) => ({
  type: 'result', subtype: 'success', num_turns: 12, total_cost_usd: 0.42, duration_ms: 1234, result: 'done',
  ...overrides,
});

// A denied tool call is two stream messages: the assistant's tool_use (which is
// what teaches the runner the tool's NAME — the denial itself carries only the id)
// and the denial tool_result. The wall discriminator is name-based, so a scripted
// denial without its tool_use resolves to null and scores nothing.
function deniedCall(at, id, name) {
  return [{ at, msg: toolUse(id, name) }, { at: at + 1, msg: denial(id) }];
}

// ---------------------------------------------------------------------------
// Scripted stream driver.
// ---------------------------------------------------------------------------

function abortError() {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

// Advance mocked time to `targetMs` in poll-sized steps so the stall watchdog runs
// exactly as often as it would in production, throwing the SDK's AbortError as soon
// as the runner aborts (which is how a real stream reacts to abortController.abort).
function advanceTo(targetMs, signal) {
  if (signal.aborted) throw abortError();
  while (Date.now() < targetMs) {
    mock.timers.tick(Math.min(POLL_MS, targetMs - Date.now()));
    if (signal.aborted) throw abortError();
  }
}

// Build a query() double that replays `script` ({at, msg} entries, `at` in ms from
// query start) and then, if `silentUntil` is set, goes SILENT — the shape a truly
// walled/stalled run has, and the only shape the interval watchdog can catch.
function scriptedQuery(script, { silentUntil = null } = {}) {
  return ({ options }) => {
    const signal = options.abortController.signal;
    async function* stream() {
      for (const step of script) {
        advanceTo(step.at, signal);
        yield step.msg;
      }
      if (silentUntil != null) advanceTo(silentUntil, signal);
    }
    const iterator = stream();
    return { [Symbol.asyncIterator]: () => iterator, close() {} };
  };
}

// runClaudeOnce logs heavily by design; keep the reporter readable but retain the
// lines so a failure can show what the runner actually decided.
function silenceConsole() {
  const lines = [];
  const originals = {};
  for (const level of ['log', 'warn', 'error']) {
    originals[level] = console[level];
    console[level] = (...args) => { lines.push(args.join(' ')); };
  }
  return { lines, restore: () => Object.assign(console, originals) };
}

async function runScript(script, { silentUntil = null, ...args } = {}) {
  const captured = silenceConsole();
  const restoreSdk = __setSdkTestDoubles({
    query: scriptedQuery(script, { silentUntil }),
    // Empty stand-in for the in-process workspace-tools MCP server: the real
    // factory does a dynamic ESM import of the SDK, which this test never loads.
    workspaceToolsServer: { name: 'workspace-tools', version: '1.0.0' },
  });
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 });
  try {
    return await runClaudeOnce({
      prompt: 'align chapter',
      label: 'TEST align',
      cwd: RUN_LOG_DIR,
      timeoutMs: NO_TIMEOUT_MS,
      mcpToolSet: 'none',
      ...args,
    });
  } finally {
    mock.timers.reset();
    restoreSdk();
    captured.restore();
    if (process.env.BP_STALL_TEST_LOGS === '1') console.log(captured.lines.join('\n'));
  }
}

// ---------------------------------------------------------------------------
// 1. JER 48 (#373) — a healthy bypass run must survive its startup denial burst.
// ---------------------------------------------------------------------------

// Replayed from run log 195534-i8w8f1: the align coordinator fanned out 6 sub-agents,
// two of their first Bash calls were denied 0.7s apart at +34.0s/+34.7s (both score as
// wall evidence on a bypass run, #291), a sibling agent's productive tool_result landed
// 1.5s later, and the run went on to a normal result minutes later. Six attempts in a
// row were killed on that second denial before #374 moved the decision behind the stall
// window. Nothing here may abort, and the result must come back unannotated.
test('JER 48: a startup denial burst that clears in seconds neither aborts nor annotates', async () => {
  const result = await runScript([
    { at: 0, msg: INIT },
    ...deniedCall(33_999, 'toolu_015H1eX7', 'Bash'),
    ...deniedCall(34_699, 'toolu_01UipAfy', 'Bash'),
    { at: 36_200, msg: productive() },
    { at: 9 * 60_000, msg: resultMsg() },
  ], { bypassPermissions: true });

  assert.equal(result.subtype, 'success');
  assert.equal(result.permissionWallDetected, undefined);
  assert.equal(result.permissionStallDetected, undefined);
});

// The ordering guard for the timer's FIRST gate. Above, the burst clears in 2.2s —
// between two 30s polls — so the watchdog never even observes the evidence. Here the
// same complete evidence sits unresolved across nine polls while staying inside the
// 300s window. If the wall check were hoisted above `if (!stall.stalled) return`, this
// run would abort as permission_wall at the 30s poll instead of succeeding: exactly
// the #373 regression, one poll later.
test('complete wall evidence younger than the stall window must not abort mid-stream', async () => {
  const firstDenialAt = 10_000;
  const clearsAt = firstDenialAt + PERMISSION_STALL_WINDOW_MS - 15_000; // still inside the window
  const result = await runScript([
    { at: 0, msg: INIT },
    ...deniedCall(firstDenialAt - 1, 'toolu_w1', 'Bash'),
    ...deniedCall(firstDenialAt + 500, 'toolu_w2', 'Bash'),
    { at: clearsAt, msg: productive() },
    { at: clearsAt + 25_000, msg: resultMsg() },
  ], { bypassPermissions: true });

  assert.equal(result.subtype, 'success');
  assert.equal(result.permissionWallDetected, undefined);
  assert.equal(result.permissionStallDetected, undefined);
});

// ---------------------------------------------------------------------------
// 2. EZK 19 (#271) — the post-loop annotation on a result that ends the run early.
// ---------------------------------------------------------------------------

// The wall's other exit: the run never goes silent long enough for the watchdog,
// because the coordinator returns a normal-looking result at 88s — well inside the
// 300s window — with every one of its tool calls denied. Only the post-loop
// `hasPermissionWallEvidence` half catches this. Drop it and the result comes back
// clean, runClaude()'s backoff never engages, and generate-pipeline misfiles the
// chapter as missing_output and retries straight back into the wall.
test('EZK 19: a success-shaped result arriving with unresolved wall evidence is annotated', async () => {
  const result = await runScript([
    { at: 0, msg: INIT },
    ...deniedCall(20_000, 'toolu_ezk_read', 'Read'),
    ...deniedCall(21_000, 'toolu_ezk_glob', 'Glob'),
    { at: 88_000, msg: resultMsg({ duration_ms: 88_000 }) },
  ]);

  assert.equal(result.subtype, 'success');
  assert.equal(result.permissionWallDetected, true);
  // A wall is transient and retryable; a stall is a hard failure. Annotating both
  // would route the run down the wrong recovery path.
  assert.equal(result.permissionStallDetected, undefined);
});

// The ordering guard for the post-loop branches. A non-success result with an active
// denial anchor is annotated permissionStallDetected by the last branch (#268, DAN 1).
// When the anchor ALSO carries wall evidence, the wall branch must win — it is checked
// first precisely so a retryable wall is never flattened into a hard stall failure.
test('EZK 19 variant: wall evidence outranks the non-success stall annotation', async () => {
  const result = await runScript([
    { at: 0, msg: INIT },
    ...deniedCall(20_000, 'toolu_ezk_read', 'Read'),
    ...deniedCall(21_000, 'toolu_ezk_glob', 'Glob'),
    { at: 88_000, msg: resultMsg({ subtype: 'error_max_turns' }) },
  ]);

  assert.equal(result.permissionWallDetected, true);
  assert.equal(result.permissionStallDetected, undefined);
});

// A denial anchor with too little evidence still takes the stall annotation, so the
// test above is really about precedence and not about the wall branch swallowing
// everything. One Read denial is below PERMISSION_WALL_DENIAL_LIMIT.
test('a non-success result with a sub-threshold anchor is annotated as a stall, not a wall', async () => {
  assert.ok(PERMISSION_WALL_DENIAL_LIMIT > 1, 'scenario assumes more than one denial is needed');
  const result = await runScript([
    { at: 0, msg: INIT },
    ...deniedCall(20_000, 'toolu_one', 'Read'),
    { at: 60_000, msg: resultMsg({ subtype: 'error_during_execution' }) },
  ]);

  assert.equal(result.permissionWallDetected, undefined);
  assert.equal(result.permissionStallDetected, true);
});

// ---------------------------------------------------------------------------
// 3. DAN 5 (#291) — denials then silence: the watchdog's wall-vs-stall decision.
// ---------------------------------------------------------------------------

// DAN 5's shape: five Bash denials and one Grep, then nothing at all. On a BYPASS run
// there are no argument-level Bash allow-rules to be ambiguous about, so all six score
// as wall evidence and the silence must be reported as the retryable permission_wall.
const DAN_5_DENIALS = [
  { at: 0, msg: INIT },
  ...deniedCall(1_000, 'toolu_dan_b1', 'Bash'),
  ...deniedCall(1_400, 'toolu_dan_b2', 'Bash'),
  ...deniedCall(1_800, 'toolu_dan_b3', 'Bash'),
  ...deniedCall(2_200, 'toolu_dan_b4', 'Bash'),
  ...deniedCall(2_600, 'toolu_dan_b5', 'Bash'),
  ...deniedCall(3_000, 'toolu_dan_g1', 'Grep'),
];
// Comfortably past the first denial + the 300s window, so the watchdog has fired.
const DAN_5_SILENT_UNTIL = 3_000 + PERMISSION_STALL_WINDOW_MS + 2 * POLL_MS;

test('DAN 5 on a bypass run: Bash denials then silence abort as permission_wall', async () => {
  const result = await runScript(DAN_5_DENIALS, {
    silentUntil: DAN_5_SILENT_UNTIL,
    bypassPermissions: true,
  });

  assert.equal(result.subtype, 'permission_wall');
  assert.equal(result.reason, 'permission_wall');
  assert.equal(result.timedOut, false);
  assert.equal(result.wallDenials, 6);
  assert.equal(result.totalPermissionDenials, 6);
  // It aborted on the watchdog, not on runClaudeOnce's own deadline.
  assert.ok(result.elapsedMs < NO_TIMEOUT_MS);
  assert.ok(result.elapsedMs >= PERMISSION_STALL_WINDOW_MS);
});

// The same stream on a NON-bypass run. There, Bash denials really can be an
// allow-rule miss (BASH_ALLOW_RULES gate individual commands), so only the Grep
// scores — one, below the limit — and the identical silence is the classic stall,
// which routes to a hard failure instead of backoff-and-retry. This pair is what
// fails if the wall and stall checks inside the timer are swapped.
test('DAN 5 on a non-bypass run: the same shape aborts as permission_stall', async () => {
  const result = await runScript(DAN_5_DENIALS, {
    silentUntil: DAN_5_SILENT_UNTIL,
    bypassPermissions: false,
  });

  assert.equal(result.subtype, 'permission_stall');
  assert.equal(result.reason, 'permission_stall');
  assert.equal(result.timedOut, false);
  assert.equal(result.totalPermissionDenials, 6);
});

// Sanity anchor for the whole harness: with no denials at all, the same driver runs
// the full 300s+ window and returns a plain success. If the watchdog fired here, every
// assertion above would be meaningless.
test('a denial-free run crosses the stall window untouched', async () => {
  const result = await runScript([
    { at: 0, msg: INIT },
    { at: 30_000, msg: toolUse('toolu_ok', 'Read') },
    { at: 31_000, msg: productive() },
    { at: PERMISSION_STALL_WINDOW_MS + 60_000, msg: resultMsg() },
  ]);

  assert.equal(result.subtype, 'success');
  assert.equal(result.permissionWallDetected, undefined);
  assert.equal(result.permissionStallDetected, undefined);
});
