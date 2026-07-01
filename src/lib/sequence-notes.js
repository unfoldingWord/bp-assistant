const fs = require('fs');
const path = require('path');

function normalizeHebrew(text) {
  if (!text) return '';
  return text
    .normalize('NFD')
    .replace(/[\u0591-\u05BD\u05BF\u05C1-\u05C2\u05C4-\u05C5\u05C7]/g, '')
    .replace(/[\u2060\u200d\ufeff]/g, '')
    .replace(/[\u05be\u2060]/g, '')
    .normalize('NFC')
    .trim();
}

function buildAlignmentMap(usfmPath) {
  const usfm = fs.readFileSync(usfmPath, 'utf8');
  const verseMap = {};

  let chapter = null;
  let verse = null;
  let englishPosition = 0;
  let pendingHebrew = [];

  const tokenPattern = /\\c\s+(\d+)|\\v\s+(\d+)|\\zaln-s\b.*?x-content="([^"]+)"|\\w\s+([^|\\]+?)\|/gs;
  let match;
  while ((match = tokenPattern.exec(usfm)) !== null) {
    const [, chap, vrs, hebrew, english] = match;

    if (chap) {
      chapter = chap;
      continue;
    }

    if (vrs) {
      verse = `${chapter}:${vrs}`;
      if (!verseMap[verse]) verseMap[verse] = [];
      englishPosition = 0;
      pendingHebrew = [];
      continue;
    }

    if (hebrew) {
      pendingHebrew.push(normalizeHebrew(hebrew));
      continue;
    }

    if (english) {
      englishPosition += 1;
      if (verse && pendingHebrew.length) {
        for (const hw of pendingHebrew) {
          verseMap[verse].push([hw, englishPosition]);
        }
        pendingHebrew = [];
      }
    }
  }

  return verseMap;
}

function quotePosition(quote, verseAlignments) {
  const quoteParts = String(quote || '').split('&').map((part) => part.trim());
  const hebrewSequence = verseAlignments.map(([hebrew]) => hebrew);
  const englishPositions = verseAlignments.map(([, position]) => position);

  const positions = [];
  let totalWords = 0;

  for (const part of quoteParts) {
    const words = part
      .split(/\s+/)
      .map((word) => normalizeHebrew(word))
      .filter(Boolean);

    totalWords += words.length;
    if (!words.length) continue;

    let found = false;
    for (let i = 0; i <= hebrewSequence.length - words.length; i++) {
      let matches = true;
      for (let j = 0; j < words.length; j++) {
        if (hebrewSequence[i + j] !== words[j]) {
          matches = false;
          break;
        }
      }
      if (matches) {
        positions.push(englishPositions[i]);
        found = true;
        break;
      }
    }

    if (!found) {
      const firstWord = words[0];
      for (let i = 0; i < hebrewSequence.length; i++) {
        if (hebrewSequence[i] === firstWord) {
          positions.push(englishPositions[i]);
          break;
        }
      }
    }
  }

  if (!positions.length) return [null, totalWords];
  return [Math.min(...positions), totalWords];
}

function getQuote(row) {
  const cols = Array.isArray(row) ? row : String(row || '').split('\t');
  return (cols[4] || '').trim();
}

function getSequenceSortKey(row, verseMap) {
  const cols = Array.isArray(row) ? row : String(row || '').split('\t');
  const reference = cols[0] || '';
  const verseAlignments = verseMap[reference] || [];
  const [position, quoteLength] = quotePosition(getQuote(cols), verseAlignments);
  if (position == null) return [Infinity, 0];
  return [position, -quoteLength];
}

function sortRowsBySequence(rows, verseMap) {
  const grouped = new Map();
  rows.forEach((row, index) => {
    const cols = Array.isArray(row) ? row : String(row || '').split('\t');
    const reference = cols[0] || '';
    if (!grouped.has(reference)) grouped.set(reference, []);
    grouped.get(reference).push({ row, index });
  });

  const sortedRows = [];
  for (const verseNotes of grouped.values()) {
    const decorated = verseNotes.map((note, noteIndex) => ({
      row: note.row,
      sortKey: [...getSequenceSortKey(note.row, verseMap), noteIndex],
    }));

    decorated.sort((a, b) => {
      for (let i = 0; i < a.sortKey.length; i++) {
        if (a.sortKey[i] !== b.sortKey[i]) return a.sortKey[i] - b.sortKey[i];
      }
      return 0;
    });

    sortedRows.push(...decorated.map(({ row }) => row));
  }

  return sortedRows;
}

function parseTsvLine(line) {
  const cells = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === '\t' && !inQuotes) {
      cells.push(cell);
      cell = '';
    } else {
      cell += ch;
    }
  }

  cells.push(cell);
  return cells;
}

function escapeTsvCell(cell) {
  const value = cell == null ? '' : String(cell);
  if (!/["\t\r\n]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

function writeTsvAtomic(tsvFile, rows) {
  const dirName = path.dirname(tsvFile);
  const tempPath = path.join(dirName, `.sequence-notes-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  const content = rows.map((row) => row.map(escapeTsvCell).join('\t')).join('\n') + '\n';
  fs.writeFileSync(tempPath, content, 'utf8');
  if (fs.existsSync(tsvFile)) {
    fs.renameSync(tsvFile, `${tsvFile}.old`);
  }
  fs.renameSync(tempPath, tsvFile);
}

function sequenceNotes(ultUsfm, notesTsv) {
  const verseMap = buildAlignmentMap(ultUsfm);
  const content = fs.readFileSync(notesTsv, 'utf8');
  const lines = content.split(/\r?\n/).filter((line) => line.length);
  if (!lines.length) throw new Error('Notes TSV is empty');

  const header = parseTsvLine(lines[0]);
  const rows = lines.slice(1).map(parseTsvLine);
  const sortedRows = sortRowsBySequence(rows, verseMap);
  writeTsvAtomic(notesTsv, [header, ...sortedRows]);
}

module.exports = {
  buildAlignmentMap,
  getSequenceSortKey,
  normalizeHebrew,
  quotePosition,
  sequenceNotes,
  sortRowsBySequence,
};
