// repo-verify.js — JS-level repo verification after repo-insert
// Runs OUTSIDE Claude to avoid "Claude says it worked but it didn't" problem.
//
// Verifies that a repo-insert actually landed on master by checking the Gitea
// API for a merged PR from the staging branch. Branch-absence alone is not
// reliable because a failed push means the branch was never created, which
// looks identical to "branch was merged and deleted."

const https = require('https');

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
 * @param {object} opts
 * @param {string} opts.repo - Repo name (en_tn, en_ult, en_ust)
 * @param {string} opts.stagingBranch - The staging branch name that should have been merged+deleted
 * @returns {{ success: boolean, details: string }}
 */
async function verifyRepoPush({ repo, stagingBranch }) {
  const token = process.env.DOOR43_TOKEN || process.env.GITEA_TOKEN;

  if (!token) {
    return {
      success: false,
      details: `No API token available for verification (DOOR43_TOKEN / GITEA_TOKEN not set)`,
    };
  }

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
    const merged = pulls.find(pr => pr.merged === true || pr.merged_by != null);

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

module.exports = { verifyRepoPush };
