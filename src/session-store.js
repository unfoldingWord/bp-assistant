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
 * @returns {{ sessionId: string, updatedAt: string } | null}
 */
function getSession() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const raw = fs.readFileSync(SESSION_FILE, 'utf8');
      const data = JSON.parse(raw);
      if (data && typeof data.sessionId === 'string') {
        return {
          sessionId: data.sessionId,
          updatedAt: data.updatedAt || new Date().toISOString(),
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
 */
function setSession(sessionId) {
  try {
    ensureDataDir();
    const data = {
      sessionId,
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.warn(`[session-store] Failed to write session: ${err.message}`);
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

module.exports = { getSession, setSession, clearSession };
