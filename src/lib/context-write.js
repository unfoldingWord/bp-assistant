// context-write.js — post-run, non-fatal writes into the bot namespace of a
// translation-context repo (CONTEXT-REPO-CONTRACT.md §4):
//   runs/{runId}.json
//   candidates/inbox/{runId}.json
// Never touches human-authority paths. Failures are logged; they must not
// fail an already-delivered translation.

'use strict';

const https = require('https');
const { readSecret } = require('../secrets');

const GITEA_API = process.env.GITEA_API_URL || 'https://git.door43.org/api/v1';
const LOG_PREFIX = '[context-write]';

function getDoor43Token() {
  return readSecret('door43_token', 'DOOR43_TOKEN') || readSecret('gitea_token', 'GITEA_TOKEN');
}

function apiRequest(method, apiPath, token, data = null, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${GITEA_API}${apiPath}`);
    const body = data ? JSON.stringify(data) : null;
    const opts = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: { 'Content-Type': 'application/json' },
      timeout: timeoutMs,
    };
    if (token) opts.headers.Authorization = `token ${token}`;

    const req = https.request(opts, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode, data: raw });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`API ${method} ${apiPath} timed out (${timeoutMs}ms)`));
    });
    if (body) req.write(body);
    req.end();
  });
}

/**
 * PUT a file via Gitea contents API. SHA-conditional update; retry once on 409.
 */
async function putRepoFile({ org, repo, filePath, content, message, branch = 'master', token }) {
  const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
  const apiPath = `/repos/${org}/${repo}/contents/${encodedPath}`;

  async function attempt(existingSha) {
    const payload = {
      message,
      content: Buffer.from(content, 'utf8').toString('base64'),
      branch,
    };
    if (existingSha) payload.sha = existingSha;
    return apiRequest('PUT', apiPath, token, payload);
  }

  let existingSha = null;
  const getRes = await apiRequest('GET', `${apiPath}?ref=${encodeURIComponent(branch)}`, token);
  if (getRes.status === 200 && getRes.data && getRes.data.sha) {
    existingSha = getRes.data.sha;
  }

  let res = await attempt(existingSha);
  if (res.status === 409) {
    const retryGet = await apiRequest('GET', `${apiPath}?ref=${encodeURIComponent(branch)}`, token);
    const retrySha = retryGet.status === 200 && retryGet.data ? retryGet.data.sha : null;
    res = await attempt(retrySha);
  }

  if (res.status !== 200 && res.status !== 201) {
    const detail = typeof res.data === 'object' ? JSON.stringify(res.data) : String(res.data);
    throw new Error(`PUT ${org}/${repo}:${filePath} → HTTP ${res.status}: ${detail}`);
  }
  return res.data;
}

function parseContextRepo(contextRef) {
  const m = /^([^/@\s]+)\/([^/@\s]+)@(.+)$/.exec(String(contextRef || '').trim());
  if (!m) return null;
  return { org: m[1], repo: m[2], ref: m[3] };
}

/**
 * Write run report + optional suggestion inbox into the context repo.
 * Local directory contextRefs are skipped (no DCS write target).
 *
 * @returns {Promise<{ok: boolean, written: string[], skipped?: string, error?: string}>}
 */
async function writeContextArtifacts({
  contextRef,
  runId,
  report,
  inbox = null,
  branch = null,
  token = null,
  putImpl = null,
} = {}) {
  const parsed = parseContextRepo(contextRef);
  if (!parsed) {
    return { ok: true, written: [], skipped: 'local-or-invalid-contextRef' };
  }

  const tok = token || getDoor43Token();
  if (!tok) {
    return { ok: false, written: [], error: 'No Door43 token (DOOR43_TOKEN / GITEA_TOKEN)' };
  }

  // Prefer writing to the branch named in contextRef when it is a branch, else master.
  const targetBranch = branch
    || (/^[0-9a-f]{40}$/i.test(parsed.ref) ? 'master' : parsed.ref);

  const put = putImpl || ((args) => putRepoFile({ ...args, token: tok }));

  const written = [];
  const messageTrailer = '\n\nX-AI-Pipeline: bp-assistant/translate';

  await put({
    org: parsed.org,
    repo: parsed.repo,
    filePath: `runs/${runId}.json`,
    content: JSON.stringify(report, null, 2) + '\n',
    message: `translate run ${runId}${messageTrailer}`,
    branch: targetBranch,
  });
  written.push(`runs/${runId}.json`);

  if (inbox && Array.isArray(inbox.suggestions) && inbox.suggestions.length > 0) {
    await put({
      org: parsed.org,
      repo: parsed.repo,
      filePath: `candidates/inbox/${runId}.json`,
      content: JSON.stringify(inbox, null, 2) + '\n',
      message: `translate suggestions ${runId} (${inbox.suggestions.length})${messageTrailer}`,
      branch: targetBranch,
    });
    written.push(`candidates/inbox/${runId}.json`);
  }

  console.log(`${LOG_PREFIX} wrote ${written.join(', ')} → ${parsed.org}/${parsed.repo}@${targetBranch}`);
  return { ok: true, written };
}

/**
 * Non-fatal wrapper: swallow errors, optionally notify via onError.
 */
async function writeContextArtifactsSafe(args, { onError } = {}) {
  try {
    return await writeContextArtifacts(args);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.warn(`${LOG_PREFIX} failed (non-fatal): ${message}`);
    if (typeof onError === 'function') {
      try { await onError(err); } catch { /* ignore secondary failures */ }
    }
    return { ok: false, written: [], error: message };
  }
}

module.exports = {
  writeContextArtifacts,
  writeContextArtifactsSafe,
  putRepoFile,
  parseContextRepo,
  apiRequest,
  getDoor43Token,
};
