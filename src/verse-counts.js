// verse-counts.js — Look up verse counts from Hebrew Bible USFM files
// Used by router to calculate dynamic timeouts (per-verse × operations).

const fs = require('fs');
const path = require('path');

const HEBREW_DIR = process.env.HEBREW_DIR || '/workspace/data/hebrew_bible';
const cache = new Map();

// Map 3-letter book codes to their Hebrew Bible filenames
let fileIndex = null;
function buildFileIndex() {
  if (fileIndex) return fileIndex;
  fileIndex = {};
  try {
    const files = fs.readdirSync(HEBREW_DIR);
    for (const f of files) {
      // Files are like "19-PSA.usfm", "01-GEN.usfm"
      const m = f.match(/^\d+-(\w+)\.usfm$/);
      if (m) fileIndex[m[1].toUpperCase()] = path.join(HEBREW_DIR, f);
    }
  } catch (err) {
    console.warn(`[verse-counts] Could not read ${HEBREW_DIR}: ${err.message}`);
  }
  return fileIndex;
}

/**
 * Count \v markers in a specific chapter of a USFM file.
 * @param {string} book - 3-letter code (PSA, GEN, etc.)
 * @param {number} chapter
 * @returns {number} verse count, or 20 as default
 */
function getVerseCount(book, chapter) {
  const key = `${book.toUpperCase()}-${chapter}`;
  if (cache.has(key)) return cache.get(key);

  const index = buildFileIndex();
  const filePath = index[book.toUpperCase()];
  if (!filePath) {
    cache.set(key, 20);
    return 20;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    // Find the chapter start
    const chapterRe = new RegExp(`^\\\\c ${chapter}\\b`, 'm');
    const start = content.search(chapterRe);
    if (start === -1) {
      cache.set(key, 20);
      return 20;
    }

    // Find next chapter or end of file
    const nextChapterRe = new RegExp(`^\\\\c ${chapter + 1}\\b`, 'm');
    const nextStart = content.slice(start + 1).search(nextChapterRe);
    const chapterText = nextStart === -1
      ? content.slice(start)
      : content.slice(start, start + 1 + nextStart);

    // Count \v markers
    const verses = (chapterText.match(/^\\v \d+/gm) || []).length;
    const count = verses || 20;
    cache.set(key, count);
    return count;
  } catch (err) {
    console.warn(`[verse-counts] Error reading ${filePath}: ${err.message}`);
    cache.set(key, 20);
    return 20;
  }
}

/**
 * Get total verse count for one or more chapters.
 * @param {string} book
 * @param {number[]} chapters - array of chapter numbers
 * @returns {number}
 */
function getTotalVerses(book, chapters) {
  return chapters.reduce((sum, ch) => sum + getVerseCount(book, ch), 0);
}

module.exports = { getVerseCount, getTotalVerses };
