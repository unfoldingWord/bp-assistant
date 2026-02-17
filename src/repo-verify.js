// repo-verify.js — JS-level repo verification after repo-insert
// Runs OUTSIDE Claude to avoid "Claude says it worked but it didn't" problem.

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VERIFY_TIMEOUT_MS = 15000; // 15 seconds for git operations

/**
 * Verify that a repo-insert push actually landed on the remote.
 *
 * @param {object} opts
 * @param {string} opts.repo - Repo name (en_tn, en_ult, en_ust)
 * @param {string} opts.branch - Branch name to check
 * @param {Array<{repoPath: string, localPath: string}>} [opts.expectedFiles] -
 *   Files to verify. repoPath is the path within the repo, localPath is the
 *   absolute path to the local source file to compare against.
 * @returns {{ success: boolean, details: string }}
 */
async function verifyRepoPush({ repo, branch, expectedFiles = [] }) {
  const repoUrl = `https://git.door43.org/unfoldingWord/${repo}.git`;

  // Load credentials from env (dotenv already loaded by the app)
  const username = process.env.DOOR43_USERNAME || process.env.GITEA_USERNAME;
  const token = process.env.DOOR43_TOKEN || process.env.GITEA_TOKEN;

  const authUrl = username && token
    ? `https://${username}:${token}@git.door43.org/unfoldingWord/${repo}.git`
    : repoUrl;

  // Step 1: Verify branch exists on remote
  try {
    const lsResult = execSync(
      `git ls-remote --heads ${authUrl} ${branch}`,
      { encoding: 'utf8', timeout: VERIFY_TIMEOUT_MS }
    ).trim();

    if (!lsResult || !lsResult.includes(branch)) {
      return {
        success: false,
        details: `Branch '${branch}' not found on remote ${repo}`,
      };
    }
  } catch (err) {
    return {
      success: false,
      details: `git ls-remote failed for ${repo}: ${err.message}`,
    };
  }

  // If no files to verify, branch existence is enough
  if (expectedFiles.length === 0) {
    return {
      success: true,
      details: `Branch '${branch}' exists on ${repo}`,
    };
  }

  // Step 2: Shallow clone branch into temp dir
  const tmpDir = path.join('/tmp/claude', `repo-verify-${repo}-${Date.now()}`);
  try {
    execSync(
      `git clone --depth 1 --branch ${branch} ${authUrl} ${tmpDir}`,
      { encoding: 'utf8', timeout: VERIFY_TIMEOUT_MS * 2, stdio: 'pipe' }
    );
  } catch (err) {
    return {
      success: false,
      details: `Failed to clone ${repo}/${branch}: ${err.message}`,
    };
  }

  // Step 3: Compare each expected file
  const failures = [];
  for (const { repoPath, localPath } of expectedFiles) {
    const clonedFile = path.join(tmpDir, repoPath);

    if (!fs.existsSync(clonedFile)) {
      failures.push(`${repoPath}: not found in cloned repo`);
      continue;
    }

    if (localPath && fs.existsSync(localPath)) {
      const localHash = hashFile(localPath);
      const remoteHash = hashFile(clonedFile);
      if (localHash !== remoteHash) {
        failures.push(`${repoPath}: content mismatch (local: ${localHash.slice(0, 8)}, remote: ${remoteHash.slice(0, 8)})`);
      }
    }
  }

  // Step 4: Cleanup
  try {
    execSync(`rm -rf ${tmpDir}`, { timeout: 5000 });
  } catch (_) {
    console.warn(`[repo-verify] Failed to clean up ${tmpDir}`);
  }

  if (failures.length > 0) {
    return {
      success: false,
      details: `Verification failures for ${repo}/${branch}:\n${failures.join('\n')}`,
    };
  }

  return {
    success: true,
    details: `Verified ${expectedFiles.length} file(s) on ${repo}/${branch}`,
  };
}

function hashFile(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

module.exports = { verifyRepoPush };
