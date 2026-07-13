// tn-tsv.js — parse/serialize 7-column translationNotes TSV.
//
// Format facts (verified against unfoldingWord/en_tn tn_OBA.tsv, 2026-07-10):
// - Header: Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote
// - One physical line per row; newlines inside Note are the literal two-char
//   sequence "\n" (backslash + n), never a real newline. Fields never contain
//   real tabs. So a naive line/tab split is exact, not approximate.
//
// insert-tn-rows.js and quality-tools.js each carry their own line-level
// parsing tuned to the English notes-generation flow; this module is the
// row-object parser used by the translate pipeline, which needs strict
// column fidelity rather than KEEP-tag/intro-normalization behavior.

'use strict';

const TN_COLUMNS = ['Reference', 'ID', 'Tags', 'SupportReference', 'Quote', 'Occurrence', 'Note'];
const TN_HEADER = TN_COLUMNS.join('\t');

/**
 * Parse a tN TSV string. Throws on structural corruption (wrong header,
 * wrong column count) — corrupt input must never be silently repaired.
 * @returns {Array<{Reference,ID,Tags,SupportReference,Quote,Occurrence,Note}>}
 */
function parseTnTsv(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop(); // trailing newline
  if (!lines.length) throw new Error('empty TSV');
  if (lines[0] !== TN_HEADER) {
    throw new Error(`bad tN header: expected "${TN_HEADER}", got "${lines[0].slice(0, 120)}"`);
  }
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '') continue; // tolerate stray blank lines between rows
    const cells = lines[i].split('\t');
    if (cells.length !== 7) {
      throw new Error(`row ${i + 1}: expected 7 columns, got ${cells.length}`);
    }
    const row = {};
    TN_COLUMNS.forEach((c, j) => { row[c] = cells[j]; });
    rows.push(row);
  }
  return rows;
}

/** Serialize rows back to canonical tN TSV (header + LF line endings + trailing newline). */
function serializeTnTsv(rows) {
  const lines = [TN_HEADER];
  for (const row of rows) {
    lines.push(TN_COLUMNS.map((c) => row[c] ?? '').join('\t'));
  }
  return lines.join('\n') + '\n';
}

/**
 * Chapter key of a row's Reference: 'front', or the integer chapter.
 * References look like "front:intro", "1:1", "1:intro", "12:3-4".
 */
function refChapter(reference) {
  const head = String(reference).split(':')[0];
  if (head === 'front') return 'front';
  const n = Number(head);
  return Number.isInteger(n) ? n : null;
}

/**
 * Verse range of a row's Reference, or null for intro/front rows.
 * "1:1" → {start:1,end:1}; "1:5-7" → {start:5,end:7}; "1:intro"/"front:intro" → null.
 */
function refVerseRange(reference) {
  const parts = String(reference).split(':');
  if (parts.length < 2) return null;
  const m = /^(\d+)(?:\s*[-–—]\s*(\d+))?/.exec(parts[1]);
  if (!m) return null;
  const start = Number(m[1]);
  return { start, end: m[2] ? Number(m[2]) : start };
}

/**
 * Select the rows belonging to a chapter range. Book-front matter
 * (front:intro) belongs to the range only when it starts at chapter 1 —
 * translating "OBA 1" means the whole translation unit including the intro,
 * while "PSA 40-42" must not touch the book intro.
 */
function sliceChapterRows(rows, startChapter, endChapter) {
  return rows.filter((r) => {
    const ch = refChapter(r.Reference);
    if (ch === 'front') return startChapter === 1;
    return typeof ch === 'number' && ch >= startChapter && ch <= endChapter;
  });
}

module.exports = { TN_COLUMNS, TN_HEADER, parseTnTsv, serializeTnTsv, refChapter, refVerseRange, sliceChapterRows };
