// door43-push.js — Deterministic Door43 push (replaces Claude-mediated repo-insert)
//
// Calls Python insertion scripts directly, then runs git + Gitea API operations
// with retry logic. No AI layer — fully deterministic, structured success/failure.

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');
const git = require('isomorphic-git');
const http_ = require('http');
const https_ = require('https');

// Custom HTTP handler for isomorphic-git — the default `simple-get` module
// aborts on large repos (en_ult, en_ust) under Node v25 in Docker containers.
// This uses native Node.js http/https which works reliably.
async function collectBody(iter) {
  const buffers = [];
  if (iter && iter[Symbol.asyncIterator]) {
    for await (const chunk of iter) buffers.push(Buffer.from(chunk));
  } else if (Array.isArray(iter)) {
    for (const chunk of iter) buffers.push(Buffer.from(chunk));
  } else if (iter) {
    buffers.push(Buffer.from(iter));
  }
  return buffers.length ? Buffer.concat(buffers) : null;
}

const gitHttp = {
  async request({ url, method = 'GET', headers = {}, body }) {
    const bodyBuf = body ? await collectBody(body) : null;
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const mod = parsed.protocol === 'https:' ? https_ : http_;
      const req = mod.request({
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method,
        headers,
      }, (res) => {
        const iter = {
          queue: [], ended: false, defer: null,
          [Symbol.asyncIterator]() { return this; },
          next() {
            return new Promise((r) => {
              if (this.queue.length > 0) return r({ value: this.queue.shift(), done: false });
              if (this.ended) return r({ done: true });
              this.defer = { resolve: r };
            });
          },
          return() {},
        };
        res.on('data', (chunk) => {
          const val = new Uint8Array(chunk);
          if (iter.defer) { iter.defer.resolve({ value: val, done: false }); iter.defer = null; }
          else iter.queue.push(val);
        });
        res.on('end', () => { iter.ended = true; if (iter.defer) { iter.defer.resolve({ done: true }); iter.defer = null; } });
        res.on('error', reject);
        resolve({ url: res.url || url, method, statusCode: res.statusCode, statusMessage: res.statusMessage, headers: res.headers, body: iter });
      });
      req.on('error', reject);
      if (bodyBuf) req.end(bodyBuf); else req.end();
    });
  },
};
const { getVerseCount } = require('./verse-counts');
const { insertTnRows } = require('./lib/insert-tn-rows');
const { insertUsfmVerses } = require('./lib/insert-usfm-verses');
const { validateTnTsv } = require('./workspace-tools/quality-tools');
const { readSecret } = require('./secrets');

const GITEA_API = 'https://git.door43.org/api/v1';
const ORG = 'unfoldingWord';

const CSKILLBP_DIR = process.env.CSKILLBP_DIR || '/srv/bot/workspace';
// Repo name for each content type
const REPO_MAP = { tn: 'en_tn', ult: 'en_ult', ust: 'en_ust' };

// Book code → USFM file number prefix (e.g. PSA → 19)
const BOOK_NUMBERS = {
  GEN: '01', EXO: '02', LEV: '03', NUM: '04', DEU: '05',
  JOS: '06', JDG: '07', RUT: '08', '1SA': '09', '2SA': '10',
  '1KI': '11', '2KI': '12', '1CH': '13', '2CH': '14', EZR: '15',
  NEH: '16', EST: '17', JOB: '18', PSA: '19', PRO: '20',
  ECC: '21', SNG: '22', ISA: '23', JER: '24', LAM: '25',
  EZK: '26', DAN: '27', HOS: '28', JOL: '29', AMO: '30',
  OBA: '31', JON: '32', MIC: '33', NAM: '34', HAB: '35',
  ZEP: '36', HAG: '37', ZEC: '38', MAL: '39',
  MAT: '41', MRK: '42', LUK: '43', JHN: '44', ACT: '45',
  ROM: '46', '1CO': '47', '2CO': '48', GAL: '49', EPH: '50',
  PHP: '51', COL: '52', '1TH': '53', '2TH': '54', '1TI': '55',
  '2TI': '56', TIT: '57', PHM: '58', HEB: '59', JAS: '60',
  '1PE': '61', '2PE': '62', '1JN': '63', '2JN': '64', '3JN': '65',
  JUD: '66', REV: '67',
};

const LOG_PREFIX = '[door43-push]';

// ---------------------------------------------------------------------------
// Generic retry utility
// ---------------------------------------------------------------------------

async function withRetry(fn, { maxAttempts = 3, baseDelayMs = 2000, label = '' } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        console.warn(`${LOG_PREFIX} ${label} attempt ${attempt}/${maxAttempts} failed: ${err.message} — retrying in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// isomorphic-git helpers
// ---------------------------------------------------------------------------

function makeOnAuth(token) {
  return () => ({ username: token, password: '' });
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

// ---------------------------------------------------------------------------
// Gitea API request (generalised from repo-verify.js apiGet)
// ---------------------------------------------------------------------------

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
    if (token) opts.headers['Authorization'] = `token ${token}`;

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
    req.on('timeout', () => { req.destroy(); reject(new Error(`API ${method} ${apiPath} timed out (${timeoutMs}ms)`)); });
    if (body) req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Check for open user PRs that modify the same file we're about to merge
//
// When `chapter` is provided, inspects the PR diff to see if it actually
// touches that chapter's content — avoids false positives when two people
// work on different chapters of the same book file (e.g. PSA 130 vs 148).
// ---------------------------------------------------------------------------

async function checkConflictingBranches(repo, targetFile, chapter) {
  const { token } = getConfig();
  if (!token) return [];

  try {
    // List open PRs (more reliable than branch compare for stale branches)
    let page = 1;
    const allPRs = [];
    while (true) {
      const res = await apiRequest('GET',
        `/repos/${ORG}/${repo}/pulls?state=open&limit=50&page=${page}`, token);
      if (res.status !== 200 || !Array.isArray(res.data) || res.data.length === 0) break;
      allPRs.push(...res.data);
      if (res.data.length < 50) break;
      page++;
    }

    // Filter to human PRs (not AI-*)
    const humanPRs = allPRs.filter(pr =>
      pr.head?.label && !pr.head.label.startsWith('AI-'));

    if (humanPRs.length === 0) {
      console.log(`${LOG_PREFIX} No open user PRs on ${repo}`);
      return [];
    }

    console.log(`${LOG_PREFIX} Checking ${humanPRs.length} open user PR(s) for conflicts with ${targetFile}${chapter ? ` ch ${chapter}` : ''} on ${repo}...`);

    // Check each PR's files via the PR files endpoint (reliable even for stale branches)
    const conflicting = [];
    for (const pr of humanPRs) {
      try {
        const filesRes = await apiRequest('GET',
          `/repos/${ORG}/${repo}/pulls/${pr.number}/files?limit=100`, token);
        if (filesRes.status !== 200 || !Array.isArray(filesRes.data)) continue;

        const fileEntry = filesRes.data.find(f => f.filename === targetFile);
        if (!fileEntry) continue;

        // If no chapter specified, any touch on the file is a conflict (old behaviour)
        if (chapter == null) {
          console.log(`${LOG_PREFIX} PR #${pr.number} (branch '${pr.head.label}') modifies ${targetFile} — potential conflict`);
          conflicting.push({ branch: pr.head.label, pr: pr.number });
          continue;
        }

        // Chapter-level check: inspect the patch to see if it touches our chapter.
        // Gitea omits patch data for large files (e.g. 19-PSA.usfm at 43K+ lines).
        // When that happens, fetch the full PR diff which includes all files regardless of size.
        let touchesChapter;
        let patch = fileEntry.patch;
        if (!patch) {
          console.log(`${LOG_PREFIX} PR #${pr.number}: no patch data for ${targetFile} — fetching full PR diff`);
          patch = await fetchPRFilePatch(repo, pr.number, targetFile, token);
        }
        if (patch) {
          touchesChapter = diffTouchesChapter(patch, targetFile, chapter);
        } else {
          // Both patch sources failed — fall back to raw content comparison (less accurate)
          console.warn(`${LOG_PREFIX} PR #${pr.number}: full PR diff also unavailable for ${targetFile} — falling back to raw content compare`);
          touchesChapter = await rawContentTouchesChapter(repo, targetFile, pr.base.label, pr.head.label, chapter, token);
        }
        if (touchesChapter) {
          console.log(`${LOG_PREFIX} PR #${pr.number} (branch '${pr.head.label}') modifies ${targetFile} chapter ${chapter} — conflict`);
          conflicting.push({ branch: pr.head.label, pr: pr.number });
        } else {
          console.log(`${LOG_PREFIX} PR #${pr.number} (branch '${pr.head.label}') modifies ${targetFile} but not chapter ${chapter} — no conflict`);
        }
      } catch (err) {
        console.warn(`${LOG_PREFIX} PR files check failed for #${pr.number}: ${err.message}`);
      }
    }

    if (conflicting.length === 0) {
      console.log(`${LOG_PREFIX} No conflicting PRs found for ${targetFile}${chapter ? ` ch ${chapter}` : ''} on ${repo}`);
    }

    return conflicting;
  } catch (err) {
    console.warn(`${LOG_PREFIX} checkConflictingBranches failed (proceeding without check): ${err.message}`);
    return [];
  }
}

/**
 * Inspect a unified diff patch to determine if it touches a specific chapter.
 *
 * For TN files (TSV): changed lines contain refs like "148:1" — check if any
 * added/removed line starts with "<chapter>:".
 * For USFM files (ULT/UST): look for \c markers in diff context to determine
 * which chapter the changed lines belong to.
 */
function diffTouchesChapter(patch, filename, chapter) {
  if (!patch) return true; // No patch data — be conservative, assume conflict

  const chStr = String(chapter);
  const isTSV = filename.endsWith('.tsv');

  if (isTSV) {
    // TN TSV: each data row starts with "Book <chapter>:<verse>" or just "<chapter>:<verse>"
    // In the diff, added/removed lines start with +/- followed by the row content.
    // Match lines where the reference column contains our chapter.
    const chapterRef = new RegExp(`^[+-].*?\\b${chStr}:`);
    for (const line of patch.split('\n')) {
      if ((line.startsWith('+') || line.startsWith('-')) && !line.startsWith('+++') && !line.startsWith('---')) {
        if (chapterRef.test(line)) return true;
      }
    }
    return false;
  }

  // USFM: track which chapter context we're in by watching \c markers
  // in both context lines (space-prefixed) and changed lines (+/-).
  let currentChapter = null;
  for (const line of patch.split('\n')) {
    // Strip diff prefix to get the actual content
    const content = line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')
      ? line.slice(1)
      : line;

    // Track \c markers
    const cMatch = content.match(/^\\c\s+(\d+)/);
    if (cMatch) {
      currentChapter = cMatch[1];
    }

    // If this is a changed line and we're in our target chapter, it's a conflict
    if ((line.startsWith('+') || line.startsWith('-')) && !line.startsWith('+++') && !line.startsWith('---')) {
      if (currentChapter === chStr) return true;
    }
  }

  return false;
}

/**
 * Fetch the full PR diff and extract the patch for a specific file.
 * The /pulls/{number}.diff endpoint returns the complete unified diff even for
 * large files where the PR-files endpoint omits patch data.
 * Returns the file's patch string, or null on failure.
 */
async function fetchPRFilePatch(repo, prNumber, targetFile, token) {
  try {
    const res = await apiRequest('GET',
      `/repos/${ORG}/${repo}/pulls/${prNumber}.diff`,
      token, null, 60000);
    if (res.status !== 200 || typeof res.data !== 'string') return null;

    // Parse the unified diff to extract hunks for targetFile.
    // File headers look like: "diff --git a/path/to/file b/path/to/file"
    const lines = res.data.split('\n');
    const patch = [];
    let inTargetFile = false;
    for (const line of lines) {
      if (line.startsWith('diff --git ')) {
        // Check if this file section is our target
        // Format: "diff --git a/19-PSA.usfm b/19-PSA.usfm"
        inTargetFile = line.includes(`a/${targetFile}`) && line.includes(`b/${targetFile}`);
        continue;
      }
      if (inTargetFile) {
        // Skip the diff metadata lines (---, +++, index)
        if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('index ')) continue;
        patch.push(line);
      }
    }

    if (patch.length === 0) return null;
    return patch.join('\n');
  } catch (err) {
    console.warn(`${LOG_PREFIX} fetchPRFilePatch failed for PR #${prNumber}: ${err.message}`);
    return null;
  }
}

/**
 * Fetch raw file content from a specific branch via the Gitea contents API.
 * Returns the file text, or null on failure.
 */
async function fetchRawContent(repo, filePath, ref, token) {
  try {
    const res = await apiRequest('GET',
      `/repos/${ORG}/${repo}/raw/${encodeURIComponent(filePath)}?ref=${encodeURIComponent(ref)}`,
      token, null, 60000);
    if (res.status === 200 && typeof res.data === 'string') return res.data;
    return null;
  } catch {
    return null;
  }
}

/**
 * Fallback for when Gitea omits patch data (large files).
 * Fetches the raw file from both base and head branches, then compares
 * line-by-line to determine if the changed lines fall within the target chapter.
 */
async function rawContentTouchesChapter(repo, filePath, baseBranch, headBranch, chapter, token) {
  const [baseContent, headContent] = await Promise.all([
    fetchRawContent(repo, filePath, baseBranch, token),
    fetchRawContent(repo, filePath, headBranch, token),
  ]);

  if (!baseContent || !headContent) {
    console.warn(`${LOG_PREFIX} Could not fetch raw content for ${filePath} — assuming conflict`);
    return true; // Conservative fallback
  }

  const baseLines = baseContent.split('\n');
  const headLines = headContent.split('\n');

  // Build a line-number → chapter map from the base file
  const chapterMap = new Map();
  let currentCh = null;
  for (let i = 0; i < baseLines.length; i++) {
    const m = baseLines[i].match(/^\\c\s+(\d+)/);
    if (m) currentCh = m[1];
    chapterMap.set(i, currentCh);
  }

  const chStr = String(chapter);

  // Quick length-mismatch scan: if lines were added/removed, do a full diff.
  // For same-length files, just compare corresponding lines.
  if (baseLines.length === headLines.length) {
    for (let i = 0; i < baseLines.length; i++) {
      if (baseLines[i] !== headLines[i] && chapterMap.get(i) === chStr) {
        return true;
      }
    }
    return false;
  }

  // Different lengths — use a simple LCS-based approach on chapter boundaries.
  // Rather than a full diff (expensive for 40K+ lines), check which chapters
  // have any content differences by comparing chapter-by-chapter.
  const extractChapter = (lines, targetCh) => {
    const result = [];
    let inChapter = false;
    for (const line of lines) {
      const m = line.match(/^\\c\s+(\d+)/);
      if (m) {
        inChapter = (m[1] === targetCh);
      }
      if (inChapter) result.push(line);
    }
    return result.join('\n');
  };

  const baseChapter = extractChapter(baseLines, chStr);
  const headChapter = extractChapter(headLines, chStr);

  return baseChapter !== headChapter;
}

// ---------------------------------------------------------------------------
// Get token and config from environment / .env files
// ---------------------------------------------------------------------------

function getConfig() {
  let token = readSecret('door43_token', 'DOOR43_TOKEN') || readSecret('gitea_token', 'GITEA_TOKEN');
  let username = readSecret('door43_username', 'DOOR43_USERNAME') || readSecret('gitea_username', 'GITEA_USERNAME');

  // Legacy compatibility: fallback to .env values if not provided via secrets or env vars.
  const envPaths = [
    path.join(CSKILLBP_DIR, '.env'),
    '/srv/bot/config/.env',
  ];
  for (const envPath of envPaths) {
    if ((!token || !username) && fs.existsSync(envPath)) {
      const lines = fs.readFileSync(envPath, 'utf8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        if (!token && (key === 'DOOR43_TOKEN' || key === 'GITEA_TOKEN')) token = val;
        if (!username && (key === 'DOOR43_USERNAME' || key === 'GITEA_USERNAME')) username = val;
      }
    }
  }

  const reposPath = process.env.DOOR43_REPOS_PATH || '/srv/bot/workspace/door43-repos';
  return { token, username, reposPath };
}

// ---------------------------------------------------------------------------
// Repo filename helpers
// ---------------------------------------------------------------------------

function getRepoFilename(type, book) {
  const bookUpper = book.toUpperCase();
  const num = BOOK_NUMBERS[bookUpper];
  if (!num) throw new Error(`Unknown book code: ${book}`);

  if (type === 'tn') {
    return `tn_${bookUpper}.tsv`;
  }
  // ULT/UST use numbered USFM files like 19-PSA.usfm
  return `${num}-${bookUpper}.usfm`;
}

// ---------------------------------------------------------------------------
// syncRepo — clone if needed, create fresh branch from origin/{baseBranch}
// ---------------------------------------------------------------------------

async function syncRepo(repoDir, repoName, branch, baseBranch = 'master') {
  const repoUrl = `https://git.door43.org/${ORG}/${repoName}.git`;
  const { token } = getConfig();
  const onAuth = token ? makeOnAuth(token) : undefined;

  // Clone if missing — shallow (depth 1) since we only need the latest master tip.
  // isomorphic-git aborts on repos with large ref lists (en_ust has 180KB+),
  // so we try native git first, falling back to isomorphic-git.
  if (!fs.existsSync(path.join(repoDir, '.git'))) {
    console.log(`${LOG_PREFIX} Cloning ${repoName} (shallow, depth 1) into ${repoDir}...`);
    fs.mkdirSync(path.dirname(repoDir), { recursive: true });
    let cloned = false;
    try {
      execFileSync('git', ['clone', '--depth', '1', '--single-branch', repoUrl, repoDir],
        { timeout: 120000, stdio: 'pipe' });
      cloned = true;
      console.log(`${LOG_PREFIX} Cloned ${repoName} via native git`);
    } catch (nativeErr) {
      console.warn(`${LOG_PREFIX} Native git clone failed (${nativeErr.message}), trying isomorphic-git...`);
    }
    if (!cloned) {
      try {
        await withTimeout(
          git.clone({ fs, http: gitHttp, dir: repoDir, url: repoUrl, depth: 1, singleBranch: true }),
          120000, `clone ${repoName}`
        );
      } catch (isoErr) {
        // Clean up partial clone
        try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch {}
        throw new Error(
          `Clone failed for ${repoName}: ${isoErr.message}. ` +
          `Repos with many branches may need pre-cloning on the host: ` +
          `git clone --depth 1 --single-branch ${repoUrl} ${repoDir}`
        );
      }
    }
  }

  // Verify remote URL points to unfoldingWord
  const remoteUrl = await git.getConfig({ fs, dir: repoDir, path: 'remote.origin.url' });
  if (remoteUrl && !remoteUrl.includes('unfoldingWord') && !remoteUrl.includes('door43.org')) {
    throw new Error(`Remote URL does not point to unfoldingWord: ${remoteUrl}`);
  }
  // Ensure remote URL is set correctly (clean URL — auth via onAuth callback, not embedded)
  await git.setConfig({ fs, dir: repoDir, path: 'remote.origin.url', value: repoUrl });

  // Set git identity
  await git.setConfig({ fs, dir: repoDir, path: 'user.email', value: 'bot@unfoldingword.org' });
  await git.setConfig({ fs, dir: repoDir, path: 'user.name', value: 'BW Bot' });

  // Fetch latest (shallow, depth 1).
  // Uses custom HTTP handler (native https) because the default `simple-get`
  // module aborts on large repos under Node v25 in Docker containers.
  console.log(`${LOG_PREFIX} Fetching origin/${baseBranch} for ${repoName} (depth 1)...`);
  try {
    await withTimeout(
      git.fetch({ fs, http: gitHttp, dir: repoDir, remote: 'origin', ref: baseBranch, depth: 1, singleBranch: true, onAuth }),
      120000, `fetch ${repoName}`
    );
  } catch (fetchErr) {
    console.warn(`${LOG_PREFIX} Fetch failed for ${repoName} (${fetchErr.message}) — deleting local clone and re-cloning fresh...`);
    fs.rmSync(repoDir, { recursive: true, force: true });
    await withTimeout(
      git.clone({ fs, http: gitHttp, dir: repoDir, url: repoUrl, depth: 1, singleBranch: true, onAuth }),
      120000, `re-clone ${repoName}`
    );
    console.log(`${LOG_PREFIX} Re-cloned ${repoName} fresh`);
  }

  // Delete local branch if it exists (ignore errors if it doesn't)
  try {
    await git.deleteBranch({ fs, dir: repoDir, ref: branch });
  } catch {
    // Branch didn't exist locally — fine
  }

  // Create fresh branch from origin/{baseBranch} and check it out
  await git.branch({ fs, dir: repoDir, ref: branch, object: `origin/${baseBranch}` });
  await git.checkout({ fs, dir: repoDir, ref: branch });
  console.log(`${LOG_PREFIX} On branch ${branch} (from origin/${baseBranch}) in ${repoDir}`);
}

// ---------------------------------------------------------------------------
// insertContent — run the appropriate Python insertion script
// ---------------------------------------------------------------------------

function insertContent({ type, book, chapter, source, verses, repoDir, repoFilename }) {
  const bookFilePath = path.join(repoDir, repoFilename);
  const sourcePath = path.resolve(CSKILLBP_DIR, source);

  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Source file not found: ${source} (resolved: ${sourcePath})`);
  }
  if (!fs.existsSync(bookFilePath)) {
    throw new Error(`Book file not found: ${bookFilePath}`);
  }

  if (type === 'tn') {
    console.log(`${LOG_PREFIX} Inserting TN rows: ${source} → ${repoFilename}`);
    let ultFile;
    const bookNum = BOOK_NUMBERS[book.toUpperCase()];
    if (bookNum) {
      const candidate = path.join(CSKILLBP_DIR, 'data', 'published_ult_english',
                                  `${bookNum}-${book.toUpperCase()}.usfm`);
      if (fs.existsSync(candidate)) ultFile = candidate;
    }
    const output = insertTnRows({
      bookFile: bookFilePath,
      sourceFile: sourcePath,
      chapter,
      skipIntro: book.toUpperCase() === 'PSA',
      ultFile,
      backup: true,
    });
    if (output.trim()) console.log(`${LOG_PREFIX} insert_tn_rows: ${output.trim()}`);
  } else {
    // ULT or UST
    const verseRange = verses || `1-${getVerseCount(book, chapter)}`;
    console.log(`${LOG_PREFIX} Inserting ${type.toUpperCase()} verses ${verseRange} for ${book} ${chapter}: ${source} → ${repoFilename}`);
    const output = insertUsfmVerses({
      bookFile: bookFilePath,
      sourceFile: sourcePath,
      chapter,
      verses: verseRange,
      backup: true,
    });
    if (output.trim()) console.log(`${LOG_PREFIX} insert_usfm_verses: ${output.trim()}`);
  }
}

// ---------------------------------------------------------------------------
// commitAndPush — git add, commit, push with retry
// ---------------------------------------------------------------------------

async function commitAndPush(repoDir, branch, filename, commitMsg, { force = false } = {}) {
  const { token } = getConfig();
  const onAuth = token ? makeOnAuth(token) : undefined;

  // Stage the file
  await git.add({ fs, dir: repoDir, filepath: filename });

  // Check if there are actually changes to commit
  const matrix = await git.statusMatrix({ fs, dir: repoDir, filepaths: [filename] });
  // statusMatrix returns [filepath, HEAD, WORKDIR, STAGE]
  // If HEAD === STAGE for all files, there are no staged changes
  const hasChanges = matrix.some(([, head, , stage]) => head !== stage);

  if (!hasChanges) {
    console.warn(`${LOG_PREFIX} No changes to commit for ${filename} — content may already match master`);
    return { noChanges: true };
  }

  // Commit
  await git.commit({
    fs, dir: repoDir,
    message: commitMsg,
    author: { name: 'BW Bot', email: 'bot@unfoldingword.org' },
  });

  // Push with retry
  await withRetry(
    () => withTimeout(
      git.push({ fs, http: gitHttp, dir: repoDir, remote: 'origin', ref: branch, onAuth, force }),
      60000, `push ${branch}`
    ),
    { maxAttempts: 3, baseDelayMs: 2000, label: `push ${branch}` }
  );

  console.log(`${LOG_PREFIX} Pushed ${branch} to origin`);
  return { noChanges: false };
}

// ---------------------------------------------------------------------------
// createAndMergePR — Gitea API: create PR, merge, delete branch
// ---------------------------------------------------------------------------

async function createAndMergePR(token, repo, branch, title, baseBranch = 'master') {
  // Validate token
  const tokenCheck = await apiRequest('GET', `/repos/${ORG}/${repo}`, token);
  if (tokenCheck.status === 401 || tokenCheck.status === 403) {
    return { success: false, details: `API token invalid/expired (HTTP ${tokenCheck.status})` };
  }

  // Verify branch exists on remote
  const branchCheck = await apiRequest('GET', `/repos/${ORG}/${repo}/branches/${branch}`, token);
  if (branchCheck.status === 404) {
    return { success: false, details: `Branch '${branch}' does not exist on ${ORG}/${repo} — push may have failed` };
  }

  // Create PR (handle 409 = already exists)
  let prNumber;
  const createResult = await withRetry(
    async () => {
      const res = await apiRequest('POST', `/repos/${ORG}/${repo}/pulls`, token, {
        title,
        head: branch,
        base: baseBranch,
        body: '',
      });

      if (res.status === 200 || res.status === 201) {
        return { prNumber: res.data.number, url: res.data.html_url || '' };
      }

      if (res.status === 409) {
        // PR already exists — extract PR number from message
        const msg = typeof res.data === 'object' ? (res.data.message || '') : String(res.data);
        const m = msg.match(/issue_id:\s*(\d+)/);
        if (m) {
          return { prNumber: parseInt(m[1], 10), url: `https://git.door43.org/${ORG}/${repo}/pulls/${m[1]}` };
        }
        // If we can't parse the existing PR number, search for it
        const searchRes = await apiRequest('GET', `/repos/${ORG}/${repo}/pulls?state=open&head=${ORG}:${branch}&limit=5`, token);
        if (searchRes.status === 200 && Array.isArray(searchRes.data) && searchRes.data.length > 0) {
          const pr = searchRes.data[0];
          return { prNumber: pr.number, url: pr.html_url || '' };
        }
        throw new Error(`PR already exists but could not find PR number (409 response)`);
      }

      if (res.status >= 500) {
        throw new Error(`Gitea API error creating PR: HTTP ${res.status}`);
      }

      return { error: true, status: res.status, data: res.data };
    },
    { maxAttempts: 3, baseDelayMs: 2000, label: `create PR ${repo}/${branch}` }
  );

  if (createResult.error) {
    return { success: false, details: `Failed to create PR: HTTP ${createResult.status} — ${JSON.stringify(createResult.data)}` };
  }

  prNumber = createResult.prNumber;
  console.log(`${LOG_PREFIX} PR #${prNumber} created for ${repo}/${branch}`);

  // Merge PR
  await withRetry(
    async () => {
      const res = await apiRequest('POST', `/repos/${ORG}/${repo}/pulls/${prNumber}/merge`, token, {
        Do: 'merge',
        merge_message_field: `Merge ${title}`,
      });

      if (res.status === 200 || res.status === 204) return;
      if (res.status === 405) {
        console.log(`${LOG_PREFIX} PR #${prNumber} already merged`);
        return;
      }
      throw new Error(`Merge failed: HTTP ${res.status} — ${JSON.stringify(res.data)}`);
    },
    { maxAttempts: 3, baseDelayMs: 2000, label: `merge PR #${prNumber}` }
  );

  console.log(`${LOG_PREFIX} PR #${prNumber} merged on ${repo}`);

  // Delete branch (best-effort)
  try {
    const delRes = await apiRequest('DELETE', `/repos/${ORG}/${repo}/branches/${branch}`, token);
    if (delRes.status === 200 || delRes.status === 204 || delRes.status === 404) {
      console.log(`${LOG_PREFIX} Branch ${branch} deleted from ${repo}`);
    } else {
      console.warn(`${LOG_PREFIX} Could not delete branch ${branch}: HTTP ${delRes.status}`);
    }
  } catch (err) {
    console.warn(`${LOG_PREFIX} Branch deletion failed (non-critical): ${err.message}`);
  }

  return { success: true, details: `PR #${prNumber} merged ${branch} into ${baseBranch} on ${repo}`, prNumber };
}

// ---------------------------------------------------------------------------
// door43Push — main entry point called by pipelines
// ---------------------------------------------------------------------------

/**
 * Push content to Door43 via direct git + API operations.
 *
 * @param {object} opts
 * @param {string} opts.type - 'tn', 'ult', or 'ust'
 * @param {string} opts.book - 3-letter book code (e.g. 'PSA')
 * @param {number} opts.chapter - chapter number
 * @param {string} opts.username - Door43 username for PR title
 * @param {string} opts.branch - staging branch name (e.g. 'AI-PSA-030')
 * @param {string} opts.source - relative path to source file (from CSKILLBP_DIR)
 * @param {string} [opts.verses] - verse range (e.g. '1-20'), auto-computed if omitted
 * @returns {{ success: boolean, details: string, prNumber?: number }}
 */
async function door43Push(opts) {
  const { type, book, chapter, username, branch, source, verses, branchOnly } = opts;
  const repo = REPO_MAP[type];
  if (!repo) {
    return { success: false, details: `Unknown type: ${type}. Expected tn, ult, or ust.` };
  }

  const config = getConfig();
  if (!config.token) {
    return { success: false, details: 'No Door43 token found (DOOR43_TOKEN / GITEA_TOKEN not set)' };
  }

  const repoDir = path.join(config.reposPath, repo);
  const repoFilename = getRepoFilename(type, book);
  const prTitle = `AI ${type.toUpperCase()} for ${book} ${chapter} [${username}]`;

  console.log(`${LOG_PREFIX} Starting push: ${type.toUpperCase()} ${book} ${chapter} → ${repo}/${branch} (target: master)`);
  const startTime = Date.now();

  try {
    // Step 1: Sync repo (clone/fetch, create staging branch from master)
    await syncRepo(repoDir, repo, branch);

    // Step 3: Insert content via Python script
    insertContent({ type, book, chapter, source, verses, repoDir, repoFilename });

    // Step 3b: Door43 CI validation gate (TN only)
    // JS port of TN TSV validation checks (distroless-safe; no python dependency).
    // Only blocks on errors in the chapter we're inserting — pre-existing errors
    // in other chapters are logged as warnings but do not block delivery.
    if (type === 'tn') {
      const relFile = path.posix.join(config.reposPath, repo, repoFilename).replace(/\\/g, '/');
      let parsed = null;
      try {
        // Keep check coverage aligned with implemented JS validator rules.
        const rawJson = validateTnTsv({ file: relFile, checks: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13], maxErrors: 1000 });
        parsed = JSON.parse(rawJson);
      } catch (validationErr) {
        console.warn(`${LOG_PREFIX} JS validation failed to run: ${validationErr.message} — skipping`);
      }

      if (parsed && Array.isArray(parsed.findings)) {
        const allErrors = parsed.findings.map((f) => ({
          line: f.line,
          ref: f.reference,
          message: f.message,
        }));

        // Only block on errors in the chapter we're inserting
        const chapterPrefix = String(chapter) + ':';
        const ourErrors = allErrors.filter(e => e.ref && String(e.ref).startsWith(chapterPrefix));
        const otherCount = allErrors.length - ourErrors.length;

        if (otherCount > 0) {
          console.warn(`${LOG_PREFIX} ${otherCount} pre-existing validation issue(s) in other chapters (not blocking)`);
        }

        if (ourErrors.length > 0) {
          const errorSummary = ourErrors.slice(0, 10).map(e =>
            `  Line ${e.line || '?'}: [${e.ref}] ${e.message}`
          ).join('\n');
          let details = `Door43 CI validation failed for ${repoFilename} — ${ourErrors.length} error(s) in chapter ${chapter}:\n${errorSummary}`;
          if (ourErrors.length > 10) details += `\n  ... and ${ourErrors.length - 10} more`;
          await git.checkout({ fs, dir: repoDir, filepaths: [repoFilename], force: true });
          console.error(`${LOG_PREFIX} ${details}`);
          throw new Error(details);
        }

        console.log(`${LOG_PREFIX} Door43 CI validation passed for chapter ${chapter} in ${repoFilename}`);
      }
    }

    // Step 4: Commit and push
    const commitMsg = `${type.toUpperCase()}: ${book} ${chapter} [${username}]`;
    const pushResult = await commitAndPush(repoDir, branch, repoFilename, commitMsg, { force: !!branchOnly });

    if (pushResult.noChanges) {
      return {
        success: true,
        noChanges: true,
        details: `No changes detected for ${type.toUpperCase()} ${book} ${chapter} — content already matches master`,
      };
    }

    // Step 5: Create PR targeting master, merge, delete staging branch
    //         Skip when branchOnly=true — leave the branch open for review
    if (branchOnly) {
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      const branchUrl = `https://git.door43.org/${ORG}/${repo}/src/branch/${branch}`;
      console.log(`${LOG_PREFIX} branchOnly: skipping PR for ${type.toUpperCase()} ${book} ${chapter} — branch at ${branchUrl}`);
      return { success: true, branchOnly: true, branchUrl, duration };
    }

    const prResult = await createAndMergePR(config.token, repo, branch, prTitle);
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    if (prResult.success) {
      console.log(`${LOG_PREFIX} Complete: ${type.toUpperCase()} ${book} ${chapter} in ${duration}s`);
    } else {
      console.error(`${LOG_PREFIX} PR step failed: ${prResult.details}`);
    }

    return { ...prResult, duration };
  } catch (err) {
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.error(`${LOG_PREFIX} Failed: ${type.toUpperCase()} ${book} ${chapter} after ${duration}s — ${err.message}`);
    return { success: false, details: `${err.message}`, duration };
  }
}

module.exports = { door43Push, checkConflictingBranches, BOOK_NUMBERS, REPO_MAP, getRepoFilename };
