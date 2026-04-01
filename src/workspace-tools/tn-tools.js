// tn-tools.js — Node.js ports of TN writer pipeline scripts
//
// Replaces: extract_alignment_data.py, fix_hebrew_quotes.py, flag_narrow_quotes.py,
//           generate_ids.py, resolve_gl_quotes.py, verify_at_fit.py,
//           assemble_notes.py, prepare_notes.py

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const CSKILLBP_DIR = process.env.CSKILLBP_DIR || '/srv/bot/workspace';

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

function extractAlignmentData({ alignedUsfm, output }) {
  const filePath = path.resolve(CSKILLBP_DIR, alignedUsfm);
  const content = fs.readFileSync(filePath, 'utf8');
  const result = {};
  let chapter = 0, verse = '0';
  const milestones = [];

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    const cm = trimmed.match(/^\\c\s+(\d+)/);
    if (cm) { chapter = parseInt(cm[1], 10); verse = '0'; milestones.length = 0; continue; }
    const vm = trimmed.match(/^\\v\s+(\d+[-\d]*|front)\s*/);
    if (vm) { verse = vm[1].split('-')[0]; milestones.length = 0; continue; }

    const ZALN_S = /\\zaln-s\s+\|([^\\]*?)\\?\*/g;
    const ZALN_E = /\\zaln-e\\?\*/g;
    const WORD = /\\w\s+([^|\\]+)\|[^\\]*\\w\*/g;
    const key = `${chapter}:${verse}`;
    if (!result[key]) result[key] = [];

    const tokens = [];
    let m;
    ZALN_S.lastIndex = 0;
    while ((m = ZALN_S.exec(trimmed)) !== null) tokens.push({ type: 's', idx: m.index, attrs: m[1] });
    ZALN_E.lastIndex = 0;
    while ((m = ZALN_E.exec(trimmed)) !== null) tokens.push({ type: 'e', idx: m.index });
    WORD.lastIndex = 0;
    while ((m = WORD.exec(trimmed)) !== null) tokens.push({ type: 'w', idx: m.index, word: m[1].trim() });
    tokens.sort((a, b) => a.idx - b.idx);

    for (const tok of tokens) {
      if (tok.type === 's') {
        const sM = tok.attrs.match(/x-strong="([^"]*)"/);
        const cM = tok.attrs.match(/x-content="([^"]*)"/);
        milestones.push({ heb: cM ? cM[1] : '', strong: sM ? sM[1] : '', heb_pos: milestones.length });
      } else if (tok.type === 'e') { milestones.pop(); }
      else if (tok.type === 'w' && milestones.length > 0) {
        const top = milestones[milestones.length - 1];
        result[key].push({ eng: tok.word, heb: top.heb, heb_pos: top.heb_pos, strong: top.strong });
      }
    }
  }

  const json = JSON.stringify(result, null, 2);
  if (output) {
    const outPath = path.resolve(CSKILLBP_DIR, output);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, json);
    return `Extracted alignment data to ${outPath}`;
  }
  return json;
}

function fixHebrewQuotes({ book, chapter, hebrewUsfm }) {
  let filePath;
  if (hebrewUsfm) filePath = path.resolve(CSKILLBP_DIR, hebrewUsfm);
  else {
    const dir = path.join(CSKILLBP_DIR, 'data/hebrew_bible');
    if (!fs.existsSync(dir)) return '[]';
    const files = fs.readdirSync(dir).filter(f => f.toUpperCase().includes(book.toUpperCase()) && f.endsWith('.usfm'));
    if (!files.length) return '[]';
    filePath = path.join(dir, files[0]);
  }
  const content = fs.readFileSync(filePath, 'utf8');
  const ch = parseInt(chapter, 10);
  let inChapter = false, inSuper = false;
  const words = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    const cm = trimmed.match(/^\\c\s+(\d+)/);
    if (cm) { if (inChapter) break; inChapter = parseInt(cm[1], 10) === ch; continue; }
    if (!inChapter) continue;
    if (trimmed.startsWith('\\d')) { inSuper = true; continue; }
    if ((trimmed.startsWith('\\v') || trimmed.startsWith('\\p')) && inSuper) break;
    if (inSuper) {
      const WRE = /\\w\s+([^|]+)\|([^\\]*?)\\w\*/g;
      let m;
      while ((m = WRE.exec(trimmed)) !== null) {
        const sM = m[2].match(/strong="([^"]*)"/);
        const lM = m[2].match(/lemma="([^"]*)"/);
        words.push({ word: m[1].trim(), strong: sM ? sM[1] : '', lemma: lM ? lM[1] : '' });
      }
    }
  }
  return JSON.stringify(words);
}

function flagNarrowQuotes({ preparedJson }) {
  const data = JSON.parse(fs.readFileSync(path.resolve(CSKILLBP_DIR, preparedJson), 'utf8'));
  const PRONOUNS = new Set(['he','she','they','it','we','you','him','her','them','us','my','his','her','their','our','your','its','mine','hers','theirs','ours','yours','i','me','myself','himself','herself','itself','themselves','ourselves','yourself','yourselves']);
  const NARROW = new Set(['figs-abstractnouns', 'figs-activepassive']);
  const flagged = [];
  for (const item of (data.items || [])) {
    const q = (item.gl_quote || '').trim();
    if (!q) continue;
    const words = q.split(/\s+/);
    let reason = null;
    if (words.length === 1) {
      if (PRONOUNS.has(words[0].toLowerCase())) reason = 'single pronoun';
      else if (NARROW.has(item.sref)) reason = `single word with ${item.sref}`;
      else reason = 'single non-pronoun word';
    } else if (words.length === 2 && PRONOUNS.has(words[0].toLowerCase())) reason = 'two-word quote starting with pronoun';
    if (reason) flagged.push(`${item.id}  ${item.reference}  [${item.sref}]\n  gl_quote: ${q}\n  reason: ${reason}`);
  }
  return flagged.length ? `${flagged.length} narrow quote(s) flagged:\n\n${flagged.join('\n\n')}` : 'No narrow quotes flagged';
}

async function generateIds({ book, count }) {
  const upstreamIds = new Set();
  try {
    const url = `https://git.door43.org/unfoldingWord/en_tn/raw/branch/master/tn_${book.toUpperCase()}.tsv`;
    const content = await httpsGet(url);
    for (const line of content.split('\n')) {
      const cols = line.split('\t');
      if (cols.length > 1 && /^[a-z][a-z0-9]{3}$/.test(cols[1])) upstreamIds.add(cols[1]);
    }
  } catch { /* proceed */ }
  const ids = [];
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  for (let i = 0; i < count; i++) {
    let id, attempts = 0;
    do {
      id = letters[Math.floor(Math.random() * 26)];
      for (let j = 0; j < 3; j++) id += chars[Math.floor(Math.random() * 36)];
      attempts++;
    } while ((upstreamIds.has(id) || ids.includes(id)) && attempts < 100);
    if (attempts >= 100) { const h = crypto.createHash('md5').update(Date.now().toString() + i).digest('hex'); id = 'x' + h.slice(0, 3); }
    ids.push(id);
  }
  return ids.join('\n');
}

function resolveGlQuotes({ preparedJson, alignmentJson, dryRun }) {
  const data = JSON.parse(fs.readFileSync(path.resolve(CSKILLBP_DIR, preparedJson), 'utf8'));
  const alignData = JSON.parse(fs.readFileSync(path.resolve(CSKILLBP_DIR, alignmentJson), 'utf8'));
  const CANT = /[\u0591-\u05AF\u2060\u05BE]/g;
  const PUNC = /[{},;:.!?'""\u2018\u2019\u201C\u201D\u2014\u2013]/g;
  let updated = 0;
  const log = [];
  for (const item of (data.items || [])) {
    if (!item.orig_quote) continue;
    const entries = alignData[item.reference] || [];
    if (!entries.length) continue;
    const hebWords = item.orig_quote.split(/\s+/);
    const matchedEng = [];
    for (const hw of hebWords) {
      const stripped = hw.replace(CANT, '');
      const found = entries.find(e => e.heb === hw) || entries.find(e => e.heb.replace(CANT, '') === stripped);
      if (found) matchedEng.push(found.eng);
    }
    if (!matchedEng.length) continue;
    const ultTokens = (item.ult_verse || '').split(/\s+/);
    const ultClean = ultTokens.map(t => t.replace(PUNC, '').toLowerCase());
    const positions = [];
    for (const eng of matchedEng) { const idx = ultClean.indexOf(eng.replace(PUNC, '').toLowerCase()); if (idx >= 0) positions.push(idx); }
    if (!positions.length) continue;
    let start = Math.min(...positions), end = Math.max(...positions);
    while (start > 0 && ultTokens[start - 1].startsWith('{')) start--;
    const span = ultTokens.slice(start, end + 1).join(' ');
    if (span !== item.gl_quote) { log.push(`${item.reference}: "${item.gl_quote}" -> "${span}"`); if (!dryRun) item.gl_quote = span; updated++; }
  }
  if (!dryRun) fs.writeFileSync(path.resolve(CSKILLBP_DIR, preparedJson), JSON.stringify(data, null, 2));
  log.unshift(`${dryRun ? '[DRY RUN] ' : ''}Updated ${updated} gl_quotes`);
  return log.join('\n');
}

function verifyAtFit({ preparedJson, generatedJson }) {
  const prepared = JSON.parse(fs.readFileSync(path.resolve(CSKILLBP_DIR, preparedJson), 'utf8'));
  const generated = JSON.parse(fs.readFileSync(path.resolve(CSKILLBP_DIR, generatedJson), 'utf8'));
  const itemById = {};
  for (const item of (prepared.items || [])) itemById[item.id] = item;
  const results = [], errors = [];
  for (const [id, noteText] of Object.entries(generated)) {
    const item = itemById[id];
    if (!item) continue;
    const atMatches = noteText.match(/\[([^\]]+)\]/g) || [];
    for (const atRaw of atMatches) {
      const at = atRaw.slice(1, -1);
      const ult = item.ult_verse || '';
      const glq = (item.gl_quote || '').replace(/\{[^}]*\}/g, '').trim();
      let idx = ult.indexOf(glq);
      if (idx < 0) idx = ult.toLowerCase().indexOf(glq.toLowerCase());
      if (idx >= 0) { results.push(`${item.reference} (${id}) [${item.sref}]\n  [${at}]\n  -> ${(ult.slice(0, idx) + at + ult.slice(idx + glq.length)).slice(0, 150)}`); }
      else errors.push(`${item.reference} (${id}): gl_quote "${glq}" not found in ULT`);
    }
  }
  const lines = [`AT check: ${results.length} OK, ${errors.length} errors`];
  if (errors.length) { lines.push('\nErrors:'); lines.push(...errors.slice(0, 10)); }
  return lines.join('\n');
}

function assembleNotes({ preparedJson, generatedJson, output }) {
  const prepared = JSON.parse(fs.readFileSync(path.resolve(CSKILLBP_DIR, preparedJson), 'utf8'));
  const generated = JSON.parse(fs.readFileSync(path.resolve(CSKILLBP_DIR, generatedJson), 'utf8'));
  const outPath = path.resolve(CSKILLBP_DIR, output);
  function refKey(ref) {
    const p = ref.split(':', 2);
    if (p.length < 2) return [999999, 999999];
    const ch = p[0] === 'front' ? -1 : parseInt(p[0], 10) || 999999;
    const vs = p[1] === 'intro' ? -2 : p[1] === 'front' ? -1 : parseInt(p[1].split('-')[0], 10) || 999999;
    return [ch, vs];
  }
  function intraKey(item) {
    const ult = (item.ult_verse || '').toLowerCase();
    const glq = (item.gl_quote || '').replace(/\{[^}]*\}/g, '').trim().toLowerCase();
    if (!ult || !glq) return [9998, 0];
    let pos = ult.indexOf(glq);
    if (pos < 0) pos = 9999;
    return [pos, -glq.length];
  }
  const rows = [];
  const missing = [];
  for (const item of (prepared.items || [])) {
    // Match by ID if available, fall back to array index for late-ID workflows
    const noteText = item.id ? generated[item.id] : generated[String(item.index)];
    if (!noteText) { missing.push(item.id || `index:${item.index}`); continue; }
    const quote = item.orig_quote || '';
    const note = noteText.replace(/\.\.\./g, '\u2026').replace(/<br\s*\/?>/gi, '').trim();
    const sref = item.sref ? `rc://*/ta/man/translate/${item.sref}` : '';
    rows.push({ ref: item.reference, id: item.id, tags: '', sref, quote, occurrence: quote ? '1' : '', note, _rk: refKey(item.reference), _ik: intraKey(item) });
  }
  rows.sort((a, b) => { const r = a._rk[0] - b._rk[0] || a._rk[1] - b._rk[1]; return r !== 0 ? r : a._ik[0] - b._ik[0] || a._ik[1] - b._ik[1]; });
  const lines = ['Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote'];
  for (const intro of (prepared.intro_rows || [])) lines.push(intro.replace(/\r\n|\r|\n/g, '\\n'));
  for (const row of rows) lines.push(`${row.ref}\t${row.id}\t${row.tags}\t${row.sref}\t${row.quote}\t${row.occurrence}\t${row.note}`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, lines.join('\n') + '\n');
  const res = [`Assembled ${rows.length} notes to ${outPath}`];
  if (missing.length) res.push(`Missing: ${missing.length}`);
  res.push(outPath);
  return res.join('\n');
}

function prepareNotes({ inputTsv, ultUsfm, ustUsfm, output, alignedUsfm, alignmentJson }) {
  const inputPath = path.resolve(CSKILLBP_DIR, inputTsv);
  const content = fs.readFileSync(inputPath, 'utf8');
  const lines = content.split('\n').filter(l => l.trim());
  const items = [];
  const introRows = [];
  for (const line of lines) {
    const cols = line.split('\t');
    if (cols[0].toLowerCase() === 'book') continue;
    while (cols.length < 7) cols.push('');
    const rawRef = cols[1] || cols[0];
    if (rawRef.includes(':intro') || rawRef === 'intro') { introRows.push(line); continue; }
    items.push({
      index: items.length,
      reference: rawRef.includes(':') ? rawRef : `${cols[0]}:${cols[1]}`,
      sref: (cols[2] || '').replace(/^rc:\/\/\*\/ta\/man\/translate\//, ''),
      gl_quote: cols[3] || '', needs_at: (cols[4] || '').toLowerCase() === 'yes' || cols[4] === '1',
      at_provided: cols[5] || '', explanation: cols[6] || '',
      id: '', orig_quote: '', ult_verse: '', ust_verse: '',
      note_type: '', hebrew_front_words: [],
    });
  }
  function parseVerses(fp) {
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
          .replace(/\\[a-z]+\d?\s+/g, ' ').replace(/\\[a-z]+\d?\*/g, '').replace(/\s+/g, ' ').trim();
        verses[`${ch}:${vm[1].split('-')[0]}`] = txt;
      }
    }
    return verses;
  }
  const ultV = parseVerses(ultUsfm);
  const ustV = parseVerses(ustUsfm);
  for (const item of items) {
    item.ult_verse = ultV[item.reference] || '';
    item.ust_verse = ustV[item.reference] || '';
    item.note_type = item.at_provided ? 'given_at' : item.needs_at ? 'writes_at' : 'see_how';
  }
  const fnM = path.basename(inputPath).match(/([A-Z0-9]+)-(\d+)/i);
  const result = { book: fnM ? fnM[1].toUpperCase() : '', chapter: fnM ? fnM[2] : '', source_file: inputTsv, item_count: items.length, items, intro_rows: introRows, alignment_data_path: alignmentJson || '' };
  const outPath = path.resolve(CSKILLBP_DIR, output || '/tmp/claude/prepared_notes.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));

  // Phase 3a: filter alignment data to target verses + 1-verse margin
  let filterNote = '';
  if (alignmentJson) {
    const alignPath = path.resolve(CSKILLBP_DIR, alignmentJson);
    if (fs.existsSync(alignPath)) {
      const alignData = JSON.parse(fs.readFileSync(alignPath, 'utf8'));
      const targetVerses = new Set(items.map(i => i.reference));
      const expanded = new Set();
      for (const ref of targetVerses) {
        const parts = ref.split(':');
        if (parts.length === 2) {
          const ch = parts[0], vsNum = parseInt(parts[1], 10);
          expanded.add(ref);
          if (vsNum > 1) expanded.add(`${ch}:${vsNum - 1}`);
          expanded.add(`${ch}:${vsNum + 1}`);
        } else {
          expanded.add(ref);
        }
      }
      const before = Object.keys(alignData).length;
      const filtered = {};
      for (const [key, val] of Object.entries(alignData)) {
        if (expanded.has(key)) filtered[key] = val;
      }
      const after = Object.keys(filtered).length;
      fs.writeFileSync(alignPath, JSON.stringify(filtered, null, 2));
      filterNote = `, alignment filtered ${before}→${after} verses`;
    }
  }

  return `Prepared ${items.length} items${filterNote}\n${outPath}`;
}

/**
 * Fix Hebrew quote Unicode to exactly match UHB source byte order.
 *
 * The TN pipeline can reorder combining marks (via NFKD normalization in
 * tsv-quote-converters or LLM tokenization). This tool re-extracts each
 * Hebrew quote from the UHB source so the bytes match exactly.
 */
function fixUnicodeQuotes({ tsvFile, hebrewUsfm, output }) {
  // --- Resolve Hebrew USFM path ---
  const tsvPath = path.resolve(CSKILLBP_DIR, tsvFile);
  const tsvContent = fs.readFileSync(tsvPath, 'utf8');
  const bookMatch = path.basename(tsvFile).match(/([A-Z0-9]{3})/i);
  const bookCode = bookMatch ? bookMatch[1].toUpperCase() : '';

  let hebrewPath;
  if (hebrewUsfm) {
    hebrewPath = path.resolve(CSKILLBP_DIR, hebrewUsfm);
  } else {
    const dir = path.join(CSKILLBP_DIR, 'data/hebrew_bible');
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.toUpperCase().includes(bookCode) && f.endsWith('.usfm')) : [];
    if (!files.length) return `ERROR: No Hebrew USFM found for ${bookCode}`;
    hebrewPath = path.join(dir, files[0]);
  }
  const hebrewContent = fs.readFileSync(hebrewPath, 'utf8');

  // Marks to strip from source to build "reduced source" (matching what TN quotes contain)
  const STRIP_RE = /[\u0591-\u05AF\u2060\u05BD\u05C3]/g;

  // --- Build verse map from Hebrew USFM ---
  // Verse text may span multiple lines: \v on its own line, \w tokens on following lines.
  // Preserves inter-word connectors like maqqeph.
  const verseMap = {};  // { "ch:vs": rawText }
  let ch = 0, curVerse = null, curLines = [];

  function extractVerseText(lines) {
    const text = lines.join(' ');
    const parts = [];
    let lastEnd = 0;
    const WRE = /\\w\s+([^|]+)\|[^\\]*?\\w\*/g;
    let m;
    while ((m = WRE.exec(text)) !== null) {
      const between = text.slice(lastEnd, m.index);
      if (parts.length && between.includes('\u05BE')) parts.push('\u05BE');
      else if (parts.length) parts.push(' ');
      parts.push(m[1].trim());
      lastEnd = m.index + m[0].length;
    }
    return parts.join('');
  }

  for (const line of hebrewContent.split('\n')) {
    const trimmed = line.trim();
    const cm = trimmed.match(/^\\c\s+(\d+)/);
    if (cm) {
      if (curVerse && curLines.length) verseMap[curVerse] = extractVerseText(curLines);
      ch = parseInt(cm[1], 10); curVerse = null; curLines = [];
      continue;
    }
    const vm = trimmed.match(/^\\v\s+(\d+[-\d]*)/);
    if (vm) {
      if (curVerse && curLines.length) verseMap[curVerse] = extractVerseText(curLines);
      const vs = vm[1].split('-')[0];
      curVerse = `${ch}:${vs}`; curLines = [];
    }
    if (curVerse && trimmed) curLines.push(trimmed);
  }
  if (curVerse && curLines.length) verseMap[curVerse] = extractVerseText(curLines);

  // --- Build stripped version + offset map back to raw ---
  // We strip marks from BOTH the quote and the raw verse for fuzzy matching,
  // then map the match back to the FULL raw verse (preserving all marks).
  function buildStripped(raw) {
    const stripped = [];
    const offsetMap = [];  // offsetMap[i] = index in raw for stripped[i]
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (!STRIP_RE.test(c)) {
        stripped.push(c);
        offsetMap.push(i);
      }
      STRIP_RE.lastIndex = 0;  // reset stateful regex
    }
    return { text: stripped.join(''), offsetMap };
  }

  // Given a match span [rStart, rEnd] in stripped text, return the
  // corresponding full span from raw (including all marks).
  function rawSpan(raw, offsetMap, rStart, rEnd, strippedLen) {
    const rawStart = offsetMap[rStart];
    // For the end: find the start of the NEXT stripped char, or end of raw
    const rawEndExcl = (rEnd + 1 < strippedLen) ? offsetMap[rEnd + 1] : raw.length;
    // Trim trailing spaces/sof-pasuq from the span
    let end = rawEndExcl;
    while (end > rawStart && (raw[end - 1] === ' ' || raw[end - 1] === '\u05C3')) end--;
    return raw.slice(rawStart, end);
  }

  // --- Fix each TSV row ---
  const lines = tsvContent.split('\n');
  const header = lines[0];
  const cols0 = header.split('\t');
  const quoteIdx = cols0.indexOf('Quote');
  const refIdx = cols0.indexOf('Reference');
  if (quoteIdx === -1 || refIdx === -1) return 'ERROR: TSV missing Quote or Reference column';

  let fixed = 0, skipped = 0, notFound = 0;
  const warnings = [];

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cols = lines[i].split('\t');
    if (cols.length <= quoteIdx) continue;
    const quote = cols[quoteIdx];
    if (!quote || !/[\u0590-\u05FF]/.test(quote)) continue;  // skip non-Hebrew

    const ref = cols[refIdx];
    const chVs = ref.includes(':') ? ref : null;
    if (!chVs) continue;

    const rawVerse = verseMap[chVs];
    if (!rawVerse) { skipped++; continue; }

    // Handle discontinuous quotes (separated by &)
    const segments = quote.split(/\s*&\s*/);
    const fixedSegments = [];
    let allMatched = true;

    for (const seg of segments) {
      const { text: strippedVerse, offsetMap } = buildStripped(rawVerse);
      // Strip the quote too (it may or may not have marks)
      const strippedQuote = seg.replace(STRIP_RE, () => { STRIP_RE.lastIndex = 0; return ''; });
      STRIP_RE.lastIndex = 0;

      // Normalize both for matching (handles combining mark reordering)
      const normQuote = strippedQuote.normalize('NFKD');
      const normStripped = strippedVerse.normalize('NFKD');

      // Build map: normStripped index -> strippedVerse index
      const nrMap = [];
      let si = 0;
      for (let ni = 0; ni < normStripped.length; ni++) {
        if (si < strippedVerse.length) {
          nrMap.push(si);
          const charNorm = strippedVerse[si].normalize('NFKD');
          if (charNorm.length > 1) {
            for (let k = 1; k < charNorm.length && ni + k < normStripped.length; k++) {
              nrMap.push(si);
            }
            ni += charNorm.length - 1;
          }
          si++;
        }
      }

      const pos = normStripped.indexOf(normQuote);
      if (pos === -1) {
        allMatched = false;
        warnings.push(`${ref}: quote segment not found: "${seg.slice(0, 30)}..."`);
        fixedSegments.push(seg);  // keep original
        continue;
      }

      // Map: normStripped pos -> strippedVerse pos -> raw pos
      const sStart = (pos < nrMap.length) ? nrMap[pos] : 0;
      const endNorm = pos + normQuote.length - 1;
      const sEnd = (endNorm < nrMap.length) ? nrMap[endNorm] : strippedVerse.length - 1;

      // Extract the FULL raw span (with all marks) from the original verse
      const fixedSeg = rawSpan(rawVerse, offsetMap, sStart, sEnd, strippedVerse.length);
      fixedSegments.push(fixedSeg);
    }

    const fixedQuote = fixedSegments.join(' & ');
    if (fixedQuote !== quote) {
      cols[quoteIdx] = fixedQuote;
      lines[i] = cols.join('\t');
      fixed++;
    }
    if (!allMatched) notFound++;
  }

  // --- Write output ---
  const outPath = output ? path.resolve(CSKILLBP_DIR, output) : tsvPath;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, lines.join('\n'));

  const result = [`Fixed ${fixed} Hebrew quotes in ${path.basename(tsvFile)}`];
  if (skipped) result.push(`Skipped ${skipped} (verse not in Hebrew source)`);
  if (notFound) result.push(`${notFound} quotes had unmatched segments`);
  if (warnings.length) result.push('Warnings:\n  ' + warnings.slice(0, 10).join('\n  '));
  result.push(outPath);
  return result.join('\n');
}

/**
 * Verify bold text in notes matches ULT verse exactly.
 * Strips bold markers from any **word** that doesn't appear as-is in the ULT.
 * Operates on assembled TSV (post-assembly, alongside curly_quotes / fix_unicode).
 */
function verifyBoldMatches({ tsvFile, ultUsfm, output }) {
  const tsvPath = path.resolve(CSKILLBP_DIR, tsvFile);
  const tsvContent = fs.readFileSync(tsvPath, 'utf8');

  // Parse ULT verses
  const ultVerses = {};
  if (ultUsfm) {
    const ultPath = path.resolve(CSKILLBP_DIR, ultUsfm);
    if (fs.existsSync(ultPath)) {
      const text = fs.readFileSync(ultPath, 'utf8');
      let ch = 0;
      for (const l of text.split('\n')) {
        const cm = l.trim().match(/^\\c\s+(\d+)/);
        if (cm) { ch = parseInt(cm[1], 10); continue; }
        const vm = l.trim().match(/^\\v\s+(\d+[-\d]*)\s*(.*)/);
        if (vm) {
          let txt = vm[2] || '';
          txt = txt.replace(/\\zaln-[se][^*]*\*/g, '').replace(/\\w\s+([^|]*?)\|[^\\]*?\\w\*/g, '$1')
            .replace(/\\[a-z]+\d?\s+/g, ' ').replace(/\\[a-z]+\d?\*/g, '').replace(/\s+/g, ' ').trim();
          ultVerses[`${ch}:${vm[1].split('-')[0]}`] = txt;
        }
      }
    }
  }

  const lines = tsvContent.split('\n');
  const header = lines[0];
  const cols0 = header.split('\t');
  const noteIdx = cols0.indexOf('Note');
  const refIdx = cols0.indexOf('Reference');
  if (noteIdx === -1 || refIdx === -1) return 'ERROR: TSV missing Note or Reference column';

  let stripped = 0;
  const log = [];

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cols = lines[i].split('\t');
    if (cols.length <= noteIdx) continue;

    const ref = cols[refIdx];
    const ult = ultVerses[ref] || '';
    if (!ult) continue;

    let note = cols[noteIdx];
    let changed = false;

    note = note.replace(/\*\*([^*]+)\*\*/g, (match, boldText) => {
      if (ult.includes(boldText)) return match; // exact match, keep bold
      stripped++;
      changed = true;
      log.push(`${ref}: stripped bold from "${boldText}"`);
      return boldText; // remove ** markers
    });

    if (changed) {
      cols[noteIdx] = note;
      lines[i] = cols.join('\t');
    }
  }

  const outPath = output ? path.resolve(CSKILLBP_DIR, output) : tsvPath;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, lines.join('\n'));

  const result = [`Bold check: stripped ${stripped} non-matching bold(s) in ${path.basename(tsvFile)}`];
  if (log.length) result.push(log.join('\n'));
  result.push(outPath);
  return result.join('\n');
}

/**
 * Fill empty orig_quote fields in prepared_notes.json using alignment data.
 * Deterministically matches English gl_quote words to Hebrew via alignment,
 * then extracts the exact Hebrew span from UHB source (character-for-character).
 * Falls back gracefully for items that can't be resolved.
 */
function fillOrigQuotes({ preparedJson, alignmentJson, hebrewUsfm }) {
  const prepPath = path.resolve(CSKILLBP_DIR, preparedJson);
  const data = JSON.parse(fs.readFileSync(prepPath, 'utf8'));
  const alignData = JSON.parse(fs.readFileSync(path.resolve(CSKILLBP_DIR, alignmentJson), 'utf8'));

  const bookCode = (data.book || '').toUpperCase();
  let hebrewPath;
  if (hebrewUsfm) {
    hebrewPath = path.resolve(CSKILLBP_DIR, hebrewUsfm);
  } else {
    const dir = path.join(CSKILLBP_DIR, 'data/hebrew_bible');
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.toUpperCase().includes(bookCode) && f.endsWith('.usfm')) : [];
    if (!files.length) return `ERROR: No Hebrew USFM found for ${bookCode}`;
    hebrewPath = path.join(dir, files[0]);
  }
  const hebrewContent = fs.readFileSync(hebrewPath, 'utf8');

  const STRIP_RE = /[\u0591-\u05AF\u2060\u05BD\u05C3]/g;
  const CANT = /[\u0591-\u05AF\u2060\u05BE]/g;
  const PUNC = /[{},;:.!?'""\u2018\u2019\u201C\u201D\u2014\u2013]/g;

  // Build verse map (same logic as fixUnicodeQuotes)
  const verseMap = {};
  let hebCh = 0, curVerse = null, curLines = [];

  function extractVerseText(lines) {
    const text = lines.join(' ');
    const parts = [];
    let lastEnd = 0;
    const WRE = /\\w\s+([^|]+)\|[^\\]*?\\w\*/g;
    let m;
    while ((m = WRE.exec(text)) !== null) {
      const between = text.slice(lastEnd, m.index);
      if (parts.length && between.includes('\u05BE')) parts.push('\u05BE');
      else if (parts.length) parts.push(' ');
      parts.push(m[1].trim());
      lastEnd = m.index + m[0].length;
    }
    return parts.join('');
  }

  for (const line of hebrewContent.split('\n')) {
    const trimmed = line.trim();
    const cm = trimmed.match(/^\\c\s+(\d+)/);
    if (cm) {
      if (curVerse && curLines.length) verseMap[curVerse] = extractVerseText(curLines);
      hebCh = parseInt(cm[1], 10); curVerse = null; curLines = [];
      continue;
    }
    const vm = trimmed.match(/^\\v\s+(\d+[-\d]*)/);
    if (vm) {
      if (curVerse && curLines.length) verseMap[curVerse] = extractVerseText(curLines);
      curVerse = `${hebCh}:${vm[1].split('-')[0]}`; curLines = [];
    }
    if (curVerse && trimmed) curLines.push(trimmed);
  }
  if (curVerse && curLines.length) verseMap[curVerse] = extractVerseText(curLines);

  function buildStripped(raw) {
    const stripped = [];
    const offsetMap = [];
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (!STRIP_RE.test(c)) { stripped.push(c); offsetMap.push(i); }
      STRIP_RE.lastIndex = 0;
    }
    return { text: stripped.join(''), offsetMap };
  }

  function rawSpan(raw, offsetMap, rStart, rEnd, strippedLen) {
    const rawStart = offsetMap[rStart];
    const rawEndExcl = (rEnd + 1 < strippedLen) ? offsetMap[rEnd + 1] : raw.length;
    let end = rawEndExcl;
    while (end > rawStart && (raw[end - 1] === ' ' || raw[end - 1] === '\u05C3')) end--;
    return raw.slice(rawStart, end);
  }

  function extractHebrewSpan(ref, hebWords) {
    const rawVerse = verseMap[ref];
    if (!rawVerse) return null;
    const { text: strippedVerse, offsetMap } = buildStripped(rawVerse);
    const normVerse = strippedVerse.normalize('NFKD');

    const positions = [];
    for (const hw of hebWords) {
      const strippedHw = hw.replace(CANT, '');
      const normHw = strippedHw.normalize('NFKD');
      const normPos = normVerse.indexOf(normHw);
      if (normPos < 0) return null;
      // Map norm position back to strippedVerse position
      let si = 0, ni = 0;
      while (ni < normPos && si < strippedVerse.length) {
        ni += strippedVerse[si].normalize('NFKD').length;
        si++;
      }
      positions.push({ start: si, end: si + strippedHw.length - 1 });
    }

    if (!positions.length) return null;
    const minStart = Math.min(...positions.map(p => p.start));
    const maxEnd = Math.max(...positions.map(p => p.end));
    return rawSpan(rawVerse, offsetMap, minStart, maxEnd, strippedVerse.length);
  }

  let resolved = 0;
  const unresolved = [];

  for (const item of (data.items || [])) {
    if (item.orig_quote) continue;
    if (!item.gl_quote) continue;
    if (item.reference && item.reference.endsWith(':front')) continue;

    const entries = alignData[item.reference] || [];
    if (!entries.length) {
      unresolved.push(`${item.id} ${item.reference}: no alignment entries`);
      continue;
    }

    const cleanGlq = item.gl_quote.replace(/\{[^}]*\}/g, '').trim();
    const glqNorm = cleanGlq.split(/\s+/).filter(Boolean).map(t => t.replace(PUNC, '').toLowerCase()).filter(Boolean);

    if (!glqNorm.length) {
      unresolved.push(`${item.id} ${item.reference}: empty gl_quote after cleaning`);
      continue;
    }

    const usedIndices = new Set();
    const matchedHeb = [];
    let allMatched = true;

    for (const glqWord of glqNorm) {
      let found = false;
      for (let i = 0; i < entries.length; i++) {
        if (usedIndices.has(i)) continue;
        const engNorm = (entries[i].eng || '').replace(PUNC, '').toLowerCase();
        if (engNorm === glqWord) {
          usedIndices.add(i);
          if (entries[i].heb) matchedHeb.push(entries[i].heb);
          found = true;
          break;
        }
      }
      if (!found) { allMatched = false; break; }
    }

    if (!allMatched || !matchedHeb.length) {
      unresolved.push(`${item.id} ${item.reference}: "${cleanGlq.slice(0, 40)}" — not all words matched in alignment`);
      continue;
    }

    const span = extractHebrewSpan(item.reference, matchedHeb);
    if (!span) {
      unresolved.push(`${item.id} ${item.reference}: Hebrew words found but not locatable in source verse`);
      continue;
    }

    item.orig_quote = span;
    resolved++;
  }

  fs.writeFileSync(prepPath, JSON.stringify(data, null, 2));

  const lines = [`Resolved: ${resolved} of ${resolved + unresolved.length} items. Unresolved: ${unresolved.length} items:`];
  for (const u of unresolved) lines.push(`  ${u}`);
  return lines.join('\n');
}

/**
 * Fill empty ID columns in an assembled TN TSV with unique generated IDs.
 * Used after merging parallel shard TSVs that were assembled without IDs.
 */
async function fillTsvIds({ tsvFile, book }) {
  const tsvPath = path.resolve(CSKILLBP_DIR, tsvFile);
  const content = fs.readFileSync(tsvPath, 'utf8');
  const lines = content.split('\n');
  if (lines.length < 2) return 'No data rows to fill';

  // Count rows needing IDs (non-header, non-empty, empty ID column)
  const header = lines[0];
  const dataLines = [];
  const needsId = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    dataLines.push(i);
    const cols = lines[i].split('\t');
    if (cols.length >= 2 && !cols[1].trim()) needsId.push(i);
  }

  if (needsId.length === 0) return `All ${dataLines.length} rows already have IDs`;

  // Generate unique IDs
  const bookCode = (book || '').toUpperCase() || path.basename(tsvFile).match(/([A-Z]{3})/i)?.[1] || 'UNK';
  const idStr = await generateIds({ book: bookCode, count: needsId.length });
  const ids = idStr.split('\n').filter(Boolean);

  // Fill IDs into the lines
  for (let j = 0; j < needsId.length; j++) {
    const lineIdx = needsId[j];
    const cols = lines[lineIdx].split('\t');
    cols[1] = ids[j] || cols[1];
    lines[lineIdx] = cols.join('\t');
  }

  // Write atomically
  const tmpFile = tsvPath + '.tmp';
  fs.writeFileSync(tmpFile, lines.join('\n'));
  fs.renameSync(tmpFile, tsvPath);
  return `Filled ${needsId.length} IDs in ${tsvFile}`;
}

module.exports = { extractAlignmentData, fixHebrewQuotes, flagNarrowQuotes, generateIds, resolveGlQuotes, verifyAtFit, assembleNotes, prepareNotes, fixUnicodeQuotes, verifyBoldMatches, fillTsvIds, fillOrigQuotes };
