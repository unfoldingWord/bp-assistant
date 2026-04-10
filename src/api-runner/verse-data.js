// verse-data.js — Bible translation data tools (verse data, existing notes, templates)
// Extracted from app/src/mcp-server.js for direct use in the API runner.

const http = require('http');
const https = require('https');
const fs = require('fs');

const DOOR43_BASE = 'https://git.door43.org/unfoldingWord';

// ---------------------------------------------------------------------------
// Book number map
// ---------------------------------------------------------------------------

const BOOK_NUMBERS = {
  GEN: '01', EXO: '02', LEV: '03', NUM: '04', DEU: '05',
  JOS: '06', JDG: '07', RUT: '08', '1SA': '09', '2SA': '10',
  '1KI': '11', '2KI': '12', '1CH': '13', '2CH': '14', EZR: '15',
  NEH: '16', EST: '17', JOB: '18', PSA: '19', PRO: '20',
  ECC: '21', SNG: '22', ISA: '23', JER: '24', LAM: '25',
  EZK: '26', DAN: '27', HOS: '28', JOL: '29', AMO: '30',
  OBA: '31', JON: '32', MIC: '33', NAM: '34', HAB: '35',
  ZEP: '36', HAG: '37', ZEC: '38', MAL: '39',
  MAT: '41', MRK: '42', LUK: '43', JHN: '44', ACT: '45',
  ROM: '46', '1CO': '47', '2CO': '48', GAL: '49', EPH: '50',
  PHP: '51', COL: '52', '1TH': '53', '2TH': '54', '1TI': '55',
  '2TI': '56', TIT: '57', PHM: '58', HEB: '59', JAS: '60',
  '1PE': '61', '2PE': '62', '1JN': '63', '2JN': '64', '3JN': '65',
  JUD: '66', REV: '67',
};

// ---------------------------------------------------------------------------
// In-memory cache (loaded once per process lifetime)
// ---------------------------------------------------------------------------

const cache = {
  validIssues: null,   // Set<string>
  templates: null,     // Map<string, Array<{type, template}>>
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const makeRequest = (targetUrl, redirectCount) => {
      if (redirectCount > 5) return reject(new Error('Too many redirects'));
      const mod = targetUrl.startsWith('https') ? https : http;
      mod.get(targetUrl, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          makeRequest(res.headers.location, redirectCount + 1);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${targetUrl}`));
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve(data));
        res.on('error', reject);
      }).on('error', reject);
    };
    makeRequest(url, 0);
  });
}

function parseCSV(text) {
  const lines = text.split('\n').filter(l => l.trim() && !l.startsWith('#'));
  return lines.map(line => {
    const row = [];
    let field = '';
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuote && line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuote = !inQuote;
        }
      } else if (ch === ',' && !inQuote) {
        row.push(field);
        field = '';
      } else {
        field += ch;
      }
    }
    row.push(field);
    return row;
  });
}

function extractChapterVerse(usfm, chapter, verse) {
  const chapterRe = new RegExp(`\\\\c ${chapter}(?:\\D|$)`);
  const chapterMatch = chapterRe.exec(usfm);
  if (!chapterMatch) return null;
  const chapterStart = chapterMatch.index;

  const nextChapterRe = new RegExp(`\\\\c ${chapter + 1}(?:\\D|$)`);
  const nextChapterMatch = nextChapterRe.exec(usfm.slice(chapterStart + 1));
  const chapterContent = nextChapterMatch
    ? usfm.slice(chapterStart, chapterStart + 1 + nextChapterMatch.index)
    : usfm.slice(chapterStart);

  const verseRe = new RegExp(`\\\\v ${verse}(?:\\D|$)`);
  const verseMatch = verseRe.exec(chapterContent);
  if (!verseMatch) return null;
  const contentStart = verseMatch.index + verseMatch[0].length;

  const nextVerseIdx = chapterContent.slice(contentStart).search(/\\v \d/);
  const verseContent = nextVerseIdx !== -1
    ? chapterContent.slice(contentStart, contentStart + nextVerseIdx)
    : chapterContent.slice(contentStart);

  return verseContent.trim();
}

function parseAlignment(verseUsfm) {
  const alignments = [];
  let pos = 0;
  const text = verseUsfm;

  while (pos < text.length) {
    const zalnStart = text.indexOf('\\zaln-s', pos);
    if (zalnStart === -1) break;

    const tagClose = text.indexOf('\\*', zalnStart);
    if (tagClose === -1) break;

    const tagText = text.slice(zalnStart, tagClose);
    const contentMatch = tagText.match(/x-content="([^"]+)"/);
    const hebrew = contentMatch ? contentMatch[1] : null;

    const zalnEnd = text.indexOf('\\zaln-e\\*', tagClose);
    if (zalnEnd === -1) break;

    const block = text.slice(tagClose + 2, zalnEnd);
    const wordPattern = /\\w ([^|\\]+?)(?:\|[^\\]*)?\\w\*/g;
    const words = [];
    let wMatch;
    while ((wMatch = wordPattern.exec(block)) !== null) {
      words.push(wMatch[1].trim());
    }

    if (hebrew && words.length > 0) {
      alignments.push({ english: words.join(' '), hebrew });
    }

    pos = zalnEnd + 9;
  }

  return alignments;
}

function stripMarkup(verseUsfm) {
  const wordPattern = /\\w ([^|\\]+?)(?:\|[^\\]*)?\\w\*/g;
  const words = [];
  let match;
  while ((match = wordPattern.exec(verseUsfm)) !== null) {
    words.push(match[1].trim());
  }
  if (words.length > 0) return words.join(' ');

  return verseUsfm
    .replace(/\\[a-z-]+\*?\s*/g, '')
    .replace(/\|[^\s\\]*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// CSV cache loader
// ---------------------------------------------------------------------------

function loadCache() {
  if (cache.validIssues && cache.templates) return;

  // Try Docker path first, then host path
  const paths = ['/workspace/data', '/srv/bot/workspace/data'];
  let dataDir;
  for (const p of paths) {
    if (fs.existsSync(p)) { dataDir = p; break; }
  }
  if (!dataDir) {
    throw new Error('Cannot find workspace/data directory for translation-issues.csv and templates.csv');
  }

  const issuesPath = `${dataDir}/translation-issues.csv`;
  const templatesPath = `${dataDir}/templates.csv`;

  const issuesText = fs.readFileSync(issuesPath, 'utf8');
  const issueRows = parseCSV(issuesText);
  cache.validIssues = new Set(
    issueRows.slice(1).map(r => r[0]).filter(Boolean)
  );

  const templatesText = fs.readFileSync(templatesPath, 'utf8');
  const templateRows = parseCSV(templatesText);
  cache.templates = new Map();
  for (const row of templateRows.slice(1)) {
    if (!row[0] || !row[2]) continue;
    const issueType = row[0].trim();
    const type = row[1] ? row[1].trim() : 'generic';
    const template = row[2].trim();
    if (!cache.templates.has(issueType)) {
      cache.templates.set(issueType, []);
    }
    cache.templates.get(issueType).push({ type, template });
  }
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

async function getVerseData({ book, chapter, verse }) {
  const bookUpper = book.toUpperCase();
  const num = BOOK_NUMBERS[bookUpper];
  if (!num) throw new Error(`Unknown book: ${book}`);

  const filename = `${num}-${bookUpper}.usfm`;
  const [ultUsfm, ustUsfm] = await Promise.all([
    fetchText(`${DOOR43_BASE}/en_ult/raw/branch/master/${filename}`),
    fetchText(`${DOOR43_BASE}/en_ust/raw/branch/master/${filename}`),
  ]);

  const ultVerse = extractChapterVerse(ultUsfm, chapter, verse);
  if (!ultVerse) throw new Error(`Verse ${book} ${chapter}:${verse} not found in ULT`);

  const ustVerse = extractChapterVerse(ustUsfm, chapter, verse);

  return {
    ult: stripMarkup(ultVerse),
    ust: ustVerse ? stripMarkup(ustVerse) : '',
    alignment: parseAlignment(ultVerse),
  };
}

async function getExistingNotes({ book, chapter }) {
  const bookUpper = book.toUpperCase();
  const tsv = await fetchText(`${DOOR43_BASE}/en_tn/raw/branch/master/tn_${bookUpper}.tsv`);

  const prefix = `${chapter}:`;
  const notes = [];

  for (const line of tsv.split('\n')) {
    if (!line.trim()) continue;
    const cols = line.split('\t');
    if (cols.length < 7) continue;
    const ref = cols[0];
    if (!ref.startsWith(prefix)) continue;
    notes.push({
      reference: ref,
      id: cols[1] || '',
      support_reference: cols[3] || '',
      quote: cols[4] || '',
      note: cols[cols.length - 1] || '',
    });
  }

  return notes;
}

function getTemplate({ issue_type }) {
  loadCache();

  const issueKey = issue_type.trim().toLowerCase();

  let matchedKey = null;
  for (const key of cache.validIssues) {
    if (key.toLowerCase() === issueKey) {
      matchedKey = key;
      break;
    }
  }

  if (!matchedKey) {
    return {
      error: `Unknown issue type '${issue_type}'. Valid types are fetched from the issues sheet.`,
      issues_sheet: 'https://docs.google.com/spreadsheets/d/1fyD4dCcrJB3UWXk-VPeoiFTh4wPc_BEuOy6PxylYv5Y/',
    };
  }

  const templates = cache.templates.get(matchedKey) || [];
  return {
    issue_type: matchedKey,
    templates,
  };
}

// ---------------------------------------------------------------------------
// Tool schemas (for registration in tools.js)
// ---------------------------------------------------------------------------

const VERSE_DATA_TOOL_SCHEMAS = [
  {
    name: 'get_verse_data',
    description: 'Fetch ULT and UST text for a verse, plus Hebrew-English alignment map from Door43.',
    parameters: {
      type: 'object',
      properties: {
        book: { type: 'string', description: '3-letter book code, e.g. "HAB"' },
        chapter: { type: 'number', description: 'Chapter number' },
        verse: { type: 'number', description: 'Verse number' },
      },
      required: ['book', 'chapter', 'verse'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_existing_notes',
    description: 'Fetch published translation notes for a chapter from Door43.',
    parameters: {
      type: 'object',
      properties: {
        book: { type: 'string', description: '3-letter book code, e.g. "HAB"' },
        chapter: { type: 'number', description: 'Chapter number' },
      },
      required: ['book', 'chapter'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_template',
    description: 'Validate an issue type and return its note template(s). Returns error for unknown types.',
    parameters: {
      type: 'object',
      properties: {
        issue_type: { type: 'string', description: 'Issue type, e.g. "figs-metaphor"' },
      },
      required: ['issue_type'],
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

async function executeVerseDataTool(name, params) {
  switch (name) {
    case 'get_verse_data': {
      const result = await getVerseData(params);
      return JSON.stringify(result, null, 2);
    }
    case 'get_existing_notes': {
      const notes = await getExistingNotes(params);
      return JSON.stringify(notes, null, 2);
    }
    case 'get_template': {
      const result = getTemplate(params);
      return JSON.stringify(result, null, 2);
    }
    default:
      return `Error: Unknown verse data tool "${name}"`;
  }
}

function isVerseDataTool(name) {
  return VERSE_DATA_TOOL_SCHEMAS.some(s => s.name === name);
}

module.exports = {
  VERSE_DATA_TOOL_SCHEMAS,
  executeVerseDataTool,
  isVerseDataTool,
};
