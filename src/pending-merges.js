// pending-merges.js — Disk-persisted store for deferred repo-insert state
// When a user has existing branches that need merging, we save the completed
// generation results here so we can resume insertion after they merge.
// Follows the session-store.js pattern (JSON files on disk).

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.resolve(__dirname, '../data');
const PENDING_DIR = path.join(DATA_DIR, 'pending-merges');

function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(PENDING_DIR)) fs.mkdirSync(PENDING_DIR, { recursive: true });
}

function getFile(sessionKey) {
  const safeKey = String(sessionKey).replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(PENDING_DIR, `${safeKey}.json`);
}

/**
 * Read pending merge state for a session.
 * @param {string} sessionKey - e.g. "stream-CONTENT_-_UR-Psalms_BP"
 * @returns {object|null} The pending merge data, or null if none
 */
function getPendingMerge(sessionKey) {
  const file = getFile(sessionKey);
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch (err) {
    console.warn(`[pending-merges] Failed to read ${sessionKey}: ${err.message}`);
  }
  return null;
}

/**
 * Write pending merge state for a session.
 * @param {string} sessionKey
 * @param {object} data - shape: { sessionKey, pipelineType, username, book, startChapter, endChapter,
 *   completedChapters, blockingBranches, originalMessage, createdAt, retryCount }
 */
function setPendingMerge(sessionKey, data) {
  try {
    ensureDirs();
    fs.writeFileSync(getFile(sessionKey), JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.warn(`[pending-merges] Failed to write ${sessionKey}: ${err.message}`);
  }
}

/**
 * Delete pending merge state for a session.
 * @param {string} sessionKey
 */
function clearPendingMerge(sessionKey) {
  try {
    const file = getFile(sessionKey);
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  } catch (err) {
    console.warn(`[pending-merges] Failed to clear ${sessionKey}: ${err.message}`);
  }
}

/**
 * List all pending merges (for startup reminders).
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

module.exports = { getPendingMerge, setPendingMerge, clearPendingMerge, getAllPendingMerges };
