// overnight-review-state.js — idempotent state for the overnight Sensor.
//
// Each review unit is keyed by MERGED-PR id + content headSha (a re-push of the
// same PR gets a new sha → a new unit), so re-running the Sensor never
// double-reviews. Live `-be-` branches are keyed by branch + tip sha. Cold
// start (no state yet) records all current HEADs as "seen" and reviews NOTHING
// on night 1 — otherwise the first run would try to review the entire merge
// history.
//
// #OVERNIGHT-STATE-LOCATION: the state file lives on the VOLUME, OUTSIDE any
// git checkout — ${BP_BOT_HOME}/overnight-review-state.json. It used to live at
// bp-assistant-skills/data/overnight-review/state.json, inside the skills
// checkout, on the theory that the wake machine's disk is ephemeral and only
// git survives. That premise is wrong: BP_BOT_HOME is a mounted volume (see
// fly.toml `[[mounts]] destination = "/data"`), which is exactly why the
// wrapper can clone the repos there once and `pull --ff-only` them on later
// wakes — and why a dry run's untracked state.json survived between runs at
// all.
//
// Keeping it in the checkout was actively dangerous, because the Sensor's two
// modes write to two different checkouts on the same volume:
//   - dry-run (OVERNIGHT_PR_ENABLED unset) writes into the volume checkout,
//     where the file is UNTRACKED;
//   - PR mode runs in a fresh worktree off origin/main and COMMITS its output
//     dir, which would put a TRACKED file at that same path on main.
// The first hourly `git pull --ff-only` after such a merge dies with "untracked
// working tree file would be overwritten by merge" — and sync_repo runs on
// every hourly wake for every RUN_MODE, so that jams the whole automation, not
// just the nightly loop, until someone SSHes in and deletes the file.
//
// Out-of-checkout also means (a) the watermark is continuous across a flip of
// OVERNIGHT_PR_ENABLED instead of cold-starting, and (b) PR mode's nightly
// commit contains only the proposal/review-task feed — the reviewable output —
// rather than a state bump. Do not move this back inside a checkout.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const STATE_VERSION = 1;
// Legacy in-checkout location. Retained ONLY so an existing deployment's
// watermark can be migrated out of the checkout once (see loadStateWithMigration).
const DEFAULT_STATE_REL = 'data/overnight-review/state.json';
const DEFAULT_STATE_BASENAME = 'overnight-review-state.json';

// Resolve where state.json should live. Order: explicit override → env override
// → the volume home (the normal production answer) → legacy in-checkout path
// (only when BP_BOT_HOME is unset, e.g. a bare unit-test or a local one-off).
function resolveStateFile({ skillsRepo, stateFile, env = process.env } = {}) {
  if (stateFile) return stateFile;
  if (env.OVERNIGHT_STATE_FILE) return env.OVERNIGHT_STATE_FILE;
  if (env.BP_BOT_HOME) return path.join(env.BP_BOT_HOME, DEFAULT_STATE_BASENAME);
  return path.join(skillsRepo, DEFAULT_STATE_REL);
}

// The legacy path for a given checkout, or null when the resolved location is
// already the legacy one (nothing to migrate from).
function legacyStateFileFor(skillsRepo, stateFile) {
  if (!skillsRepo) return null;
  const legacy = path.join(skillsRepo, DEFAULT_STATE_REL);
  return legacy === stateFile ? null : legacy;
}

// Load state, falling back to the legacy in-checkout file exactly once so an
// already-running deployment keeps its watermark instead of cold-starting (a
// cold start would silently prime the whole accumulated backlog away).
// Reports which file it came from so the caller can log the migration and
// delete the legacy copy — deleting it is the point, not a tidy-up: an
// untracked file at a path that may become tracked is the collision hazard.
function loadStateWithMigration(stateFile, legacyFile, { readImpl = fs.readFileSync } = {}) {
  const exists = (p) => {
    if (!p) return false;
    try { readImpl(p, 'utf8'); return true; } catch { return false; }
  };
  if (exists(stateFile)) {
    return { state: loadState(stateFile, readImpl), source: 'primary', legacyPresent: exists(legacyFile) };
  }
  if (exists(legacyFile)) {
    return { state: loadState(legacyFile, readImpl), source: 'legacy', legacyPresent: true };
  }
  return { state: defaultState(), source: 'none', legacyPresent: false };
}

function defaultState() {
  return { version: STATE_VERSION, initialized: false, lastRun: null, reviewed: {}, branchTips: {} };
}

function loadState(stateFile, readImpl = fs.readFileSync) {
  let raw;
  try { raw = readImpl(stateFile, 'utf8'); } catch { return defaultState(); }
  try {
    const s = JSON.parse(raw);
    return {
      version: s.version || STATE_VERSION,
      initialized: !!s.initialized,
      lastRun: s.lastRun || null,
      reviewed: s.reviewed && typeof s.reviewed === 'object' ? s.reviewed : {},
      branchTips: s.branchTips && typeof s.branchTips === 'object' ? s.branchTips : {},
    };
  } catch { return defaultState(); }
}

function saveState(stateFile, state, { writeImpl = fs.writeFileSync, mkdirImpl } = {}) {
  const mkdir = mkdirImpl || ((p) => fs.mkdirSync(p, { recursive: true }));
  mkdir(path.dirname(stateFile));
  writeImpl(stateFile, JSON.stringify(state, null, 2) + '\n');
}

// Stable unit key for a merged PR: repo#prId@headSha.
function prUnitKey(repo, prId, headSha) {
  return `${repo}#${prId}@${String(headSha || '').slice(0, 12)}`;
}

// Stable unit key for a live (unmerged) branch: repo:branch@tipSha.
function branchUnitKey(repo, branch, tipSha) {
  return `${repo}:${branch}@${String(tipSha || '').slice(0, 12)}`;
}

function isReviewed(state, key) {
  return Object.prototype.hasOwnProperty.call(state.reviewed, key);
}

function markReviewed(state, key, now = new Date()) {
  state.reviewed[key] = now.toISOString();
  return state;
}

function isColdStart(state) {
  return !state.initialized;
}

// On cold start, record every current unit as already-seen (so night 1 reviews
// nothing) and flip initialized. Subsequent runs only see genuinely new units.
function primeColdStart(state, unitKeys, now = new Date()) {
  for (const k of unitKeys) state.reviewed[k] = now.toISOString();
  state.initialized = true;
  state.lastRun = now.toISOString();
  return state;
}

module.exports = {
  STATE_VERSION,
  DEFAULT_STATE_REL,
  DEFAULT_STATE_BASENAME,
  resolveStateFile,
  legacyStateFileFor,
  loadStateWithMigration,
  defaultState,
  loadState,
  saveState,
  prUnitKey,
  branchUnitKey,
  isReviewed,
  markReviewed,
  isColdStart,
  primeColdStart,
};
