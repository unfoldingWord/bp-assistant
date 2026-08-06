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
// "Parses as JSON" is too weak a bar: `[]`, `{}` and `null` all parse, and all
// of them make loadState return defaultState() — i.e. a cold start that primes
// the backlog away. Require something that actually looks like state.
function readUsableState(p, readImpl) {
  let raw;
  try { raw = readImpl(p, 'utf8'); } catch (err) { return { present: false, err }; }
  try {
    const parsed = JSON.parse(raw);
    const looksLikeState = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      && (parsed.version !== undefined || parsed.reviewed !== undefined || parsed.initialized !== undefined);
    return { present: true, usable: !!looksLikeState, raw };
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
//
// Returns one of:
//   'noop'     — nothing to do (already migrated, or no legacy file).
//   'migrated' — the watermark moved; the legacy file is gone (or logged).
//   'blocked'  — a legacy file EXISTS but could not be migrated (unreadable or
//                corrupt). The caller MUST NOT continue: with no state at the
//                new path the run would cold-start, prime the entire enumerated
//                backlog as already-seen — irreversibly — and report it as a
//                "genuine first run". That is the exact misleading diagnostic
//                #303 was written to kill, and it would be caused by a
//                transient, operator-fixable condition. Failing the run instead
//                persists nothing and retries next hour.
function migrateLegacyStateFile(stateFile, legacyStateFile, {
  readImpl = fs.readFileSync,
  writeImpl = fs.writeFileSync,
  mkdirImpl,
  unlinkImpl = fs.unlinkSync,
  renameImpl = fs.renameSync,
  log = () => {},
} = {}) {
  if (!legacyStateFile || legacyStateFile === stateFile) return 'noop';

  const dest = readUsableState(stateFile, readImpl);
  // A read error on the DESTINATION that is not "file absent" must fail closed
  // too, and this asymmetry was a live data-loss bug: readUsableState reports
  // `present: false` for any errno, so an EACCES/EIO on the volume file made a
  // perfectly current watermark look absent — and the migration would then
  // overwrite it with the older legacy copy and delete the legacy original,
  // reporting success. We cannot tell "no state here" from "cannot read the
  // state here", so we must not write.
  if (!dest.present && dest.err && dest.err.code && dest.err.code !== 'ENOENT') {
    log(`[overnight] could not read the state file ${stateFile} (${dest.err.code}: ${dest.err.message}) — refusing to migrate over a file we cannot read (issue #305).`);
    return 'blocked';
  }
  if (dest.present && dest.usable) {
    // Already migrated — but a legacy file can still be sitting in the checkout
    // (e.g. an earlier run declined to migrate it and then cold-started, which
    // wrote a fresh state at the new path). Returning here without looking
    // would leave the untracked file that IS the #305 hazard in place forever,
    // and report success by silence. It is stale by definition — the live
    // watermark is the one at `stateFile` — so remove it.
    if (readUsableState(legacyStateFile, readImpl).present) {
      try {
        unlinkImpl(legacyStateFile);
        log(`[overnight] removed a stale legacy state file left in the git checkout: ${legacyStateFile} (the live watermark is ${stateFile}) — issue #305.`);
      } catch (err) {
        log(`[overnight] WARNING: a stale legacy state file remains at ${legacyStateFile} and could not be removed (${(err && err.message) || err}). Remove it by hand — an untracked file there breaks \`git pull --ff-only\` on the skills checkout once PR mode commits one (issue #305).`);
      }
    }
    return 'noop';
  }
  if (dest.present && !dest.usable) {
    log(`[overnight] WARNING: ${stateFile} exists but does not parse as state — treating it as absent and re-running the migration from ${legacyStateFile} (issue #305).`);
  }

  const src = readUsableState(legacyStateFile, readImpl);
  if (!src.present) {
    // ENOENT is the normal, expected case (already migrated, or never existed).
    // Anything else (EACCES, EIO) is a real problem worth surfacing.
    if (src.err && src.err.code && src.err.code !== 'ENOENT') {
      log(`[overnight] could not read the legacy state file ${legacyStateFile} (${src.err.code}: ${src.err.message}) — NOT migrating (issue #305).`);
      return 'blocked';
    }
    return 'noop';
  }
  if (!src.usable) {
    // Distinguish "carries nothing" from "carries something we can't read".
    // An empty/whitespace file, or JSON with no state fields at all (`{}`,
    // `[]`), holds no watermark to salvage — blocking on it would wedge the
    // Sensor forever over an artifact that a single ENOSPC or OOM kill can
    // produce, and pre-#305 such a file was simply harmless. Delete it (it is
    // the untracked in-checkout file that IS the hazard) and carry on.
    // A non-empty file that fails to PARSE is different: it may be a truncated
    // real watermark, so stop and let a human look.
    const empty = !String(src.raw || '').trim();
    let parsedButEmptyShape = false;
    if (!empty) {
      try { JSON.parse(src.raw); parsedButEmptyShape = true; } catch { parsedButEmptyShape = false; }
    }
    if (empty || parsedButEmptyShape) {
      try {
        unlinkImpl(legacyStateFile);
        log(`[overnight] removed an ${empty ? 'empty' : 'contentless'} legacy state file from the git checkout: ${legacyStateFile} — it carried no watermark (issue #305).`);
      } catch (err) {
        log(`[overnight] WARNING: an ${empty ? 'empty' : 'contentless'} legacy state file remains at ${legacyStateFile} and could not be removed (${(err && err.message) || err}). Remove it by hand (issue #305).`);
      }
      return 'noop';
    }
    log(`[overnight] legacy state file ${legacyStateFile} does not parse as state — leaving both files untouched rather than migrating a corrupt watermark. Inspect it by hand (issue #305).`);
    return 'blocked';
  }

  // From here on a real watermark exists at the legacy path and nowhere else.
  // Any failure to move it must fail CLOSED: letting the exception escape means
  // the caller continues, cold-starts, and primes the whole backlog away — and
  // the run after that sees usable state at the new path and unlinks the legacy
  // file as "stale", destroying the last copy. That is the exact outcome the
  // 'blocked' status exists to prevent, so it must cover throws too.
  const mkdir = mkdirImpl || ((p) => fs.mkdirSync(p, { recursive: true }));
  const tmp = `${stateFile}.tmp`;
  try {
    mkdir(path.dirname(stateFile));
    writeImpl(tmp, src.raw);
    renameImpl(tmp, stateFile);
  } catch (err) {
    try { unlinkImpl(tmp); } catch { /* best effort — don't orphan the .tmp */ }
    log(`[overnight] could not move the legacy state file ${legacyStateFile} to ${stateFile} (${(err && err.message) || err}) — NOT migrating (issue #305).`);
    return 'blocked';
  }
  try {
    unlinkImpl(legacyStateFile);
  } catch (err) {
    log(`[overnight] WARNING: migrated state to ${stateFile} but could not remove the legacy file ${legacyStateFile} (${(err && err.message) || err}). Remove it by hand — an untracked file at that path will break \`git pull --ff-only\` on the skills checkout once PR mode commits one (issue #305).`);
    return 'migrated';
  }
  log(`[overnight] migrated state file out of the git checkout: ${legacyStateFile} → ${stateFile} (issue #305); legacy file removed.`);
  return 'migrated';
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
