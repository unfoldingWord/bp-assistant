// repo-verify.js — JS-level repo verification after repo-insert
// Runs OUTSIDE Claude to avoid "Claude says it worked but it didn't" problem.
//
// Verifies that a repo-insert actually landed on master by checking the Gitea
// API for a merged PR from the staging branch. Branch-absence alone is not
// reliable because a failed push means the branch was never created, which
// looks identical to "branch was merged and deleted."

const https = require('https');
const { readSecret } = require('./secrets');

const GITEA_API = 'https://git.door43.org/api/v1';
const ORG = 'unfoldingWord';

/**
 * Make a Gitea API GET request. Returns { status, data }.
 */
function apiGet(path, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${GITEA_API}${path}`);
    const opts = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000,
    };
    if (token) opts.headers['Authorization'] = `token ${token}`;

    const req = https.request(opts, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, data: body });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('API request timed out')); });
    req.end();
  });
}

/**
 * Fetch a file's raw bytes from a branch. Returns the text, or null on any
 * failure (missing file, non-200, network error) — callers treat null as
 * "could not read", which is a verification failure, not a pass.
 */
function fetchRawFile(repo, filename, branch = 'master', org = ORG) {
  return new Promise((resolve) => {
    const url = new URL(`https://git.door43.org/${org}/${repo}/raw/branch/${branch}/${filename}`);
    const req = https.request(
      { hostname: url.hostname, path: url.pathname, method: 'GET', timeout: 20000 },
      (res) => {
        if (res.statusCode !== 200) { res.resume(); return resolve(null); }
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve(body));
        res.on('error', () => resolve(null));
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

/**
 * Count TSV rows whose Reference column belongs to one of `chapters`.
 * Intro rows (`3:intro`) count — they are content we pushed.
 */
function countTsvChapterRows(text, chapters) {
  const wanted = new Set(chapters.map(String));
  let count = 0;
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    const ref = line.split('\t')[0] || '';
    const ch = ref.split(':')[0];
    if (wanted.has(ch)) count++;
  }
  return count;
}

/**
 * Count verse markers inside one chapter of a USFM file.
 *
 * Counts \v markers anywhere on a line, not just at line start — mid-line \v
 * markers are legitimate USFM and undercounting them was the #245 bug.
 */
function countUsfmChapterVerses(text, chapter) {
  const src = String(text);
  const startRe = new RegExp(`\\\\c\\s+${chapter}(?!\\d)`);
  const start = src.search(startRe);
  if (start === -1) return null; // chapter marker absent entirely
  const rest = src.slice(start);
  const nextC = rest.slice(1).search(/\\c\s+\d+/);
  const chapterText = nextC === -1 ? rest : rest.slice(0, nextC + 1);
  return (chapterText.match(/\\v\s+\d+/g) || []).length;
}

/**
 * Assert that the content we pushed is actually readable on master.
 *
 * Why this exists: verifyRepoPush's merged-PR check proves a PR merged, not
 * that the chapter's rows are in the file. A PR that merged zero rows, the
 * wrong rows, or a truncated file satisfies it exactly as well as a correct
 * one. The old Claude-mediated repo-verify skill DID compare content
 * (`git show origin/master:tn_PSA.tsv | grep -c "^122:"`); that step was lost
 * when the deterministic JS module replaced it, and every subsequent patch to
 * this file (#79, #116, #73) addressed verification reporting failure wrongly
 * — never the inverse. This closes the inverse.
 *
 * Asserts presence, not equality: remote may legitimately have MORE rows than
 * we pushed (a concurrent editor PR). Missing content is the failure mode.
 *
 * @param {object} opts
 * @param {string} opts.repo - Repo name (en_tn, en_ult, en_ust)
 * @param {string} opts.type - Push type: 'tn' | 'tq' | 'ult' | 'ust'
 * @param {string} opts.book - 3-letter book code
 * @param {number} opts.chapter - First chapter pushed
 * @param {number} [opts.endChapter] - Last chapter pushed (defaults to chapter)
 * @param {number} [opts.expectedRows] - Local row count for TSV pushes
 * @param {number} [opts.expectedVerses] - Local verse count for USFM pushes
 * @returns {{ success: boolean, details: string, skipped?: boolean }}
 */
async function verifyRemoteContent({ repo, type, book, chapter, endChapter, expectedRows, expectedVerses, org = ORG }) {
  if (!type || !book || chapter == null) {
    return { success: true, skipped: true, details: 'content check skipped (caller passed no type/book/chapter)' };
  }

  let filename;
  try {
    filename = require('./door43-push').getRepoFilename(type, book);
  } catch (err) {
    return { success: true, skipped: true, details: `content check skipped (cannot derive filename: ${err.message})` };
  }

  const text = await fetchRawFile(repo, filename, 'master', org);
  if (text == null) {
    return { success: false, details: `could not read ${filename} from ${repo} master — content NOT confirmed` };
  }

  const last = endChapter || chapter;
  const chapters = [];
  for (let c = Number(chapter); c <= Number(last); c++) chapters.push(c);

  if (filename.endsWith('.tsv')) {
    const found = countTsvChapterRows(text, chapters);
    if (found === 0) {
      return {
        success: false,
        details: `${filename} on ${repo} master has NO rows for chapter(s) ${chapters.join(',')} — the merge landed but the content is missing`,
      };
    }
    if (expectedRows != null && found < expectedRows) {
      return {
        success: false,
        details: `${filename} on ${repo} master has ${found} row(s) for chapter(s) ${chapters.join(',')}, expected at least ${expectedRows} — content is incomplete`,
      };
    }
    return {
      success: true,
      details: `${found} row(s) confirmed on master for chapter(s) ${chapters.join(',')}${expectedRows != null ? ` (expected >= ${expectedRows})` : ''}`,
    };
  }

  // USFM (ULT/UST)
  const verses = countUsfmChapterVerses(text, chapter);
  if (verses == null) {
    return { success: false, details: `${filename} on ${repo} master has no \\c ${chapter} marker — the merge landed but the chapter is missing` };
  }
  if (verses === 0) {
    return { success: false, details: `${filename} on ${repo} master has chapter ${chapter} but no verses in it — content is missing` };
  }
  if (expectedVerses != null && verses < expectedVerses) {
    return {
      success: false,
      details: `${filename} on ${repo} master has ${verses} verse(s) in chapter ${chapter}, expected at least ${expectedVerses} — content is incomplete`,
    };
  }
  return {
    success: true,
    details: `${verses} verse(s) confirmed on master in chapter ${chapter}${expectedVerses != null ? ` (expected >= ${expectedVerses})` : ''}`,
  };
}

/**
 * Verify that a repo-insert actually merged to master.
 *
 * Strategy: query the Gitea API for closed PRs from the staging branch.
 * A PR with state "closed" that was merged confirms the content landed.
 * This avoids the false-positive where a never-pushed branch is absent
 * and mistakenly interpreted as "merged and deleted."
 *
 * When a `prNumber` is supplied, a direct PR-by-number lookup is used first.
 * This is resilient to Gitea's behavior of stripping `head.label`/`head.ref`
 * from merged PR records once the source branch is deleted — which breaks
 * both the head-filtered query and the field-based fallback scan below.
 *
 * @param {object} opts
 * @param {string} opts.repo - Repo name (en_tn, en_ult, en_ust)
 * @param {string} opts.stagingBranch - The staging branch name that should have been merged+deleted
 * @param {string} [opts.since] - ISO timestamp; only accept PRs merged after this time
 * @param {number} [opts.prNumber] - Numeric PR id from door43Push; enables direct PR lookup
 * @returns {{ success: boolean, details: string }}
 */
async function verifyRepoPush({ repo, stagingBranch, since, prNumber, content }) {
  const token = readSecret('door43_token', 'DOOR43_TOKEN') || readSecret('gitea_token', 'GITEA_TOKEN');

  // A merged PR is necessary but not sufficient — it says a merge happened, not
  // that the chapter's content is in the file. Every success path below funnels
  // through here so "verified" always means both.
  const confirm = async (mergeDetails) => {
    const contentResult = await verifyRemoteContent({ repo, ...(content || {}) });
    if (!contentResult.success) {
      return { success: false, details: `${mergeDetails}, but content verification FAILED: ${contentResult.details}` };
    }
    if (contentResult.skipped) {
      return { success: true, details: `${mergeDetails} (${contentResult.details})`, contentSkipped: true };
    }
    return { success: true, details: `${mergeDetails}; ${contentResult.details}` };
  };

  if (!token) {
    return {
      success: false,
      details: `No API token available for verification (DOOR43_TOKEN / GITEA_TOKEN not set)`,
    };
  }

  // If no 'since' is provided, default to looking for PRs merged within the last 1 hour
  // to avoid picking up stale merged PRs from older runs reusing the same branch name.
  const effectiveSince = since || new Date(Date.now() - 60 * 60 * 1000).toISOString();

  // First: validate the token works at all
  try {
    const tokenCheck = await apiGet(`/repos/${ORG}/${repo}`, token);
    if (tokenCheck.status === 401 || tokenCheck.status === 403) {
      return {
        success: false,
        details: `API token is invalid or expired (HTTP ${tokenCheck.status}). Repo-insert likely failed silently. Regenerate the token at https://git.door43.org/user/settings/applications`,
      };
    }
  } catch (err) {
    return {
      success: false,
      details: `Token validation failed: ${err.message}`,
    };
  }

  // Direct PR-by-number lookup when door43Push provided one. This works even
  // after Gitea strips head.label/head.ref from the PR record on branch deletion.
  if (prNumber) {
    try {
      const prRes = await apiGet(`/repos/${ORG}/${repo}/pulls/${prNumber}`, token);
      if (prRes.status === 200 && prRes.data && typeof prRes.data === 'object') {
        const pr = prRes.data;
        const isMerged = pr.merged === true || pr.merged_by != null;
        if (isMerged && pr.merged_at && new Date(pr.merged_at) >= new Date(effectiveSince)) {
          return await confirm(`PR #${prNumber} merged ${stagingBranch} into master on ${repo} (confirmed via direct PR lookup)`);
        }
      }
    } catch (_) {
      // Non-fatal: fall through to the head-filter + fallback scan logic below.
    }
  }

  // Search for a merged PR from this staging branch
  try {
    const res = await apiGet(
      `/repos/${ORG}/${repo}/pulls?state=closed&head=${ORG}:${stagingBranch}&limit=5`,
      token,
    );

    if (res.status !== 200) {
      return {
        success: false,
        details: `Gitea API error checking PRs for ${repo}/${stagingBranch}: HTTP ${res.status}`,
      };
    }

    const pulls = Array.isArray(res.data) ? res.data : [];
    const merged = pulls.find(pr => {
      const isMerged = pr.merged === true || pr.merged_by != null;
      if (!isMerged) return false;
      
      if (pr.merged_at) {
        return new Date(pr.merged_at) >= new Date(effectiveSince);
      }
      return false;
    });

    if (merged) {
      return await confirm(`PR #${merged.number} merged ${stagingBranch} into master on ${repo}`);
    }

    // No merged PR found — check if branch exists (PR created but not merged)
    const branchRes = await apiGet(
      `/repos/${ORG}/${repo}/branches/${stagingBranch}`,
      token,
    );

    if (branchRes.status === 200) {
      return {
        success: false,
        details: `Staging branch '${stagingBranch}' still exists on ${repo} but no merged PR found — PR was not merged. Content did NOT land on master.`,
      };
    }

    // Fallback: Gitea's head-filter is unreliable once the branch is deleted —
    // the association is silently dropped and the PR disappears from head-filtered
    // queries.  Scan the most recent closed PRs without a head filter and look
    // for one whose head branch matches the staging branch and was merged within
    // the verification window.
    try {
      const recentRes = await apiGet(
        `/repos/${ORG}/${repo}/pulls?state=closed&limit=20`,
        token,
      );
      if (recentRes.status === 200 && Array.isArray(recentRes.data)) {
        const fallbackMerged = recentRes.data.find((pr) => {
          const headLabel = pr.head?.label || pr.head?.ref || '';
          const isBranch =
            headLabel === stagingBranch || headLabel.endsWith(`:${stagingBranch}`);
          const isMerged = pr.merged === true || pr.merged_by != null;
          if (!isBranch || !isMerged) return false;
          if (pr.merged_at) return new Date(pr.merged_at) >= new Date(effectiveSince);
          return false;
        });
        if (fallbackMerged) {
          return await confirm(`PR #${fallbackMerged.number} merged ${stagingBranch} into master on ${repo} (confirmed via fallback scan; head-filter was unreliable after branch deletion)`);
        }
      }
    } catch (_) {
      // Non-fatal: if the fallback scan itself fails, fall through to the
      // original failure response so the pipeline can retry.
    }

    // Branch doesn't exist AND no merged PR — push likely never happened
    return {
      success: false,
      details: `No merged PR found for '${stagingBranch}' on ${repo} and branch does not exist — push likely failed (check token/auth).`,
    };
  } catch (err) {
    return {
      success: false,
      details: `Verification failed for ${repo}/${stagingBranch}: ${err.message}`,
    };
  }
}

/**
 * Quick token validation — call before expensive pipeline work.
 * Returns { valid: boolean, details: string }.
 */
async function verifyDcsToken() {
  const token = readSecret('door43_token', 'DOOR43_TOKEN') || readSecret('gitea_token', 'GITEA_TOKEN');
  if (!token) {
    return { valid: false, details: 'No DCS token set (DOOR43_TOKEN / GITEA_TOKEN)' };
  }
  try {
    const res = await apiGet(`/repos/${ORG}/en_tn`, token);
    if (res.status === 401 || res.status === 403) {
      return { valid: false, details: `DCS token is invalid or expired (HTTP ${res.status}). Regenerate at https://git.door43.org/user/settings/applications` };
    }
    if (res.status === 200) {
      return { valid: true, details: 'DCS token OK' };
    }
    return { valid: false, details: `DCS token check returned unexpected HTTP ${res.status}` };
  } catch (err) {
    return { valid: false, details: `DCS token check failed: ${err.message}` };
  }
}

// apiGet + GITEA_API are reused by the overnight Sensor (overnight-watcher.js)
// for read-only PR/branch enumeration against Door43.
module.exports = {
  verifyRepoPush,
  verifyDcsToken,
  verifyRemoteContent,
  apiGet,
  GITEA_API,
  _countTsvChapterRows: countTsvChapterRows,
  _countUsfmChapterVerses: countUsfmChapterVerses,
};
