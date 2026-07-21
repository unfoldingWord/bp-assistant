'use strict';

// Unit tests for the claude-runner SDK user-message error classifier + reducer,
// focused on the permission-denial-stall fail-safe (issues #235 and #238).
//
// The pipeline runs headless (permissionMode:'auto', no approval callback), so any
// out-of-allowlist tool call is auto-denied with "The user doesn't want to take
// this action right now. STOP what you are doing and wait for the user...".
//
// Two opposite failure modes calibrate the fail-safe:
//  - #235 (EZK 16, true stall): align agents obeyed the denial literally and went
//    silent; the run burned to the timeout. The fail-safe must abort such runs.
//  - #238 (EZK 16, false abort): 8 parallel batch sub-agents each burned a benign
//    improvised probe at startup — 3 denials in ~1.5s — then recovered by switching
//    to allowed tools. The original count-based limit (3 cumulative, never reset)
//    killed that healthy run in its first seconds. Benign bursts scale with fan-out,
//    so NO count threshold works.
//
// The detection is therefore time-based: `stallStartAt` anchors at the first denial
// after the last productive tool result; assessPermissionStall() reports a stall
// only when that anchor ages past the window with nothing productive since.

const test = require('node:test');
const assert = require('node:assert');

const {
  classifyRunnerUserMessage,
  applyRunnerUserMessage,
  assessPermissionStall,
  resultIndicatesPermissionStall,
} = require('../src/claude-runner');

const DENIAL_TEXT =
  '{"type":"tool_result","is_error":true,"content":"The user doesn\'t want to take ' +
  "this action right now. STOP what you are doing and wait for the user to tell you " +
  'how to proceed."}';
const NORMAL_TOOL_RESULT = '{"type":"tool_result","content":"ok, read 20 lines"}';
const TOOL_ERROR = '{"type":"tool_result","is_error":true,"content":"tool_use_error: String to replace not found"}';
const TRANSPORT_CLOSED = '{"type":"tool_result","is_error":true,"content":"Stream closed"}';

const LIMITS = { transportLimit: 3 };
const WINDOW_MS = 5 * 60 * 1000;

function freshState() {
  return {
    consecutiveToolErrors: 0,
    consecutiveTransportErrors: 0,
    consecutivePermissionDenials: 0,
    totalPermissionDenials: 0,
    stallStartAt: null,
    toolErrorSigs: new Map(),
  };
}

function step(state, text, now) {
  return applyRunnerUserMessage(state, classifyRunnerUserMessage(text), LIMITS, null, now);
}

// ---------- classification (unchanged semantics) ----------

test('classifyRunnerUserMessage recognizes the permission-denial signature', () => {
  const sig = classifyRunnerUserMessage(DENIAL_TEXT);
  assert.equal(sig.isPermissionDenied, true);
  // It must NOT be mistaken for a transport-closed or tool_use_error signature.
  assert.equal(sig.isTransportClosed, false);
  assert.equal(sig.isToolError, false);
});

test('classifyRunnerUserMessage matches either half of the denial text (in an is_error result)', () => {
  assert.equal(
    classifyRunnerUserMessage('{"is_error":true,"content":"The user doesn\'t want to take this action right now."}').isPermissionDenied,
    true,
  );
  assert.equal(
    classifyRunnerUserMessage('{"is_error":true,"content":"STOP what you are doing and wait for the user to tell you how to proceed."}').isPermissionDenied,
    true,
  );
  assert.equal(classifyRunnerUserMessage(NORMAL_TOOL_RESULT).isPermissionDenied, false);
});

test('a SUCCESSFUL tool_result that merely QUOTES the denial phrase is NOT a permission denial (no is_error)', () => {
  // Regression guard: the denial arrives only as an is_error tool_result. A healthy
  // Read/Grep/cat of a log, issue (#235), or this very test file that echoes the
  // denial wording must not be miscounted as a denial.
  const quotedInSuccessfulRead =
    '{"type":"tool_result","content":"issue #235 says: The user doesn\'t want to take '
    + 'this action right now. STOP what you are doing and wait for the user to proceed."}';
  const sig = classifyRunnerUserMessage(quotedInSuccessfulRead);
  assert.equal(sig.isPermissionDenied, false);
  assert.equal(sig.isToolResult, true);
  const state = freshState();
  step(state, quotedInSuccessfulRead, 0);
  assert.equal(state.totalPermissionDenials, 0);
  assert.equal(state.stallStartAt, null);
});

// ---------- reducer: counting + window anchoring ----------

test('denials are counted and anchor the stall window at the FIRST denial', () => {
  const state = freshState();
  assert.equal(step(state, DENIAL_TEXT, 1000).type, 'permission_denied');
  assert.equal(state.totalPermissionDenials, 1);
  assert.equal(state.stallStartAt, 1000);
  // A later denial does NOT re-anchor the window — a denial loop with no
  // interleaved progress must still age out against the first denial.
  assert.equal(step(state, DENIAL_TEXT, 60_000).type, 'permission_denied');
  assert.equal(state.totalPermissionDenials, 2);
  assert.equal(state.stallStartAt, 1000, 'window anchor must stay at the first denial');
});

test('a successful tool_result clears the stall window (#238 regression: benign startup probes)', () => {
  // This is the deliberate INVERSE of the original #237 behavior. Not resetting on
  // success is exactly what aborted a healthy 8-agent run whose sub-agents each
  // burned one improvised probe at startup and then recovered (#238).
  const state = freshState();
  step(state, DENIAL_TEXT, 1000);
  step(state, DENIAL_TEXT, 1200);
  step(state, DENIAL_TEXT, 1400); // 3 denials in a burst — the old limit aborted here
  assert.equal(step(state, NORMAL_TOOL_RESULT, 5000).type, 'tool_result_reset');
  assert.equal(state.stallStartAt, null, 'productive result must clear the stall anchor');
  assert.equal(state.consecutivePermissionDenials, 0);
  assert.equal(state.totalPermissionDenials, 3, 'total stays for logging');
  // No stall, no matter how much time passes with further productive work.
  assert.equal(assessPermissionStall(state, 5000 + WINDOW_MS * 10, WINDOW_MS).stalled, false);
});

test('a tool_use_error also clears the stall window (agent is still getting real responses)', () => {
  const state = freshState();
  step(state, DENIAL_TEXT, 1000);
  const r = step(state, TOOL_ERROR, 2000);
  assert.equal(r.type, 'tool_error');
  assert.equal(state.stallStartAt, null);
});

test('a transport-closed result does NOT clear the stall window', () => {
  const state = freshState();
  step(state, DENIAL_TEXT, 1000);
  step(state, TRANSPORT_CLOSED, 2000);
  assert.equal(state.stallStartAt, 1000);
});

// ---------- stall assessment (time-based abort decision) ----------

test('#235 regression: denial followed by silence IS a stall once the window elapses', () => {
  const state = freshState();
  step(state, DENIAL_TEXT, 0);
  assert.equal(assessPermissionStall(state, WINDOW_MS - 1, WINDOW_MS).stalled, false, 'not before the window');
  const at = assessPermissionStall(state, WINDOW_MS, WINDOW_MS);
  assert.equal(at.stalled, true, 'a denial with no productive result for the whole window is a stall');
  assert.equal(at.idleMs, WINDOW_MS);
});

test('a denial loop with no productive results stalls against the FIRST denial', () => {
  const state = freshState();
  step(state, DENIAL_TEXT, 0);
  step(state, DENIAL_TEXT, WINDOW_MS - 1000); // still denying near the window edge
  assert.equal(assessPermissionStall(state, WINDOW_MS, WINDOW_MS).stalled, true,
    'repeated denials must not keep pushing the window out');
});

test('denial → success → later denial anchors a NEW window at the later denial', () => {
  const state = freshState();
  step(state, DENIAL_TEXT, 0);
  step(state, NORMAL_TOOL_RESULT, 10_000);
  step(state, DENIAL_TEXT, 600_000); // mid-run stall begins here
  assert.equal(state.stallStartAt, 600_000);
  assert.equal(assessPermissionStall(state, 600_000 + WINDOW_MS - 1, WINDOW_MS).stalled, false);
  assert.equal(assessPermissionStall(state, 600_000 + WINDOW_MS, WINDOW_MS).stalled, true);
});

test('no denials → never a stall, regardless of elapsed time', () => {
  const state = freshState();
  step(state, NORMAL_TOOL_RESULT, 0);
  assert.equal(assessPermissionStall(state, WINDOW_MS * 100, WINDOW_MS).stalled, false);
});

// ---------- outcome classification for callers ----------

test('resultIndicatesPermissionStall matches the bail subtype AND the annotated success result', () => {
  assert.equal(resultIndicatesPermissionStall({ subtype: 'permission_stall' }), true);
  // #238: the SDK emitted the result message before the trailing denial messages, so
  // the runner returned a success-shaped result; the annotation must still classify.
  assert.equal(resultIndicatesPermissionStall({ subtype: 'success', permissionStallDetected: true }), true);
  assert.equal(resultIndicatesPermissionStall({ subtype: 'success' }), false);
  assert.equal(resultIndicatesPermissionStall(null), false);
  assert.equal(resultIndicatesPermissionStall({ subtype: 'timeout' }), false);
});

// ---------- unrelated counters unaffected ----------

test('precedence: transport-closed and tool_use_error signatures are unaffected', () => {
  const state = freshState();
  assert.equal(step(state, TRANSPORT_CLOSED, 0).type, 'transport_error');
  assert.equal(step(state, TRANSPORT_CLOSED, 0).type, 'transport_error');
  assert.equal(step(state, TRANSPORT_CLOSED, 0).type, 'abort_transport');

  const s2 = freshState();
  const r = step(s2, TOOL_ERROR, 0);
  assert.equal(r.type, 'tool_error');
  assert.equal(r.sig, 'string_not_found');
  assert.equal(s2.totalPermissionDenials, 0, 'a tool error is not a permission denial');
});

test('guardrail_stop still fires for repeated tool errors (regression guard)', () => {
  const state = freshState();
  const guardrails = { maxConsecutiveToolErrors: 2 };
  const first = applyRunnerUserMessage(state, classifyRunnerUserMessage(TOOL_ERROR), LIMITS, guardrails, 0);
  assert.equal(first.type, 'tool_error');
  const second = applyRunnerUserMessage(state, classifyRunnerUserMessage(TOOL_ERROR), LIMITS, guardrails, 0);
  assert.equal(second.type, 'guardrail_stop');
  assert.equal(second.consecutive, 2);
});
