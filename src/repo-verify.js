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
async function verifyRepoPush({ repo, stagingBranch, since, prNumber }) {
  const token = readSecret('door43_token', 'DOOR43_TOKEN') || readSecret('gitea_token', 'GITEA_TOKEN');

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
          return {
            success: true,
            details: `PR #${prNumber} merged ${stagingBranch} into master on ${repo} (confirmed via direct PR lookup)`,
          };
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
      return {
        success: true,
        details: `PR #${merged.number} merged ${stagingBranch} into master on ${repo}`,
      };
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
          return {
            success: true,
            details: `PR #${fallbackMerged.number} merged ${stagingBranch} into master on ${repo} (confirmed via fallback scan; head-filter was unreliable after branch deletion)`,
          };
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

module.exports = { verifyRepoPush, verifyDcsToken };
