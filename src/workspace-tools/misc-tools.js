// misc-tools.js — Node.js ports of remaining workspace scripts
//
// Replaces: prepare_compare.py, gitea_pr.py, prepare_tq.py, verify_tq.py

const fs = require('fs');
const path = require('path');
const https = require('https');
const { readSecret } = require('../secrets');
const { resolveOutputFile } = require('../pipeline-utils');

const CSKILLBP_DIR = process.env.CSKILLBP_DIR || '/srv/bot/workspace';
const GITEA_API = 'https://git.door43.org/api/v1';
const ORG = 'unfoldingWord';

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 30000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return httpsGet(res.headers.location).then(resolve, reject);
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function apiRequest(method, apiPath, token, data = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${GITEA_API}${apiPath}`);
    const body = data ? JSON.stringify(data) : null;
    const opts = { hostname: url.hostname, path: url.pathname + url.search, method, headers: { 'Content-Type': 'application/json' }, timeout: 30000 };
    if (token) opts.headers['Authorization'] = `token ${token}`;
    const req = https.request(opts, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); } catch { resolve({ status: res.statusCode, data: raw }); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

function getToken() {
  let token = readSecret('door43_token', 'DOOR43_TOKEN') || readSecret('gitea_token', 'GITEA_TOKEN');
  if (token) return token;
  const envPaths = [path.join(CSKILLBP_DIR, '.env'), '/srv/bot/config/.env'];
  for (const ep of envPaths) {
    if (!fs.existsSync(ep)) continue;
    for (const line of fs.readFileSync(ep, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (!token && (key === 'DOOR43_TOKEN' || key === 'GITEA_TOKEN')) token = val;
    }
  }
  return token;
}

// --- gitea_pr ---

async function giteaPr({ repo, head, base, title, body, merge, noDelete, ensureBase }) {
  const token = getToken();
  if (!token) return 'No Door43 token found';
  const log = [];

  // Ensure base branch exists
  if (ensureBase) {
    const brRes = await apiRequest('GET', `/repos/${ORG}/${repo}/branches/${base}`, token);
    if (brRes.status === 404) {
      const createRes = await apiRequest('POST', `/repos/${ORG}/${repo}/branches`, token, { new_branch_name: base, old_branch_name: 'master' });
      if (createRes.status === 201 || createRes.status === 409) log.push(`Branch ${base} ensured`);
      else return `Failed to create base branch: HTTP ${createRes.status}`;
    }
  }

  // Create or get PR
  let prNumber;
  const createRes = await apiRequest('POST', `/repos/${ORG}/${repo}/pulls`, token, { title, head, base, body: body || '' });
  if (createRes.status === 200 || createRes.status === 201) {
    prNumber = createRes.data.number;
    log.push(`PR #${prNumber} created: ${createRes.data.html_url || ''}`);
  } else if (createRes.status === 409) {
    const searchRes = await apiRequest('GET', `/repos/${ORG}/${repo}/pulls?state=open&head=${ORG}:${head}&limit=5`, token);
    if (searchRes.status === 200 && Array.isArray(searchRes.data) && searchRes.data.length > 0) {
      prNumber = searchRes.data[0].number;
      log.push(`PR #${prNumber} already exists`);
    } else return 'PR exists but could not find PR number';
  } else return `Failed to create PR: HTTP ${createRes.status} ${JSON.stringify(createRes.data).slice(0, 200)}`;

  // Merge if requested
  if (merge) {
    const mergeRes = await apiRequest('POST', `/repos/${ORG}/${repo}/pulls/${prNumber}/merge`, token, { Do: 'merge', merge_message_field: `Merge ${title}` });
    if (mergeRes.status === 200 || mergeRes.status === 204) log.push(`PR #${prNumber} merged`);
    else if (mergeRes.status === 405) log.push(`PR #${prNumber} already merged`);
    else return `Merge failed: HTTP ${mergeRes.status}`;

    // Delete branch
    if (!noDelete) {
      const delRes = await apiRequest('DELETE', `/repos/${ORG}/${repo}/branches/${head}`, token);
      if (delRes.status === 200 || delRes.status === 204 || delRes.status === 404) log.push(`Branch ${head} deleted`);
    }
  }

  return log.join('\n');
}

// --- prepare_compare ---

function prepareCompare({ book, chapter, type, editorUsfm, output, verses: verseScope }) {
  const contentType = type || 'ult';
  const bookUpper = book.toUpperCase();
  const width = bookUpper === 'PSA' ? 3 : 2;
  const tag = `${bookUpper}-${String(chapter).padStart(width, '0')}`;

  function parseVersesPlain(text) {
    const verses = {};
    let ch = 0;
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      const cm = trimmed.match(/^\\c\s+(\d+)/);
      if (cm) { ch = parseInt(cm[1], 10); continue; }
      const vm = trimmed.match(/^\\v\s+(\d+[-\d]*)\s*(.*)/);
      if (vm) {
        if (vm[1] === 'front') continue;
        const v = parseInt(vm[1].split('-')[0], 10);
        let txt = vm[2] || '';
        txt = txt.replace(/\\qs\b/g, '').replace(/\\[pqsmd]\d?\s*/g, '').replace(/\\b\s*/g, '')
          .replace(/\\r\s*/g, '').replace(/\\f[^\\]*\\f\*/g, '').replace(/\\x[^\\]*\\x\*/g, '')
          .replace(/\\zaln-[se][^*]*\*/g, '').replace(/\\w\s+([^|]*?)\|[^\\]*?\\w\*/g, '$1')
          .replace(/\\[a-z]+\d?\*/g, '').replace(/\s+/g, ' ').trim();
        if (ch === parseInt(chapter, 10)) verses[v] = txt;
      }
    }
    return verses;
  }

  function parseVerseScope(spec) {
    if (!spec) return null;
    const trimmed = String(spec).trim();
    // Accept "1-6" or "1,3,5-7"
    const parts = trimmed.split(',').map((p) => p.trim()).filter(Boolean);
    const allowed = new Set();
    for (const part of parts) {
      const m = part.match(/^(\d+)(?:\s*[-–—]\s*(\d+))?$/);
      if (!m) return null;
      const start = parseInt(m[1], 10);
      const end = m[2] ? parseInt(m[2], 10) : start;
      const lo = Math.min(start, end);
      const hi = Math.max(start, end);
      for (let v = lo; v <= hi; v++) allowed.add(v);
    }
    return allowed;
  }

  function normalizeForCompare(text) {
    return String(text || '')
      // Ignore bracket/quote presentation-only differences in compare mode.
      .replace(/[{}]/g, '')
      .replace(/["'“”‘’]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  // AI source
  const aiPath = path.join(CSKILLBP_DIR, `output/AI-${contentType.toUpperCase()}/${bookUpper}/${tag}.usfm`);
  if (!fs.existsSync(aiPath)) return `AI file not found: ${aiPath}`;
  const aiVerses = parseVersesPlain(fs.readFileSync(aiPath, 'utf8'));

  // Editor source
  let editorVerses = {};
  if (editorUsfm) {
    const edPath = path.resolve(CSKILLBP_DIR, editorUsfm);
    if (fs.existsSync(edPath)) editorVerses = parseVersesPlain(fs.readFileSync(edPath, 'utf8'));
  }

  // Build comparison
  const allVersesUnfiltered = [...new Set([...Object.keys(aiVerses).map(Number), ...Object.keys(editorVerses).map(Number)])].sort((a, b) => a - b);
  const allowedVerses = parseVerseScope(verseScope);
  const allVerses = allowedVerses
    ? allVersesUnfiltered.filter((v) => allowedVerses.has(v))
    : allVersesUnfiltered;
  const compareRows = [];
  let changed = 0;

  for (const v of allVerses) {
    const ai = aiVerses[v] || '';
    const editor = editorVerses[v] || '';
    const aiNorm = normalizeForCompare(ai);
    const editorNorm = normalizeForCompare(editor);
    const isChanged = aiNorm !== editorNorm && editor !== '';
    if (isChanged) changed++;
    compareRows.push({
      verse: v,
      ai,
      editor,
      ai_normalized: aiNorm,
      editor_normalized: editorNorm,
      changed: isChanged,
      changed_raw: ai !== editor && editor !== '',
    });
  }

  const result = {
    book: bookUpper,
    chapter: parseInt(chapter, 10),
    type: contentType,
    verse_scope: verseScope || null,
    verses: compareRows,
    summary: { total: allVerses.length, changed, unchanged: allVerses.length - changed },
  };
  const json = JSON.stringify(result, null, 2);

  if (output) {
    const outPath = path.resolve(CSKILLBP_DIR, output);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, json);
    return `Compared ${allVerses.length} verses: ${changed} changed\n${outPath}`;
  }
  return json;
}

// --- prepare_tq ---

function prepareTq({ book, chapter, wholeBook, tqRepo, ultPath, ustPath, output }) {
  const bookUpper = book.toUpperCase();

  function parseVersesClean(fp) {
    if (!fp) return {};
    const full = path.resolve(CSKILLBP_DIR, fp);
    if (!fs.existsSync(full)) return {};
    const text = fs.readFileSync(full, 'utf8');
    const verses = {};
    let ch = 0;
    for (const l of text.split('\n')) {
      const cm = l.trim().match(/^\\c\s+(\d+)/);
      if (cm) { ch = parseInt(cm[1], 10); continue; }
      const vm = l.trim().match(/^\\v\s+(\d+[-\d]*)\s*(.*)/);
      if (vm) {
        let txt = vm[2] || '';
        txt = txt.replace(/\\zaln-[se][^*]*\*/g, '').replace(/\\w\s+([^|]*?)\|[^\\]*?\\w\*/g, '$1')
          .replace(/\\[a-z]+\d?\s+/g, ' ').replace(/\\[a-z]+\d?\*/g, '').replace(/\|[^\\|\s]*/g, '')
          .replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
        verses[`${ch}:${vm[1].split('-')[0]}`] = txt;
      }
    }
    return verses;
  }

  // Find ULT/UST
  const BOOK_NUMBERS = {};
  const OT = ['GEN','EXO','LEV','NUM','DEU','JOS','JDG','RUT','1SA','2SA','1KI','2KI','1CH','2CH','EZR','NEH','EST','JOB','PSA','PRO','ECC','SNG','ISA','JER','LAM','EZK','DAN','HOS','JOL','AMO','OBA','JON','MIC','NAM','HAB','ZEP','HAG','ZEC','MAL'];
  const NT = ['MAT','MRK','LUK','JHN','ACT','ROM','1CO','2CO','GAL','EPH','PHP','COL','1TH','2TH','1TI','2TI','TIT','PHM','HEB','JAS','1PE','2PE','1JN','2JN','3JN','JUD','REV'];
  OT.forEach((b, i) => { BOOK_NUMBERS[b] = String(i + 1).padStart(2, '0'); });
  NT.forEach((b, i) => { BOOK_NUMBERS[b] = String(i + 41).padStart(2, '0'); });
  const num = BOOK_NUMBERS[bookUpper];

  let ultFile = ultPath;
  if (!ultFile) {
    const width = bookUpper === 'PSA' ? 3 : 2;
    const tag = `${bookUpper}-${String(chapter || 1).padStart(width, '0')}`;
    const aiPath = resolveOutputFile(`output/AI-ULT/${bookUpper}/${tag}.usfm`, bookUpper);
    if (aiPath) ultFile = aiPath;
    else if (num) {
      const pubPath = `data/published_ult_english/${num}-${bookUpper}.usfm`;
      if (fs.existsSync(path.join(CSKILLBP_DIR, pubPath))) ultFile = pubPath;
    }
  }
  let ustFile = ustPath;
  if (!ustFile && num) {
    const pubPath = `data/published_ust/${num}-${bookUpper}.usfm`;
    if (fs.existsSync(path.join(CSKILLBP_DIR, pubPath))) ustFile = pubPath;
  }

  const ultVerses = parseVersesClean(ultFile);
  const ustVerses = parseVersesClean(ustFile);

  // Find TQ TSV
  const tqDir = tqRepo || path.join(CSKILLBP_DIR, 'data/published-tqs');
  let tqFile;
  if (fs.existsSync(path.join(tqDir, `tq_${bookUpper}.tsv`))) tqFile = path.join(tqDir, `tq_${bookUpper}.tsv`);

  let tqHeader = '';
  const tqRowsByChapter = {};
  if (tqFile) {
    const lines = fs.readFileSync(tqFile, 'utf8').split('\n');
    tqHeader = lines[0] || '';
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const ref = line.split('\t', 1)[0];
      const ch = ref.split(':')[0];
      if (chapter && ch !== String(chapter)) continue;
      if (!tqRowsByChapter[ch]) tqRowsByChapter[ch] = [];
      tqRowsByChapter[ch].push(line);
    }
  }

  const result = {
    book: bookUpper,
    chapters: chapter ? [parseInt(chapter, 10)] : Object.keys(tqRowsByChapter).map(Number).sort((a, b) => a - b),
    ult_source: ultFile || 'not found',
    ust_source: ustFile || 'not found',
    ult_by_verse: ultVerses,
    ust_by_verse: ustVerses,
    tq_header: tqHeader,
    tq_rows_by_chapter: tqRowsByChapter,
  };

  const outPath = path.resolve(CSKILLBP_DIR, output || '/tmp/claude/prepared_tq.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  return `Prepared TQ for ${bookUpper}: ${Object.keys(tqRowsByChapter).length} chapters\n${outPath}`;
}

// --- verify_tq ---

function verifyTq({ tsvFile, inputJson }) {
  const filePath = path.resolve(CSKILLBP_DIR, tsvFile);
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const errors = [];
  const warnings = [];
  const EXPECTED_HEADER = 'Reference\tID\tTags\tQuote\tOccurrence\tQuestion\tResponse';

  if (lines[0] && lines[0].trimEnd() !== EXPECTED_HEADER) {
    errors.push(`Line 1: Invalid header`);
  }

  let rowCount = 0;
  const seenIds = new Map(); // id -> first line number (1-based)
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    rowCount++;
    const cols = line.split('\t');
    const ref = cols[0] || '';
    const id = cols[1] || '';

    if (cols.length !== 7) errors.push(`Line ${i + 1}: Expected 7 columns, found ${cols.length}`);
    if (!/^\d+:\d+(-\d+)?$/.test(ref)) errors.push(`Line ${i + 1}: Invalid reference "${ref}"`);
    if (!cols[5]) errors.push(`Line ${i + 1}: Empty Question`);
    if (!cols[6]) warnings.push(`Line ${i + 1}: Empty Response`);
    if (!id) {
      warnings.push(`Line ${i + 1}: Empty ID`);
    } else if (seenIds.has(id)) {
      errors.push(`Line ${i + 1}: Duplicate ID "${id}" (first seen at line ${seenIds.get(id)})`);
    } else {
      seenIds.set(id, i + 1);
    }
    if (/["\u201c\u201d]/.test(cols[5] || '') || /["\u201c\u201d]/.test(cols[6] || '')) {
      warnings.push(`Line ${i + 1}: Direct quotes in Q/A`);
    }
  }

  // Row count delta check
  if (inputJson) {
    try {
      const input = JSON.parse(fs.readFileSync(path.resolve(CSKILLBP_DIR, inputJson), 'utf8'));
      const origCount = Object.values(input.tq_rows_by_chapter || {}).reduce((s, rows) => s + rows.length, 0);
      if (origCount > 0) {
        const delta = Math.abs(rowCount - origCount) / origCount;
        if (delta > 0.3) warnings.push(`Row count changed by ${(delta * 100).toFixed(0)}% (${origCount} -> ${rowCount})`);
      }
    } catch { /* skip */ }
  }

  const result = [`Verified ${rowCount} rows in ${path.basename(filePath)}`];
  if (errors.length) { result.push(`${errors.length} error(s):`); result.push(...errors.slice(0, 20)); }
  if (warnings.length) { result.push(`${warnings.length} warning(s):`); result.push(...warnings.slice(0, 20)); }
  if (!errors.length && !warnings.length) result.push('All checks passed');
  return result.join('\n');
}

/**
 * Deduplicate the ID column of a TQ TSV file in-place.
 * Any row whose ID collides with a previously seen ID is assigned a freshly
 * generated unique 4-character random ID (same [a-z][a-z0-9]{3} format used
 * by the TN pipeline).  The file is rewritten only when at least one duplicate
 * is found.  Returns a human-readable result string.
 */
function deduplicateTqIds({ tsvFile }) {
  const filePath = path.resolve(CSKILLBP_DIR, tsvFile);
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');

  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const seenIds = new Set();
  let duplicatesFixed = 0;
  const fixedLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Always keep header and blank lines as-is
    if (i === 0 || !line.trim()) {
      fixedLines.push(line);
      continue;
    }
    const cols = line.split('\t');
    const id = cols[1] || '';
    if (id && seenIds.has(id)) {
      // Collision — generate a new unique ID
      let newId;
      let attempts = 0;
      do {
        newId = letters[Math.floor(Math.random() * 26)];
        for (let j = 0; j < 3; j++) newId += chars[Math.floor(Math.random() * 36)];
        attempts++;
      } while (seenIds.has(newId) && attempts < 200);
      cols[1] = newId;
      seenIds.add(newId);
      duplicatesFixed++;
      fixedLines.push(cols.join('\t'));
    } else {
      if (id) seenIds.add(id);
      fixedLines.push(line);
    }
  }

  if (duplicatesFixed > 0) {
    fs.writeFileSync(filePath, fixedLines.join('\n'), 'utf8');
  }

  const basename = path.basename(filePath);
  return duplicatesFixed > 0
    ? `Deduplicated ${duplicatesFixed} duplicate ID(s) in ${basename}`
    : `No duplicate IDs found in ${basename}`;
}

/**
 * Append a vocabulary decision to a quick-ref CSV file.
 * Deduplicates by Strong number — returns existing entry if found.
 */
function appendQuickref({ file, strong, hebrew, rendering, book = 'ALL', context = '', notes = '', source = 'AI' }) {
  const HEADER = 'Strong,Hebrew,Rendering,Book,Context,Notes,Date,Source';
  const csvName = `${file}.csv`;
  const csvPath = path.join(CSKILLBP_DIR, 'data', 'quick-ref', csvName);

  // Ensure directory exists
  const dir = path.dirname(csvPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // Create file with header if missing
  if (!fs.existsSync(csvPath)) {
    fs.writeFileSync(csvPath, HEADER + '\n', 'utf8');
  }

  // Check for existing entry with same Strong number
  const content = fs.readFileSync(csvPath, 'utf8');
  const lines = content.split('\n').filter(l => l.trim());
  for (const line of lines.slice(1)) { // skip header
    const fields = line.split(',');
    if (fields[0] === strong) {
      return `Already exists: ${line}`;
    }
  }

  // Build and append new row
  const today = new Date().toISOString().slice(0, 10);
  const escapeCsv = (s) => s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
  const row = [strong, hebrew, rendering, book, escapeCsv(context), escapeCsv(notes), today, source].join(',');
  fs.appendFileSync(csvPath, row + '\n', 'utf8');
  return `Appended to ${csvName}: ${row}`;
}

module.exports = { giteaPr, prepareCompare, prepareTq, verifyTq, deduplicateTqIds, appendQuickref };
