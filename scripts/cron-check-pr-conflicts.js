#!/usr/bin/env node
// Check for file-level conflicts between PRs created in one cron session.
// Reads the run log, extracts PR URLs, fetches changed files from the
// appropriate API, and reports any files touched by more than one PR.
// Prints a markdown summary to stdout.
'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

function readSecret(name) {
  const envKey = name.toUpperCase().replace(/-/g, '_');
  if (process.env[envKey]) return process.env[envKey];
  const secretsDir = process.env.BP_SECRETS_DIR || process.env.BOT_SECRETS_DIR;
  if (!secretsDir) return null;
  try {
    return fs.readFileSync(path.join(secretsDir, name.toLowerCase()), 'utf8').trim();
  } catch {
    return null;
  }
}

function httpsGet(url, { token, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...headers,
        ...(token ? { Authorization: `token ${token}` } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.status, body: JSON.parse(data) }); }
        catch { resolve({ status: res.status, body: null }); }
      });
    });
    req.setTimeout(10000, () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });
}

// Extract all unique PR URLs from a block of text.
function extractPRUrls(text) {
  const re = /https:\/\/(?:git\.door43\.org\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pulls\/\d+|github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+)/g;
  return [...new Set(text.match(re) || [])];
}

function parsePRUrl(url) {
  const door43 = url.match(/https:\/\/git\.door43\.org\/([^/]+)\/([^/]+)\/pulls\/(\d+)/);
  if (door43) {
    return {
      host: 'git.door43.org',
      owner: door43[1],
      repo: door43[2],
      index: door43[3],
      apiBase: 'https://git.door43.org/api/v1',
    };
  }

  const github = url.match(/https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (github) {
    return {
      host: 'github.com',
      owner: github[1],
      repo: github[2],
      index: github[3],
      apiBase: 'https://api.github.com',
    };
  }

  return null;
}

function prLabel(url) {
  const p = parsePRUrl(url);
  return p ? `${p.repo}#${p.index}` : url;
}

function selectTokenForHost(parsed, tokens) {
  if (!parsed) return null;
  if (parsed.host === 'github.com') return tokens.githubToken || null;
  if (parsed.host === 'git.door43.org') return tokens.door43Token || null;
  return null;
}

async function getPRFiles(prUrl, tokens = {}) {
  const parsed = parsePRUrl(prUrl);
  if (!parsed) return null;
  const { owner, repo, index, apiBase, host } = parsed;
  const apiUrl = host === 'github.com'
    ? `${apiBase}/repos/${owner}/${repo}/pulls/${index}/files`
    : `${apiBase}/repos/${owner}/${repo}/pulls/${index}/files`;
  try {
    const headers = host === 'github.com'
      ? { 'User-Agent': 'bp-assistant-cron-check-pr-conflicts' }
      : {};
    const { body } = await httpsGet(apiUrl, { token: selectTokenForHost(parsed, tokens), headers });
    if (!Array.isArray(body)) return null;
    return body.map((f) => f.filename).filter(Boolean);
  } catch (err) {
    process.stderr.write(`[cron-check-pr-conflicts] Failed to fetch ${prUrl}: ${err.message}\n`);
    return null;
  }
}

function formatConflictReport(prUrls, fileMap, fetchFailed) {
  if (prUrls.length === 0) {
    return 'PR conflict check: no PRs found in run output.';
  }

  const conflicts = [...fileMap.entries()].filter(([, prs]) => prs.size > 1);
  const failNote = fetchFailed > 0 ? ` (${fetchFailed} PR(s) not fetched)` : '';

  if (conflicts.length === 0) {
    return `PR conflict check: ${prUrls.length} PR(s), no overlapping files${failNote}.`;
  }

  const lines = [
    `⚠️ PR conflict check: ${conflicts.length} file(s) touched by multiple PRs${failNote}:`,
  ];
  for (const [file, prs] of conflicts) {
    const labels = [...prs].map(prLabel).join(', ');
    lines.push(`- \`${file}\`: ${labels}`);
  }
  return lines.join('\n');
}

async function collectConflictReport(prUrls, tokens, fetchFiles = getPRFiles) {
  const fileMap = new Map(); // filename → Set of prUrls
  let fetchFailed = 0;

  for (const prUrl of prUrls) {
    const files = await fetchFiles(prUrl, tokens);
    if (!files) {
      fetchFailed++;
      continue;
    }
    for (const file of files) {
      if (!fileMap.has(file)) fileMap.set(file, new Set());
      fileMap.get(file).add(prUrl);
    }
  }

  return formatConflictReport(prUrls, fileMap, fetchFailed);
}

async function main() {
  const logFilePath = process.argv[2];
  if (!logFilePath) {
    process.stdout.write('PR conflict check: no log file path provided.\n');
    return;
  }

  let logText;
  try {
    logText = fs.readFileSync(logFilePath, 'utf8');
  } catch (err) {
    process.stdout.write(`PR conflict check: could not read log (${err.message}).\n`);
    return;
  }

  const prUrls = extractPRUrls(logText);
  const tokens = {
    door43Token: readSecret('door43_token') || process.env.GITEA_TOKEN || null,
    githubToken: process.env.GH_TOKEN || process.env.GITHUB_TOKEN || null,
  };
  const report = await collectConflictReport(prUrls, tokens);
  process.stdout.write(`${report}\n`);
}

if (require.main === module) {
  main().catch((err) => {
    process.stdout.write(`PR conflict check: error — ${err.message}\n`);
  });
}

module.exports = {
  extractPRUrls,
  parsePRUrl,
  prLabel,
  formatConflictReport,
  collectConflictReport,
  getPRFiles,
};
