'use strict';

// Unit tests for external-permission-wall detection in claude-runner (issue #271).
//
// EZK 19 (2026-07-24) failed a full-pipeline run this way. The align coordinator's
// own first calls succeeded; 6.3s after the second sub-agent spawn, EVERY tool call
// in the session tree began being auto-denied — plain `Read`, `Glob`, `TaskOutput`,
// `Agent`, the mandated `node workspace-tools-cli.js` wrapper AND the
// `mcp__workspace-tools__*` alternate — 16 in a row, despite the align run passing
// bypassPermissions:true. The refusal therefore came from ABOVE this process's
// permission config; no allowlist or skill change could clear it.
//
// Neither existing safeguard caught it:
//  - the time-based stall fail-safe needs 300s of no productive result, but the
//    coordinator returned a NORMAL result 88s in, so the window never elapsed;
//  - so errorKind fell through to the coverage-derived `missing_output`, and the
//    filed issue advised "investigate the coordinator prompt / model or simply
//    re-run" — a diagnosis no prompt change and no re-run could act on.
//
// The discriminator here is deliberately QUALITATIVE, not a denial count, because a
// count is what caused #238's false abort (a healthy 8-agent fan-out burned benign
// raw-shell probes at startup and recovered; a cumulative limit of 3 killed it).
// Bash is the only tool with argument-level allow-rules, so a denied Bash call is
// genuinely ambiguous and scores nothing. Every other tool is granted per-session,
// so its denial cannot be an allowlist miss. #238's probes were all Bash and score
// zero here; EZK 19 scored on its very first denial (a `Read` inside cwd).

const test = require('node:test');
const assert = require('node:assert');

const {
  classifyRunnerUserMessage,
  applyRunnerUserMessage,
  isPermissionWallEvidence,
  resultIndicatesPermissionWall,
  resultIndicatesPermissionStall,
  PERMISSION_WALL_DENIAL_LIMIT,
} = require('../src/claude-runner');

const denialText = (toolUseId) =>
  '{"type":"tool_result","content":"The user doesn\'t want to take this action right now. ' +
  'STOP what you are doing and wait for the user to tell you how to proceed.",' +
  `"is_error":true,"tool_use_id":"${toolUseId}"}`;

const NORMAL_TOOL_RESULT = '{"type":"tool_result","content":"ok, read 20 lines"}';
const TOOL_ERROR = '{"type":"tool_result","is_error":true,"content":"tool_use_error: String to replace not found"}';

const LIMITS = { transportLimit: 3, wallLimit: 2 };

function freshState() {
  return {
    consecutiveToolErrors: 0,
    consecutiveTransportErrors: 0,
    consecutivePermissionDenials: 0,
    totalPermissionDenials: 0,
    stallStartAt: null,
    wallDenials: 0,
    toolErrorSigs: new Map(),
  };
}

// Feed one denial whose tool_use resolved to `toolName` (null = unresolved).
function feedDenial(state, toolName, id = 'toolu_x') {
  const sig = classifyRunnerUserMessage(denialText(id));
  sig.deniedToolName = toolName;
  return applyRunnerUserMessage(state, sig, LIMITS, null);
}

function feed(state, text) {
  return applyRunnerUserMessage(state, classifyRunnerUserMessage(text), LIMITS, null);
}

test('the denial message carries the tool_use_id, so the refused tool can be named', () => {
  const sig = classifyRunnerUserMessage(denialText('toolu_01PjdPbwEaZawJXekVpEBbwA'));
  assert.equal(sig.isPermissionDenied, true);
  assert.equal(sig.toolUseId, 'toolu_01PjdPbwEaZawJXekVpEBbwA');
});

test('a productive tool_result carries no tool_use_id requirement and is not a denial', () => {
  const sig = classifyRunnerUserMessage(NORMAL_TOOL_RESULT);
  assert.equal(sig.isPermissionDenied, false);
  assert.equal(sig.isToolResult, true);
});

test('only wholesale-granted tools are wall evidence; Bash and unknowns are ambiguous', () => {
  // Granted per-session — a denial cannot be our own allowlist.
  for (const t of ['Read', 'Glob', 'Grep', 'Agent', 'Task', 'TaskOutput', 'Write', 'mcp__workspace-tools__read_usfm_chapter']) {
    assert.equal(isPermissionWallEvidence(t), true, `${t} should be wall evidence`);
  }
  // Bash has argument-level allow-rules, so a denial is explainable locally.
  assert.equal(isPermissionWallEvidence('Bash'), false);
  // An unresolved id must never be treated as evidence.
  assert.equal(isPermissionWallEvidence(null), false);
  assert.equal(isPermissionWallEvidence(undefined), false);
  assert.equal(isPermissionWallEvidence(''), false);
});

test('EZK 19: two back-to-back Read denials trip the wall', () => {
  const state = freshState();
  // 19:36:36.318 — sub-agent's first call, a Read inside cwd.
  assert.equal(feedDenial(state, 'Read', 'toolu_a').type, 'permission_denied');
  // 19:36:36.335 — 17ms later, the hints-JSON Read. This is where we now bail,
  // instead of never (the real run took 14 more denials and then gave up).
  const action = feedDenial(state, 'Read', 'toolu_b');
  assert.equal(action.type, 'abort_permission_wall');
  assert.equal(action.wallDenials, 2);
  assert.equal(action.tool, 'Read');
});

test('the wall trips on mixed wholesale-granted tools, not just repeats of one', () => {
  const state = freshState();
  assert.equal(feedDenial(state, 'Glob').type, 'permission_denied');
  assert.equal(feedDenial(state, 'mcp__workspace-tools__read_usfm_chapter').type, 'abort_permission_wall');
});

test('#238 regression: a burst of benign raw-shell probe denials never trips the wall', () => {
  const state = freshState();
  // 8 parallel batch sub-agents each improvise an out-of-allowlist shell probe.
  // Every one is a Bash denial, which is exactly what our own allow-rules produce.
  for (let i = 0; i < 8; i++) {
    assert.equal(feedDenial(state, 'Bash', `toolu_${i}`).type, 'permission_denied');
  }
  assert.equal(state.wallDenials, 0);
  assert.equal(state.totalPermissionDenials, 8);
});

test('unresolved tool names never accumulate wall evidence', () => {
  const state = freshState();
  for (let i = 0; i < 5; i++) feedDenial(state, null, `toolu_${i}`);
  assert.equal(state.wallDenials, 0);
});

test('a productive tool_result between denials clears wall evidence', () => {
  const state = freshState();
  feedDenial(state, 'Read', 'toolu_a');
  assert.equal(state.wallDenials, 1);
  // The agent recovered — tools are reachable, so nothing is walling us off.
  assert.equal(feed(state, NORMAL_TOOL_RESULT).type, 'tool_result_reset');
  assert.equal(state.wallDenials, 0);
  // A later lone denial must not resurrect the earlier one into an abort.
  assert.equal(feedDenial(state, 'Read', 'toolu_b').type, 'permission_denied');
});

test('a real tool_use_error also clears wall evidence — tools are answering', () => {
  const state = freshState();
  feedDenial(state, 'Read', 'toolu_a');
  assert.equal(state.wallDenials, 1);
  feed(state, TOOL_ERROR);
  assert.equal(state.wallDenials, 0);
});

test('wall detection stays off when the caller supplies no wallLimit', () => {
  // Guards the existing callers/tests that pass only { transportLimit }.
  const state = freshState();
  const limits = { transportLimit: 3 };
  for (let i = 0; i < 6; i++) {
    const sig = classifyRunnerUserMessage(denialText(`toolu_${i}`));
    sig.deniedToolName = 'Read';
    assert.equal(applyRunnerUserMessage(state, sig, limits, null).type, 'permission_denied');
  }
});

test('the stall anchor still advances during a wall, so both signals stay coherent', () => {
  const state = freshState();
  feedDenial(state, 'Read', 'toolu_a');
  assert.notEqual(state.stallStartAt, null);
  assert.equal(state.consecutivePermissionDenials, 1);
});

test('permission_wall and permission_stall outcomes are distinguishable', () => {
  assert.equal(resultIndicatesPermissionWall({ subtype: 'permission_wall' }), true);
  assert.equal(resultIndicatesPermissionWall({ subtype: 'permission_stall' }), false);
  assert.equal(resultIndicatesPermissionWall({ subtype: 'success' }), false);
  assert.equal(resultIndicatesPermissionWall(null), false);
  // A wall must NOT read as a stall: the stall path routes to a hard failure,
  // while the wall is transient and must be backed off and retried.
  assert.equal(resultIndicatesPermissionStall({ subtype: 'permission_wall' }), false);
});

test('the default wall limit is small — the wall is unambiguous once it appears', () => {
  assert.ok(PERMISSION_WALL_DENIAL_LIMIT >= 2 && PERMISSION_WALL_DENIAL_LIMIT <= 4,
    `expected a tight default, got ${PERMISSION_WALL_DENIAL_LIMIT}`);
});
