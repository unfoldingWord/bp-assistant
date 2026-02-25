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
// Tries all combos: {unpadded, 2-digit, 3-digit} × {flat, subdirectory}
function resolveOutputFile(relPath, book) {
  const direct = path.join(CSKILLBP_DIR, relPath);
  if (fs.existsSync(direct)) return relPath;

  const parts = relPath.split('/');
  const filename = parts.pop();

  // Try with book subdirectory (unpadded)
  const altPath = [...parts, book, filename].join('/');
  if (fs.existsSync(path.join(CSKILLBP_DIR, altPath))) return altPath;

  // Try zero-padded chapter numbers — 2-digit and 3-digit
  for (const width of [2, 3]) {
    const padded = filename.replace(/-(\d+)([-.])/, (_, n, sep) => `-${n.padStart(width, '0')}${sep}`);
    if (padded === filename) continue;

    // Flat
    const paddedDirect = [...parts, padded].join('/');
    if (fs.existsSync(path.join(CSKILLBP_DIR, paddedDirect))) return paddedDirect;

    // Subdirectory
    const paddedAlt = [...parts, book, padded].join('/');
    if (fs.existsSync(path.join(CSKILLBP_DIR, paddedAlt))) return paddedAlt;
  }

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

/**
 * Build a standardized AI branch name for repo-insert.
 * Single chapter: AI-PSA-030, AI-ISA-33
 * Range: AI-PSA-030-031, AI-ISA-33-34
 * PSA uses 3-digit padding, all other books use 2-digit.
 * @param {string} book - 3-letter book code (e.g. 'PSA')
 * @param {number} startCh - starting chapter
 * @param {number} [endCh] - ending chapter (omit or same as startCh for single chapter)
 * @returns {string} branch name
 */
function buildBranchName(book, startCh, endCh) {
  const width = book.toUpperCase() === 'PSA' ? 3 : 2;
  const padStart = String(startCh).padStart(width, '0');
  if (endCh != null && endCh !== startCh) {
    const padEnd = String(endCh).padStart(width, '0');
    return `AI-${book.toUpperCase()}-${padStart}-${padEnd}`;
  }
  return `AI-${book.toUpperCase()}-${padStart}`;
}

/**
 * Normalize common book names/variants to 3-letter USFM codes.
 * Built from en_ult repo filenames (\h headers → 3-letter codes).
 * Covers full names, plurals, numbered-book forms, and common abbreviations.
 */
const BOOK_NAME_MAP = {
  // --- OT ---
  GENESIS: 'GEN', GENE: 'GEN',
  EXODUS: 'EXO', EXOD: 'EXO',
  LEVITICUS: 'LEV', LEVI: 'LEV',
  NUMBERS: 'NUM', NUMB: 'NUM',
  DEUTERONOMY: 'DEU', DEUT: 'DEU',
  JOSHUA: 'JOS', JOSH: 'JOS',
  JUDGES: 'JDG', JUDG: 'JDG',
  RUTH: 'RUT',
  '1SAMUEL': '1SA', '2SAMUEL': '2SA', '1SAM': '1SA', '2SAM': '2SA',
  '1KINGS': '1KI', '2KINGS': '2KI', '1KGS': '1KI', '2KGS': '2KI',
  '1CHRONICLES': '1CH', '2CHRONICLES': '2CH', '1CHRON': '1CH', '2CHRON': '2CH', '1CHR': '1CH', '2CHR': '2CH',
  EZRA: 'EZR',
  NEHEMIAH: 'NEH', NEHE: 'NEH',
  ESTHER: 'EST', ESTH: 'EST',
  JOB: 'JOB',
  PSALM: 'PSA', PSALMS: 'PSA',
  PROVERBS: 'PRO', PROV: 'PRO',
  ECCLESIASTES: 'ECC', ECCL: 'ECC', ECCLES: 'ECC',
  SONG: 'SNG',
  ISAIAH: 'ISA',
  JEREMIAH: 'JER', JERE: 'JER',
  LAMENTATIONS: 'LAM', LAMENT: 'LAM',
  EZEKIEL: 'EZK', EZEK: 'EZK',
  DANIEL: 'DAN', DANI: 'DAN',
  HOSEA: 'HOS',
  JOEL: 'JOL',
  AMOS: 'AMO',
  OBADIAH: 'OBA', OBAD: 'OBA',
  JONAH: 'JON',
  MICAH: 'MIC',
  NAHUM: 'NAM', NAHU: 'NAM',
  HABAKKUK: 'HAB', HABA: 'HAB',
  ZEPHANIAH: 'ZEP', ZEPH: 'ZEP',
  HAGGAI: 'HAG', HAGG: 'HAG',
  ZECHARIAH: 'ZEC', ZECH: 'ZEC',
  MALACHI: 'MAL', MALA: 'MAL',
  // --- NT ---
  MATTHEW: 'MAT', MATT: 'MAT',
  MARK: 'MRK',
  LUKE: 'LUK',
  JOHN: 'JHN',
  ACTS: 'ACT',
  ROMANS: 'ROM', ROMA: 'ROM',
  '1CORINTHIANS': '1CO', '2CORINTHIANS': '2CO', '1COR': '1CO', '2COR': '2CO',
  GALATIANS: 'GAL', GALA: 'GAL',
  EPHESIANS: 'EPH', EPHE: 'EPH',
  PHILIPPIANS: 'PHP', PHIL: 'PHP',
  COLOSSIANS: 'COL', COLO: 'COL',
  '1THESSALONIANS': '1TH', '2THESSALONIANS': '2TH', '1THESS': '1TH', '2THESS': '2TH',
  '1TIMOTHY': '1TI', '2TIMOTHY': '2TI', '1TIM': '1TI', '2TIM': '2TI',
  TITUS: 'TIT',
  PHILEMON: 'PHM', PHILE: 'PHM', PHLM: 'PHM',
  HEBREWS: 'HEB', HEBR: 'HEB',
  JAMES: 'JAS', JAME: 'JAS',
  '1PETER': '1PE', '2PETER': '2PE', '1PET': '1PE', '2PET': '2PE',
  '1JOHN': '1JN', '2JOHN': '2JN', '3JOHN': '3JN',
  JUDE: 'JUD',
  REVELATION: 'REV', REVELATIONS: 'REV', REVE: 'REV',
};

function normalizeBookName(name) {
  const upper = name.toUpperCase();
  return BOOK_NAME_MAP[upper] || upper;
}

module.exports = {
  getDoor43Username,
  checkExistingBranch,
  buildBranchName,
  resolveOutputFile,
  checkPrerequisites,
  calcSkillTimeout,
  normalizeBookName,
  CSKILLBP_DIR,
};
