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

// issue #291 (DAN 5): on a bypass run, Bash carries NO argument-level allow-rules —
// buildOptions hands a bypass query allow-all with no decider at all — so a denied
// Bash there cannot be an allowlist miss either, and counts exactly like any other
// tool. The `isBypassRun` parameter defaults to false, so every call site above
// (and every existing caller) is unaffected.
test('Bash IS wall evidence on a bypass run, and is NOT on a non-bypass run', () => {
  assert.equal(isPermissionWallEvidence('Bash', true), true);
  assert.equal(isPermissionWallEvidence('Bash', false), false);
  assert.equal(isPermissionWallEvidence('Bash'), false); // default unchanged
});

// An unresolved tool name is ambiguous in EITHER mode — there is nothing to widen,
// since we don't even know what was denied.
test('an unresolved tool name is never wall evidence, bypass or not', () => {
  for (const isBypassRun of [true, false]) {
    assert.equal(isPermissionWallEvidence(null, isBypassRun), false);
    assert.equal(isPermissionWallEvidence(undefined, isBypassRun), false);
    assert.equal(isPermissionWallEvidence('', isBypassRun), false);
  }
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

// Review finding on #273. The SDK can emit the terminal `result` while trailing
// sub-agent messages are still streaming (#238/#268), so the wall can fire AFTER a
// result has been captured. In that ordering runClaudeOnce returns the captured result
// and never reaches the post-loop permissionWallFired branch, so the wall must ride out
// on the result as an annotation — otherwise the backoff never engages and the align
// step misclassifies a walled run as missing output and retries straight into it.
test('a wall detected after the result is captured rides out as an annotation', () => {
  assert.equal(resultIndicatesPermissionWall({ subtype: 'success', permissionWallDetected: true }), true);
  assert.equal(resultIndicatesPermissionWall({ subtype: 'error', permissionWallDetected: true }), true);
  // Absent or false annotation must not read as a wall.
  assert.equal(resultIndicatesPermissionWall({ subtype: 'success', permissionWallDetected: false }), false);
});

test('a wall-annotated result does not also read as a stall (wall outranks)', () => {
  // Both flags present would be contradictory routing: stall means hard failure, wall
  // means retry. runClaudeOnce checks the wall first so only the wall flag is set.
  const walled = { subtype: 'success', permissionWallDetected: true };
  assert.equal(resultIndicatesPermissionWall(walled), true);
  assert.equal(resultIndicatesPermissionStall(walled), false);
});

test('the default wall limit is small — the wall is unambiguous once it appears', () => {
  assert.ok(PERMISSION_WALL_DENIAL_LIMIT >= 2 && PERMISSION_WALL_DENIAL_LIMIT <= 4,
    `expected a tight default, got ${PERMISSION_WALL_DENIAL_LIMIT}`);
});

// issue #291 — reducer regression replaying DAN 5's REAL denial sequence (5 Bash
// denials, then 1 Grep denial; see #289's transcript table). Under the old
// unconditional Bash exemption this scored only 1 (the lone Grep), below
// PERMISSION_WALL_DENIAL_LIMIT (2), so no wall fired and the run hard-failed as a
// permission_stall instead of getting the wall's 20-minute retry budget. On a
// bypass run, Bash now counts too, so the wall must fire on the SECOND denial
// (both Bash) — 2s into the real incident, instead of 512s in. On a non-bypass
// run the old behavior must hold: Bash stays ambiguous and the sequence never
// trips the wall at all (only the trailing Grep would ever score).
test('DAN 5 sequence (5x Bash then 1x Grep) trips the wall by the 2nd denial on a bypass run, not on non-bypass', () => {
  const bypassState = freshState();
  const bypassLimits = { transportLimit: 3, wallLimit: 2, isBypassRun: true };
  const feedBypass = (toolName, id) => {
    const sig = classifyRunnerUserMessage(denialText(id));
    sig.deniedToolName = toolName;
    return applyRunnerUserMessage(bypassState, sig, bypassLimits, null);
  };

  const first = feedBypass('Bash', 'toolu_dan5_1');
  assert.equal(first.type, 'permission_denied');
  const second = feedBypass('Bash', 'toolu_dan5_2');
  assert.equal(second.type, 'abort_permission_wall');
  assert.equal(second.wallDenials, 2);
  assert.equal(second.tool, 'Bash');

  // Same sequence, non-bypass: Bash never counts, so the wall never trips even
  // after all 5 Bash denials plus the trailing Grep (which alone is only 1).
  const nonBypassState = freshState();
  const nonBypassLimits = { transportLimit: 3, wallLimit: 2, isBypassRun: false };
  const feedNonBypass = (toolName, id) => {
    const sig = classifyRunnerUserMessage(denialText(id));
    sig.deniedToolName = toolName;
    return applyRunnerUserMessage(nonBypassState, sig, nonBypassLimits, null);
  };
  const dan5Sequence = ['Bash', 'Bash', 'Bash', 'Bash', 'Bash', 'Grep'];
  let lastAction = null;
  dan5Sequence.forEach((toolName, i) => {
    lastAction = feedNonBypass(toolName, `toolu_nb_${i}`);
  });
  assert.notEqual(lastAction.type, 'abort_permission_wall');
  assert.equal(nonBypassState.wallDenials, 1); // only the trailing Grep scored
});

// Gate 1 locking test (issue #291). A guard-hook denial (src/guard-hooks.js) must
// NEVER be able to trip the wall, on a bypass run or otherwise. Widening evidence
// to Bash raises the stakes: PreToolUse decisions aggregate deny-wins, so guard
// hooks are live even on bypass runs (BP_GUARD_HOOKS=1 in fly.toml). If a guard
// hook's own reason text were ever mistaken for the external "STOP and wait"
// auto-deny text, a run denied by OUR OWN guard could trip a 20-minute external-
// wall retry — pointless, since retrying our own config never helps. This asserts
// the guard reason strings do not match `classifyRunnerUserMessage`'s
// `isPermissionDenied` predicate (so they never even reach the wall-evidence
// check), and separately confirms they classify as `denialSource: 'guard_hook'`
// rather than `'external_classifier'`.
test('Gate 1: a guard-hook denial can never be counted as wall evidence', () => {
  const guardHookReasons = [
    "tool 'Bash' is not permitted in this run",
    "tool 'WebFetch' is not on the allowlist for this run",
    'write to protected canonical file is not allowed: output/AI-ULT/EZK/EZK-16.usfm',
  ];
  for (const reason of guardHookReasons) {
    const text = JSON.stringify({
      type: 'tool_result',
      is_error: true,
      tool_use_id: 'toolu_guard',
      content: reason,
    });
    const sig = classifyRunnerUserMessage(text);
    // The wall/stall reducer only ever looks at sig.isPermissionDenied — a guard
    // denial must read false there, or it would silently become wall evidence
    // the moment its tool name resolved to something other than Bash.
    assert.equal(sig.isPermissionDenied, false, `guard reason misclassified as external denial: "${reason}"`);
    assert.equal(sig.denialSource, 'guard_hook', `expected denialSource 'guard_hook' for: "${reason}"`);

    // Belt-and-braces: even if isPermissionDenied were somehow true, drive it
    // through the real reducer on a bypass run (the widest-evidence mode) and
    // confirm a single such denial cannot trip the wall.
    sig.deniedToolName = 'Bash';
    const state = freshState();
    const action = applyRunnerUserMessage(state, sig, { transportLimit: 3, wallLimit: 2, isBypassRun: true }, null);
    assert.notEqual(action.type, 'abort_permission_wall');
  }
});
