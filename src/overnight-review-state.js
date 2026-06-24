// overnight-review-state.js — idempotent state for the overnight Sensor.
//
// Each review unit is keyed by MERGED-PR id + content headSha (a re-push of the
// same PR gets a new sha → a new unit), so re-running the Sensor never
// double-reviews. Live `-be-` branches are keyed by branch + tip sha. State is
// committed to bp-assistant-skills/data/overnight-review/state.json (the wake
// machine's disk is ephemeral). Cold start (no state yet) records all current
// HEADs as "seen" and reviews NOTHING on night 1 — otherwise the first run would
// try to review the entire merge history.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const STATE_VERSION = 1;
const DEFAULT_STATE_REL = 'data/overnight-review/state.json';

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
