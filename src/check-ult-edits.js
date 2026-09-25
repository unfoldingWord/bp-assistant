// check-ult-edits.js — Mechanical diff gate for post-edit-review
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { resolveOutputFile } = require('./pipeline-utils');
const { parsePlainUsfmVersesFromText, glQuoteAnchorsInVerseText } = require('./workspace-tools/tn-tools');

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
 * Find issue rows whose GLQuote no longer occurs in the master ULT verse text.
 * Matching is tn-tools glQuoteAnchorsInVerseText, which mirrors the alignment
 * anchor (resolveWithAlignment): punctuation and {supplied} words ignored,
 * segments split on "&" / ellipsis, words in order with a content-word
 * fallback. So a row reported here is one mechanical prep would also fail to
 * anchor (issue #186); punctuation-only or spacing-only differences are not
 * reported. Only canonical rows (Book, Reference, SupportReference, GLQuote,
 * ...) for this chapter are checked; rows with an empty GLQuote are ignored.
 *
 * @returns {Array<{ ref: string, glQuote: string, row: number }>} row is the
 *   1-based line number in the issues TSV.
 */
function findStaleIssueQuotes(issuesTsvText, masterChapterUsfm, chapter) {
  const ch = Number(chapter);
  const verses = parsePlainUsfmVersesFromText(masterChapterUsfm);
  const misses = [];
  const lines = String(issuesTsvText || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const cols = lines[i].split('\t');
    if (cols.length < 4 || !/^[A-Z0-9]{3}$/i.test(cols[0].trim())) continue;
    const ref = cols[1].trim();
    const glQuote = cols[3].trim();
    if (!glQuote) continue;
    const m = ref.match(/^(\d+):(\d+)(?:-(\d+))?$/);
    if (!m || Number(m[1]) !== ch) continue;
    const first = Number(m[2]);
    const last = m[3] ? Number(m[3]) : first;
    const verseText = [];
    for (let v = first; v <= last; v++) {
      if (verses[`${ch}:${v}`]) verseText.push(verses[`${ch}:${v}`]);
    }
    const found = verseText.length > 0 && glQuoteAnchorsInVerseText(glQuote, verseText.join(' '));
    if (!found) misses.push({ ref, glQuote, row: i + 1 });
  }
  return misses;
}

/**
 * Compare the plain (pre-alignment) AI-ULT chapter with the master chapter,
 * verse by verse, ignoring USFM markers and whitespace. Used when the aligned
 * AI-ULT is unavailable; post-edit-review itself diffs the plain AI-ULT.
 */
function plainChapterDiffers(plainUsfm, masterChapterUsfm, chapter) {
  const prefix = Number(chapter) + ':';
  const pick = (usfm) => {
    const out = {};
    for (const [key, text] of Object.entries(parsePlainUsfmVersesFromText(usfm))) {
      if (key.startsWith(prefix)) out[key] = normalizeWhitespace(text);
    }
    return out;
  };
  const plain = pick(extractChapter(plainUsfm, chapter) || plainUsfm);
  const master = pick(stripAlignmentMarkers(masterChapterUsfm));
  const keys = new Set([...Object.keys(plain), ...Object.keys(master)]);
  for (const key of keys) {
    if (plain[key] !== master[key]) return true;
  }
  return false;
}

function formatRefList(refs, max = 10) {
  if (refs.length <= max) return refs.join(', ');
  return refs.slice(0, max).join(', ') + ', +' + (refs.length - max) + ' more';
}

/**
 * Decide whether a chapter needs post-edit-review. It does when any of:
 *   - the Door43 master ULT chapter differs from the AI aligned USFM (ult_diff);
 *     when the aligned file (or its chapter) is missing, the plain AI-ULT is
 *     compared instead (ult_diff_plain);
 *   - an issues-TSV GLQuote is absent from its master ULT verse
 *     (stale_issue_quotes). This catches issues written against older ULT
 *     wording even when the aligned file already matches master (issue #186);
 *   - neither the aligned nor the plain AI-ULT exists, so no diff is possible
 *     (aligned_missing / aligned_chapter_missing, plus plain_missing).
 *
 * @param {object} opts
 * @param {string} opts.book          - 3-letter book code (e.g. 'PSA')
 * @param {number} opts.chapter       - chapter number
 * @param {string} opts.workspaceDir  - absolute path to the workspace directory
 * @param {string} [opts.pipeDir]     - relative path to the pipeline dir (e.g. 'tmp/pipeline/PSA-036')
 * @param {string} [opts.issuesPath]  - issues TSV path (relative to workspaceDir, or absolute)
 * @returns {Promise<{ hasEdits: boolean, masterPath: string|null, reason: string|null,
 *   staleQuotes: Array<{ref: string, glQuote: string, row: number}>, masterChapter: string }>}
 *   masterChapter is the raw Door43 master chapter USFM, kept for re-checking
 *   stale quotes after post-edit-review.
 */
async function checkUltEdits({ book, chapter, workspaceDir, pipeDir, issuesPath }) {
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

  const reasons = [];

  const width = bookUpper === 'PSA' ? 3 : 2;
  const chPadded = String(chapter).padStart(width, '0');
  const alignedName = 'output/AI-ULT/' + bookUpper + '/' + bookUpper + '-' + chPadded + '-aligned.usfm';
  const alignedRelPath = resolveOutputFile(alignedName, bookUpper);
  let alignedProblem = null;
  if (!alignedRelPath) {
    alignedProblem = 'aligned_missing';
  } else {
    const alignedUsfm = fs.readFileSync(path.resolve(workspaceDir, alignedRelPath), 'utf8');
    const alignedChapter = extractChapter(alignedUsfm, chapter);
    if (!alignedChapter) {
      alignedProblem = 'aligned_chapter_missing';
    } else if (normalizeWhitespace(masterChapter) !== normalizeWhitespace(alignedChapter)) {
      reasons.push('ult_diff');
    }
  }
  if (alignedProblem) {
    // No aligned text to diff: fall back to the plain AI-ULT, which is what
    // post-edit-review compares against master anyway.
    const plainName = 'output/AI-ULT/' + bookUpper + '/' + bookUpper + '-' + chPadded + '.usfm';
    const plainRelPath = resolveOutputFile(plainName, bookUpper);
    if (!plainRelPath) {
      console.log('[check-ult-edits] Neither aligned nor plain AI-ULT found (' + alignedName + ', ' + plainName + ') — cannot diff, routing to post-edit-review');
      reasons.push(alignedProblem + ', plain_missing');
    } else {
      const plainUsfm = fs.readFileSync(path.resolve(workspaceDir, plainRelPath), 'utf8');
      console.log('[check-ult-edits] ' + alignedProblem + ' — comparing plain AI-ULT ' + plainRelPath + ' against master instead');
      if (plainChapterDiffers(plainUsfm, masterChapter, chapter)) reasons.push('ult_diff_plain');
    }
  }

  let staleQuotes = [];
  if (issuesPath) {
    const issuesAbsPath = path.resolve(workspaceDir, issuesPath);
    if (fs.existsSync(issuesAbsPath)) {
      staleQuotes = findStaleIssueQuotes(fs.readFileSync(issuesAbsPath, 'utf8'), masterChapter, chapter);
      if (staleQuotes.length) {
        reasons.push('stale_issue_quotes: ' + staleQuotes.length + ' GLQuote(s) not in master ULT ('
          + formatRefList(staleQuotes.map((q) => q.ref)) + ')');
      }
    } else {
      console.log('[check-ult-edits] Issues TSV not found: ' + issuesPath + ' — skipping stale-quote check');
    }
  }

  if (!reasons.length) {
    return { hasEdits: false, masterPath: null, reason: null, staleQuotes, masterChapter };
  }
  const reason = reasons.join('; ');

  let masterPath = null;
  if (pipeDir) {
    const plainContent = stripAlignmentMarkers(masterChapter);
    const absDir = path.resolve(workspaceDir, pipeDir);
    fs.mkdirSync(absDir, { recursive: true });
    const plainRelPath = pipeDir + '/ult_master_plain.usfm';
    fs.writeFileSync(path.resolve(workspaceDir, plainRelPath), plainContent);
    masterPath = plainRelPath;
    console.log('[check-ult-edits] Post-edit-review needed for ' + bookUpper + ' ' + chapter + ' (' + reason + '). Master written: ' + plainRelPath);
  } else {
    console.log('[check-ult-edits] Post-edit-review needed for ' + bookUpper + ' ' + chapter + ' (' + reason + ')');
  }

  return { hasEdits: true, masterPath, reason, staleQuotes, masterChapter };
}

/**
 * System-prompt addendum for post-edit-review when stale issue quotes
 * triggered it. The skill's Diff Analyzer skips verses where AI-ULT and master
 * agree, which is exactly where stale quotes hide, so name those rows. The same
 * rows are written to context.json (postEditReview.staleIssueQuotes) so the
 * skill can hand them to its reconciler sub-agent.
 */
function buildStaleQuotesHint(staleQuotes) {
  if (!Array.isArray(staleQuotes) || !staleQuotes.length) return '';
  const rows = staleQuotes
    .map((q) => '- ' + q.ref + (q.row ? ' (TSV row ' + q.row + ')' : '') + ': "' + q.glQuote + '"')
    .join('\n');
  return 'These issue rows have a GLQuote that does not occur in the current master ULT verse '
    + '(the issues were written against older ULT wording). Reconcile each one against the master '
    + 'ULT text even if the AI-ULT and master agree for that verse: update the GLQuote to the '
    + 'master ULT wording; drop the issue only if it no longer exists in the text. '
    + 'The same list is in context.json at postEditReview.staleIssueQuotes.\n' + rows;
}

/**
 * Record the post-edit-review trigger in the pipeline context so the skill
 * and its sub-agents read the stale rows from a file, not only from the
 * orchestrator's system prompt.
 */
function recordPostEditReviewContext(ctx, diffResult) {
  ctx.postEditReview = {
    reason: diffResult.reason || null,
    staleIssueQuotes: Array.isArray(diffResult.staleQuotes) ? diffResult.staleQuotes : [],
  };
  if (diffResult.masterPath) {
    ctx.sources = ctx.sources || {};
    ctx.sources.ultMasterPlain = diffResult.masterPath;
  }
  return ctx;
}

/**
 * After post-edit-review: the issue rows whose GLQuote the anchor still cannot
 * place in the master ULT. Diagnostic only (callers log, never fail). Returns
 * null when the check cannot run.
 */
function findRemainingStaleQuotes({ issuesPath, workspaceDir, masterChapter, chapter }) {
  if (!issuesPath || !masterChapter) return null;
  const abs = path.resolve(workspaceDir, issuesPath);
  if (!fs.existsSync(abs)) return null;
  return findStaleIssueQuotes(fs.readFileSync(abs, 'utf8'), masterChapter, chapter);
}

// Primitives exported for reuse by the overnight Sensor (overnight-watcher.js):
// USFM chapter extraction, alignment-marker stripping, whitespace normalization,
// the redirect-following text fetcher, and the book→number map.
module.exports = {
  checkUltEdits,
  findStaleIssueQuotes,
  buildStaleQuotesHint,
  recordPostEditReviewContext,
  findRemainingStaleQuotes,
  plainChapterDiffers,
  extractChapter,
  stripAlignmentMarkers,
  normalizeWhitespace,
  fetchText,
  BOOK_NUMBERS,
  DOOR43_BASE,
};
