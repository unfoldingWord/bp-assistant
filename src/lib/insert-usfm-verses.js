// insert-usfm-verses.js — Node.js port of insert_usfm_verses.py
//
// Surgically replace a verse range in a book-level USFM file.
// Strips source headers, preserves inter-verse markers, validates verse counts.

const fs = require('fs');
const path = require('path');

const HEADER_MARKERS = /^\\(id|usfm|ide|h|toc\d?|mt\d?|c)\b/;
const BOOK_LEVEL_JUNK = /^\\(id|usfm|ide|h|toc\d?|mt\d?|cl)\b/;
const INTER_VERSE_MARKERS = /^\\(d\b|ts\\\*|s\d+\s|qa\s|b\s*$)/;

function parseVerseRange(spec) {
  if (spec.includes('-')) {
    const parts = spec.split('-', 2);
    return [parseInt(parts[0], 10), parseInt(parts[1], 10)];
  }
  const v = parseInt(spec, 10);
  return [v, v];
}

function stripSourceHeader(lines) {
  const result = [];
  let foundVerse = false;
  const preVerseMarkers = [];

  for (const line of lines) {
    const stripped = line.trim();
    if (!foundVerse) {
      if (HEADER_MARKERS.test(stripped)) continue;
      if (stripped === '') continue;
      if (INTER_VERSE_MARKERS.test(stripped)) {
        preVerseMarkers.push(line);
        continue;
      }
      if (stripped.includes('\\v ')) {
        foundVerse = true;
        result.push(...preVerseMarkers);
        result.push(line);
      } else if (/^\\q\d?\s/.test(stripped) && stripped.includes('\\v ')) {
        foundVerse = true;
        result.push(...preVerseMarkers);
        result.push(line);
      }
    } else {
      result.push(line);
    }
  }

  return result.filter(line => !BOOK_LEVEL_JUNK.test(line.trim()));
}

function findChapterRange(lines, chapter) {
  const pattern = new RegExp(`^\\\\c\\s+${chapter}\\s*$`);
  let chapterLine = null;
  let chapterEnd = null;

  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i].trim())) {
      chapterLine = i;
      break;
    }
  }

  if (chapterLine === null) return [null, null];

  for (let i = chapterLine + 1; i < lines.length; i++) {
    if (/^\\c\s+\d+/.test(lines[i].trim())) {
      chapterEnd = i;
      break;
    }
  }
  if (chapterEnd === null) chapterEnd = lines.length;

  return [chapterLine + 1, chapterEnd];
}

function findVerseBoundaries(lines, startIdx, endIdx, verseStart, verseEnd) {
  let replaceStart = null;
  let replaceEnd = null;
  const nextVerse = verseEnd + 1;
  const verseStartPat = new RegExp(`\\\\v\\s+${verseStart}(?:\\s|$)`);
  const nextVersePat = new RegExp(`\\\\v\\s+${nextVerse}(?:\\s|$)`);

  for (let i = startIdx; i < endIdx; i++) {
    const line = lines[i];
    if (replaceStart === null && verseStartPat.test(line)) {
      replaceStart = i;
      while (replaceStart > startIdx) {
        const prev = lines[replaceStart - 1].trim();
        if (prev === '\\ts\\*' || prev === '\\s5'
            || /^\\s\d+\s/.test(prev)
            || /^\\(cl|d)\b/.test(prev)) {
          replaceStart--;
        } else {
          break;
        }
      }
    }
    if (replaceStart !== null && nextVersePat.test(line)) {
      replaceEnd = i;
      break;
    }
  }

  if (replaceStart !== null && replaceEnd === null) {
    replaceEnd = endIdx;
  }

  return [replaceStart, replaceEnd];
}

function countVerseMarkers(lines, startIdx, endIdx) {
  let count = 0;
  const pat = /\\v\s+\d+(?:\s|$)/g;
  for (let i = startIdx; i < endIdx; i++) {
    const matches = lines[i].match(pat);
    if (matches) count += matches.length;
  }
  return count;
}

function detectLineEnding(content) {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

/**
 * Insert USFM verses into a book file.
 * @param {object} opts
 * @param {string} opts.bookFile - Path to full book USFM
 * @param {string} opts.sourceFile - Path to source USFM with replacement verses
 * @param {number} opts.chapter - Chapter number
 * @param {string} opts.verses - Verse range (e.g. '100-104' or '5')
 * @param {boolean} [opts.backup=false] - Create .bak backup
 * @returns {string} Log output
 */
function insertUsfmVerses({ bookFile, sourceFile, chapter, verses, backup = false }) {
  const log = [];
  const [verseStart, verseEnd] = parseVerseRange(verses);

  // Read files
  const bookContent = fs.readFileSync(bookFile, 'utf8');
  const lineEnding = detectLineEnding(bookContent);
  let bookLines = bookContent.split('\n');
  let trailingNewline = false;
  if (bookLines.length && bookLines[bookLines.length - 1] === '') {
    trailingNewline = true;
    bookLines = bookLines.slice(0, -1);
  }

  const sourceContent = fs.readFileSync(sourceFile, 'utf8');
  let sourceLines = sourceContent.split('\n');
  if (sourceLines.length && sourceLines[sourceLines.length - 1] === '') {
    sourceLines = sourceLines.slice(0, -1);
  }

  // Strip source headers
  const sourceVerses = stripSourceHeader(sourceLines);
  if (!sourceVerses.length) {
    throw new Error('No verse content found in source file after stripping headers');
  }

  // Find chapter range
  const [chStart, chEnd] = findChapterRange(bookLines, chapter);
  if (chStart === null) {
    throw new Error(`Chapter ${chapter} not found in ${bookFile}`);
  }

  // Find verse boundaries
  const [vStart, vEnd] = findVerseBoundaries(bookLines, chStart, chEnd, verseStart, verseEnd);
  if (vStart === null) {
    throw new Error(`Verse ${verseStart} not found in chapter ${chapter}`);
  }

  // Pre-insertion verse count
  const preCount = countVerseMarkers(bookLines, chStart, chEnd);

  log.push(`Chapter ${chapter}, verses ${verseStart}-${verseEnd}`);
  log.push(`Replacing lines ${vStart + 1}-${vEnd} (1-indexed)`);

  // Build new file content
  const newLines = [...bookLines.slice(0, vStart), ...sourceVerses, ...bookLines.slice(vEnd)];

  // Post-insertion verse count
  const [newChStart, newChEnd] = findChapterRange(newLines, chapter);
  const postCount = countVerseMarkers(newLines, newChStart, newChEnd);

  if (preCount !== postCount) {
    log.push(`WARNING: Verse marker count changed! Before: ${preCount}, After: ${postCount}`);
  } else {
    log.push(`Verse marker count: ${postCount} (unchanged)`);
  }

  // Verify inserted verses are present
  const insertedText = sourceVerses.join('\n');
  for (let v = verseStart; v <= verseEnd; v++) {
    if (!new RegExp(`\\\\v\\s+${v}\\s`).test(insertedText)) {
      log.push(`WARNING: \\v ${v} not found in inserted content`);
    }
  }

  // Backup
  if (backup) {
    const backupPath = bookFile + '.bak';
    fs.copyFileSync(bookFile, backupPath);
    log.push(`Backup saved to ${backupPath}`);
  }

  // Write
  let finalContent = newLines.join('\n');
  if (trailingNewline) finalContent += '\n';
  if (lineEnding === '\r\n') finalContent = finalContent.replace(/\n/g, '\r\n');

  fs.writeFileSync(bookFile, finalContent, { encoding: 'utf8' });
  log.push(`Successfully replaced verses ${verseStart}-${verseEnd} in chapter ${chapter}`);

  return log.join('\n');
}

module.exports = { insertUsfmVerses };
