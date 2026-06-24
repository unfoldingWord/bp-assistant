// tsv-tools.js — Node.js ports of TSV processing scripts
//
// Replaces: split_tsv.py, merge_tsvs.py, fix_trailing_newlines.py

const fs = require('fs');
const path = require('path');
const { glob } = require('path');

const CSKILLBP_DIR = process.env.CSKILLBP_DIR || '/srv/bot/workspace';

// PSA 119 stanza boundaries (22 stanzas of 8 verses each)
const STANZA_TABLE = {};
for (let i = 0; i < 22; i++) {
  const start = i * 8 + 1;
  const end = start + 7;
  STANZA_TABLE[`${start}-${end}`] = { start, end };
}

function parseVerseNum(ref) {
  if (!ref) return null;
  const parts = ref.split(':');
  const last = parts[parts.length - 1];
  if (last === 'intro' || last === 'front') return null;
  const m = last.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

function isIntro(ref) {
  return ref && (ref.includes(':intro') || ref === 'intro');
}

/**
 * Split a verse-based issue TSV into chunks for parallel processing.
 * @returns {string} Absolute paths of chunk files, one per line
 */
function splitTsv({ inputTsv, chunkSize = 40, ranges, outputDir }) {
  const inputPath = path.resolve(CSKILLBP_DIR, inputTsv);
  const content = fs.readFileSync(inputPath, 'utf8');
  let lines = content.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines = lines.slice(0, -1);
  if (!lines.length) return 'Empty file';

  // Detect header
  let header = null;
  let dataLines = lines;
  if (lines[0].toLowerCase().startsWith('reference') || lines[0].toLowerCase().startsWith('book')) {
    header = lines[0];
    dataLines = lines.slice(1);
  }

  // Parse book/chapter from filename
  const basename = path.basename(inputPath);
  const fnMatch = basename.match(/([A-Za-z0-9]+)-(\d+)/);
  const chapter = fnMatch ? parseInt(fnMatch[2], 10) : null;

  // Detect issues TSV format: Book\tReference\t... (col 0 = book code, col 1 = verse ref)
  // vs notes TSV format: Reference\t... (col 0 = verse ref)
  const firstDataLine = dataLines.find(l => l.trim());
  const refCol = firstDataLine && /^[A-Z0-9]{2,3}\t/.test(firstDataLine) ? 1 : 0;

  // Separate intro rows
  const introRows = [];
  const verseRows = [];
  for (const line of dataLines) {
    if (!line.trim()) continue;
    const ref = line.split('\t')[refCol] || '';
    if (isIntro(ref)) introRows.push(line);
    else verseRows.push(line);
  }

  // Get all verse numbers
  const verseNums = new Set();
  for (const line of verseRows) {
    const ref = line.split('\t')[refCol] || '';
    const v = parseVerseNum(ref);
    if (v !== null) verseNums.add(v);
  }
  const maxVerse = Math.max(...verseNums, 0);

  // Compute ranges
  let chunkRanges;
  if (ranges) {
    chunkRanges = ranges.split(',').map(r => {
      const [s, e] = r.trim().split('-').map(Number);
      return { start: s, end: e || s };
    });
  } else if (chapter === 119 && basename.toUpperCase().includes('PSA')) {
    // Stanza-aware splitting for PSA 119
    chunkRanges = [];
    for (let i = 0; i < 22; i++) {
      const s = i * 8 + 1;
      const e = s + 7;
      chunkRanges.push({ start: s, end: e });
    }
    // Group stanzas to hit ~chunkSize
    const grouped = [];
    let cur = null;
    for (const r of chunkRanges) {
      if (!cur) { cur = { ...r }; continue; }
      if (cur.end - cur.start + 1 + (r.end - r.start + 1) <= chunkSize) {
        cur.end = r.end;
      } else {
        grouped.push(cur);
        cur = { ...r };
      }
    }
    if (cur) grouped.push(cur);
    chunkRanges = grouped;
  } else {
    chunkRanges = [];
    for (let s = 1; s <= maxVerse; s += chunkSize) {
      chunkRanges.push({ start: s, end: Math.min(s + chunkSize - 1, maxVerse) });
    }
  }

  if (chunkRanges.length <= 1 && !ranges) return path.resolve(inputPath);

  // Strip existing -vN-M suffix
  const dir = outputDir ? path.resolve(CSKILLBP_DIR, outputDir) : path.dirname(inputPath);
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(basename);
  let base = basename.slice(0, -ext.length).replace(/-v\d+-\d+$/, '');

  const outputPaths = [];
  for (let ci = 0; ci < chunkRanges.length; ci++) {
    const { start, end } = chunkRanges[ci];
    const chunkFile = path.join(dir, `${base}-v${start}-${end}${ext}`);
    const chunkRows = verseRows.filter(line => {
      const v = parseVerseNum(line.split('\t')[refCol] || '');
      return v !== null && v >= start && v <= end;
    });

    if (chunkRows.length === 0 && ci > 0) continue;

    const out = [];
    if (header) out.push(header);
    if (ci === 0) out.push(...introRows);
    out.push(...chunkRows);
    fs.writeFileSync(chunkFile, out.join('\n') + '\n');
    outputPaths.push(path.resolve(chunkFile));
  }

  return outputPaths.join('\n');
}

/**
 * Merge multiple notes TSVs with dedup and verse sorting.
 * @returns {string} Absolute path to merged file
 */
function mergeTsvs({ files, globPattern, output, noSort = false }) {
  const outputPath = path.resolve(CSKILLBP_DIR, output);
  let inputFiles = files ? files.map(f => path.resolve(CSKILLBP_DIR, f)) : [];

  if (globPattern) {
    const pattern = path.resolve(CSKILLBP_DIR, globPattern);
    const dir = path.dirname(pattern);
    const base = path.basename(pattern);
    if (fs.existsSync(dir)) {
      const re = new RegExp('^' + base.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
      const matches = fs.readdirSync(dir).filter(f => re.test(f)).map(f => path.join(dir, f));
      inputFiles = [...inputFiles, ...matches];
    }
  }

  // Filter out output file from inputs
  inputFiles = inputFiles.filter(f => path.resolve(f) !== outputPath);
  if (!inputFiles.length) return 'No input files found';

  let header = null;
  const allLines = [];
  const seen = new Set();
  let dupCount = 0;

  for (const file of inputFiles.sort()) {
    if (!fs.existsSync(file)) continue;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      const cols = line.split('\t');
      if (!header && cols[0].toLowerCase() === 'reference') {
        header = line;
        continue;
      }
      if (cols[0].toLowerCase() === 'reference') continue; // skip extra headers

      // Dedup key: Reference|SupportReference|Quote
      const key = `${cols[0] || ''}|${cols[3] || ''}|${cols[4] || ''}`;
      if (seen.has(key)) { dupCount++; continue; }
      seen.add(key);
      allLines.push(line);
    }
  }

  // Sort by verse unless --no-sort
  if (!noSort) {
    allLines.sort((a, b) => {
      const refA = a.split('\t', 1)[0];
      const refB = b.split('\t', 1)[0];
      const vA = isIntro(refA) ? 0 : (parseVerseNum(refA) || 999999);
      const vB = isIntro(refB) ? 0 : (parseVerseNum(refB) || 999999);
      return vA - vB;
    });
  }

  const out = [];
  if (header) out.push(header);
  out.push(...allLines);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, out.join('\n') + '\n');
  return `Merged ${inputFiles.length} files -> ${allLines.length} rows (${dupCount} duplicates removed)\n${outputPath}`;
}

/**
 * Fix trailing literal \n in Note column of a TSV file.
 * @returns {string} Summary of fixes
 */
function fixTrailingNewlines({ file }) {
  const filePath = path.resolve(CSKILLBP_DIR, file);
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  if (!lines.length) return 'Empty file';

  // Find Note column
  const headerCols = lines[0].split('\t');
  const noteIdx = headerCols.indexOf('Note');
  if (noteIdx === -1) return 'No Note column found';

  let fixed = 0;
  const result = [lines[0]];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) { result.push(lines[i]); continue; }
    const cols = lines[i].split('\t');
    if (cols.length > noteIdx && cols[noteIdx].endsWith('\\n')) {
      cols[noteIdx] = cols[noteIdx].slice(0, -2).trimEnd();
      fixed++;
    }
    result.push(cols.join('\t'));
  }

  fs.writeFileSync(filePath, result.join('\n'));
  return `Fixed ${fixed} trailing \\n in ${path.basename(filePath)}`;
}

// --- TN edit comparator (Phase 2 overnight Sensor) ---------------------------
// TN is TSV, not USFM, so prepare_compare (USFM) can't parse it. This diffs two
// versions of a book's notes TSV row-by-row, keyed by Reference+SupportReference
// (the stable identity; the random ID column is ignored entirely, and Quote can
// drift). Classifies each change as reworded / quote-changed / dropped / added
// and ignores cosmetic (whitespace-only) Note edits. Returns a plain object.
function _tnColIndices(headerLine) {
  const cols = headerLine.split('\t').map((c) => c.trim().toLowerCase());
  const find = (name, dflt) => { const i = cols.indexOf(name); return i >= 0 ? i : dflt; };
  return {
    reference: find('reference', 0),
    supportReference: find('supportreference', 3),
    quote: find('quote', 4),
    occurrence: find('occurrence', 5),
    note: find('note', 6),
  };
}

function _parseTnRows(content, chapterFilter) {
  const lines = String(content || '').split(/\r?\n/);
  let idx = { reference: 0, supportReference: 3, quote: 4, note: 6 };
  let start = 0;
  if (lines.length && /^reference\t/i.test(lines[0])) { idx = _tnColIndices(lines[0]); start = 1; }
  const rows = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const cols = line.split('\t');
    const reference = (cols[idx.reference] || '').trim();
    if (!reference) continue;
    if (chapterFilter != null && String(reference.split(':')[0]) !== String(chapterFilter)) continue;
    rows.push({
      reference,
      supportReference: (cols[idx.supportReference] || '').trim(),
      quote: (cols[idx.quote] || '').trim(),
      occurrence: (cols[idx.occurrence] || '').trim(),
      note: (cols[idx.note] || '').trim(),
    });
  }
  return rows;
}

function _normNote(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

/**
 * Row-keyed diff of two TN notes-TSV versions.
 * @param {object} opts
 * @param {string} [opts.oldTsv]  - old TSV content (inline)
 * @param {string} [opts.newTsv]  - new TSV content (inline)
 * @param {string} [opts.oldPath] - old TSV path (relative to CSKILLBP_DIR)
 * @param {string} [opts.newPath] - new TSV path
 * @param {string} [opts.book]    - book code (label only)
 * @param {number|string} [opts.chapter] - restrict to one chapter (Reference prefix)
 * @returns {{ book, chapter, summary, changes }}
 */
function prepareCompareTn({ oldTsv, newTsv, oldPath, newPath, book = null, chapter = null } = {}) {
  const oldContent = oldTsv != null ? oldTsv : (oldPath ? fs.readFileSync(path.resolve(CSKILLBP_DIR, oldPath), 'utf8') : '');
  const newContent = newTsv != null ? newTsv : (newPath ? fs.readFileSync(path.resolve(CSKILLBP_DIR, newPath), 'utf8') : '');
  const oldRows = _parseTnRows(oldContent, chapter);
  const newRows = _parseTnRows(newContent, chapter);

  const fullKey = (r) => [r.reference, r.supportReference, r.quote, r.occurrence].join("|");
  const pairKey = (r) => [r.reference, r.supportReference].join("|");
  const oldByFull = new Map();
  for (const r of oldRows) if (!oldByFull.has(fullKey(r))) oldByFull.set(fullKey(r), r);
  const newByFull = new Map();
  for (const r of newRows) if (!newByFull.has(fullKey(r))) newByFull.set(fullKey(r), r);

  const changes = [];
  const oldOnly = [];
  const newOnly = [];
  for (const [k, oldR] of oldByFull) {
    if (newByFull.has(k)) {
      const newR = newByFull.get(k);
      if (_normNote(oldR.note) !== _normNote(newR.note)) {
        changes.push({ changeType: 'reworded', reference: oldR.reference, supportReference: oldR.supportReference,
          before: { quote: oldR.quote, occurrence: oldR.occurrence, note: oldR.note }, after: { quote: newR.quote, occurrence: newR.occurrence, note: newR.note } });
      }
    } else { oldOnly.push(oldR); }
  }
  for (const [k, newR] of newByFull) if (!oldByFull.has(k)) newOnly.push(newR);

  // Pair a single dropped + single added on the same (Reference, SupportReference)
  // as a quote-changed; leftovers are genuine drops/adds.
  const groupBy = (arr) => { const m = new Map(); for (const r of arr) { const p = pairKey(r); if (!m.has(p)) m.set(p, []); m.get(p).push(r); } return m; };
  const oldG = groupBy(oldOnly);
  const newG = groupBy(newOnly);
  const usedOld = new Set();
  const usedNew = new Set();
  for (const [p, oArr] of oldG) {
    const nArr = newG.get(p);
    if (oArr.length === 1 && nArr && nArr.length === 1) {
      const o = oArr[0]; const n = nArr[0];
      changes.push({ changeType: 'quote-changed', reference: o.reference, supportReference: o.supportReference,
        before: { quote: o.quote, occurrence: o.occurrence, note: o.note }, after: { quote: n.quote, occurrence: n.occurrence, note: n.note } });
      usedOld.add(o); usedNew.add(n);
    }
  }
  for (const r of oldOnly) if (!usedOld.has(r)) changes.push({ changeType: 'dropped', reference: r.reference, supportReference: r.supportReference, before: { quote: r.quote, occurrence: r.occurrence, note: r.note }, after: null });
  for (const r of newOnly) if (!usedNew.has(r)) changes.push({ changeType: 'added', reference: r.reference, supportReference: r.supportReference, before: null, after: { quote: r.quote, occurrence: r.occurrence, note: r.note } });

  changes.sort((a, b) => (parseVerseNum(a.reference) || 0) - (parseVerseNum(b.reference) || 0));
  const summary = { reworded: 0, 'quote-changed': 0, dropped: 0, added: 0, total: changes.length };
  for (const c of changes) summary[c.changeType] = (summary[c.changeType] || 0) + 1;
  return { book, chapter, summary, changes };
}

module.exports = { splitTsv, mergeTsvs, fixTrailingNewlines, prepareCompareTn };
