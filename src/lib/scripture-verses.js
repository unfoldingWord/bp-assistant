// scripture-verses.js — fetch source/target Bible text for the verses a row
// set covers, for injection into translate batch context packs.
//
// Fetches the four USFM books (source ULT/UST, target literal/simplified) and
// builds per-verse plain-text maps keyed "chapter:verse". Target repos that
// don't exist yet (404 or fetch failure) degrade to "absent" — this must
// never fail the run.

'use strict';

const { fetchResourceFile } = require('./translate-core');
const { extractChapterVerse, stripMarkup, BOOK_NUMBERS } = require('../api-runner/verse-data');
const { refChapter, refVerseRange } = require('./tn-tsv');

const MAX_ROW_VERSE_SPAN = 10;
const MAX_TOTAL_VERSES = 80;

/** Ordered, de-duplicated list of {chapter, verse} covered by a row set. */
function collectVerseRefs(rows) {
  const refs = [];
  const seen = new Set();
  for (const row of rows) {
    const chapter = refChapter(row.Reference);
    if (chapter === 'front' || typeof chapter !== 'number') continue;
    const range = refVerseRange(row.Reference);
    if (!range) continue;
    const end = Math.min(range.end, range.start + MAX_ROW_VERSE_SPAN - 1);
    for (let verse = range.start; verse <= end; verse++) {
      const key = `${chapter}:${verse}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push({ chapter, verse });
    }
  }
  return refs.length > MAX_TOTAL_VERSES ? refs.slice(0, MAX_TOTAL_VERSES) : refs;
}

/** Parse "org/repo@ref" and return just the repo (or the raw string if unparseable). */
function repoOf(ref) {
  const m = /^([^/@\s]+)\/([^/@\s]+)@(.+)$/.exec(String(ref || '').trim());
  return m ? m[2] : ref;
}

/** Fetch USFM for a ref; returns null if the ref is falsy, 404s, or the fetch throws. */
async function fetchUsfm(ref, book, { fetchImpl } = {}) {
  if (!ref) return null;
  try {
    return await fetchResourceFile(ref, `${BOOK_NUMBERS[book.toUpperCase()]}-${book.toUpperCase()}.usfm`, { fetchImpl });
  } catch (e) {
    return null;
  }
}

/** Build {chapter:verse -> text} for the given refs from one USFM book. */
function buildByRef(usfm, refs) {
  const byRef = {};
  for (const { chapter, verse } of refs) {
    const raw = extractChapterVerse(usfm, chapter, verse);
    const text = stripMarkup(raw || '');
    if (text) byRef[`${chapter}:${verse}`] = text;
  }
  return byRef;
}

/**
 * Fetch source (ULT/UST) and target (literal/simplified) scripture text for
 * the verses a row set covers. Never throws — target (and source, degraded)
 * fetch failures just mark that version absent.
 */
async function buildScripturePack({ book, rows, sourceLiteralRef, sourceSimplifiedRef, targetLiteralRef, targetSimplifiedRef }, { fetchImpl } = {}) {
  const refs = collectVerseRefs(rows);

  const [sourceLiteralUsfm, sourceSimplifiedUsfm, targetLiteralUsfm, targetSimplifiedUsfm] = await Promise.all([
    fetchUsfm(sourceLiteralRef, book, { fetchImpl }),
    fetchUsfm(sourceSimplifiedRef, book, { fetchImpl }),
    fetchUsfm(targetLiteralRef, book, { fetchImpl }),
    fetchUsfm(targetSimplifiedRef, book, { fetchImpl }),
  ]);

  const versions = [];
  if (sourceLiteralUsfm) {
    versions.push({ role: 'source-literal', label: 'Source literal (ULT)', byRef: buildByRef(sourceLiteralUsfm, refs) });
  }
  if (sourceSimplifiedUsfm) {
    versions.push({ role: 'source-simplified', label: 'Source simplified (UST)', byRef: buildByRef(sourceSimplifiedUsfm, refs) });
  }
  const targetLiteralFound = !!targetLiteralUsfm;
  if (targetLiteralFound) {
    versions.push({
      role: 'target-literal',
      label: `Target literal (${repoOf(targetLiteralRef)})`,
      byRef: buildByRef(targetLiteralUsfm, refs),
    });
  }
  const targetSimplifiedFound = !!targetSimplifiedUsfm;
  if (targetSimplifiedFound) {
    versions.push({
      role: 'target-simplified',
      label: `Target simplified (${repoOf(targetSimplifiedRef)})`,
      byRef: buildByRef(targetSimplifiedUsfm, refs),
    });
  }

  return { versions, targetLiteralFound, targetSimplifiedFound };
}

module.exports = { buildScripturePack };
