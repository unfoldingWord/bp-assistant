// overnight-review-state.js — idempotent state for the overnight Sensor.
//
// Each review unit is keyed by MERGED-PR id + content headSha (a re-push of the
// same PR gets a new sha → a new unit), so re-running the Sensor never
// double-reviews. Live `-be-` branches are keyed by branch + tip sha. Cold start
// (no state yet) records all current HEADs as "seen" and reviews NOTHING on
// night 1 — otherwise the first run would try to review the entire merge
// history.
//
// #OVERNIGHT-STATE-LOCATION (issue #305): the state file lives on the bot's
// persistent volume (`${BP_BOT_HOME}/overnight-review-state.json`), NOT inside
// the bp-assistant-skills checkout. It used to live at
// `<skillsRepo>/data/overnight-review/state.json` (DEFAULT_STATE_REL below,
// kept only as the legacy path to migrate off of), and that was a trap:
//   - Dry-run mode writes into the volume's checkout, where the file is
//     UNTRACKED. That is what makes the #303 persistence fix work today.
//   - PR mode runs in a fresh worktree off origin/main and COMMITS its output.
// The first time PR mode committed state.json to main, the volume's checkout
// would hold an untracked file at a path with a tracked file incoming, and the
// hourly `git pull --ff-only` in the automation repo's sync_repo would fail
// with "untracked working tree file would be overwritten by merge" — jamming
// EVERY hourly wake for EVERY run mode until a human SSHed in.
// One path, outside git, for both modes removes the collision by construction.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const STATE_VERSION = 1;
// Legacy in-repo location — read once for migration, never written again.
const DEFAULT_STATE_REL = 'data/overnight-review/state.json';
const DEFAULT_STATE_BASENAME = 'overnight-review-state.json';

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

// #OVERNIGHT-STATE-LOCATION: where does state.json live for this run?
// Resolution order, deliberately mode-INDEPENDENT (dry-run and PR mode must
// agree, or they reintroduce the collision described at the top of this file):
//   1. OVERNIGHT_STATE_FILE — explicit override, for operators and tests.
//   2. ${BP_BOT_HOME}/overnight-review-state.json — production. BP_BOT_HOME is
//      exported by the automation repo's host-cron-bootstrap.sh, so the Sensor
//      sees it in both modes.
//   3. Fall back to the legacy in-repo path when neither is set (local dev and
//      the existing unit tests, where there is no volume to write to). In that
//      case there is nothing to migrate FROM, so legacyStateFile is null.
function resolveStateFile({ skillsRepo, env = process.env } = {}) {
  const legacy = skillsRepo ? path.join(skillsRepo, DEFAULT_STATE_REL) : null;
  const explicit = String(env.OVERNIGHT_STATE_FILE || '').trim();
  if (explicit) return { stateFile: explicit, legacyStateFile: legacy };
  const home = String(env.BP_BOT_HOME || '').trim();
  if (home) return { stateFile: path.join(home, DEFAULT_STATE_BASENAME), legacyStateFile: legacy };
  return { stateFile: legacy, legacyStateFile: null };
}

// #OVERNIGHT-STATE-LOCATION: one-shot migration off the in-repo path. A real
// watermark already exists on the production volume at the legacy path; if the
// new code simply started reading a new path, the Sensor would cold-start and
// silently prime past everything it has already been primed for.
//
// The legacy file is DELETED after a successful copy, on purpose: leaving it
// behind would leave an untracked file sitting at exactly the path whose future
// tracked twin is the whole hazard in issue #305, so the migration would fix
// nothing. Copy first, unlink second — if the copy throws, the old file is
// still there and the next run retries; if only the unlink fails, we have the
// watermark and log loudly enough for someone to remove the file by hand.
function migrateLegacyStateFile(stateFile, legacyStateFile, {
  readImpl = fs.readFileSync,
  writeImpl = fs.writeFileSync,
  mkdirImpl,
  unlinkImpl = fs.unlinkSync,
  log = () => {},
} = {}) {
  if (!legacyStateFile || legacyStateFile === stateFile) return false;
  try { readImpl(stateFile, 'utf8'); return false; } catch { /* new location empty — continue */ }
  let raw;
  try { raw = readImpl(legacyStateFile, 'utf8'); } catch { return false; }
  const mkdir = mkdirImpl || ((p) => fs.mkdirSync(p, { recursive: true }));
  mkdir(path.dirname(stateFile));
  writeImpl(stateFile, raw);
  try {
    unlinkImpl(legacyStateFile);
  } catch (err) {
    log(`[overnight] WARNING: migrated state to ${stateFile} but could not remove the legacy file ${legacyStateFile} (${(err && err.message) || err}). Remove it by hand — an untracked file at that path will break \`git pull --ff-only\` on the skills checkout once PR mode commits one (issue #305).`);
    return true;
  }
  log(`[overnight] migrated state file out of the git checkout: ${legacyStateFile} → ${stateFile} (issue #305); legacy file removed.`);
  return true;
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
  migrateLegacyStateFile,
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
