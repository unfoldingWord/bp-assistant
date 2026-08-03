// pipeline-liveness.js — the single answer to "is this 'running' checkpoint
// actually still alive?"
//
// This exists because that question used to be answered in three places with
// two different heuristics. /health/pipelines (mcp-server.js) and the resume
// path (router.js) both tested "last written before this process started";
// the job-status endpoint that bible-editor polls (api/pipeline.js) instead
// used a 12h staleness window while its comment claimed to mirror the other
// two. On 2026-08-03 a fly.io restart killed an in-flight NUM 27 notes run:
// /health/pipelines correctly reported interrupted, job-status reported
// healthy, and bible-editor held a chapter lock for ~3h until it was
// force-failed by hand. Keep all three call sites on this module so the
// heuristics cannot drift apart again.
//
// Deliberately a leaf module: it requires nothing from the codebase, so both
// mcp-server.js and router.js can depend on it without a require cycle
// (index.js loads mcp-server before router).

// Frozen at first require, which is process start for every real caller.
const MODULE_LOADED_AT_MS = Date.now();

// A single skill invocation can legitimately run to MAX_TIMEOUT_MS (150 min,
// pipeline-utils.js) without writing a checkpoint, and a full `generate` run
// can take ~4h end to end. This window only has to exceed the longest silent
// GAP between checkpoint writes, not the run length — 6h gives ~2.4x headroom
// over that 150-min gap while still being half of the old 12h.
const WEDGE_STALENESS_MS = 6 * 60 * 60 * 1000;

/**
 * Wall-clock this process started, in ms.
 *
 * Read from the environment on every call rather than frozen alongside
 * MODULE_LOADED_AT_MS so a test can pin it without clearing the require
 * cache. Production never sets PROCESS_STARTED_AT_MS, so it resolves to the
 * module load time — the same value the previous inline constants used.
 */
function getProcessStartedAtMs() {
  const fromEnv = Number(process.env.PROCESS_STARTED_AT_MS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : MODULE_LOADED_AT_MS;
}

/**
 * True when a checkpoint claiming state 'running' cannot actually be running.
 *
 * Two independent signals, OR'd, because neither alone is sufficient:
 *  - Written before this process started => the in-memory pipeline that owned
 *    it is gone (restart, crash, OOM kill). This is the precise signal and
 *    fires immediately.
 *  - Untouched for longer than WEDGE_STALENESS_MS => the run wedged while the
 *    process stayed up (hung API call, runaway skill loop). No restart-based
 *    test can see this case.
 *
 * Callers pass the raw checkpoint; a non-running or unparseable checkpoint is
 * never reported interrupted.
 *
 * @param {{ state?: string, updatedAt?: string }} cp
 * @param {number} [nowMs]
 * @returns {boolean}
 */
function isInterruptedRunningCheckpoint(cp, nowMs = Date.now()) {
  if (!cp || cp.state !== 'running') return false;
  const updatedMs = Date.parse(cp.updatedAt || '');
  if (!Number.isFinite(updatedMs)) return false;
  if (updatedMs < getProcessStartedAtMs()) return true;
  return (nowMs - updatedMs) > WEDGE_STALENESS_MS;
}

module.exports = {
  getProcessStartedAtMs,
  isInterruptedRunningCheckpoint,
  WEDGE_STALENESS_MS,
};
