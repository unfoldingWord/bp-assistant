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
//      case there is nothing to migrate FROM, so legacyStateFile is null — and
//      it is LOGGED, because on the production host this fallback silently
//      reproduces the exact #305 hazard the rest of this file exists to remove.
function resolveStateFile({ skillsRepo, env = process.env, log } = {}) {
  const legacy = skillsRepo ? path.join(skillsRepo, DEFAULT_STATE_REL) : null;
  const explicit = String(env.OVERNIGHT_STATE_FILE || '').trim();
  if (explicit) return { stateFile: explicit, legacyStateFile: legacy };
  const home = String(env.BP_BOT_HOME || '').trim();
  if (home) return { stateFile: path.join(home, DEFAULT_STATE_BASENAME), legacyStateFile: legacy };
  if (log) log(`[overnight] WARNING: neither OVERNIGHT_STATE_FILE nor BP_BOT_HOME is set — falling back to the legacy in-repo state path ${legacy}. That is fine for local dev, but on the bot host it puts the watermark back inside the git checkout (issue #305).`);
  return { stateFile: legacy, legacyStateFile: null };
}

// Does `p` hold a state file we can actually use? Mere existence is not enough:
// a run killed mid-write (ENOSPC, OOM, container stop) can leave a truncated or
// empty file, and treating that as "already migrated" would strand the real
// watermark at the legacy path forever while loadState silently falls back to
// defaultState() and primes the whole backlog away.
function readUsableState(p, readImpl) {
  let raw;
  try { raw = readImpl(p, 'utf8'); } catch (err) { return { present: false, err }; }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { present: true, usable: false, raw };
    return { present: true, usable: true, raw };
  } catch { return { present: true, usable: false, raw }; }
}

// #OVERNIGHT-STATE-LOCATION: one-shot migration off the in-repo path. A real
// watermark already exists on the production volume at the legacy path; if the
// new code simply started reading a new path, the Sensor would cold-start and
// silently prime past everything it has already been primed for.
//
// The legacy file is DELETED after a successful copy, on purpose: leaving it
// behind would leave an untracked file sitting at exactly the path whose future
// tracked twin is the whole hazard in issue #305, so the migration would fix
// nothing.
//
// Every step is defensive, because the failure mode here is losing a watermark
// (and re-priming a real backlog past the point of recovery):
//   - "already migrated" means the destination holds PARSEABLE state, not just
//     that a file exists there — see readUsableState.
//   - the legacy file must parse before it is copied; a corrupt one is left
//     alone, both copies intact, for a human to look at.
//   - the copy lands on a `.tmp` sibling and is renamed into place, so a
//     half-written destination can never be mistaken for a completed migration.
//   - the legacy file is unlinked only after that rename returns.
// A read error on the legacy path that is NOT "file absent" is logged rather
// than swallowed: silently declining to migrate would show up downstream as a
// confident "COLD START (genuine first run)", which is precisely the
// misleading-diagnostic failure #303 was written to kill.
function migrateLegacyStateFile(stateFile, legacyStateFile, {
  readImpl = fs.readFileSync,
  writeImpl = fs.writeFileSync,
  mkdirImpl,
  unlinkImpl = fs.unlinkSync,
  renameImpl = fs.renameSync,
  log = () => {},
} = {}) {
  if (!legacyStateFile || legacyStateFile === stateFile) return false;

  const dest = readUsableState(stateFile, readImpl);
  if (dest.present && dest.usable) return false;
  if (dest.present && !dest.usable) {
    log(`[overnight] WARNING: ${stateFile} exists but does not parse as state — treating it as absent and re-running the migration from ${legacyStateFile} (issue #305).`);
  }

  const src = readUsableState(legacyStateFile, readImpl);
  if (!src.present) {
    // ENOENT is the normal, expected case (already migrated, or never existed).
    // Anything else (EACCES, EIO) is a real problem worth surfacing.
    if (src.err && src.err.code && src.err.code !== 'ENOENT') {
      log(`[overnight] WARNING: could not read the legacy state file ${legacyStateFile} (${src.err.code}: ${src.err.message}) — NOT migrating. If a watermark exists there, this run will look like a cold start (issue #305).`);
    }
    return false;
  }
  if (!src.usable) {
    log(`[overnight] WARNING: legacy state file ${legacyStateFile} does not parse as JSON — leaving both files untouched rather than migrating a corrupt watermark. Inspect it by hand (issue #305).`);
    return false;
  }

  const mkdir = mkdirImpl || ((p) => fs.mkdirSync(p, { recursive: true }));
  mkdir(path.dirname(stateFile));
  const tmp = `${stateFile}.tmp`;
  writeImpl(tmp, src.raw);
  renameImpl(tmp, stateFile);
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
