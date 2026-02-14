// session-store.js — single admin Claude session for interactive DM pipeline
// Persists sessionId so DMs can resume the same conversation across messages and restarts.

const fs = require('fs');
const path = require('path');

const SESSION_FILE = path.resolve(__dirname, '../data/claude-session.json');

function ensureDataDir() {
  const dir = path.dirname(SESSION_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * @returns {{ sessionId?: string, updatedAt: string, model?: string } | null}
 */
function getSession() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const raw = fs.readFileSync(SESSION_FILE, 'utf8');
      const data = JSON.parse(raw);
      if (data) {
        return {
          sessionId: typeof data.sessionId === 'string' ? data.sessionId : undefined,
          updatedAt: data.updatedAt || new Date().toISOString(),
          model: typeof data.model === 'string' ? data.model : undefined,
        };
      }
    }
  } catch (err) {
    console.warn(`[session-store] Failed to read session: ${err.message}`);
  }
  return null;
}

/**
 * @param {string} sessionId
 * @param {string} [model] optional model to persist (merged, does not clear if omitted)
 */
function setSession(sessionId, model) {
  try {
    ensureDataDir();
    const existing = getSession();
    const data = {
      sessionId,
      updatedAt: new Date().toISOString(),
      model: model !== undefined ? model : (existing && existing.model) || undefined,
    };
    if (data.model === undefined) delete data.model;
    fs.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.warn(`[session-store] Failed to write session: ${err.message}`);
  }
}

/**
 * Persist model preference only (keeps existing sessionId).
 * @param {string} model
 */
function setModel(model) {
  try {
    const existing = getSession();
    ensureDataDir();
    const data = {
      sessionId: existing && existing.sessionId,
      updatedAt: new Date().toISOString(),
      model,
    };
    if (!data.sessionId) delete data.sessionId;
    fs.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.warn(`[session-store] Failed to set model: ${err.message}`);
  }
}

function clearSession() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      fs.unlinkSync(SESSION_FILE);
    }
  } catch (err) {
    console.warn(`[session-store] Failed to clear session: ${err.message}`);
  }
}

module.exports = { getSession, setSession, setModel, clearSession };
