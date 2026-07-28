'use strict';

// Unit tests for issue #292 — is a permission-denial burst time-clustered or
// skill-correlated?
//
// The headline test is `reproduces #292's evidence table ...`: it encodes the
// exact run/denial timetable from the issue body and asserts the analysis
// refuses to call it skill-correlated. That table is perfectly collinear —
// every deep-issue-id run falls inside a denial window and every other-skill
// run falls outside one — so it cannot distinguish "deep-issue-id's children
// are uncovered by #286's hook" from "the classifier was degraded during those
// two windows". #292 was one careless read away from being closed as a
// diagnosis on that data; this test is the guard against a future change
// quietly making the analyzer answer the question anyway.
//
// Pure/offline: no SDK query, no live pipeline, no permission decision.

const test = require('node:test');
const assert = require('node:assert');

const {
  parseRunLog,
  assessClustering,
  summarizeHookEvidence,
  formatReport,
} = require('../src/denial-clustering');

// --- fixture helpers ----------------------------------------------------------

const MIN = 60 * 1000;

// Build a run log in exactly the shape run-logs.js writes: a `start` event, one
// `tool_use` per call, `tool_result` events (denials carry the #293 attribution
// fields), and an `end` event with the bypass hook counters.
function runLog({
  skill,
  scope,
  startIso,
  durationMin = 5,
  toolCalls = 12,
  denials = [],           // [{ atMin, agentType, attributionKind }]
  bypassHookRegistered = true,
  hookFireWithAgent = null,
  sessionId = null,
}) {
  const t0 = Date.parse(startIso);
  const at = (ms) => new Date(t0 + ms).toISOString();
  const lines = [];
  lines.push(JSON.stringify({
    t: at(0), type: 'start', skill, scope, label: `${scope || ''} ${skill}`.trim(), queryId: 'q1',
  }));
  if (sessionId) lines.push(JSON.stringify({ t: at(1), type: 'session', sessionId }));
  for (let i = 0; i < toolCalls; i += 1) {
    lines.push(JSON.stringify({ t: at(1000 + i), type: 'tool_use', tool: 'Read', id: `tu_${i}` }));
  }
  for (const d of denials) {
    lines.push(JSON.stringify({
      t: at(d.atMin * MIN),
      type: 'tool_result',
      denied: true,
      deniedToolName: d.tool || 'Read',
      denialSource: d.source || 'external_cli',
      agentId: d.agentId || (d.agentType ? 'agent_1' : null),
      agentType: d.agentType || null,
      agentAttributionKind: d.attributionKind || null,
      text: 'STOP what you are doing and wait',
    }));
  }
  lines.push(JSON.stringify({
    t: at(durationMin * MIN),
    type: 'end',
    subtype: denials.length ? 'error_permission' : 'success',
    turnCount: toolCalls,
    totalPermissionDenials: denials.length,
    bypassHookRegistered,
    bypassHookFireCount: toolCalls,
    bypassHookFireWithAgentCount:
      hookFireWithAgent != null ? hookFireWithAgent : denials.filter((d) => d.agentType).length,
  }));
  return lines.join('\n') + '\n';
}

function parse(spec) {
  return parseRunLog(runLog(spec), { file: `${spec.scope || spec.skill}.jsonl` });
}

// --- parsing ------------------------------------------------------------------

test('parseRunLog extracts skill, window, denials and the bypass hook counters', () => {
  const run = parse({
    skill: 'deep-issue-id',
    scope: 'DAN 5',
    startIso: '2026-07-28T11:20:00Z',
    durationMin: 6,
    toolCalls: 9,
    sessionId: '5dacdcdc-d8e4-424a-a953-651c1ee961f8',
    denials: [
      { atMin: 4, agentType: 'analyst', attributionKind: 'exact' },
      { atMin: 4, agentType: 'analyst', attributionKind: 'exact' },
    ],
  });
  assert.strictEqual(run.skill, 'deep-issue-id');
  assert.strictEqual(run.scope, 'DAN 5');
  assert.strictEqual(run.sessionId, '5dacdcdc-d8e4-424a-a953-651c1ee961f8');
  assert.strictEqual(run.toolCallCount, 9);
  assert.strictEqual(run.totalPermissionDenials, 2);
  assert.strictEqual(run.bypassHookRegistered, true);
  assert.strictEqual(run.denials[0].agentType, 'analyst');
  assert.strictEqual(run.endMs - run.startMs, 6 * MIN);
});

test('parseRunLog survives a truncated final line without losing the run', () => {
  // A run killed mid-write (abort/OOM) leaves a half-written line — and those
  // are the runs most worth reading.
  const text = runLog({
    skill: 'deep-issue-id', scope: 'DAN 4', startIso: '2026-07-27T22:55:00Z',
    denials: [{ atMin: 3, agentType: 'analyst', attributionKind: 'exact' }],
  }) + '{"t":"2026-07-27T23:01:0';
  const run = parseRunLog(text);
  assert.strictEqual(run.malformedLines, 1);
  assert.strictEqual(run.skill, 'deep-issue-id');
  assert.strictEqual(run.totalPermissionDenials, 1);
});

test('parseRunLog falls back to counted denials when the run never wrote `end`', () => {
  const text = runLog({
    skill: 'deep-issue-id', startIso: '2026-07-28T11:20:00Z',
    denials: [{ atMin: 2 }, { atMin: 3 }],
  }).split('\n').filter((l) => !l.includes('"end"')).join('\n');
  const run = parseRunLog(text);
  assert.strictEqual(run.totalPermissionDenials, 2);
});

// --- the #292 evidence table --------------------------------------------------

// A denial charged to a spawned Wave-2 analyst, seen and ALLOWED by our own
// PreToolUse hook (attributionKind 'exact') and refused anyway.
const childDenial = { atMin: 3, agentType: 'analyst', attributionKind: 'exact' };
// A denial on the parent thread: no agent_id, so no attribution (sdk.d.ts:174).
const parentDenial = { atMin: 4, agentType: null, attributionKind: null };
const times = (n, d) => Array.from({ length: n }, () => ({ ...d }));

// Every run in the issue body, at its stated UTC time and denial count:
// DAN 4 x3 attempts = 4 each, DAN 5 = 6, everything else clean = 18 total.
// Only DAN 5's parent/child split is stated in the issue ("4 + 1 in the two
// Wave-2 analyst sub-agent transcripts, 1 in the parent"); DAN 4's is not
// broken out, so it follows the issue's "the children are the primary victims".
function issue292Runs() {
  return [
    parse({ skill: 'deep-issue-id', scope: 'DAN 4 a1', startIso: '2026-07-27T22:55:00Z', durationMin: 6, denials: times(4, childDenial) }),
    parse({ skill: 'deep-issue-id', scope: 'DAN 4 a2', startIso: '2026-07-27T23:02:00Z', durationMin: 5, denials: times(4, childDenial) }),
    parse({ skill: 'deep-issue-id', scope: 'DAN 4 a3', startIso: '2026-07-27T23:08:00Z', durationMin: 5, denials: times(4, childDenial) }),
    parse({ skill: 'align-all-parallel', scope: 'EZK 20', startIso: '2026-07-28T00:22:00Z', durationMin: 30, toolCalls: 40 }),
    parse({ skill: 'deep-issue-id', scope: 'DAN 4 rerun', startIso: '2026-07-28T03:16:00Z', durationMin: 12 }),
    parse({ skill: 'tn-writer', scope: 'DAN 4', startIso: '2026-07-28T03:44:00Z', durationMin: 20 }),
    parse({ skill: 'deep-issue-id', scope: 'DAN 5', startIso: '2026-07-28T11:20:00Z', durationMin: 8, denials: [...times(5, childDenial), parentDenial] }),
    parse({ skill: 'initial-pipeline', scope: 'JER 36', startIso: '2026-07-28T14:01:00Z', durationMin: 25, toolCalls: 30 }),
  ];
}

test("reproduces #292's evidence table and refuses to call it skill-correlated", () => {
  const assessment = assessClustering(issue292Runs());

  // 18 denials across 4 runs, exactly as the issue's table totals (4+4+4+6).
  assert.strictEqual(assessment.totalDenials, 18);
  assert.strictEqual(assessment.affectedRuns, 4);

  // The finding: skill and time are collinear, so this sample decides nothing.
  assert.strictEqual(assessment.verdict, 'inconclusive_confounded');
  assert.strictEqual(assessment.counts.confounded, 4);
  assert.strictEqual(assessment.counts.time_clustered, 0);
  assert.strictEqual(assessment.counts.skill_correlated, 0);

  // Concretely: no denial window contained ANY run of a different skill.
  for (const r of assessment.perRun) {
    assert.strictEqual(r.skill, 'deep-issue-id');
    assert.deepStrictEqual(r.otherSkillControls, [], `${r.scope} should have no other-skill control`);
  }

  // And the report must say so in words, not just in a field.
  const report = formatReport(assessment);
  assert.match(report, /INCONCLUSIVE/);
  assert.match(report, /Do NOT conclude either way/);
});

test("#292's table also shows the hook DID fire inside sub-agents and they were denied anyway", () => {
  // 17 of the 18 denials carry an 'exact' attribution: our own PreToolUse
  // allow-all saw that very tool_use_id and returned allow, and it was refused
  // regardless. That kills "the hook doesn't reach deep-issue-id's children"
  // as the mechanism and points at #292's hypothesis 3 / an external refusal.
  const h = summarizeHookEvidence(issue292Runs());
  assert.strictEqual(h.hookReachedSubAgents, true);
  assert.strictEqual(h.deniedDespiteExactHook, 17);
  assert.strictEqual(h.deniedWithNoHookSight, 1);
  assert.strictEqual(h.deniedByAgentType.analyst, 17);
});

// --- the two verdicts a real control produces ---------------------------------

test('a different skill denied in the same window reads as time_clustered', () => {
  const runs = [
    parse({ skill: 'deep-issue-id', scope: 'DAN 5', startIso: '2026-07-28T11:20:00Z', durationMin: 8, denials: [{ atMin: 4 }, { atMin: 5 }] }),
    // align overlaps the burst and is ALSO denied => ambient cause.
    parse({ skill: 'align-all-parallel', scope: 'EZK 20', startIso: '2026-07-28T11:22:00Z', durationMin: 10, denials: [{ atMin: 3 }] }),
  ];
  const assessment = assessClustering(runs);
  assert.strictEqual(assessment.verdict, 'time_clustered');
  assert.match(formatReport(assessment), /AMBIENT/);
  assert.match(formatReport(assessment), /hypothesis 1/);
});

test('a different skill running clean through the same window reads as skill_correlated', () => {
  const runs = [
    parse({ skill: 'deep-issue-id', scope: 'DAN 5', startIso: '2026-07-28T11:20:00Z', durationMin: 8, denials: [{ atMin: 4 }, { atMin: 5 }] }),
    parse({ skill: 'align-all-parallel', scope: 'EZK 20', startIso: '2026-07-28T11:22:00Z', durationMin: 10, toolCalls: 40 }),
  ];
  const assessment = assessClustering(runs);
  assert.strictEqual(assessment.verdict, 'skill_correlated');
  assert.match(formatReport(assessment), /STRUCTURAL/);
});

test('same-skill runs in the window are not controls', () => {
  // DAN 4's three consecutive attempts overlap each other. They are the same
  // skill, so they cannot discriminate skill from time and must not be counted.
  const runs = [
    parse({ skill: 'deep-issue-id', scope: 'a1', startIso: '2026-07-27T22:55:00Z', durationMin: 6, denials: [{ atMin: 3 }] }),
    parse({ skill: 'deep-issue-id', scope: 'a2', startIso: '2026-07-27T22:58:00Z', durationMin: 6, denials: [{ atMin: 3 }] }),
  ];
  const assessment = assessClustering(runs);
  assert.strictEqual(assessment.verdict, 'inconclusive_confounded');
  for (const r of assessment.perRun) {
    assert.ok(r.controls.every((c) => c.sameSkill), 'only same-skill overlaps expected');
  }
});

// --- control eligibility ------------------------------------------------------

test('a non-bypass run is excluded as a control with a stated reason', () => {
  // #292's question is explicitly "same image, same hook". A run without the
  // allow-all registered is denied for ordinary allowlist reasons and proves
  // nothing either way — but it must be reported, not silently dropped.
  const runs = [
    parse({ skill: 'deep-issue-id', startIso: '2026-07-28T11:20:00Z', durationMin: 8, denials: [{ atMin: 4 }] }),
    parse({ skill: 'tn-writer', startIso: '2026-07-28T11:22:00Z', durationMin: 6, bypassHookRegistered: false }),
  ];
  const assessment = assessClustering(runs);
  assert.strictEqual(assessment.verdict, 'inconclusive_confounded');
  const [affected] = assessment.perRun;
  assert.deepStrictEqual(affected.excludedControls.map((e) => e.reason), ['not_a_bypass_run']);
  assert.match(formatReport(assessment), /excluded: tn-writer — not_a_bypass_run/);
});

test('a run that made no tool calls is excluded as a control', () => {
  const runs = [
    parse({ skill: 'deep-issue-id', startIso: '2026-07-28T11:20:00Z', durationMin: 8, denials: [{ atMin: 4 }] }),
    parse({ skill: 'tn-writer', startIso: '2026-07-28T11:22:00Z', durationMin: 6, toolCalls: 0 }),
  ];
  const assessment = assessClustering(runs);
  assert.strictEqual(assessment.perRun[0].excludedControls[0].reason, 'no_tool_calls');
  assert.strictEqual(assessment.verdict, 'inconclusive_confounded');
});

test('the padding window is what admits a nearby control, and is tunable', () => {
  const runs = [
    // denial at 11:24; control skill runs 11:31-11:41.
    parse({ skill: 'deep-issue-id', startIso: '2026-07-28T11:20:00Z', durationMin: 8, denials: [{ atMin: 4 }] }),
    parse({ skill: 'align-all-parallel', startIso: '2026-07-28T11:31:00Z', durationMin: 10, toolCalls: 40 }),
  ];
  // 5-minute default pad ends at 11:29 — no overlap, so: inconclusive.
  assert.strictEqual(assessClustering(runs).verdict, 'inconclusive_confounded');
  // 15-minute pad reaches 11:39 and picks the clean align run up as a control.
  assert.strictEqual(assessClustering(runs, { padMs: 15 * MIN }).verdict, 'skill_correlated');
});

// --- degenerate inputs --------------------------------------------------------

test('a sample with no denials reports no_denials rather than a verdict', () => {
  const assessment = assessClustering([
    parse({ skill: 'align-all-parallel', startIso: '2026-07-28T00:22:00Z' }),
    parse({ skill: 'tn-writer', startIso: '2026-07-28T03:44:00Z' }),
  ]);
  assert.strictEqual(assessment.verdict, 'no_denials');
  assert.strictEqual(assessment.affectedRuns, 0);
  assert.match(formatReport(assessment), /Nothing to assess/);
});

test('mixed evidence is reported as mixed rather than collapsed to one answer', () => {
  const runs = [
    // Window A: ambient — a different skill is denied alongside.
    parse({ skill: 'deep-issue-id', scope: 'A', startIso: '2026-07-28T11:20:00Z', durationMin: 8, denials: [{ atMin: 4 }] }),
    parse({ skill: 'align-all-parallel', scope: 'A', startIso: '2026-07-28T11:22:00Z', durationMin: 8, denials: [{ atMin: 3 }] }),
    // Window B: structural — a different skill runs clean alongside.
    parse({ skill: 'deep-issue-id', scope: 'B', startIso: '2026-07-28T20:00:00Z', durationMin: 8, denials: [{ atMin: 4 }] }),
    parse({ skill: 'tn-writer', scope: 'B', startIso: '2026-07-28T20:02:00Z', durationMin: 8, toolCalls: 30 }),
  ];
  const assessment = assessClustering(runs);
  assert.strictEqual(assessment.verdict, 'mixed');
  assert.ok(assessment.counts.time_clustered > 0 && assessment.counts.skill_correlated > 0);
});

test('per-skill denial totals are aggregated for the reader', () => {
  const assessment = assessClustering(issue292Runs());
  const deep = assessment.bySkill.find((s) => s.skill === 'deep-issue-id');
  assert.strictEqual(deep.denials, 18);
  assert.strictEqual(deep.runsWithDenials, 4);
  assert.strictEqual(deep.runs, 5); // includes the clean re-run
  const align = assessment.bySkill.find((s) => s.skill === 'align-all-parallel');
  assert.strictEqual(align.denials, 0);
});
