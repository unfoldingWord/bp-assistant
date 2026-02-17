// session-store.js — multi-session support for interactive Claude pipeline
// Persists sessionIds keyed by userId or stream+topic to allow multiple concurrent conversations.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.resolve(__dirname, '../data');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');

function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

/**
 * @param {string} key
 */
function getSessionFile(key) {
  // Sanitize key to avoid path traversal
  const safeKey = String(key).replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(SESSIONS_DIR, `${safeKey}.json`);
}

/**
 * @param {string} key
 * @returns {{ sessionId?: string, updatedAt: string, model?: string } | null}
 */
function getSession(key = 'default') {
  const file = getSessionFile(key);
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8');
      const data = JSON.parse(raw);
      if (data) {
        return {
          sessionId: typeof data.sessionId === 'string' ? data.sessionId : undefined,
          updatedAt: data.updatedAt || new Date().toISOString(),
          model: typeof data.model === 'string' ? data.model : undefined,
          exchanges: typeof data.exchanges === 'number' ? data.exchanges : 0,
        };
      }
    }
  } catch (err) {
    console.warn(`[session-store] Failed to read session ${key}: ${err.message}`);
  }
  return null;
}

/**
 * @param {string} key
 * @param {string} sessionId
 * @param {string} [model] optional model to persist (merged, does not clear if omitted)
 */
function setSession(key = 'default', sessionId, model) {
  try {
    ensureDirs();
    const existing = getSession(key);
    const data = {
      sessionId,
      updatedAt: new Date().toISOString(),
      model: model !== undefined ? model : (existing && existing.model) || undefined,
      exchanges: 0,
    };
    if (data.model === undefined) delete data.model;
    fs.writeFileSync(getSessionFile(key), JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.warn(`[session-store] Failed to write session ${key}: ${err.message}`);
  }
}

/**
 * Persist model preference only (keeps existing sessionId).
 * @param {string} key
 * @param {string} model
 */
function setModel(key = 'default', model) {
  try {
    const existing = getSession(key);
    ensureDirs();
    const data = {
      sessionId: existing && existing.sessionId,
      updatedAt: new Date().toISOString(),
      model,
    };
    if (!data.sessionId) delete data.sessionId;
    fs.writeFileSync(getSessionFile(key), JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.warn(`[session-store] Failed to set model for ${key}: ${err.message}`);
  }
}

/**
 * @param {string} key
 */
function clearSession(key = 'default') {
  try {
    const file = getSessionFile(key);
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  } catch (err) {
    console.warn(`[session-store] Failed to clear session ${key}: ${err.message}`);
  }
}

/**
 * Increment the exchange counter for a session.
 * @param {string} key
 * @returns {number} the new exchange count
 */
function incrementExchanges(key) {
  try {
    const file = getSessionFile(key);
    if (!fs.existsSync(file)) return 0;
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    data.exchanges = (typeof data.exchanges === 'number' ? data.exchanges : 0) + 1;
    data.updatedAt = new Date().toISOString();
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
    return data.exchanges;
  } catch (err) {
    console.warn(`[session-store] Failed to increment exchanges for ${key}: ${err.message}`);
    return 0;
  }
}

module.exports = { getSession, setSession, setModel, clearSession, incrementExchanges };
