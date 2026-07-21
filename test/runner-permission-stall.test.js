'use strict';

// Unit tests for the claude-runner SDK user-message error classifier + reducer,
// focused on the permission-denial-stall fail-safe (issue #235, EZK 16 2026-07-21).
// The pipeline runs headless (permissionMode:'auto', no approval callback), so any
// out-of-allowlist tool call is auto-denied with "The user doesn't want to take
// this action right now. STOP what you are doing and wait for the user...". The
// align sub-agents obeyed that literally and stalled; the runner never detected it
// and burned to timeout. The reducer below must (a) count those denials, (b) NOT
// reset that count on an interleaved successful tool_result, and (c) signal a bail
// (abort_permission → subtype 'permission_stall') once the threshold is reached.

const test = require('node:test');
const assert = require('node:assert');

const {
  classifyRunnerUserMessage,
  applyRunnerUserMessage,
} = require('../src/claude-runner');

const DENIAL_TEXT =
  '{"type":"tool_result","is_error":true,"content":"The user doesn\'t want to take ' +
  "this action right now. STOP what you are doing and wait for the user to tell you " +
  'how to proceed."}';
const NORMAL_TOOL_RESULT = '{"type":"tool_result","content":"ok, read 20 lines"}';

const LIMITS = { transportLimit: 3, permissionLimit: 3 };

function freshState() {
  return {
    consecutiveToolErrors: 0,
    consecutiveTransportErrors: 0,
    consecutivePermissionDenials: 0,
    toolErrorSigs: new Map(),
  };
}

function step(state, text) {
  return applyRunnerUserMessage(state, classifyRunnerUserMessage(text), LIMITS, null);
}

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
  // denial wording must not be miscounted as a stall — otherwise 3 such reads would
  // false-abort a healthy run as permission_stall.
  const quotedInSuccessfulRead =
    '{"type":"tool_result","content":"issue #235 says: The user doesn\'t want to take '
    + 'this action right now. STOP what you are doing and wait for the user to proceed."}';
  const sig = classifyRunnerUserMessage(quotedInSuccessfulRead);
  assert.equal(sig.isPermissionDenied, false);
  assert.equal(sig.isToolResult, true);
  // And it must not accumulate the stall counter across three such benign reads.
  const state = freshState();
  assert.equal(step(state, quotedInSuccessfulRead).type, 'tool_result_reset');
  assert.equal(step(state, quotedInSuccessfulRead).type, 'tool_result_reset');
  assert.equal(step(state, quotedInSuccessfulRead).type, 'tool_result_reset');
  assert.equal(state.consecutivePermissionDenials, 0);
});

test('(a) permission denials are counted', () => {
  const state = freshState();
  assert.equal(step(state, DENIAL_TEXT).type, 'permission_denied');
  assert.equal(state.consecutivePermissionDenials, 1);
  assert.equal(step(state, DENIAL_TEXT).type, 'permission_denied');
  assert.equal(state.consecutivePermissionDenials, 2);
});

test('(b) an interleaved successful tool_result does NOT reset the permission-denial count', () => {
  const state = freshState();
  assert.equal(step(state, DENIAL_TEXT).type, 'permission_denied'); // 1
  // A legitimate read/validation tool_result lands between denials.
  const mid = step(state, NORMAL_TOOL_RESULT);
  assert.equal(mid.type, 'tool_result_reset');
  assert.equal(state.consecutivePermissionDenials, 1, 'tool_result must not clear the permission counter');
  // The transport/tool-error counters DO get reset by a clean tool_result...
  assert.equal(state.consecutiveTransportErrors, 0);
  assert.equal(state.consecutiveToolErrors, 0);
  // ...but the stall keeps accumulating across the interleaved success.
  assert.equal(step(state, DENIAL_TEXT).type, 'permission_denied'); // 2
  assert.equal(state.consecutivePermissionDenials, 2);
});

test('(c) reducer signals abort_permission once the threshold is reached', () => {
  const state = freshState();
  assert.equal(step(state, DENIAL_TEXT).type, 'permission_denied'); // 1
  assert.equal(step(state, DENIAL_TEXT).type, 'permission_denied'); // 2
  const third = step(state, DENIAL_TEXT); // 3 == permissionLimit
  assert.equal(third.type, 'abort_permission');
  assert.equal(state.consecutivePermissionDenials, 3);
});

test('(c) threshold still trips when a clean tool_result interleaves the denials', () => {
  const state = freshState();
  assert.equal(step(state, DENIAL_TEXT).type, 'permission_denied'); // 1
  assert.equal(step(state, NORMAL_TOOL_RESULT).type, 'tool_result_reset');
  assert.equal(step(state, DENIAL_TEXT).type, 'permission_denied'); // 2
  assert.equal(step(state, NORMAL_TOOL_RESULT).type, 'tool_result_reset');
  assert.equal(step(state, DENIAL_TEXT).type, 'abort_permission'); // 3
  assert.equal(state.consecutivePermissionDenials, 3);
});

test('precedence: transport-closed and tool_use_error signatures are unaffected by the new branch', () => {
  const state = freshState();
  const transport = '{"type":"tool_result","is_error":true,"content":"Stream closed"}';
  assert.equal(step(state, transport).type, 'transport_error');
  assert.equal(step(state, transport).type, 'transport_error');
  assert.equal(step(state, transport).type, 'abort_transport');

  const s2 = freshState();
  const toolErr = '{"type":"tool_result","is_error":true,"content":"tool_use_error: String to replace not found"}';
  const r = applyRunnerUserMessage(s2, classifyRunnerUserMessage(toolErr), LIMITS, null);
  assert.equal(r.type, 'tool_error');
  assert.equal(r.sig, 'string_not_found');
  assert.equal(s2.consecutivePermissionDenials, 0, 'a tool error is not a permission denial');
});

test('guardrail_stop still fires for repeated tool errors (regression guard)', () => {
  const state = freshState();
  const toolErr = '{"type":"tool_result","is_error":true,"content":"tool_use_error: String to replace not found"}';
  const guardrails = { maxConsecutiveToolErrors: 2 };
  const first = applyRunnerUserMessage(state, classifyRunnerUserMessage(toolErr), LIMITS, guardrails);
  assert.equal(first.type, 'tool_error');
  const second = applyRunnerUserMessage(state, classifyRunnerUserMessage(toolErr), LIMITS, guardrails);
  assert.equal(second.type, 'guardrail_stop');
  assert.equal(second.consecutive, 2);
});
