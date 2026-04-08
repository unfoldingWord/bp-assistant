// fetch-tools.js — Node.js ports of workspace fetch scripts as MCP tool handlers
//
// Replaces: fetch_hebrew_bible.py, fetch_all_ult.py, fetch_all_ust.py,
//           fetch_t4t.py, fetch_door43.py, fetch_glossary.py,
//           fetch_issues_resolved.py, fetch_templates.py

const fs = require('fs');
const path = require('path');
const https = require('https');
const { optimizeIssuesResolved } = require('./optimize-tools');

const CSKILLBP_DIR = process.env.CSKILLBP_DIR || '/srv/bot/workspace';

// --- Book number maps ---

const OT_BOOKS = [
  'GEN', 'EXO', 'LEV', 'NUM', 'DEU', 'JOS', 'JDG', 'RUT', '1SA', '2SA',
  '1KI', '2KI', '1CH', '2CH', 'EZR', 'NEH', 'EST', 'JOB', 'PSA', 'PRO',
  'ECC', 'SNG', 'ISA', 'JER', 'LAM', 'EZK', 'DAN', 'HOS', 'JOL', 'AMO',
  'OBA', 'JON', 'MIC', 'NAM', 'HAB', 'ZEP', 'HAG', 'ZEC', 'MAL',
];

const NT_BOOKS = [
  'MAT', 'MRK', 'LUK', 'JHN', 'ACT', 'ROM', '1CO', '2CO', 'GAL', 'EPH',
  'PHP', 'COL', '1TH', '2TH', '1TI', '2TI', 'TIT', 'PHM', 'HEB', 'JAS',
  '1PE', '2PE', '1JN', '2JN', '3JN', 'JUD', 'REV',
];

const BOOK_NUMBERS = {};
OT_BOOKS.forEach((b, i) => { BOOK_NUMBERS[b] = String(i + 1).padStart(2, '0'); });
NT_BOOKS.forEach((b, i) => { BOOK_NUMBERS[b] = String(i + 41).padStart(2, '0'); });

const V88_PUBLISHED = [
  'GEN', 'EXO', 'LEV', 'DEU', 'JOS', 'JDG', 'RUT', '1SA', '2SA',
  '1KI', '2KI', 'EZR', 'NEH', 'EST', 'JOB', 'PRO', 'SNG',
  'JOL', 'OBA', 'JON', 'NAM', 'ZEP', 'HAG', 'MAL', 'PSA',
];

const BOOK_ALIASES = {
  GENESIS: 'GEN', EXODUS: 'EXO', LEVITICUS: 'LEV', NUMBERS: 'NUM',
  DEUTERONOMY: 'DEU', JOSHUA: 'JOS', JUDGES: 'JDG', RUTH: 'RUT',
  PSALM: 'PSA', PSALMS: 'PSA', PROVERBS: 'PRO', ECCLESIASTES: 'ECC',
  ISAIAH: 'ISA', JEREMIAH: 'JER', LAMENTATIONS: 'LAM', EZEKIEL: 'EZK',
  EZEK: 'EZK', DANIEL: 'DAN', HOSEA: 'HOS', JOEL: 'JOL', AMOS: 'AMO',
  OBADIAH: 'OBA', JONAH: 'JON', MICAH: 'MIC', NAHUM: 'NAM',
  HABAKKUK: 'HAB', ZEPHANIAH: 'ZEP', HAGGAI: 'HAG', ZECHARIAH: 'ZEC',
  MALACHI: 'MAL', MATTHEW: 'MAT', MARK: 'MRK', LUKE: 'LUK', JOHN: 'JHN',
  ACTS: 'ACT', ROMANS: 'ROM', GALATIANS: 'GAL', EPHESIANS: 'EPH',
  PHILIPPIANS: 'PHP', COLOSSIANS: 'COL', TITUS: 'TIT', PHILEMON: 'PHM',
  HEBREWS: 'HEB', JAMES: 'JAS', JUDE: 'JUD', REVELATION: 'REV',
};

function normalizeBook(name) {
  const upper = name.toUpperCase();
  return BOOK_ALIASES[upper] || upper;
}

// --- HTTP helpers ---

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 30000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsGet(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function httpsHead(url) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'HEAD', timeout: 30000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return httpsHead(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      res.resume();
      resolve(res.headers);
    });
    req.on('error', reject);
    req.end();
  });
}

// --- Cache helpers ---

function getCachedDate(filepath) {
  if (!fs.existsSync(filepath)) return null;
  const first = fs.readFileSync(filepath, 'utf8').split('\n')[0];
  const m = first.match(/^# Fetched: (\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function shouldRefreshWeekly(cachedDate) {
  if (!cachedDate) return true;
  const cached = new Date(cachedDate);
  const now = new Date();
  // Find last Thursday
  const daysSinceThursday = (now.getDay() + 3) % 7;
  const lastThursday = new Date(now);
  lastThursday.setDate(now.getDate() - daysSinceThursday);
  lastThursday.setHours(0, 0, 0, 0);
  return cached < lastThursday;
}

// --- Door43 batch fetch (shared logic for hebrew_bible, ult, ust, t4t) ---

async function fetchDoor43Batch(repo, books, outputDir, force) {
  const dir = path.join(CSKILLBP_DIR, outputDir);
  fs.mkdirSync(dir, { recursive: true });
  const today = todayStr();
  const results = [];
  let fetched = 0;
  let cached = 0;

  for (const book of books) {
    const num = BOOK_NUMBERS[book];
    if (!num) { results.push(`Unknown book: ${book}`); continue; }
    const filename = `${num}-${book}.usfm`;
    const filepath = path.join(dir, filename);
    const cachedDate = getCachedDate(filepath);

    if (!force && cachedDate === today) {
      cached++;
      continue;
    }

    const url = `https://git.door43.org/unfoldingWord/${repo}/raw/branch/master/${filename}`;
    try {
      const content = await httpsGet(url);
      fs.writeFileSync(filepath, `# Fetched: ${today}\n${content}`);
      fetched++;
    } catch (err) {
      results.push(`Failed: ${book} — ${err.message}`);
    }
  }

  results.unshift(`Fetched ${fetched}, cached ${cached}, total ${books.length} from ${repo} -> ${outputDir}`);
  return results.join('\n');
}

// --- Individual tool handlers ---

async function fetchHebrewBible({ books, force }) {
  const bookList = books && books.length ? books.map(normalizeBook) : OT_BOOKS;
  return fetchDoor43Batch('hbo_uhb', bookList, 'data/hebrew_bible', force || false);
}

async function fetchUlt({ books, force }) {
  const bookList = books && books.length ? books.map(normalizeBook) : V88_PUBLISHED;
  return fetchDoor43Batch('en_ult', bookList, 'data/published_ult', force || false);
}

async function fetchUst({ books, force }) {
  const bookList = books && books.length ? books.map(normalizeBook) : V88_PUBLISHED;
  return fetchDoor43Batch('en_ust', bookList, 'data/published_ust', force || false);
}

async function fetchT4t({ books, force }) {
  const bookList = books && books.length ? books.map(normalizeBook) : OT_BOOKS;
  return fetchDoor43Batch('en_t4t', bookList, 'data/t4t', force || false);
}

async function fetchDoor43({ book, repo, branch, user, output }) {
  const normalized = normalizeBook(book);
  const num = BOOK_NUMBERS[normalized];
  if (!num) throw new Error(`Unknown book: ${book}`);
  const filename = `${num}-${normalized}.usfm`;
  const org = user || 'unfoldingWord';
  const repoName = repo || 'en_ult';
  const branchName = branch || 'master';
  const url = `https://git.door43.org/${org}/${repoName}/raw/branch/${branchName}/${filename}`;

  const content = await httpsGet(url);

  if (output) {
    const outPath = path.resolve(CSKILLBP_DIR, output);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, content);
    return `Saved ${filename} to ${outPath} (${content.split('\n').length} lines)`;
  }
  return content;
}

async function getDoor43FileInfo({ book, repo, branch, user }) {
  const normalized = normalizeBook(book);
  const num = BOOK_NUMBERS[normalized];
  if (!num) throw new Error(`Unknown book: ${book}`);
  const filename = `${num}-${normalized}.usfm`;
  const org = user || 'unfoldingWord';
  const repoName = repo || 'en_ult';
  const branchName = branch || 'master';
  const url = `https://git.door43.org/${org}/${repoName}/raw/branch/${branchName}/${filename}`;
  const headers = await httpsHead(url);
  const lastModified = headers['last-modified'] || null;
  const lastModifiedMs = lastModified ? Date.parse(lastModified) : null;
  return {
    url,
    lastModified,
    lastModifiedMs: Number.isFinite(lastModifiedMs) ? lastModifiedMs : null,
    etag: headers.etag || null,
  };
}

// --- Google Sheets/Docs fetch ---

const GLOSSARY_SHEET_ID = '1pop2F61kRCRBgUvf8zHVwx9s-CBE8x3PyXojrTjJ3Lc';
const GLOSSARY_GIDS = {
  hebrew_ot_glossary: '1711192506',
  biblical_measurements: '1835633752',
  psalms_reference: '1739562476',
  sacrifice_terminology: '243454428',
  biblical_phrases: '1459152614',
};

async function fetchGlossary({ sheets, force }) {
  const dir = path.join(CSKILLBP_DIR, 'data/glossary');
  fs.mkdirSync(dir, { recursive: true });
  const today = todayStr();
  const sheetList = sheets && sheets.length ? sheets : Object.keys(GLOSSARY_GIDS);
  const results = [];

  for (const name of sheetList) {
    const gid = GLOSSARY_GIDS[name];
    if (!gid) { results.push(`Unknown sheet: ${name}`); continue; }
    const filepath = path.join(dir, `${name}.csv`);
    const cachedDate = getCachedDate(filepath);

    if (!force && cachedDate && !shouldRefreshWeekly(cachedDate)) {
      results.push(`${name}: using cached (${cachedDate})`);
      continue;
    }

    const url = `https://docs.google.com/spreadsheets/d/${GLOSSARY_SHEET_ID}/export?format=csv&gid=${gid}`;
    try {
      let content = await httpsGet(url);
      content = content.replace(/^\ufeff/, ''); // strip BOM
      fs.writeFileSync(filepath, `# Fetched: ${today}\n${content}`);
      results.push(`${name}: fetched (${content.split('\n').length} lines)`);
    } catch (err) {
      results.push(`${name}: FAILED — ${err.message}`);
    }
  }
  return results.join('\n');
}

async function fetchIssuesResolved({ force }) {
  const filepath = path.join(CSKILLBP_DIR, 'data/issues_resolved.txt');
  const today = todayStr();
  const cachedDate = getCachedDate(filepath);

  if (!force && cachedDate === today) {
    return `Using cached issues_resolved.txt from ${today}`;
  }
  if (!force && cachedDate && !shouldRefreshWeekly(cachedDate)) {
    return `Using cached issues_resolved.txt (${cachedDate})`;
  }

  const docId = '1C0C7Qsm78fM0tuLyVZEAs-IWtClNo9nqbsAZkAFeFio';
  const url = `https://docs.google.com/document/d/${docId}/export?format=txt`;
  let content = await httpsGet(url);
  content = content.replace(/^\ufeff/, '');

  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  fs.writeFileSync(filepath, `# Fetched: ${today}\n${content}`);
  const fetchMsg = `Fetched issues_resolved.txt (${content.split('\n').length} lines)`;

  // Optimize for AI consumption after fresh fetch
  try {
    const optMsg = await optimizeIssuesResolved();
    return `${fetchMsg}\n${optMsg}`;
  } catch (err) {
    console.warn(`[fetch-tools] Issues optimization failed (non-fatal): ${err.message}`);
    return `${fetchMsg}\n(optimization skipped: ${err.message})`;
  }
}

async function fetchTemplates({ sheetId, gid, output, format, force }) {
  const sid = sheetId || '1ot6A7RxcsxM_Wv94sauoTAaRPO5Q-gynFqMHeldnM64';
  const fmt = format || 'csv';
  let url = `https://docs.google.com/spreadsheets/d/${sid}/export?format=${fmt}`;
  if (gid) url += `&gid=${gid}`;

  const outPath = output ? path.resolve(CSKILLBP_DIR, output) : null;

  if (!force && outPath) {
    const cachedDate = getCachedDate(outPath);
    if (cachedDate === todayStr()) {
      return `Using cached templates from ${todayStr()}`;
    }
  }

  let content = await httpsGet(url);
  content = content.replace(/^\ufeff/, '');

  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `# Fetched: ${todayStr()}\n${content}`);
    return `Saved templates to ${outPath} (${content.split('\n').length} lines)`;
  }
  return content;
}

module.exports = {
  fetchHebrewBible,
  fetchUlt,
  fetchUst,
  fetchT4t,
  fetchDoor43,
  getDoor43FileInfo,
  fetchGlossary,
  fetchIssuesResolved,
  fetchTemplates,
};
