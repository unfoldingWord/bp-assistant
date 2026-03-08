// door43-push.js — Deterministic Door43 push (replaces Claude-mediated repo-insert)
//
// Calls Python insertion scripts directly, then runs git + Gitea API operations
// with retry logic. No AI layer — fully deterministic, structured success/failure.

const { execSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { getVerseCount } = require('./verse-counts');

const GITEA_API = 'https://git.door43.org/api/v1';
const ORG = 'unfoldingWord';

const CSKILLBP_DIR = process.env.CSKILLBP_DIR || '/srv/bot/workspace';
const SCRIPTS_DIR = path.join(CSKILLBP_DIR, '.claude/skills/repo-insert/scripts');

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
// User branch naming conventions (from Door43 / tcCreate)
// ---------------------------------------------------------------------------

/**
 * Derive the user's working branch name for a given content type.
 * @param {string} type - 'tn', 'tq', 'ult', or 'ust'
 * @param {string} username - Door43 username (e.g. 'deferredreward')
 * @param {string} book - 3-letter book code (e.g. 'PSA')
 * @returns {string} user branch name
 */
function getUserBranch(type, username, book) {
  const bookUpper = book.toUpperCase();
  if (type === 'tn' || type === 'tq') {
    return `${username}-tc-create-1`;
  }
  // ULT / UST
  return `auto-${username}-${bookUpper}`;
}

/**
 * Ensure a branch exists on the remote repo. If missing, create from master.
 * @param {string} token - Gitea API token
 * @param {string} repo - repo name (e.g. 'en_tn')
 * @param {string} branch - branch to ensure exists
 */
async function ensureRemoteBranch(token, repo, branch) {
  const checkRes = await apiRequest('GET', `/repos/${ORG}/${repo}/branches/${encodeURIComponent(branch)}`, token);
  if (checkRes.status === 200) {
    console.log(`${LOG_PREFIX} User branch '${branch}' exists on ${repo}`);
    return;
  }

  console.log(`${LOG_PREFIX} Creating user branch '${branch}' from master on ${repo}`);
  const createRes = await apiRequest('POST', `/repos/${ORG}/${repo}/branches`, token, {
    new_branch_name: branch,
    old_branch_name: 'master',
  });

  if (createRes.status === 201 || createRes.status === 200) {
    console.log(`${LOG_PREFIX} Created user branch '${branch}' from master`);
    return;
  }
  // 409 = branch already exists (race condition) — that's fine
  if (createRes.status === 409) {
    console.log(`${LOG_PREFIX} User branch '${branch}' already exists (409 race)`);
    return;
  }

  throw new Error(`Failed to create branch '${branch}' on ${repo}: HTTP ${createRes.status} — ${JSON.stringify(createRes.data)}`);
}

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
// Get token and config from environment / .env files
// ---------------------------------------------------------------------------

function getConfig() {
  // Try workspace .env first (same logic as gitea_pr.py)
  let token = process.env.DOOR43_TOKEN || process.env.GITEA_TOKEN;
  let username = process.env.DOOR43_USERNAME || process.env.GITEA_USERNAME;

  // Try loading from workspace .env if env vars missing
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

function syncRepo(repoDir, repoName, branch, baseBranch = 'master') {
  const repoUrl = `https://git.door43.org/${ORG}/${repoName}.git`;

  // Clone if missing
  if (!fs.existsSync(path.join(repoDir, '.git'))) {
    console.log(`${LOG_PREFIX} Cloning ${repoName} into ${repoDir}...`);
    fs.mkdirSync(path.dirname(repoDir), { recursive: true });
    execSync(`git clone ${repoUrl} ${repoDir}`, { timeout: 120000, stdio: 'pipe' });
  }

  // Verify remote URL points to unfoldingWord
  try {
    const remoteUrl = execSync('git remote get-url origin', { cwd: repoDir, encoding: 'utf8', timeout: 5000 }).trim();
    if (!remoteUrl.includes('unfoldingWord') && !remoteUrl.includes('door43.org')) {
      throw new Error(`Remote URL does not point to unfoldingWord: ${remoteUrl}`);
    }
  } catch (err) {
    if (err.message.includes('Remote URL')) throw err;
    // If remote check fails, set it
    execSync(`git remote set-url origin ${repoUrl}`, { cwd: repoDir, timeout: 5000, stdio: 'pipe' });
  }

  // Update token in remote URL for authenticated push
  const { token } = getConfig();
  if (token) {
    const authUrl = `https://${token}@git.door43.org/${ORG}/${repoName}.git`;
    execSync(`git remote set-url origin ${authUrl}`, { cwd: repoDir, timeout: 5000, stdio: 'pipe' });
  }

  // Ensure git identity is configured (prevents "Author identity unknown" errors)
  execFileSync('git', ['config', 'user.email', 'bot@unfoldingword.org'], { cwd: repoDir, timeout: 5000, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'BW Bot'], { cwd: repoDir, timeout: 5000, stdio: 'pipe' });

  // Fetch latest
  console.log(`${LOG_PREFIX} Fetching origin for ${repoName}...`);
  execSync('git fetch origin', { cwd: repoDir, timeout: 60000, stdio: 'pipe' });

  // Detach HEAD, delete local branch if it exists, create fresh from origin/{baseBranch}
  execSync('git checkout --detach', { cwd: repoDir, timeout: 10000, stdio: 'pipe' });
  try {
    execFileSync('git', ['branch', '-D', branch], { cwd: repoDir, timeout: 5000, stdio: 'pipe' });
  } catch {
    // Branch didn't exist locally — fine
  }
  execFileSync('git', ['checkout', '-b', branch, `origin/${baseBranch}`], { cwd: repoDir, timeout: 10000, stdio: 'pipe' });
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
    const script = path.join(SCRIPTS_DIR, 'insert_tn_rows.py');
    console.log(`${LOG_PREFIX} Inserting TN rows: ${source} → ${repoFilename}`);
    const args = [
      script,
      '--book-file', bookFilePath,
      '--source-file', sourcePath,
      '--chapter', String(chapter),
      '--backup',
    ];
    if (book.toUpperCase() === 'PSA') args.push('--skip-intro');
    const output = execFileSync('python3', args, { encoding: 'utf8', timeout: 60000, cwd: CSKILLBP_DIR });
    if (output.trim()) console.log(`${LOG_PREFIX} insert_tn_rows: ${output.trim()}`);
  } else {
    // ULT or UST
    const script = path.join(SCRIPTS_DIR, 'insert_usfm_verses.py');
    const verseRange = verses || `1-${getVerseCount(book, chapter)}`;
    console.log(`${LOG_PREFIX} Inserting ${type.toUpperCase()} verses ${verseRange} for ${book} ${chapter}: ${source} → ${repoFilename}`);
    const output = execFileSync('python3', [
      script,
      '--book-file', bookFilePath,
      '--source-file', sourcePath,
      '--chapter', String(chapter),
      '--verses', verseRange,
      '--backup',
    ], { encoding: 'utf8', timeout: 60000, cwd: CSKILLBP_DIR });
    if (output.trim()) console.log(`${LOG_PREFIX} insert_usfm_verses: ${output.trim()}`);
  }
}

// ---------------------------------------------------------------------------
// commitAndPush — git add, commit, push with retry
// ---------------------------------------------------------------------------

async function commitAndPush(repoDir, branch, filename, commitMsg) {
  execSync(`git add ${filename}`, { cwd: repoDir, timeout: 10000, stdio: 'pipe' });

  // Check if there are actually changes to commit
  try {
    execSync('git diff --cached --quiet', { cwd: repoDir, timeout: 5000, stdio: 'pipe' });
    // No error = no changes
    console.warn(`${LOG_PREFIX} No changes to commit for ${filename} — content may already match master`);
    return { noChanges: true };
  } catch {
    // Has changes — proceed with commit
  }

  execSync(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, { cwd: repoDir, timeout: 10000, stdio: 'pipe' });

  // Push with retry
  await withRetry(
    () => {
      execSync(`git push origin ${branch}`, { cwd: repoDir, timeout: 60000, stdio: 'pipe' });
    },
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
  const { type, book, chapter, username, branch, source, verses } = opts;
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

  // Derive user branch (PR target) from content type + username + book
  const userBranch = getUserBranch(type, username, book);

  console.log(`${LOG_PREFIX} Starting push: ${type.toUpperCase()} ${book} ${chapter} → ${repo}/${branch} (target: ${userBranch})`);
  const startTime = Date.now();

  try {
    // Step 1: Ensure user branch exists on remote (create from master if not)
    await ensureRemoteBranch(config.token, repo, userBranch);

    // Step 2: Sync repo (clone/fetch, create staging branch from user branch)
    syncRepo(repoDir, repo, branch, userBranch);

    // Step 3: Insert content via Python script
    insertContent({ type, book, chapter, source, verses, repoDir, repoFilename });

    // Step 3b: Door43 CI validation gate (TN only)
    // TEMPORARILY DISABLED — Door43 CI workflow (validate_tn_files.py) is not
    // finalized yet. Re-enable once the remote CI script is stable.
    // if (type === 'tn') {
    //   const bookFilePath = path.join(repoDir, repoFilename);
    //   const validateScript = path.join(CSKILLBP_DIR, '.claude/skills/tn-quality-check/scripts/validate_tn_tsv.py');
    //   const jsonOut = path.join(repoDir, '.validation-result.json');
    //   try {
    //     execFileSync('python3', [validateScript, bookFilePath, '--json', jsonOut], {
    //       encoding: 'utf8', timeout: 60000, cwd: CSKILLBP_DIR, stdio: 'pipe',
    //     });
    //     console.log(`${LOG_PREFIX} Door43 CI validation passed for ${repoFilename}`);
    //   } catch (valErr) {
    //     let details = `Door43 CI validation failed for ${repoFilename}`;
    //     try {
    //       const result = JSON.parse(fs.readFileSync(jsonOut, 'utf8'));
    //       const errorSummary = result.errors.slice(0, 10).map(e =>
    //         `  Line ${e.line}: [${e.rule}] ${e.message}`
    //       ).join('\n');
    //       details += ` (${result.error_count} error(s)):\n${errorSummary}`;
    //       if (result.error_count > 10) details += `\n  ... and ${result.error_count - 10} more`;
    //     } catch {
    //       details += `: ${valErr.stderr || valErr.message}`;
    //     }
    //     execFileSync('git', ['checkout', '--', repoFilename], { cwd: repoDir, timeout: 5000, stdio: 'pipe' });
    //     console.error(`${LOG_PREFIX} ${details}`);
    //     throw new Error(details);
    //   }
    // }

    // Step 4: Commit and push
    const commitMsg = `${type.toUpperCase()}: ${book} ${chapter} [${username}]`;
    const pushResult = await commitAndPush(repoDir, branch, repoFilename, commitMsg);

    if (pushResult.noChanges) {
      return { success: true, details: `No changes detected for ${type.toUpperCase()} ${book} ${chapter} — content already matches ${userBranch}` };
    }

    // Step 5: Create PR targeting user branch, merge, delete staging branch
    const prResult = await createAndMergePR(config.token, repo, branch, prTitle, userBranch);
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

module.exports = { door43Push, BOOK_NUMBERS, getRepoFilename, getUserBranch };
