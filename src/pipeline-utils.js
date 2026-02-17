// pipeline-utils.js — Shared utilities for notes and generate pipelines

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { getVerseCount, getTotalVerses } = require('./verse-counts');

const CSKILLBP_DIR = path.resolve(__dirname, '../../cSkillBP');

const MIN_TIMEOUT_MS = 10 * 60 * 1000;   // 10 min floor
const MAX_TIMEOUT_MS = 60 * 60 * 1000;   // 60 min cap
const MS_PER_VERSE_OP = 5 * 60 * 1000;   // 5 min per verse per operation

// --- Look up Door43 username from sender email ---
function getDoor43Username(senderEmail) {
  const usersFile = path.resolve(__dirname, '../door43-users.json');
  if (!fs.existsSync(usersFile)) return null;
  const users = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
  return users[senderEmail] || null;
}

/**
 * Check if user has an existing branch on a Door43 repo.
 * @param {string} username - Door43 username
 * @param {string} repo - Repo name (en_tn, en_ult, en_ust)
 * @param {string} branchPattern - Branch name or pattern with {username} and {BOOK} placeholders
 * @param {string} [book] - Book code for {BOOK} placeholder
 * @returns {string|null} Branch name if exists, null otherwise
 */
function checkExistingBranch(username, repo = 'en_tn', branchPattern = '{username}-tc-create-1', book = '') {
  const branchName = branchPattern
    .replace('{username}', username)
    .replace('{BOOK}', book);
  const repoUrl = `https://git.door43.org/unfoldingWord/${repo}.git`;

  try {
    const result = execSync(
      `git ls-remote --heads ${repoUrl} ${branchName}`,
      { encoding: 'utf8', timeout: 15000 }
    ).trim();
    return result.length > 0 ? branchName : null;
  } catch (err) {
    console.error(`[pipeline-utils] git ls-remote failed for ${repo}/${branchName}: ${err.message}`);
    return null; // Assume no branch on error — don't block the pipeline
  }
}

// --- Resolve an output file that may live in either output/X/ or output/X/BOOK/ ---
function resolveOutputFile(relPath, book) {
  const direct = path.join(CSKILLBP_DIR, relPath);
  if (fs.existsSync(direct)) return relPath;

  // Try output/subdir/BOOK/filename  (e.g. output/issues/PSA/PSA-117.tsv)
  const parts = relPath.split('/');
  const filename = parts.pop();
  const altPath = [...parts, book, filename].join('/');
  const alt = path.join(CSKILLBP_DIR, altPath);
  if (fs.existsSync(alt)) return altPath;

  return null;
}

// --- Verify prerequisite files exist (AI-ULT, AI-UST, issues) ---
function checkPrerequisites(book, chapter) {
  const tag = `${book}-${chapter}`;
  const required = [
    { path: `output/AI-ULT/${tag}.usfm`, label: 'AI-ULT' },
    { path: `output/AI-UST/${tag}.usfm`, label: 'AI-UST' },
    { path: `output/issues/${tag}.tsv`,   label: 'issues TSV' },
  ];

  const missing = [];
  const resolved = {};
  for (const f of required) {
    const found = resolveOutputFile(f.path, book);
    if (!found) {
      missing.push(f.label);
    } else {
      resolved[f.label] = found;
    }
  }
  return { missing, resolved };
}

/**
 * Calculate dynamic timeout for a skill invocation.
 * timeout = totalVerses × ops × 5min, clamped between 10min and 60min.
 * @param {string} book - 3-letter book code
 * @param {number|number[]} chapters - single chapter or array
 * @param {number} ops - number of operations
 * @returns {number} timeout in ms
 */
function calcSkillTimeout(book, chapters, ops) {
  const chapterArr = Array.isArray(chapters) ? chapters : [chapters];
  const totalVerses = getTotalVerses(book, chapterArr);
  const total = totalVerses * ops * MS_PER_VERSE_OP;
  return Math.min(Math.max(total, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

module.exports = {
  getDoor43Username,
  checkExistingBranch,
  resolveOutputFile,
  checkPrerequisites,
  calcSkillTimeout,
  CSKILLBP_DIR,
};
