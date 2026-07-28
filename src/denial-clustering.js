// denial-clustering.js — decide whether permission denials are TIME-clustered
// or SKILL-correlated, from the durable run logs on the volume.
//
// Why this exists (issue #292). #286 moved the bypass allow-all onto a
// PreToolUse hook "because that surface runs for every tool call in the session
// tree — children included." #292 then recorded that align-all-parallel's
// children see zero denials while deep-issue-id's Wave-2 analysts still get
// refused, on the same image with the same hook, and asked why.
//
// The answer to that question was never derivable from the evidence offered,
// and the reason is worth stating precisely, because it is the trap this module
// exists to stop: in #292's own table every deep-issue-id run sits inside a
// denial window (07-27 22:55-23:17, 07-28 11:20) and every other-skill run
// (align 00:22, tn-writer 03:44, initial-pipeline 14:01) sits outside one.
// Skill and time are perfectly collinear there, so the table is equally
// consistent with "deep-issue-id's children aren't covered" and with "the
// classifier was degraded during those two windows and deep-issue-id merely
// happened to be what was running." No amount of re-reading that table
// separates them.
//
// What separates them is a CONTROL: a run of a DIFFERENT skill that overlaps a
// denial window. If it was also denied, the cause is time (hypothesis 1 in
// #292 — the load-degraded classifier, nothing skill-specific to fix). If it
// sailed through clean, the cause really is structural and the hunt for a
// spawn-shape difference is justified. If no such run exists, the honest
// verdict is INCONCLUSIVE, and the fix is to keep looking, not to guess.
//
// So the headline verdict here is deliberately three-valued. A two-valued
// answer would have to call #292's data "skill_correlated", which is exactly
// the unsupported conclusion that made the issue an open question instead of a
// diagnosis.
//
// Everything here is pure and offline: it reads run logs written by
// run-logs.js. It never touches a live run and never makes a permission
// decision.

'use strict';

const fs = require('fs');
const path = require('path');

// How far on either side of a denial the classifier is presumed to have been in
// the same state. Denials in #292 arrive in bursts of 4-6 inside a single run,
// and the runs that bracket them are minutes away, so a few minutes of padding
// is what turns "no control overlapped" into "a control overlapped". Too large
// and unrelated runs get swept in as controls; too small and genuine controls
// are missed. Tunable per call.
const DEFAULT_PAD_MS = 5 * 60 * 1000;

// A control run only counts as evidence if it was actually exposed to the same
// permission surface during the window. Two filters, both necessary:
//
//   * it must have made tool calls (a run that called nothing cannot have been
//     denied, so its clean record proves nothing), and
//   * it must be a bypass run with the allow-all hook registered (#292's
//     question is explicitly "on the same image with the same hook"; a
//     non-bypass run keeps the restrictive decider and is denied for entirely
//     ordinary allowlist reasons).
//
// Runs excluded by these filters are counted and reported rather than silently
// dropped — "no control overlapped" and "controls overlapped but none
// qualified" are different findings and a reader must be able to tell them
// apart.
const DEFAULT_MIN_CONTROL_TOOL_CALLS = 1;

// --- parsing -----------------------------------------------------------------

function toMs(t) {
  if (!t) return null;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : null;
}

// Parse one run log's JSONL text into the run shape the assessment consumes.
// Defensive by design: run logs are appended by a live pipeline and a run that
// was killed mid-write leaves a truncated final line. A parse failure on any
// line skips that line rather than losing the whole run — a run log that ends
// abruptly is usually the most interesting one in the directory.
function parseRunLog(text, { file = null } = {}) {
  const run = {
    file,
    skill: null,
    label: null,
    pipelineType: null,
    scope: null,
    startMs: null,
    endMs: null,
    toolCallCount: 0,
    denials: [],
    totalPermissionDenials: null,
    bypassHookRegistered: null,
    bypassHookFireCount: null,
    bypassHookFireWithAgentCount: null,
    subtype: null,
    sessionId: null,
    malformedLines: 0,
  };
  const lines = String(text || '').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let ev;
    try {
      ev = JSON.parse(trimmed);
    } catch (_) {
      run.malformedLines += 1;
      continue;
    }
    if (!ev || typeof ev !== 'object') continue;
    const tMs = toMs(ev.t);
    if (tMs != null) {
      if (run.startMs == null || tMs < run.startMs) run.startMs = tMs;
      if (run.endMs == null || tMs > run.endMs) run.endMs = tMs;
    }
    switch (ev.type) {
      case 'start':
        run.skill = ev.skill || run.skill;
        run.label = ev.label || run.label;
        run.pipelineType = ev.pipelineType || run.pipelineType;
        run.scope = ev.scope || run.scope;
        break;
      case 'session':
        run.sessionId = ev.sessionId || run.sessionId;
        break;
      case 'tool_use':
        run.toolCallCount += 1;
        break;
      case 'tool_result':
        if (ev.denied) {
          run.denials.push({
            tMs,
            tool: ev.deniedToolName || null,
            source: ev.denialSource || null,
            agentId: ev.agentId || null,
            agentType: ev.agentType || null,
            // 'exact' means our own PreToolUse allow-all hook saw this very
            // tool_use_id and returned allow — yet it was refused anyway. That
            // is a materially different finding from no attribution at all
            // (the hook never saw the call), and it is the discriminator #292
            // asked for. See summarizeHookEvidence.
            attributionKind: ev.agentAttributionKind || null,
          });
        }
        break;
      case 'end':
        if (ev.totalPermissionDenials != null) run.totalPermissionDenials = ev.totalPermissionDenials;
        if (ev.bypassHookRegistered != null) run.bypassHookRegistered = ev.bypassHookRegistered;
        if (ev.bypassHookFireCount != null) run.bypassHookFireCount = ev.bypassHookFireCount;
        if (ev.bypassHookFireWithAgentCount != null) {
          run.bypassHookFireWithAgentCount = ev.bypassHookFireWithAgentCount;
        }
        if (ev.subtype != null) run.subtype = ev.subtype;
        break;
      default:
        break;
    }
  }
  // `end` carries the authoritative count; fall back to what we counted from
  // the stream when a run died before writing it (abort, OOM, killed machine)
  // — precisely the runs #292 is about.
  if (run.totalPermissionDenials == null) run.totalPermissionDenials = run.denials.length;
  return run;
}

// Walk a run-log tree (day-directories of JSONL files, as run-logs.js writes
// them) and parse every run. Accepts a flat directory too, so a hand-assembled
// evidence folder works without reshaping.
function loadRunLogs(dir, { fsImpl = fs } = {}) {
  const runs = [];
  const walk = (d) => {
    let entries;
    try {
      entries = fsImpl.readdirSync(d, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          runs.push(parseRunLog(fsImpl.readFileSync(full, 'utf8'), { file: full }));
        } catch (_) { /* unreadable file: skip, never abort the sweep */ }
      }
    }
  };
  walk(dir);
  runs.sort((a, b) => (a.startMs || 0) - (b.startMs || 0));
  return runs;
}

// --- assessment ---------------------------------------------------------------

function overlaps(aStart, aEnd, bStart, bEnd) {
  if (aStart == null || aEnd == null || bStart == null || bEnd == null) return false;
  return aStart <= bEnd && bStart <= aEnd;
}

function skillOf(run) {
  return run.skill || run.label || run.file || 'unknown';
}

// Was this run a usable control — i.e. would it have shown a denial if the
// cause were ambient rather than skill-specific?
function controlEligibility(run, { minToolCalls }) {
  if (run.bypassHookRegistered !== true) {
    return { eligible: false, reason: 'not_a_bypass_run' };
  }
  if (run.toolCallCount < minToolCalls) {
    return { eligible: false, reason: 'no_tool_calls' };
  }
  return { eligible: true, reason: null };
}

// The core discriminator, per affected run.
//
// Verdicts:
//   'time_clustered'  — a different skill overlapped this denial window and was
//                       ALSO denied. Ambient cause; nothing skill-shaped to fix.
//   'skill_correlated'— different skills overlapped and came through CLEAN.
//                       Structural difference is real; go diff the spawn shapes.
//   'confounded'      — no eligible different-skill run overlapped at all. The
//                       window says nothing either way. This is #292's case.
function assessRun(affected, allRuns, { padMs, minToolCalls }) {
  const denialTimes = affected.denials.map((d) => d.tMs).filter((t) => t != null);
  const first = denialTimes.length ? Math.min(...denialTimes) : affected.startMs;
  const last = denialTimes.length ? Math.max(...denialTimes) : affected.endMs;
  const windowStart = first == null ? null : first - padMs;
  const windowEnd = last == null ? null : last + padMs;

  const controls = [];
  const excluded = [];
  for (const other of allRuns) {
    if (other === affected) continue;
    if (!overlaps(windowStart, windowEnd, other.startMs, other.endMs)) continue;
    const sameSkill = skillOf(other) === skillOf(affected);
    const { eligible, reason } = controlEligibility(other, { minToolCalls });
    const entry = {
      file: other.file,
      skill: skillOf(other),
      sameSkill,
      denials: other.totalPermissionDenials,
      toolCallCount: other.toolCallCount,
    };
    if (eligible) controls.push(entry);
    else excluded.push({ ...entry, reason });
  }

  const otherSkillControls = controls.filter((c) => !c.sameSkill);
  const otherSkillDenied = otherSkillControls.filter((c) => c.denials > 0);

  let verdict;
  if (otherSkillControls.length === 0) verdict = 'confounded';
  else if (otherSkillDenied.length > 0) verdict = 'time_clustered';
  else verdict = 'skill_correlated';

  return {
    file: affected.file,
    skill: skillOf(affected),
    scope: affected.scope,
    sessionId: affected.sessionId,
    denials: affected.totalPermissionDenials,
    windowStart,
    windowEnd,
    verdict,
    controls,
    otherSkillControls,
    otherSkillDenied,
    excludedControls: excluded,
  };
}

// Does the evidence say the allow-all hook reached the sub-agents at all?
//
// This is #292's "capture a run with SDK hook-level logging to see whether
// bypassAllowAllMatcher is invoked at all for a Wave-2 analyst's tool call" —
// except the logging already exists (#293/#296 record agent_id/agent_type and
// the hook fire counters on every bypass run), and nothing was reading it back.
//
// Read the two signals together:
//
//   hookReachedSubAgents  — the hook fired at least once with an agent_id, so
//                           it demonstrably runs inside spawned children.
//   deniedDespiteExactHook— a denial whose tool_use_id our hook had already
//                           seen AND allowed. The hook fired for that exact
//                           call and something downstream refused it anyway,
//                           which kills "the hook doesn't cover children" and
//                           points at #292's hypothesis 3 (override) or an
//                           account-level refusal above this process.
//   deniedWithNoHookSight — a denial the hook never saw. Consistent with the
//                           hook not reaching that child at all (hypothesis 2).
function summarizeHookEvidence(runs) {
  let hookRegisteredRuns = 0;
  let hookFiredWithAgent = 0;
  let deniedDespiteExactHook = 0;
  let deniedWithNoHookSight = 0;
  let deniedHeuristicOnly = 0;
  const subAgentTypes = new Map();

  for (const run of runs) {
    if (run.bypassHookRegistered === true) hookRegisteredRuns += 1;
    if (run.bypassHookFireWithAgentCount > 0) hookFiredWithAgent += 1;
    for (const d of run.denials) {
      if (d.attributionKind === 'exact') deniedDespiteExactHook += 1;
      else if (d.attributionKind) deniedHeuristicOnly += 1;
      else deniedWithNoHookSight += 1;
      if (d.agentType) subAgentTypes.set(d.agentType, (subAgentTypes.get(d.agentType) || 0) + 1);
    }
  }
  return {
    hookRegisteredRuns,
    hookFiredWithAgent,
    deniedDespiteExactHook,
    deniedWithNoHookSight,
    deniedHeuristicOnly,
    deniedByAgentType: Object.fromEntries(subAgentTypes),
    hookReachedSubAgents: hookFiredWithAgent > 0,
  };
}

// Roll the per-run verdicts into one answer, plus the per-skill denial rates a
// reader will want next.
//
// The overall verdict stays three-valued for the reason in the module header:
// when every affected run is confounded there is no honest binary answer, and
// reporting one is how #292 nearly became a diagnosis on collinear data.
function assessClustering(runs, {
  padMs = DEFAULT_PAD_MS,
  minControlToolCalls = DEFAULT_MIN_CONTROL_TOOL_CALLS,
} = {}) {
  const opts = { padMs, minToolCalls: minControlToolCalls };
  const affected = runs.filter((r) => (r.totalPermissionDenials || 0) > 0);
  const perRun = affected.map((r) => assessRun(r, runs, opts));

  const counts = { time_clustered: 0, skill_correlated: 0, confounded: 0 };
  for (const r of perRun) counts[r.verdict] += 1;

  let verdict;
  if (perRun.length === 0) verdict = 'no_denials';
  else if (counts.time_clustered > 0 && counts.skill_correlated > 0) verdict = 'mixed';
  else if (counts.time_clustered > 0) verdict = 'time_clustered';
  else if (counts.skill_correlated > 0) verdict = 'skill_correlated';
  else verdict = 'inconclusive_confounded';

  const bySkill = new Map();
  for (const run of runs) {
    const key = skillOf(run);
    const cur = bySkill.get(key) || { skill: key, runs: 0, denials: 0, runsWithDenials: 0 };
    cur.runs += 1;
    cur.denials += run.totalPermissionDenials || 0;
    if ((run.totalPermissionDenials || 0) > 0) cur.runsWithDenials += 1;
    bySkill.set(key, cur);
  }

  return {
    verdict,
    counts,
    totalRuns: runs.length,
    affectedRuns: perRun.length,
    totalDenials: runs.reduce((n, r) => n + (r.totalPermissionDenials || 0), 0),
    padMs,
    perRun,
    bySkill: [...bySkill.values()].sort((a, b) => b.denials - a.denials),
    hookEvidence: summarizeHookEvidence(runs),
  };
}

// --- reporting ---------------------------------------------------------------

const VERDICT_GUIDANCE = {
  time_clustered:
    'Denials are AMBIENT: other skills running in the same windows were denied too.\n' +
    '  => This matches #292 hypothesis 1 (load-degraded classifier). There is no\n' +
    '     skill-shaped bug to fix; spend the effort on survivability (retry/backoff,\n' +
    '     honest reporting) rather than on diffing spawn shapes.',
  skill_correlated:
    'Denials are STRUCTURAL: other skills ran clean through the same windows.\n' +
    '  => #292 hypothesis 2/3 survives. Diff the affected skill\'s child-spawn shape\n' +
    '     (Agent vs Task, per-agent permissionMode, nesting depth) against a clean one.',
  mixed:
    'Both patterns present across the sample — some windows ambient, some not.\n' +
    '  => Split the sample and re-run per window before concluding anything.',
  inconclusive_confounded:
    'INCONCLUSIVE. Every denial window contained NO eligible run of a different\n' +
    '  skill, so skill and time are perfectly collinear in this sample and it cannot\n' +
    '  distinguish "this skill\'s children are uncovered" from "the classifier was\n' +
    '  degraded just then". This is exactly the shape of the evidence table in #292.\n' +
    '  => Do NOT conclude either way. Get a control: run a second skill concurrently\n' +
    '     with the affected one, or widen the window/sample until one overlaps.',
  no_denials:
    'No permission denials in the sample. Nothing to assess.',
};

function fmtTime(ms) {
  return ms == null ? '?' : new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

function formatReport(assessment) {
  const out = [];
  out.push('=== permission-denial clustering (issue #292) ===');
  out.push(`runs=${assessment.totalRuns} affected=${assessment.affectedRuns} ` +
    `denials=${assessment.totalDenials} pad=${Math.round(assessment.padMs / 1000)}s`);
  out.push('');
  out.push(`VERDICT: ${assessment.verdict}`);
  out.push(`  ${VERDICT_GUIDANCE[assessment.verdict] || ''}`);
  out.push('');

  const h = assessment.hookEvidence;
  out.push('--- bypass allow-all hook (#286/#293) ---');
  out.push(`  bypass runs with hook registered : ${h.hookRegisteredRuns}`);
  out.push(`  runs where hook fired for a CHILD: ${h.hookFiredWithAgent} ` +
    `(reached sub-agents: ${h.hookReachedSubAgents ? 'YES' : 'NO / not observed'})`);
  out.push(`  denials our hook had ALLOWED     : ${h.deniedDespiteExactHook} ` +
    '(hook fired for that exact call, refused anyway => override/external, not coverage)');
  out.push(`  denials the hook never saw       : ${h.deniedWithNoHookSight} ` +
    '(consistent with the hook not reaching that child)');
  if (h.deniedHeuristicOnly) out.push(`  denials attributed heuristically : ${h.deniedHeuristicOnly}`);
  const types = Object.entries(h.deniedByAgentType);
  if (types.length) {
    out.push(`  denied sub-agent types           : ${types.map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }
  out.push('');

  out.push('--- per skill ---');
  for (const s of assessment.bySkill) {
    out.push(`  ${s.skill}: ${s.denials} denial(s) across ${s.runsWithDenials}/${s.runs} run(s)`);
  }
  out.push('');

  out.push('--- affected runs ---');
  for (const r of assessment.perRun) {
    out.push(`  [${r.verdict}] ${r.skill}${r.scope ? ` (${r.scope})` : ''} — ${r.denials} denial(s)`);
    out.push(`      window ${fmtTime(r.windowStart)} .. ${fmtTime(r.windowEnd)} UTC`);
    if (r.sessionId) out.push(`      session ${r.sessionId}`);
    if (r.otherSkillControls.length === 0) {
      out.push('      controls: NONE — no eligible different-skill run overlapped this window');
    } else {
      for (const c of r.otherSkillControls) {
        out.push(`      control: ${c.skill} — ${c.denials} denial(s), ${c.toolCallCount} tool call(s)`);
      }
    }
    for (const e of r.excludedControls) {
      out.push(`      (excluded: ${e.skill} — ${e.reason})`);
    }
  }
  return out.join('\n');
}

module.exports = {
  DEFAULT_PAD_MS,
  DEFAULT_MIN_CONTROL_TOOL_CALLS,
  parseRunLog,
  loadRunLogs,
  assessRun,
  assessClustering,
  summarizeHookEvidence,
  formatReport,
  VERDICT_GUIDANCE,
};
