// repo-verify.js — JS-level repo verification after repo-insert
// Runs OUTSIDE Claude to avoid "Claude says it worked but it didn't" problem.
//
// Verifies that a staging branch was MERGED and DELETED from the remote.
// If the staging branch still exists, the PR was never created or never merged.

const { execSync } = require('child_process');

const VERIFY_TIMEOUT_MS = 15000; // 15 seconds for git operations

/**
 * Verify that a repo-insert actually merged to master by checking that the
 * staging branch no longer exists on the remote (it gets deleted after merge).
 *
 * @param {object} opts
 * @param {string} opts.repo - Repo name (en_tn, en_ult, en_ust)
 * @param {string} opts.stagingBranch - The staging branch name that should have been merged+deleted
 * @returns {{ success: boolean, details: string }}
 */
async function verifyRepoPush({ repo, stagingBranch }) {
  // Load credentials from env (dotenv already loaded by the app)
  const username = process.env.DOOR43_USERNAME || process.env.GITEA_USERNAME;
  const token = process.env.DOOR43_TOKEN || process.env.GITEA_TOKEN;

  const authUrl = username && token
    ? `https://${username}:${token}@git.door43.org/unfoldingWord/${repo}.git`
    : `https://git.door43.org/unfoldingWord/${repo}.git`;

  // Check if the staging branch still exists on the remote
  try {
    const lsResult = execSync(
      `git ls-remote --heads ${authUrl} ${stagingBranch}`,
      { encoding: 'utf8', timeout: VERIFY_TIMEOUT_MS }
    ).trim();

    if (lsResult && lsResult.includes(stagingBranch)) {
      // Staging branch still exists — PR was never merged
      return {
        success: false,
        details: `Staging branch '${stagingBranch}' still exists on ${repo} — PR was not merged. Content did NOT land on master.`,
      };
    }
  } catch (err) {
    return {
      success: false,
      details: `git ls-remote failed for ${repo}: ${err.message}`,
    };
  }

  // Staging branch is gone — means it was merged and deleted
  return {
    success: true,
    details: `Staging branch '${stagingBranch}' deleted from ${repo} — merge to master confirmed`,
  };
}

module.exports = { verifyRepoPush };
