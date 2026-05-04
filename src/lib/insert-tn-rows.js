// insert-tn-rows.js — Node.js port of insert_tn_rows.py
//
// Replace translation note rows in a book-level TSV file with verse-aware
// chapter replacement, KEEP-tag support, and ULT-based intra-verse ordering.

const fs = require('fs');
const path = require('path');

// --- TSV field helpers ---

function getReference(row) {
  return row.split('\t', 1)[0];
}

function getChapter(ref) {
  const parts = ref.split(':', 1);
  if (parts[0] === 'front') return -1;
  const n = parseInt(parts[0], 10);
  return isNaN(n) ? 999999 : n;
}

function isIntroRef(ref) {
  const parts = ref.split(':', 2);
  return parts.length === 2 && parts[1] === 'intro';
}

// Canonical 7-col TN row: Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote
const INTRO_ID_RE = /^[a-z][a-z0-9]{3}$/;
const INTRO_REF_RE = /^(?:front|\d+):(?:intro|front)$/;

function generateIntroId(existingIds) {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (let attempt = 0; attempt < 100; attempt++) {
    let id = letters[Math.floor(Math.random() * 26)];
    for (let j = 0; j < 3; j++) id += chars[Math.floor(Math.random() * 36)];
    if (!existingIds || !existingIds.has(id)) return id;
  }
  // Fallback: deterministic from timestamp
  const ts = Date.now().toString(36);
  return ('x' + ts.slice(-3)).slice(0, 4);
}

/**
 * Normalize a raw TSV intro line into the canonical 7-column shape.
 * Handles column drift (e.g. "intro" landing in the ID column) and
 * non-canonical source formats (6-col issues TSV, missing SupportReference, etc.).
 *
 * @param {string} rawLine - Tab-separated row as read from a TSV
 * @param {object} opts
 * @param {number|string} opts.chapter - Chapter number (used for Reference fallback)
 * @param {Set<string>} [opts.existingIds] - IDs already present in the chapter
 * @param {(msg: string) => void} [opts.warn] - Optional warning logger
 * @returns {string} Canonical 7-col line, or empty string if row is empty
 */
function normalizeIntroRow(rawLine, { chapter, existingIds, warn } = {}) {
  if (!rawLine || !rawLine.trim()) return '';
  const cols = rawLine.split('\t').map(c => (c == null ? '' : c));
  const chapterStr = chapter != null ? String(chapter) : '';
  const emitWarn = (msg) => { if (typeof warn === 'function') warn(msg); };

  // Happy path: already canonical (7 cols, valid ref in col 0, valid id in col 1).
  if (cols.length === 7 && INTRO_REF_RE.test(cols[0].trim()) && INTRO_ID_RE.test(cols[1].trim())) {
    return cols.join('\t');
  }

  // 1) Find a reference cell matching chapter:intro / front:intro
  let reference = '';
  for (const c of cols) {
    const s = (c || '').trim();
    if (INTRO_REF_RE.test(s)) { reference = s; break; }
  }
  if (!reference) {
    reference = chapterStr ? `${chapterStr}:intro` : 'front:intro';
    emitWarn(`normalizeIntroRow: missing/invalid Reference, defaulted to "${reference}"`);
  }

  // 2) ID lives at column 1 in the canonical format. Only trust that position;
  //    scanning other columns could misidentify a 4-char word in the note body
  //    (e.g. "body", "also") as an ID.
  let id = '';
  const colOneId = (cols[1] || '').trim();
  if (INTRO_ID_RE.test(colOneId)) {
    id = colOneId;
  } else {
    id = generateIntroId(existingIds);
    emitWarn(`normalizeIntroRow: invalid/missing ID at col 1 ("${colOneId}"), generated "${id}"`);
  }
  if (existingIds) existingIds.add(id);

  // 3) Note body: last non-empty cell that is not the reference cell.
  //    In both canonical tn and issue-TSV formats, the note/content is the
  //    rightmost populated column.
  let note = '';
  for (let i = cols.length - 1; i >= 0; i--) {
    const s = (cols[i] || '').trim();
    if (!s) continue;
    if (s === reference) continue;
    if (s === colOneId && s !== id) continue;
    note = cols[i];
    break;
  }

  // Canonical: Reference, ID, Tags, SupportReference, Quote, Occurrence, Note
  return [reference, id, '', '', '', '', note].join('\t');
}

function getTags(row) {
  const parts = row.split('\t');
  return parts.length > 2 ? parts[2] : '';
}

function getSupportReference(row) {
  const parts = row.split('\t');
  return parts.length > 3 ? parts[3] : '';
}

function hasKeepTag(row) {
  const tags = getTags(row).trim();
  if (!tags) return false;
  return tags.split(',').some(t => t.trim().toUpperCase() === 'KEEP');
}

function extractBoldPhrase(row) {
  const parts = row.split('\t');
  const note = parts.length > 6 ? parts[6] : '';
  const m = note.match(/\*\*([^*]+)\*\*/);
  return m ? m[1] : '';
}

// --- Reference sorting ---

function parseReference(ref) {
  const parts = ref.split(':', 2);
  if (parts.length !== 2) return [999999, 999999];

  const [chapterStr, verseStr] = parts;
  let ch;
  if (chapterStr === 'front') ch = -1;
  else { ch = parseInt(chapterStr, 10); if (isNaN(ch)) ch = 999999; }

  let vs;
  if (verseStr === 'intro') vs = -2;
  else if (verseStr === 'front') vs = -1;
  else { vs = parseInt(verseStr.split('-')[0], 10); if (isNaN(vs)) vs = 999999; }

  return [ch, vs];
}

/**
 * Return the anchor (start) verse key for a reference that may include a range.
 * "18:9-10" → "18:9",  "18:9" → "18:9",  "front:intro" → "front:intro"
 */
function anchorVerse(ref) {
  const m = ref.match(/^(\d+):(\d+)/);
  return m ? `${m[1]}:${m[2]}` : ref;
}

function refCompare(a, b) {
  const [aCh, aVs] = parseReference(getReference(a));
  const [bCh, bVs] = parseReference(getReference(b));
  if (aCh !== bCh) return aCh - bCh;
  return aVs - bVs;
}

// --- ULT verse parsing for intra-verse ordering ---

function stripUsfm(text) {
  text = text.replace(/\\zaln-[se][^*]*\*/g, '');
  text = text.replace(/\\w\s+/g, '');
  text = text.replace(/\\w\*/g, '');
  text = text.replace(/\\[a-z]+\d?\s+/g, ' ');
  text = text.replace(/\\[a-z]+\d?\*/g, '');
  text = text.replace(/\s+/g, ' ');
  return text.trim();
}

function parseUltVerses(usfmPath, chapter) {
  const content = fs.readFileSync(usfmPath, 'utf8');
  const verses = {};
  let inChapter = false;
  let currentVerse = null;
  const currentText = [];

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    const cMatch = trimmed.match(/^\\c\s+(\d+)/);
    if (cMatch) {
      if (inChapter && currentVerse !== null) {
        verses[currentVerse] = currentText.join(' ').trim();
      }
      currentVerse = null;
      currentText.length = 0;
      inChapter = parseInt(cMatch[1], 10) === chapter;
      continue;
    }
    if (!inChapter) continue;

    const vMatch = trimmed.match(/^\\v\s+(\d+[-\d]*)\s*(.*)/);
    if (vMatch) {
      if (currentVerse !== null) {
        verses[currentVerse] = currentText.join(' ').trim();
      }
      const vs = vMatch[1].split('-')[0];
      currentVerse = `${chapter}:${vs}`;
      currentText.length = 0;
      if (vMatch[2]) currentText.push(stripUsfm(vMatch[2]));
      continue;
    }

    if (currentVerse !== null && trimmed && !trimmed.startsWith('\\c ')) {
      currentText.push(stripUsfm(trimmed));
    }
  }

  if (inChapter && currentVerse !== null) {
    verses[currentVerse] = currentText.join(' ').trim();
  }
  return verses;
}

function ultPositionKey(row, ultVerses) {
  const ref = getReference(row);
  const ultText = ultVerses[ref] || '';
  if (!ultText) return [9998, 0];

  const phrase = extractBoldPhrase(row);
  if (!phrase) return [9998, 0];

  let pos = ultText.toLowerCase().indexOf(phrase.toLowerCase());
  if (pos < 0) pos = 9999;
  return [pos, -phrase.length];
}

// --- Chapter/position helpers ---

function findChapterBounds(bookRows, chapter) {
  let start = null;
  let end = null;
  for (let i = 0; i < bookRows.length; i++) {
    if (getChapter(getReference(bookRows[i])) === chapter) {
      if (start === null) start = i;
      end = i + 1;
    }
  }
  return [start, end];
}

function findInsertPosition(bookRows, targetCh, targetVs) {
  const [chStart, chEnd] = findChapterBounds(bookRows, targetCh);
  if (chStart !== null) {
    for (let i = chStart; i < chEnd; i++) {
      const rowVs = parseReference(getReference(bookRows[i]))[1];
      if (rowVs > targetVs) return i;
    }
    return chEnd;
  }
  for (let i = 0; i < bookRows.length; i++) {
    if (parseReference(getReference(bookRows[i]))[0] > targetCh) return i;
  }
  return bookRows.length;
}

function findChapterInsertPosition(bookRows, chapter) {
  for (let i = 0; i < bookRows.length; i++) {
    if (getChapter(getReference(bookRows[i])) > chapter) return i;
  }
  return bookRows.length;
}

// --- TSV I/O ---

function readTsv(filepath) {
  const content = fs.readFileSync(filepath, 'utf8');
  let lines = content.split('\n');
  if (lines.length && lines[lines.length - 1] === '') {
    lines = lines.slice(0, -1);
  }
  if (!lines.length) return [null, []];
  return [lines[0], lines.slice(1)];
}

function detectLineEnding(filepath) {
  const buf = Buffer.alloc(4096);
  const fd = fs.openSync(filepath, 'r');
  const bytesRead = fs.readSync(fd, buf, 0, 4096, 0);
  fs.closeSync(fd);
  return buf.slice(0, bytesRead).includes(Buffer.from('\r\n')) ? '\r\n' : '\n';
}

// --- Per-reference replacement ---

function doPerReference(bookRows, sourceGroups, ultVerses, log) {
  const newRows = [...bookRows];
  let totalRemoved = 0;
  let totalAdded = 0;
  let totalKept = 0;

  for (const [ref, newRefRows] of sourceGroups) {
    const refSortKey = parseReference(ref);
    const indicesToRemove = [];
    const keepRows = [];

    for (let i = 0; i < newRows.length; i++) {
      if (getReference(newRows[i]) === ref) {
        if (hasKeepTag(newRows[i])) keepRows.push(newRows[i]);
        else indicesToRemove.push(i);
      }
    }

    let dedupedSource = newRefRows;
    if (keepRows.length) {
      const keepKeys = new Set();
      for (const row of keepRows) {
        const sref = getSupportReference(row);
        if (sref) keepKeys.add(`${ref}\t${sref}`);
      }
      if (keepKeys.size) {
        dedupedSource = newRefRows.filter(row =>
          !keepKeys.has(`${getReference(row)}\t${getSupportReference(row)}`)
        );
        const dedupCount = newRefRows.length - dedupedSource.length;
        if (dedupCount) log.push(`  ${ref}: deduplicated ${dedupCount} source row(s) against KEEP notes`);
      }
    }

    let insertPos;
    if (indicesToRemove.length) {
      insertPos = indicesToRemove[0];
      log.push(`  ${ref}: replacing ${indicesToRemove.length} existing rows with ${dedupedSource.length} new rows`);
      const keepIndices = [];
      for (let i = 0; i < newRows.length; i++) {
        if (getReference(newRows[i]) === ref && hasKeepTag(newRows[i])) keepIndices.push(i);
      }
      const allIndices = [...new Set([...indicesToRemove, ...keepIndices])].sort((a, b) => a - b);
      for (let j = allIndices.length - 1; j >= 0; j--) newRows.splice(allIndices[j], 1);
      totalRemoved += indicesToRemove.length;
    } else if (keepRows.length) {
      const keepIndices = [];
      for (let i = 0; i < newRows.length; i++) {
        if (getReference(newRows[i]) === ref && hasKeepTag(newRows[i])) keepIndices.push(i);
      }
      insertPos = keepIndices.length ? keepIndices[0] : findInsertPosition(newRows, refSortKey[0], refSortKey[1]);
      for (let j = keepIndices.length - 1; j >= 0; j--) newRows.splice(keepIndices[j], 1);
    } else {
      insertPos = findInsertPosition(newRows, refSortKey[0], refSortKey[1]);
      log.push(`  ${ref}: inserting ${dedupedSource.length} new rows at position ${insertPos}`);
    }

    const merged = [...dedupedSource, ...keepRows];
    if (ultVerses && Object.keys(ultVerses).length && keepRows.length) {
      merged.sort((a, b) => {
        const ka = ultPositionKey(a, ultVerses);
        const kb = ultPositionKey(b, ultVerses);
        return ka[0] !== kb[0] ? ka[0] - kb[0] : ka[1] - kb[1];
      });
    }

    if (keepRows.length) {
      log.push(`  ${ref}: preserved ${keepRows.length} KEEP-tagged row(s)`);
      totalKept += keepRows.length;
    }

    for (let i = 0; i < merged.length; i++) {
      newRows.splice(insertPos + i, 0, merged[i]);
    }
    totalAdded += merged.length;
  }

  if (totalKept) log.push(`\n  Total KEEP rows preserved: ${totalKept}`);
  return [newRows, totalRemoved, totalAdded];
}

// --- Full-chapter replacement ---

function doFullChapter(bookRows, sourceRows, chapter, skipIntro, ultVerses, log) {
  const newRows = [...bookRows];

  const sourceRefs = new Set();
  for (const row of sourceRows) {
    const ref = getReference(row);
    if (getChapter(ref) === chapter) sourceRefs.add(ref);
  }

  // Anchor verses covered by the source — used to detect orphaned multi-verse rows
  // when the generator narrowed a range reference (e.g. 18:9-10 → 18:9).
  const sourceAnchors = new Set();
  for (const ref of sourceRefs) sourceAnchors.add(anchorVerse(ref));

  const [chapterStart, chapterEnd] = findChapterBounds(newRows, chapter);

  // Collect existing intro rows
  const existingIntroRows = [];
  if (chapterStart !== null) {
    for (let i = chapterStart; i < chapterEnd; i++) {
      const ref = getReference(newRows[i]);
      if (isIntroRef(ref) && getChapter(ref) === chapter) {
        existingIntroRows.push(newRows[i]);
      }
    }
  }

  const sourceHasIntro = sourceRows.some(row => {
    const ref = getReference(row);
    return isIntroRef(ref) && getChapter(ref) === chapter;
  });

  // Determine which intro rows to preserve
  let preserveIntro = [];
  if (skipIntro && existingIntroRows.length) {
    preserveIntro = existingIntroRows;
  } else if (!sourceHasIntro && existingIntroRows.length) {
    preserveIntro = existingIntroRows;
  }

  // Filter source rows
  let filteredSource = sourceRows;
  if (preserveIntro.length) {
    filteredSource = sourceRows.filter(row => {
      const ref = getReference(row);
      return !(isIntroRef(ref) && getChapter(ref) === chapter);
    });
  }

  // KEEP tag extraction
  const keepRows = [];
  if (chapterStart !== null) {
    for (let i = chapterStart; i < chapterEnd; i++) {
      const ref = getReference(newRows[i]);
      if (sourceRefs.has(ref) && hasKeepTag(newRows[i]) && !isIntroRef(ref)) {
        keepRows.push(newRows[i]);
      }
    }
  }

  // Deduplicate source against KEEP rows
  let dedupCount = 0;
  if (keepRows.length) {
    const keepKeys = new Set();
    for (const row of keepRows) {
      const sref = getSupportReference(row);
      if (sref) keepKeys.add(`${getReference(row)}\t${sref}`);
    }
    if (keepKeys.size) {
      const before = filteredSource.length;
      filteredSource = filteredSource.filter(row =>
        !keepKeys.has(`${getReference(row)}\t${getSupportReference(row)}`)
      );
      dedupCount = before - filteredSource.length;
    }
  }

  // Identify rows to remove and rows to preserve
  let totalRemoved = 0;
  const preservedRows = [];
  let insertPos;

  if (chapterStart !== null) {
    const indicesToRemove = [];
    for (let i = chapterStart; i < chapterEnd; i++) {
      const ref = getReference(newRows[i]);
      if (sourceRefs.has(ref)) {
        if (!hasKeepTag(newRows[i])) indicesToRemove.push(i);
      } else if (isIntroRef(ref) && sourceRefs.has(ref)) {
        // dead branch kept for clarity
        indicesToRemove.push(i);
      } else if (!isIntroRef(ref) && anchorVerse(ref) !== ref && sourceAnchors.has(anchorVerse(ref))) {
        // Orphaned multi-verse row: the source replaced this reference with a narrower
        // single-verse reference (e.g. existing 18:9-10 → source 18:9).  Remove it
        // unless it is explicitly KEEP-tagged.
        if (hasKeepTag(newRows[i])) {
          preservedRows.push(newRows[i]);
        } else {
          indicesToRemove.push(i);
          log.push(`  ${ref}: orphaned multi-verse row (anchor ${anchorVerse(ref)} covered by source)`);
        }
      } else {
        if (!(isIntroRef(ref) && ref.split(':')[1] === 'intro')) {
          preservedRows.push(newRows[i]);
        }
      }
    }

    const introRemoved = [];
    if (!preserveIntro.length) {
      for (let i = chapterStart; i < chapterEnd; i++) {
        const ref = getReference(newRows[i]);
        if (isIntroRef(ref) && getChapter(ref) === chapter) {
          if (!indicesToRemove.includes(i)) introRemoved.push(i);
        }
      }
    }

    const allRemoveIndices = [...new Set([...indicesToRemove, ...introRemoved])].sort((a, b) => a - b);
    totalRemoved = allRemoveIndices.length;

    // Remove ALL chapter rows (re-insert preserved + keep + new)
    newRows.splice(chapterStart, chapterEnd - chapterStart);
    insertPos = chapterStart;

    if (preservedRows.length) {
      log.push(`  Removed ${totalRemoved} existing rows for verses in source`);
      log.push(`  Preserving ${preservedRows.length} existing rows for verses not in source`);
    } else {
      log.push(`  Removed ${totalRemoved} existing rows for chapter ${chapter}`);
    }
  } else {
    insertPos = findChapterInsertPosition(newRows, chapter);
    log.push(`  Chapter ${chapter} not found in book file; inserting at position ${insertPos}`);
  }

  if (keepRows.length) {
    log.push(`  Preserved ${keepRows.length} KEEP-tagged row(s)`);
  }
  if (dedupCount) {
    log.push(`  Deduplicated ${dedupCount} source row(s) against KEEP notes`);
  }

  // Defensive: normalize any intro rows to canonical 7-col shape before merge.
  // Fixes column drift (e.g. id="intro") on preserved upstream rows and
  // missing/blank Reference that would otherwise sort intros to the end.
  const chapterIds = new Set();
  for (const row of [...bookRows, ...sourceRows]) {
    const cols = row.split('\t');
    const id = (cols[1] || '').trim();
    if (INTRO_ID_RE.test(id)) chapterIds.add(id);
  }
  const normalizeIntros = (rows) => rows.map(row => {
    const cols = row.split('\t');
    const ref = (cols[0] || '').trim();
    const id = (cols[1] || '').trim();
    // Only normalize intros, and only when they are not already canonical.
    if (!isIntroRef(ref) && id !== 'intro') return row;
    if (INTRO_REF_RE.test(ref) && INTRO_ID_RE.test(id) && cols.length === 7) return row;
    return normalizeIntroRow(row, {
      chapter,
      existingIds: chapterIds,
      warn: (msg) => log.push(`  WARNING: ${msg}`),
    });
  });
  const normalizedPreserveIntro = normalizeIntros(preserveIntro);
  const filteredSourceNormalized = normalizeIntros(filteredSource);

  // Build combined rows
  const combined = [...normalizedPreserveIntro, ...filteredSourceNormalized, ...keepRows, ...preservedRows];

  // Sort by reference with optional ULT ordering
  if (ultVerses && Object.keys(ultVerses).length) {
    combined.sort((a, b) => {
      const refCmp = refCompare(a, b);
      if (refCmp !== 0) return refCmp;
      const ka = ultPositionKey(a, ultVerses);
      const kb = ultPositionKey(b, ultVerses);
      return ka[0] !== kb[0] ? ka[0] - kb[0] : ka[1] - kb[1];
    });
  } else {
    combined.sort(refCompare);
  }

  const totalAdded = combined.length;

  if (preserveIntro.length) {
    log.push(`  Preserved ${preserveIntro.length} existing intro row(s)`);
  }

  // Insert
  newRows.splice(insertPos, 0, ...combined);
  log.push(`  Inserted ${totalAdded} rows for chapter ${chapter}`);

  return [newRows, totalRemoved, totalAdded];
}

/**
 * Insert TN rows into a book file.
 * @param {object} opts
 * @param {string} opts.bookFile - Path to full book TN TSV
 * @param {string} opts.sourceFile - Path to source TSV with replacement rows
 * @param {number} opts.chapter - Chapter number
 * @param {boolean} [opts.skipIntro=false] - Preserve existing intro
 * @param {string} [opts.ultFile] - Path to English ULT USFM for KEEP ordering
 * @param {boolean} [opts.backup=false] - Create .bak backup
 * @returns {string} Log output
 */
function insertTnRows({ bookFile, sourceFile, chapter, skipIntro = false, ultFile, backup = false }) {
  const log = [];
  const lineEnding = detectLineEnding(bookFile);

  const [bookHeader, bookRows] = readTsv(bookFile);
  const [, sourceRows] = readTsv(sourceFile);

  if (bookHeader === null) throw new Error('Book file is empty');
  if (!sourceRows.length) throw new Error('Source file has no data rows');

  // Parse ULT verses for intra-verse ordering
  let ultVerses = {};
  if (ultFile) {
    try {
      ultVerses = parseUltVerses(ultFile, chapter);
      if (Object.keys(ultVerses).length) {
        log.push(`Loaded ULT verse text for ${Object.keys(ultVerses).length} verses (intra-verse ordering enabled)`);
      }
    } catch (e) {
      log.push(`WARNING: Could not parse ULT file: ${e.message}`);
    }
  }

  log.push(`Mode: verse-aware chapter replacement (chapter ${chapter})`);
  log.push(`Source rows: ${sourceRows.length}`);
  if (skipIntro) log.push('Preserving existing intro row (--skip-intro)');

  const [newRows, totalRemoved, totalAdded] = doFullChapter(
    bookRows, sourceRows, chapter, skipIntro, ultVerses, log
  );

  log.push('');
  log.push(`Summary: removed ${totalRemoved} rows, added ${totalAdded} rows`);
  log.push(`Book rows: ${bookRows.length} -> ${newRows.length}`);

  // Backup
  if (backup) {
    const backupPath = bookFile + '.bak';
    fs.copyFileSync(bookFile, backupPath);
    log.push(`Backup saved to ${backupPath}`);
  }

  // Write
  const allLines = [bookHeader, ...newRows];
  let finalContent = allLines.join('\n') + '\n';
  if (lineEnding === '\r\n') finalContent = finalContent.replace(/\n/g, '\r\n');

  fs.writeFileSync(bookFile, finalContent, { encoding: 'utf8' });
  log.push(`Successfully updated ${bookFile}`);

  return log.join('\n');
}

module.exports = { insertTnRows, normalizeIntroRow, INTRO_ID_RE, INTRO_REF_RE };
