// auth-refresh.js — Auto-refresh Claude OAuth tokens before they expire
// Max plan OAuth tokens last 8 hours. This module checks before each SDK call
// and refreshes proactively when within REFRESH_MARGIN of expiry.
// Self-healing: when refresh fails (e.g. host rotated token), spawns
// `claude auth login` and notifies admin with the OAuth URL.

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');

const CREDENTIALS_PATH = path.join(
  process.env.CLAUDE_CONFIG_DIR || path.join(require('os').homedir(), '.claude'),
  '.credentials.json'
);

const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const REFRESH_MARGIN_MS = 30 * 60 * 1000; // refresh when within 30 min of expiry

// --- Reauth state ---
let reauthNotifier = null;   // async function(url) — sends OAuth URL to admin
let reauthPromise = null;     // non-null while reauth is in progress

/**
 * Register a function that will be called with the OAuth URL when reauth is needed.
 * @param {(url: string) => Promise<void>} notifier
 */
function setReauthNotifier(notifier) {
  reauthNotifier = notifier;
}

/**
 * Spawn `claude auth login` and wait for it to complete.
 * Returns true if login succeeded, false otherwise.
 */
function attemptReauth() {
  if (reauthPromise) {
    console.log('[auth] Reauth already in progress — joining existing attempt');
    return reauthPromise;
  }

  reauthPromise = new Promise((resolve) => {
    console.log('[auth] Spawning claude auth login...');
    const child = spawn('claude', ['auth', 'login'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stdout = '';
    let notified = false;

    child.stdout.on('data', (data) => {
      const chunk = data.toString();
      stdout += chunk;
      console.log(`[auth-login] ${chunk.trim()}`);

      // Look for the OAuth URL in output
      if (!notified) {
        const urlMatch = stdout.match(/(https:\/\/[^\s]+)/);
        if (urlMatch && reauthNotifier) {
          notified = true;
          reauthNotifier(urlMatch[1]).catch(err => {
            console.error(`[auth] Failed to send reauth notification: ${err.message}`);
          });
        }
      }
    });

    child.stderr.on('data', (data) => {
      const chunk = data.toString();
      console.log(`[auth-login:err] ${chunk.trim()}`);

      // URL may appear on stderr too
      if (!notified) {
        const urlMatch = chunk.match(/(https:\/\/[^\s]+)/);
        if (urlMatch && reauthNotifier) {
          notified = true;
          reauthNotifier(urlMatch[1]).catch(err => {
            console.error(`[auth] Failed to send reauth notification: ${err.message}`);
          });
        }
      }
    });

    child.on('close', (code) => {
      reauthPromise = null;
      if (code === 0) {
        console.log('[auth] claude auth login succeeded');
        resolve(true);
      } else {
        console.error(`[auth] claude auth login exited with code ${code}`);
        resolve(false);
      }
    });

    child.on('error', (err) => {
      reauthPromise = null;
      console.error(`[auth] claude auth login spawn error: ${err.message}`);
      resolve(false);
    });
  });

  return reauthPromise;
}

/**
 * Check if an error looks like an auth failure.
 */
function isAuthError(err) {
  if (!err) return false;
  const msg = (err.message || err.toString()).toLowerCase();
  return msg.includes('401')
    || msg.includes('authentication_error')
    || msg.includes('oauth token has expired')
    || msg.includes('invalid_grant')
    || msg.includes('unauthorized');
}

/**
 * Ensure the OAuth token is fresh. Call before any SDK query().
 * Returns true if token is valid, false if refresh failed.
 * If a reauth is in progress, waits for it to complete.
 */
async function ensureFreshToken() {
  // If reauth is in progress, wait for it
  if (reauthPromise) {
    console.log('[auth] Waiting for in-progress reauth...');
    const ok = await reauthPromise;
    if (!ok) return false;
    // Re-read credentials after reauth
  }

  let creds;
  try {
    creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  } catch (err) {
    console.error(`[auth] Cannot read credentials: ${err.message}`);
    return false;
  }

  const oauth = creds.claudeAiOauth;
  if (!oauth) {
    console.error('[auth] No claudeAiOauth in credentials');
    return false;
  }

  const timeLeft = oauth.expiresAt - Date.now();
  if (timeLeft > REFRESH_MARGIN_MS) {
    // Token still fresh
    return true;
  }

  console.log(`[auth] Token expires in ${(timeLeft / 60000).toFixed(1)} min — refreshing...`);

  if (!oauth.refreshToken) {
    console.error('[auth] No refresh token available');
    return false;
  }

  try {
    const newTokens = await refreshOAuthToken(oauth.refreshToken);

    // Update credentials file
    creds.claudeAiOauth = {
      ...oauth,
      accessToken: newTokens.access_token,
      refreshToken: newTokens.refresh_token || oauth.refreshToken,
      expiresAt: Date.now() + (newTokens.expires_in * 1000),
    };

    fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds), 'utf8');
    console.log(`[auth] Token refreshed — new expiry: ${new Date(creds.claudeAiOauth.expiresAt).toISOString()}`);
    return true;
  } catch (err) {
    console.error(`[auth] Refresh failed: ${err.message}`);

    // Self-healing: attempt interactive reauth
    if (reauthNotifier) {
      console.log('[auth] Attempting self-healing reauth...');
      const ok = await attemptReauth();
      return ok;
    }

    return false;
  }
}

function refreshOAuthToken(refreshToken) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    });

    const url = new URL(TOKEN_URL);
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error(`Invalid JSON response: ${body.slice(0, 200)}`));
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy(new Error('Refresh request timed out'));
    });
    req.write(data);
    req.end();
  });
}

module.exports = { ensureFreshToken, setReauthNotifier, attemptReauth, isAuthError };
