// check-ult-edits.js — Mechanical diff gate for post-edit-review
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const DOOR43_BASE = 'https://git.door43.org/unfoldingWord';

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
          return reject(new Error('HTTP ' + res.statusCode + ' for ' + targetUrl));
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

function extractChapter(usfm, chapter) {
  const chStr = String(chapter);
  const startRe = new RegExp('\\\\c\\s+' + chStr + '(?:\\s|$)');
  const startMatch = startRe.exec(usfm);
  if (!startMatch) return null;

  const afterStart = usfm.slice(startMatch.index);
  const nextRe = /\\c\s+\d+/g;
  nextRe.lastIndex = startMatch[0].length;
  const nextMatch = nextRe.exec(afterStart);
  if (nextMatch) {
    return afterStart.slice(0, nextMatch.index);
  }
  return afterStart;
}

function stripAlignmentMarkers(text) {
  let result = text;
  result = result.replace(/\\zaln-s\s*\|[^*]*\*/g, '');
  result = result.replace(/\\zaln-e\\\*/g, '');
  result = result.replace(/\\w\s+([^|]+)\|[^*]*\\w\*/g, '$1');
  result = result.replace(/\\w\s+([^\\]+)\\w\*/g, '$1');
  result = result.replace(/ {2,}/g, ' ');
  result = result.replace(/ +([.,;:!?'")}])/g, '$1');
  result = result.replace(/([{('"]) +/g, '$1');
  result = result.replace(/ +\n/g, '\n');
  result = result.replace(/\n{3,}/g, '\n\n');
  return result;
}

function normalizeWhitespace(text) {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Check whether the Door43 master ULT differs from the AI-generated aligned USFM.
 *
 * @param {object} opts
 * @param {string} opts.book          - 3-letter book code (e.g. 'PSA')
 * @param {number} opts.chapter       - chapter number
 * @param {string} opts.workspaceDir  - absolute path to the workspace directory
 * @param {string} [opts.pipeDir]     - relative path to the pipeline dir (e.g. 'tmp/pipeline/PSA-036')
 * @returns {Promise<{ hasEdits: boolean, masterPath: string|null }>}
 */
async function checkUltEdits({ book, chapter, workspaceDir, pipeDir }) {
  const bookUpper = book.toUpperCase();
  const num = BOOK_NUMBERS[bookUpper];
  if (!num) throw new Error('Unknown book: ' + bookUpper);

  const filename = num + '-' + bookUpper + '.usfm';
  const url = DOOR43_BASE + '/en_ult/raw/branch/master/' + filename;
  const masterUsfm = await fetchText(url);

  const masterChapter = extractChapter(masterUsfm, chapter);
  if (!masterChapter) {
    throw new Error('Chapter ' + chapter + ' not found in Door43 master for ' + bookUpper);
  }

  const width = bookUpper === 'PSA' ? 3 : 2;
  const chPadded = String(chapter).padStart(width, '0');
  const alignedRelPath = 'output/AI-ULT/' + bookUpper + '/' + bookUpper + '-' + chPadded + '-aligned.usfm';
  const alignedAbsPath = path.resolve(workspaceDir, alignedRelPath);

  if (!fs.existsSync(alignedAbsPath)) {
    console.log('[check-ult-edits] Aligned file not found: ' + alignedRelPath + ' — skipping diff');
    return { hasEdits: false, masterPath: null };
  }

  const alignedUsfm = fs.readFileSync(alignedAbsPath, 'utf8');
  const alignedChapter = extractChapter(alignedUsfm, chapter);
  if (!alignedChapter) {
    console.log('[check-ult-edits] Chapter ' + chapter + ' not found in aligned file — skipping diff');
    return { hasEdits: false, masterPath: null };
  }

  const masterNorm = normalizeWhitespace(masterChapter);
  const alignedNorm = normalizeWhitespace(alignedChapter);
  const hasEdits = masterNorm !== alignedNorm;

  if (!hasEdits) {
    return { hasEdits: false, masterPath: null };
  }

  let masterPath = null;
  if (pipeDir) {
    const plainContent = stripAlignmentMarkers(masterChapter);
    const absDir = path.resolve(workspaceDir, pipeDir);
    fs.mkdirSync(absDir, { recursive: true });
    const plainRelPath = pipeDir + '/ult_master_plain.usfm';
    fs.writeFileSync(path.resolve(workspaceDir, plainRelPath), plainContent);
    masterPath = plainRelPath;
    console.log('[check-ult-edits] Human edits detected for ' + bookUpper + ' ' + chapter + '. Master written: ' + plainRelPath);
  } else {
    console.log('[check-ult-edits] Human edits detected for ' + bookUpper + ' ' + chapter);
  }

  return { hasEdits: true, masterPath };
}

module.exports = { checkUltEdits };
