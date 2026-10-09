// insert-tn-rows.js — Node.js port of insert_tn_rows.py
//
// Replace translation note rows in a book-level TSV file with verse-aware
// chapter replacement, KEEP-tag support, and ULT-based intra-verse ordering.

const fs = require('fs');
const { buildAlignmentMap, getSequenceSortKey } = require('./sequence-notes');
const { normalizeQuote } = require('./quote-normalize');
const { keptRefVerseSpan } = require('./kept-notes');

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

// A row survives an AI run when it is KEEP-tagged or its ID (column 2) is in
// keptIds — the editor's export blanks Tags, so it sends kept IDs instead.
function isKeptRow(row, keptIds) {
  if (hasKeepTag(row)) return true;
  return !!keptIds && keptIds.size > 0 && keptIds.has(row.split('\t')[1]);
}

// Dedup keys for source rows against kept rows. A KEEP-tagged row claims its
// (Reference, SupportReference); an editor-kept row claims only the same
// (Reference, SupportReference, Quote), so a new note on a different phrase in
// that verse still lands. Quotes compare through normalizeQuote. This key stays
// exact even though the prepared-notes pass also drops overlapping quotes
// (#446): here it guards which en_tn rows a push deletes, not which notes get
// written, so it must not widen.
function getQuote(row) {
  const parts = row.split('\t');
  return parts.length > 4 ? normalizeQuote(parts[4]) : '';
}

function keptDedupKey(row) {
  return `${getReference(row)}\t${getSupportReference(row)}`;
}

// Editor-kept key tail: support reference without its rc:// prefix (as the
// prepared-notes pass compares it) plus the normalized quote. A leading "K"
// keeps these keys apart from the KEEP-tag (ref, sref) keys.
function keptTail(row) {
  const sref = getSupportReference(row).trim().replace(/^rc:\/\/[^/]+\/ta\/man\/translate\//, '');
  return `\tK\t${sref}\t${getQuote(row)}`;
}

function buildKeepKeys(keepRows) {
  const keys = new Set();
  for (const row of keepRows) {
    if (hasKeepTag(row)) {
      if (getSupportReference(row)) keys.add(keptDedupKey(row));
    } else {
      // Claim every verse the kept row covers, so a single-verse AI row inside
      // a kept 40:12-14 range is still caught.
      const ref = getReference(row);
      const tail = keptTail(row);
      keys.add(`${ref}${tail}`);
      // A cross-chapter "40:48-42:2" covers verses in every chapter it spans.
      const m = ref.match(/^(\d+):\d+-(\d+):\d+$/);
      const first = m ? Number(m[1]) : getChapter(ref);
      const last = m ? Math.min(Number(m[2]), 200) : first;
      for (let ch = first; ch <= last; ch++) {
        const span = keptRefVerseSpan(ref, ch);
        if (span) for (let v = span.lo; v <= span.hi && v - span.lo < 200; v++) keys.add(`${ch}:${v}${tail}`);
      }
    }
  }
  return keys;
}

function isClaimedByKeep(row, keepKeys) {
  return keepKeys.has(keptDedupKey(row)) || keepKeys.has(`${getReference(row)}${keptTail(row)}`);
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

// --- ULT alignment sequencing ---

function compareSequenceKeys(a, b) {
  // a[0]/b[0] are always a finite position or exactly Infinity (never
  // -Infinity), so plain subtraction already yields the correct sign in
  // every case Array.prototype.sort needs — no special-casing required.
  if (a[0] !== b[0]) return a[0] - b[0];
  return a[1] - b[1];
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

function doPerReference(bookRows, sourceGroups, verseMap, log, keptIds = new Set()) {
  const newRows = [...bookRows];
  let totalRemoved = 0;
  let totalAdded = 0;
  let totalKept = 0;
  // Editor-kept rows claim their verse span wherever they sit, so a kept
  // 40:12-14 row also blocks a duplicate at 40:13.
  const keptElsewhereKeys = buildKeepKeys(bookRows.filter((row) => !hasKeepTag(row) && isKeptRow(row, keptIds)));

  for (const [ref, newRefRows] of sourceGroups) {
    const refSortKey = parseReference(ref);
    const indicesToRemove = [];
    const keepRows = [];

    for (let i = 0; i < newRows.length; i++) {
      if (getReference(newRows[i]) === ref) {
        if (isKeptRow(newRows[i], keptIds)) keepRows.push(newRows[i]);
        else indicesToRemove.push(i);
      }
    }

    let dedupedSource = newRefRows;
    if (keepRows.length || keptElsewhereKeys.size) {
      const keepKeys = new Set([...buildKeepKeys(keepRows), ...keptElsewhereKeys]);
      if (keepKeys.size) {
        dedupedSource = newRefRows.filter(row => !isClaimedByKeep(row, keepKeys));
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
        if (getReference(newRows[i]) === ref && isKeptRow(newRows[i], keptIds)) keepIndices.push(i);
      }
      const allIndices = [...new Set([...indicesToRemove, ...keepIndices])].sort((a, b) => a - b);
      for (let j = allIndices.length - 1; j >= 0; j--) newRows.splice(allIndices[j], 1);
      totalRemoved += indicesToRemove.length;
    } else if (keepRows.length) {
      const keepIndices = [];
      for (let i = 0; i < newRows.length; i++) {
        if (getReference(newRows[i]) === ref && isKeptRow(newRows[i], keptIds)) keepIndices.push(i);
      }
      insertPos = keepIndices.length ? keepIndices[0] : findInsertPosition(newRows, refSortKey[0], refSortKey[1]);
      for (let j = keepIndices.length - 1; j >= 0; j--) newRows.splice(keepIndices[j], 1);
    } else {
      insertPos = findInsertPosition(newRows, refSortKey[0], refSortKey[1]);
      log.push(`  ${ref}: inserting ${dedupedSource.length} new rows at position ${insertPos}`);
    }

    let merged = [...dedupedSource, ...keepRows];
    if (verseMap && Object.keys(verseMap).length && keepRows.length) {
      // Decorate-sort-undecorate: compute each row's sort key once instead of
      // recomputing it on every comparator call.
      merged = merged
        .map((row) => ({ row, key: getSequenceSortKey(row, verseMap) }))
        .sort((a, b) => compareSequenceKeys(a.key, b.key))
        .map(({ row }) => row);
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

function doFullChapter(bookRows, sourceRows, chapter, skipIntro, verseMap, log, replaceChapter = false, keptIds = new Set()) {
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
  // An intro the editor kept (by ID) stays, like --skip-intro.
  const introKept = keptIds.size > 0 && existingIntroRows.some((row) => keptIds.has(row.split('\t')[1]));
  if (introKept) log.push(`Preserving existing ${chapter}:intro row (kept in the editor)`);
  if (skipIntro && existingIntroRows.length) {
    preserveIntro = existingIntroRows;
  } else if (introKept) {
    preserveIntro = existingIntroRows.filter((row) => keptIds.has(row.split('\t')[1]));
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
      if (sourceRefs.has(ref) && isKeptRow(newRows[i], keptIds) && !isIntroRef(ref)) {
        keepRows.push(newRows[i]);
      }
    }
  }

  // Deduplicate source against KEEP rows. Editor-kept rows anywhere in the
  // chapter claim their whole verse span (a kept 40:12-14 blocks 40:13).
  const dedupRows = [...keepRows];
  if (keptIds.size > 0) {
    // Whole file, not just this chapter's span: a cross-chapter kept row
    // (40:48-41:2) sits in chapter 40 but also covers 41:1-2.
    for (const row of newRows) {
      const ref = getReference(row);
      if (!sourceRefs.has(ref) && !isIntroRef(ref) && !hasKeepTag(row) && isKeptRow(row, keptIds)
        && keptRefVerseSpan(ref, chapter)) {
        dedupRows.push(row);
      }
    }
  }
  let dedupCount = 0;
  if (dedupRows.length) {
    const keepKeys = buildKeepKeys(dedupRows);
    if (keepKeys.size) {
      const before = filteredSource.length;
      filteredSource = filteredSource.filter(row => !isClaimedByKeep(row, keepKeys));
      dedupCount = before - filteredSource.length;
    }
  }

  // Identify rows to remove and rows to preserve
  let totalRemoved = 0;
  const preservedRows = [];
  const legacyRemovedRefs = [];
  let insertPos;

  if (chapterStart !== null) {
    const indicesToRemove = [];
    for (let i = chapterStart; i < chapterEnd; i++) {
      const ref = getReference(newRows[i]);
      if (sourceRefs.has(ref)) {
        if (!isKeptRow(newRows[i], keptIds)) indicesToRemove.push(i);
      } else if (isIntroRef(ref) && sourceRefs.has(ref)) {
        // dead branch kept for clarity
        indicesToRemove.push(i);
      } else if (!isIntroRef(ref) && anchorVerse(ref) !== ref && sourceAnchors.has(anchorVerse(ref))) {
        // Orphaned multi-verse row: the source replaced this reference with a narrower
        // single-verse reference (e.g. existing 18:9-10 → source 18:9).  Remove it
        // unless it is explicitly KEEP-tagged.
        if (isKeptRow(newRows[i], keptIds)) {
          preservedRows.push(newRows[i]);
        } else {
          indicesToRemove.push(i);
          log.push(`  ${ref}: orphaned multi-verse row (anchor ${anchorVerse(ref)} covered by source)`);
        }
      } else if (replaceChapter && getChapter(ref) === chapter && !isIntroRef(ref) && !isKeptRow(newRows[i], keptIds)) {
        // Whole-chapter replace: drop legacy rows in verses the source did not cover.
        // The chapter check keeps an out-of-order row from another chapter (or a
        // malformed Reference) that happens to sit inside the chapter span.
        indicesToRemove.push(i);
        legacyRemovedRefs.push(ref);
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

    if (legacyRemovedRefs.length) {
      log.push(`  Removed ${legacyRemovedRefs.length} legacy row(s) in verses not in source (whole-chapter replace): ${[...new Set(legacyRemovedRefs)].join(', ')}`);
    }
    if (preservedRows.length) {
      log.push(`  Removed ${totalRemoved - legacyRemovedRefs.length} existing rows for verses in source`);
      log.push(`  Preserving ${preservedRows.length} existing rows for verses not in source`);
      // #415: make silently kept rows visible — a source missing whole verses
      // leaves their old (possibly legacy English-quote) notes in place.
      const keptRefs = [...new Set(preservedRows.map(getReference))];
      log.push(`  Kept existing rows for: ${keptRefs.join(', ')}`);
      const nonOrigQuote = preservedRows.filter((row) => {
        const quote = (row.split('\t')[4] || '').trim();
        return /\p{L}/u.test(quote) && !/[\u0590-\u05FF\u0370-\u03FF\u1F00-\u1FFF]/.test(quote);
      });
      if (nonOrigQuote.length) {
        log.push(`  WARNING: ${nonOrigQuote.length} kept row(s) have a Quote that is not Hebrew/Greek: ${[...new Set(nonOrigQuote.map(getReference))].join(', ')}`);
      }
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
  let combined = [...normalizedPreserveIntro, ...filteredSourceNormalized, ...keepRows, ...preservedRows];

  // Sort by reference with optional ULT alignment ordering
  if (verseMap && Object.keys(verseMap).length) {
    // Decorate-sort-undecorate: compute each row's reference/sequence keys
    // once instead of recomputing them on every comparator call.
    combined = combined
      .map((row) => ({
        row,
        refKey: parseReference(getReference(row)),
        seqKey: getSequenceSortKey(row, verseMap),
      }))
      .sort((a, b) => {
        if (a.refKey[0] !== b.refKey[0]) return a.refKey[0] - b.refKey[0];
        if (a.refKey[1] !== b.refKey[1]) return a.refKey[1] - b.refKey[1];
        return compareSequenceKeys(a.seqKey, b.seqKey);
      })
      .map(({ row }) => row);
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
 * @param {boolean} [opts.replaceChapter=false] - Whole-chapter run: also remove existing
 *   non-intro, non-KEEP rows in verses absent from the source (default keeps them, for
 *   verse-range runs). KEEP-tagged rows and intro handling are unchanged.
 * @param {Iterable<string>} [opts.keptIds] - Row IDs (column 2) to treat exactly like KEEP-tagged
 *   rows (editor-preserved notes whose Tags column is blank).
 * @returns {string} Log output
 */
function insertTnRows({ bookFile, sourceFile, chapter, skipIntro = false, ultFile, backup = false, replaceChapter = false, keptIds = [] }) {
  const log = [];
  const lineEnding = detectLineEnding(bookFile);

  const [bookHeader, bookRows] = readTsv(bookFile);
  const [, sourceRows] = readTsv(sourceFile);

  if (bookHeader === null) throw new Error('Book file is empty');
  if (!sourceRows.length) throw new Error('Source file has no data rows');

  // Parse ULT alignments for intra-verse ordering
  let verseMap = {};
  if (ultFile) {
    try {
      verseMap = buildAlignmentMap(ultFile);
      if (Object.keys(verseMap).length) {
        log.push(`Loaded ULT alignments for ${Object.keys(verseMap).length} verses (intra-verse ordering enabled)`);
      }
    } catch (e) {
      log.push(`WARNING: Could not parse ULT file: ${e.message}`);
    }
  }

  log.push(`Mode: verse-aware chapter replacement (chapter ${chapter})`);
  log.push(`Source rows: ${sourceRows.length}`);
  if (skipIntro) log.push('Preserving existing intro row (--skip-intro)');

  const [newRows, totalRemoved, totalAdded] = doFullChapter(
    bookRows, sourceRows, chapter, skipIntro, verseMap, log, replaceChapter, new Set(keptIds || [])
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
