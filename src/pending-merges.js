// pending-merges.js — Disk-persisted store for deferred repo-insert state
// When a user has existing branches that need merging, we save the completed
// generation results here so we can resume insertion after they merge.
// Follows the session-store.js pattern (JSON files on disk).
//
// Records are keyed per-RUN, not per-session: the key encodes
// sessionKey + pipelineType + scope (the caller builds it, typically with
// buildCheckpointKey). This matters because several runs can share one Zulip
// topic — notably every API-triggered run shares the control thread, and a
// single Zulip topic can host more than one deferred run — and a per-session
// key would let the second deferral silently overwrite the first's record.

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.PENDING_MERGES_DIR
  ? path.resolve(process.env.PENDING_MERGES_DIR)
  : path.resolve(__dirname, '../data');
const PENDING_DIR = process.env.PENDING_MERGES_DIR
  ? DATA_DIR
  : path.join(DATA_DIR, 'pending-merges');

function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(PENDING_DIR)) fs.mkdirSync(PENDING_DIR, { recursive: true });
}

function getFile(key) {
  const safeKey = String(key).replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(PENDING_DIR, `${safeKey}.json`);
}

/**
 * Read pending merge state for a run.
 * @param {string} key - per-run key (sessionKey + pipelineType + scope)
 * @returns {object|null} The pending merge data, or null if none
 */
function getPendingMerge(key) {
  const file = getFile(key);
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch (err) {
    console.warn(`[pending-merges] Failed to read ${key}: ${err.message}`);
  }
  return null;
}

/**
 * Write pending merge state for a run.
 * @param {string} key - per-run key; callers should also store it as data.key
 * @param {object} data - shape: { key, sessionKey, pipelineType, username, book, startChapter, endChapter,
 *   scope, completedChapters, blockingBranches, originalMessage, createdAt, retryCount }
 */
function setPendingMerge(key, data) {
  try {
    ensureDirs();
    fs.writeFileSync(getFile(key), JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.warn(`[pending-merges] Failed to write ${key}: ${err.message}`);
  }
}

/**
 * Delete pending merge state for a run.
 * @param {string} key
 */
function clearPendingMerge(key) {
  try {
    const file = getFile(key);
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  } catch (err) {
    console.warn(`[pending-merges] Failed to clear ${key}: ${err.message}`);
  }
}

/**
 * List all pending merges (for startup reminders and scope-addressed resume).
 * @returns {object[]} Array of pending merge data objects
 */
function getAllPendingMerges() {
  try {
    ensureDirs();
    const files = fs.readdirSync(PENDING_DIR).filter(f => f.endsWith('.json'));
    const results = [];
    for (const f of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(PENDING_DIR, f), 'utf8'));
        results.push(data);
      } catch (err) {
        console.warn(`[pending-merges] Failed to parse ${f}: ${err.message}`);
      }
    }
    return results;
  } catch (err) {
    console.warn(`[pending-merges] Failed to list pending merges: ${err.message}`);
    return [];
  }
}

/**
 * All pending merges originating from a given Zulip session (stream-topic / DM).
 * A shared topic (e.g. the API control thread) can hold several at once, so this
 * returns an array; bare "merged"/"cancel" act only when exactly one matches.
 * @param {string} sessionKey
 * @returns {object[]}
 */
function getPendingMergesForSession(sessionKey) {
  return getAllPendingMerges().filter(pm => pm && pm.sessionKey === sessionKey);
}

module.exports = {
  getPendingMerge,
  setPendingMerge,
  clearPendingMerge,
  getAllPendingMerges,
  getPendingMergesForSession,
};
