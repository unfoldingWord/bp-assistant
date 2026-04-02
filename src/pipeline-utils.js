// pipeline-utils.js — Shared utilities for notes and generate pipelines

const https = require('https');
const fs = require('fs');
const path = require('path');
const { getVerseCount, getTotalVerses } = require('./verse-counts');

const CSKILLBP_DIR = process.env.CSKILLBP_DIR || path.resolve(__dirname, '../../cSkillBP');

const MIN_TIMEOUT_MS = 10 * 60 * 1000;   // 10 min floor
const MAX_TIMEOUT_MS = 90 * 60 * 1000;   // 90 min cap (post-MCP migration)
const MS_PER_VERSE_OP = 7 * 60 * 1000;   // 7 min per verse per operation (post-MCP)

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
async function checkExistingBranch(username, repo = 'en_tn', branchPattern = '{username}-tc-create-1', book = '') {
  const branchName = branchPattern
    .replace('{username}', username)
    .replace('{BOOK}', book);

  try {
    const status = await new Promise((resolve, reject) => {
      const url = `https://git.door43.org/api/v1/repos/unfoldingWord/${repo}/branches/${encodeURIComponent(branchName)}`;
      const req = https.get(url, { timeout: 15000 }, (res) => {
        res.resume(); // drain response body
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
    return status === 200 ? branchName : null;
  } catch (err) {
    console.error(`[pipeline-utils] Gitea branch check failed for ${repo}/${branchName}: ${err.message}`);
    return null; // Assume no branch on error — don't block the pipeline
  }
}

// --- Resolve an output file that may live in either output/X/ or output/X/BOOK/ ---
// Tries all combos: {unpadded, 2-digit, 3-digit} × {flat, subdirectory}
// When verseSuffix is provided (e.g. "-v3-4"), only match that specific suffix
// in the verse-range fallback — prevents returning a v1-2 file for a v3-4 request.
function resolveOutputFile(relPath, book, verseSuffix) {
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

  // Try verse-suffixed variants (e.g. HAB-03.tsv -> HAB-03-v1-2.tsv)
  // Skills may append -vN-M when working on a verse range
  const ext = path.extname(filename);
  const base = filename.slice(0, -ext.length);
  // When verseSuffix is given, parse verse numbers and match numerically
  // so -vv6-22 matches files named -v6-22, -06-22, -vv06-22, etc.
  let suffixFilter;
  if (verseSuffix) {
    const vMatch = verseSuffix.match(/(\d+)\D+(\d+)/);
    if (vMatch) {
      const wantStart = parseInt(vMatch[1], 10);
      const wantEnd = parseInt(vMatch[2], 10);
      suffixFilter = (f) => {
        if (!f.startsWith(base + '-') || !f.endsWith(ext)) return false;
        const middle = f.slice(base.length + 1, -ext.length);
        const nums = middle.match(/(\d+)\D+(\d+)/);
        if (!nums) return false;
        return parseInt(nums[1], 10) === wantStart && parseInt(nums[2], 10) === wantEnd;
      };
    } else {
      suffixFilter = (f) => f === `${base}${verseSuffix}${ext}`;
    }
  } else {
    // Match any verse-range suffix (any format: -vv, -v, bare digits after dash)
    suffixFilter = (f) => f.startsWith(base + '-') && f.endsWith(ext) && f !== base + ext;
  }
  for (const dir of [parts.join('/'), [...parts, book].join('/')]) {
    const searchDir = path.join(CSKILLBP_DIR, dir);
    if (!fs.existsSync(searchDir)) continue;
    const matches = fs.readdirSync(searchDir)
      .filter(suffixFilter)
      .sort();
    if (matches.length > 0) {
      return path.join(dir, matches[0]);
    }
  }

  return null;
}

/**
 * Find the most recently written file matching a pattern in a directory.
 * Searches both flat (output/X/) and subdirectory (output/X/BOOK/) locations.
 * @param {string} dir - base dir relative to CSKILLBP_DIR (e.g. 'output/AI-ULT')
 * @param {string} book - book code for subdirectory search
 * @param {RegExp} pattern - filename pattern (e.g. /^LAM-\d+-.*-aligned\.usfm$/)
 * @param {number} afterMs - only files modified after this timestamp (skill start time)
 * @returns {string|null} relative path from CSKILLBP_DIR, or null
 */
function discoverFreshOutput(dir, book, pattern, afterMs) {
  let best = null;
  let bestMtime = 0;

  const searchDirs = [
    dir,
    path.join(dir, book),
  ];

  for (const searchDir of searchDirs) {
    const absDir = path.join(CSKILLBP_DIR, searchDir);
    if (!fs.existsSync(absDir)) continue;
    let entries;
    try {
      entries = fs.readdirSync(absDir);
    } catch (_) {
      continue;
    }
    for (const entry of entries) {
      if (!pattern.test(entry)) continue;
      try {
        const absFile = path.join(absDir, entry);
        const stat = fs.statSync(absFile);
        if (!stat.isFile()) continue;
        if (afterMs != null && stat.mtimeMs < (afterMs - 2000)) continue;
        if (stat.mtimeMs > bestMtime) {
          bestMtime = stat.mtimeMs;
          best = path.join(searchDir, entry);
        }
      } catch (_) {
        continue;
      }
    }
  }

  return best;
}

// --- Verify prerequisite files exist (AI-ULT, AI-UST, issues) ---
// When verseStart/verseEnd are provided, the issues TSV must match that
// specific verse range (e.g. HAB-03-v3-4.tsv), not just any verse-suffixed
// file for the chapter. AI-ULT/UST are full-chapter files and don't need
// verse-range matching.
function checkPrerequisites(book, chapter, verseStart, verseEnd) {
  const width = book.toUpperCase() === 'PSA' ? 3 : 2;
  const tag = `${book}-${String(chapter).padStart(width, '0')}`;
  const verseSuffix = verseStart != null ? `-vv${verseStart}-${verseEnd}` : null;

  const required = [
    { path: `output/AI-ULT/${tag}.usfm`, label: 'AI-ULT' },
    { path: `output/AI-UST/${tag}.usfm`, label: 'AI-UST' },
    { path: `output/issues/${tag}.tsv`,   label: 'issues TSV', verseSuffix },
  ];

  const missing = [];
  const resolved = {};
  for (const f of required) {
    const found = resolveOutputFile(f.path, book, f.verseSuffix);
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
  PSALM: 'PSA', PSALMS: 'PSA', PS: 'PSA',
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

const VALID_BOOK_CODES = new Set(Object.values(BOOK_NAME_MAP));

function normalizeBookName(name) {
  const upper = name.toUpperCase();
  // Direct match (full name or known alias)
  if (BOOK_NAME_MAP[upper]) return BOOK_NAME_MAP[upper];
  // Already a valid 3-letter code
  if (VALID_BOOK_CODES.has(upper)) return upper;
  // Prefix match: find map keys that start with the input (e.g. "PS" -> "PSALM" -> "PSA")
  const prefixMatch = Object.keys(BOOK_NAME_MAP).find(k => k.startsWith(upper));
  if (prefixMatch) return BOOK_NAME_MAP[prefixMatch];
  return upper;
}

function isValidBook(name) {
  const upper = name.toUpperCase();
  return BOOK_NAME_MAP.hasOwnProperty(upper) || VALID_BOOK_CODES.has(upper);
}

/**
 * Resolve a Door43 branch name to a Zulip @-mention for the branch owner.
 * Tries to identify the Door43 username from the branch name, reverse-looks up
 * door43-users.json to find the email, then uses Zulip API to get the full name.
 * Falls back to the provided fallback name if lookup fails.
 *
 * @param {string} branchName - e.g. "deferredreward-tc-create-1"
 * @param {string} fallbackSenderName - Zulip full name to use if lookup fails
 * @returns {Promise<string>} Zulip @-mention string, e.g. '@**John Smith**'
 */
async function resolveConflictMention(branchName, fallbackSenderName) {
  try {
    // Extract Door43 username from branch name
    // Common pattern: {username}-tc-create-{n}
    const tcMatch = branchName.match(/^(.+?)-tc-create/);
    const d43Username = tcMatch ? tcMatch[1] : branchName.split('-')[0];

    // Reverse-lookup door43-users.json (email → d43username) to find email
    const usersFile = path.resolve(__dirname, '../door43-users.json');
    if (!fs.existsSync(usersFile)) return `@**${fallbackSenderName}**`;

    const users = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
    const entry = Object.entries(users).find(([_, u]) => u === d43Username);
    if (!entry) return `@**${fallbackSenderName}**`;

    const email = entry[0];

    // Use Zulip API to get full name from email
    const { getClient } = require('./zulip-client');
    const z = await getClient();
    const res = await z.callEndpoint(`/users/${encodeURIComponent(email)}`, 'GET');
    if (res.result === 'success' && res.user?.full_name) {
      return `@**${res.user.full_name}**`;
    }
  } catch (err) {
    console.warn(`[pipeline-utils] resolveConflictMention failed for '${branchName}': ${err.message}`);
  }

  return `@**${fallbackSenderName}**`;
}

/**
 * Parse a partial TSV file from a crashed tn-writer run.
 * Identifies safely-completed verses (discards the last verse as potentially incomplete).
 * Returns null if no usable partial work exists.
 *
 * @param {string} filePath - Absolute path to the partial TSV file
 * @param {string} book - Book code (e.g. 'PSA')
 * @param {number} chapter - Chapter number
 * @returns {{ safeVerses: number[], resumeFromVerse: number, safeRowCount: number, filePath: string, header: string } | null}
 */
function parsePartialTsv(filePath, book, chapter) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return null;

    const lines = raw.split('\n');
    if (lines.length < 2) return null; // header only

    const header = lines[0];
    const headerCols = header.split('\t').length;

    // Parse data rows, discarding any truncated final line
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const cols = line.split('\t');
      if (cols.length < headerCols) {
        // Truncated row — crash artifact, stop here
        console.warn(`[pipeline-utils] Partial TSV line ${i + 1} truncated (${cols.length}/${headerCols} cols) — discarding`);
        break;
      }
      rows.push({ line: lines[i], cols });
    }

    if (rows.length === 0) return null;

    // Extract verse numbers from Reference column (col 0), format: "BOOK CH:V" or "front:intro"
    const versesByRow = rows.map(r => {
      const ref = r.cols[0];
      const match = ref.match(/(\d+):(\d+)/);
      return match ? parseInt(match[2], 10) : null;
    });

    // Find all unique verses present
    const allVerses = [...new Set(versesByRow.filter(v => v != null))].sort((a, b) => a - b);
    if (allVerses.length === 0) return null;

    // Discard the last verse — may be incomplete
    const lastVerse = allVerses[allVerses.length - 1];
    const safeVerses = allVerses.slice(0, -1);

    if (safeVerses.length === 0) return null; // only one verse present, can't trust it

    // Count safe rows (everything except rows for the last verse)
    const safeRows = rows.filter((_, i) => versesByRow[i] !== lastVerse);

    return {
      safeVerses,
      resumeFromVerse: lastVerse,
      safeRowCount: safeRows.length,
      filePath,
      header,
    };
  } catch (err) {
    console.warn(`[pipeline-utils] parsePartialTsv failed for ${filePath}: ${err.message}`);
    return null;
  }
}

/**
 * Truncate a partial TSV file to keep only the header and rows for safe verses.
 * Removes rows for the last (potentially incomplete) verse.
 *
 * @param {string} filePath - Absolute path to the TSV file
 * @param {number[]} safeVerses - Verse numbers to keep
 * @returns {boolean} true if truncation was successful
 */
function truncatePartialTsv(filePath, safeVerses) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split('\n');
    const header = lines[0];
    const headerCols = header.split('\t').length;
    const safeSet = new Set(safeVerses);

    const kept = [header];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      const cols = line.split('\t');
      if (cols.length < headerCols) break; // truncated row
      const match = cols[0].match(/(\d+):(\d+)/);
      const verse = match ? parseInt(match[2], 10) : null;
      // Keep intro rows (no verse number) and rows for safe verses
      if (verse === null || safeSet.has(verse)) {
        kept.push(line);
      }
    }

    // Write atomically
    const tmpFile = filePath + '.trunc.tmp';
    fs.writeFileSync(tmpFile, kept.join('\n') + '\n', 'utf8');
    fs.renameSync(tmpFile, filePath);
    return true;
  } catch (err) {
    console.warn(`[pipeline-utils] truncatePartialTsv failed for ${filePath}: ${err.message}`);
    return false;
  }
}

module.exports = {
  getDoor43Username,
  checkExistingBranch,
  buildBranchName,
  resolveOutputFile,
  discoverFreshOutput,
  checkPrerequisites,
  calcSkillTimeout,
  normalizeBookName,
  isValidBook,
  resolveConflictMention,
  parsePartialTsv,
  truncatePartialTsv,
  CSKILLBP_DIR,
};
