// auth-refresh.js — Auto-refresh Claude OAuth tokens before they expire
// Max plan OAuth tokens last 8 hours. This module checks before each SDK call
// and refreshes proactively when within REFRESH_MARGIN of expiry.

const fs = require('fs');
const path = require('path');
const https = require('https');

const CREDENTIALS_PATH = path.join(
  process.env.CLAUDE_CONFIG_DIR || path.join(require('os').homedir(), '.claude'),
  '.credentials.json'
);

const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const REFRESH_MARGIN_MS = 30 * 60 * 1000; // refresh when within 30 min of expiry

/**
 * Ensure the OAuth token is fresh. Call before any SDK query().
 * Returns true if token is valid, false if refresh failed.
 */
async function ensureFreshToken() {
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

module.exports = { ensureFreshToken };
