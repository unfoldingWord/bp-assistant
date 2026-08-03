// quality-tools.js — Node.js ports of TN quality check scripts
//
// Replaces: check_tn_quality.py, validate_tn_tsv.py

const fs = require('fs');
const path = require('path');
const https = require('https');

const { loadTemplateMap, resolveAtRequirement, _inspectOpeningBold, countCaseInsensitiveOccurrences } = require('./tn-tools');

const CSKILLBP_DIR = process.env.CSKILLBP_DIR || '/srv/bot/workspace';

// Sets used by orphaned-word checks (Check 10 / 10b)
const CONJUNCTIONS = new Set(['and','but','so','then','or','for','yet','nor']);
const PREPOSITIONS = new Set(['in','to','from','by','for','with','on','at','of','into','upon','about','through','against','between']);

// Proper nouns that may legitimately start with uppercase mid-sentence
const PROPER_NOUNS = new Set(['Yahweh','God','Lord','David','Israel','Jerusalem','Zion','Moses','Jacob','Abraham','Christ','Jesus','I']);

// --- validate_tn_tsv ---

const ID_RE = /^[a-z][a-z0-9]{3}$/;
const REFERENCE_RE = /^(?:front:intro|\d+:intro|\d+:front|\d+:\d+(?:[,\-][\d,:\-]*\d+)*)$/;
const SUPPORT_REFERENCE_RE = /^rc:\/\/[^/]+\/[^/]+\/[^/]+\/[^ \\]+$/;
const OCCURRENCE_RE = /^(?:-1|[0-9]+)$/;
const ALT_TRANSLATION_RE = /Alternat(e|ive)( *)([Tt])ranslation/;
const DUPLICATE_ALT_RE = /Alternate translation.{0,2} [Aa]lternat/;
const EXPECTED_HEADER = 'Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote';

function validateTnTsv({ file, checks, maxErrors }) {
  const filePath = path.resolve(CSKILLBP_DIR, file);
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const max = maxErrors || 200;
  const enabledChecks = checks && checks.length ? new Set(checks) : new Set([3,4,5,6,7,8,9,10,11,12,13]);
  const errors = [];
  const seenIds = new Set();

  function addError(check, line, ref, id, msg) {
    if (errors.length < max) errors.push({ check, line, reference: ref, id, message: msg, severity: 'error' });
  }

  // Check 4: Header
  if (enabledChecks.has(4) && lines[0] && lines[0].trimEnd() !== EXPECTED_HEADER) {
    addError(4, 1, '', '', `Invalid header. Expected: ${EXPECTED_HEADER}`);
  }

  let prevRefKey = [-Infinity, -Infinity];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const cols = line.split('\t');
    const lineNum = i + 1;
    const ref = cols[0] || '';
    const id = cols[1] || '';

    // Check 3: Column count
    if (enabledChecks.has(3) && cols.length !== 7) {
      addError(3, lineNum, ref, id, `Expected 7 columns, found ${cols.length}`);
    }

    // Check 5: ID format + uniqueness
    if (enabledChecks.has(5)) {
      if (!ID_RE.test(id)) addError(5, lineNum, ref, id, `Invalid ID format: "${id}"`);
      if (seenIds.has(id)) addError(5, lineNum, ref, id, `Duplicate ID: "${id}"`);
      seenIds.add(id);
    }

    // Check 6: Reference format
    if (enabledChecks.has(6) && !REFERENCE_RE.test(ref)) {
      addError(6, lineNum, ref, id, `Invalid reference format: "${ref}"`);
    }

    // Check 7: SupportReference format
    if (enabledChecks.has(7)) {
      const sref = cols[3] || '';
      if (sref && !SUPPORT_REFERENCE_RE.test(sref)) {
        addError(7, lineNum, ref, id, `Invalid SupportReference: "${sref.slice(0, 80)}"`);
      }
    }

    // Check 8: Literal \n in non-Note columns
    if (enabledChecks.has(8)) {
      for (let c = 0; c < Math.min(cols.length, 6); c++) {
        if (cols[c].includes('\\n')) addError(8, lineNum, ref, id, `Literal \\n in column ${c}`);
      }
    }

    // Check 8b: HTML tags in Note column
    if (enabledChecks.has(8)) {
      const noteCol = cols[6] || '';
      if (/<br\s*\/?>/i.test(noteCol)) addError(8, lineNum, ref, id, 'HTML <br> tag in Note column');
    }

    // Check 9: Occurrence
    if (enabledChecks.has(9)) {
      const occ = cols[5] || '';
      const quote = cols[4] || '';
      if (occ && !OCCURRENCE_RE.test(occ)) addError(9, lineNum, ref, id, `Invalid Occurrence: "${occ}"`);
      if (!occ && quote) addError(9, lineNum, ref, id, 'Occurrence empty but Quote is set');
    }

    // Check 11: Reference order
    if (enabledChecks.has(11)) {
      const parts = ref.split(':', 2);
      if (parts.length === 2) {
        const ch = parts[0] === 'front' ? -1 : parseInt(parts[0], 10) || 0;
        const vs = parts[1] === 'intro' ? -2 : parts[1] === 'front' ? -1 : parseInt(parts[1].split(/[-,]/)[0], 10) || 0;
        const key = [ch, vs];
        if (key[0] < prevRefKey[0] || (key[0] === prevRefKey[0] && key[1] < prevRefKey[1])) {
          addError(11, lineNum, ref, id, `Reference out of order (after ${prevRefKey.join(':')})`);
        }
        prevRefKey = key;
      }
    }

    // Check 12: Alternate translation label
    if (enabledChecks.has(12)) {
      const note = cols[6] || '';
      const altMatch = note.match(ALT_TRANSLATION_RE);
      if (altMatch) {
        if (altMatch[1] === 'ive') addError(12, lineNum, ref, id, 'Use "Alternate" not "Alternative"');
        if (altMatch[2] !== ' ') addError(12, lineNum, ref, id, 'Exactly one space between "Alternate" and "translation"');
        if (altMatch[3] === 'T') addError(12, lineNum, ref, id, 'Lowercase "t" in "translation"');
      }
      if (DUPLICATE_ALT_RE.test(note)) addError(12, lineNum, ref, id, 'Duplicate "Alternate translation" label');
    }

    // Check 13: Paired square brackets
    if (enabledChecks.has(13)) {
      const note = cols[6] || '';
      const opens = (note.match(/\[/g) || []).length;
      const closes = (note.match(/\]/g) || []).length;
      if (opens !== closes) addError(13, lineNum, ref, id, `Unmatched brackets: ${opens} [ vs ${closes} ]`);
    }
  }

  return JSON.stringify({
    file: path.basename(filePath),
    total_rows: lines.length - 1,
    errors: errors.length,
    truncated: errors.length >= max,
    findings: errors,
  }, null, 2);
}

// --- check_tn_quality helpers ---

/**
 * Strip {supply} braces from text (e.g. from gl_quote).
 */
function stripBraces(text) {
  return text.replace(/\{[^}]*\}/g, '').trim();
}

function flattenBraces(text) {
  return String(text || '').replace(/\{([^}]*)\}/g, '$1').replace(/\s+/g, ' ').trim();
}

function normalizeComparableAtText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\s*(?:\.{3}|\u2026)\s*/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compareNormalizedSpanText(text) {
  return String(text || '')
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/\s*(?:\.{3}|\u2026)\s*/g, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract AT texts from after "Alternate translation:" lines.
 * Returns array of strings (contents of [...] brackets).
 */
function extractAts(noteText) {
  const ats = [];
  const atLineRe = /Alternate translation:\s*(.*?)(?=\n|$)/g;
  let m;
  while ((m = atLineRe.exec(noteText)) !== null) {
    const atLine = m[1];
    const bracketRe = /\[([^\]]+)\]/g;
    let bm;
    while ((bm = bracketRe.exec(atLine)) !== null) {
      ats.push(bm[1]);
    }
  }
  return ats;
}

/**
 * Parse Hebrew USFM into a map of { "ch:vs": [wordToken, ...] }.
 * Extracts \w word|...\w* tokens by verse.
 */
function parseHebrewVerseWords(hebrewUsfmPath) {
  if (!hebrewUsfmPath) return {};
  const full = path.resolve(CSKILLBP_DIR, hebrewUsfmPath);
  if (!fs.existsSync(full)) return {};
  const text = fs.readFileSync(full, 'utf8');
  const verseWords = {};
  let ch = 0;
  let curVerse = null;
  let wordBuf = [];

  function flushVerse() {
    if (curVerse) verseWords[curVerse] = wordBuf.slice();
  }

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    const cm = trimmed.match(/^\\c\s+(\d+)/);
    if (cm) {
      flushVerse();
      ch = parseInt(cm[1], 10);
      curVerse = null;
      wordBuf = [];
      continue;
    }
    const vm = trimmed.match(/^\\v\s+(\d+[-\d]*)/);
    if (vm) {
      flushVerse();
      curVerse = `${ch}:${vm[1].split('-')[0]}`;
      wordBuf = [];
    }
    if (curVerse) {
      const WRE = /\\w\s+([^|\\]+)\|[^\\]*?\\w\*/g;
      let wm;
      while ((wm = WRE.exec(trimmed)) !== null) {
        wordBuf.push(wm[1].trim());
      }
    }
  }
  flushVerse();
  return verseWords;
}

const HEBREW_RTL_RE = /[֐-׿؀-ۿיִ-﷿ﹰ-﻿]/;
const HEBREW_CANT_RE = /[֑-֯⁠־]/g;

/**
 * Normalize a candidate Hebrew quote against the canonical verse word list
 * loaded from the UHB. Inserts ` & ` joiners at discontinuity gaps so the
 * returned string matches translation-note conventions.
 *
 * Returns { quote, status, warnings } where:
 *   quote    — normalized Hebrew (NFC, with ` & ` joiners where needed)
 *   status   — 'ok' | 'no_rtl' | 'no_words_match' | 'partial_match'
 *   warnings — [{ code, detail }] zero or more soft issues
 *
 * Matching is cantillation/taamim-insensitive. First occurrence wins when
 * a verse repeats a word (refinement candidate if mis-matches show up).
 */
function normalizeHebrewQuote(rawQuote, verseWords) {
  const warnings = [];
  if (!rawQuote || typeof rawQuote !== 'string') {
    return { quote: '', status: 'no_rtl', warnings };
  }
  if (!HEBREW_RTL_RE.test(rawQuote)) {
    return { quote: rawQuote, status: 'no_rtl', warnings };
  }

  const tokens = rawQuote
    .split(/\s+&\s+|\s+/)
    .map(s => s.trim())
    .filter(Boolean);
  if (tokens.length === 0) {
    return { quote: rawQuote, status: 'no_words_match', warnings };
  }

  const matched = [];
  let matchCount = 0;
  for (const tok of tokens) {
    const tokStripped = tok.replace(HEBREW_CANT_RE, '');
    let pos = -1;
    for (let i = 0; i < verseWords.length; i++) {
      const w = verseWords[i];
      if (w === tok || w.replace(HEBREW_CANT_RE, '') === tokStripped) {
        pos = i;
        break;
      }
    }
    if (pos < 0) {
      warnings.push({ code: 'hebrew_word_not_in_verse', detail: tok });
    } else {
      matchCount++;
    }
    matched.push({ token: tok, position: pos });
  }

  if (matchCount === 0) {
    return { quote: rawQuote, status: 'no_words_match', warnings };
  }

  const parts = [];
  for (let i = 0; i < matched.length; i++) {
    const cur = matched[i];
    if (i === 0) {
      parts.push(cur.token);
      continue;
    }
    const prev = matched[i - 1];
    const gap = (prev.position >= 0 && cur.position >= 0)
      ? (cur.position - prev.position)
      : 1;
    parts.push(gap > 1 ? ' & ' : ' ');
    parts.push(cur.token);
  }

  const normalized = parts.join('').normalize('NFC');
  const status = matchCount < tokens.length ? 'partial_match' : 'ok';
  return { quote: normalized, status, warnings };
}

/**
 * Fetch upstream TN IDs for a given book from Door43.
 * Returns a Set of IDs on success, or null on failure.
 */
async function fetchUpstreamIds(book) {
  return new Promise((resolve) => {
    function parseIds(body) {
      const ids = new Set();
      for (const line of body.split('\n')) {
        const cols = line.split('\t');
        if (cols.length > 1 && /^[a-z][a-z0-9]{3}$/.test(cols[1])) ids.add(cols[1]);
      }
      return ids;
    }
    function fetchUrl(url, redirectsLeft) {
      if (redirectsLeft <= 0) return resolve(null);
      https.get(url, { timeout: 30000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return fetchUrl(res.headers.location, redirectsLeft - 1);
        }
        if (res.statusCode !== 200) { res.resume(); return resolve(null); }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(parseIds(Buffer.concat(chunks).toString('utf8'))));
        res.on('error', () => resolve(null));
      }).on('error', () => resolve(null));
    }
    fetchUrl(`https://git.door43.org/unfoldingWord/en_tn/raw/branch/master/tn_${book.toUpperCase()}.tsv`, 3);
  });
}

// --- self-talk / reasoning-leakage detection (shared) ---
//
// The per-note generator takes the model's final message verbatim
// (notes-pipeline.js runPerNoteGeneration) — the only cleanup is trim +
// trailing-AT strip. When the model deliberates out loud instead of emitting
// just the note, its reasoning ships to Door43 inside the Note column
// (MIC 5:7, 2026-08-03: a "wait, actually..." paragraph published above an
// otherwise-correct figs-parallelism note).
//
// Exported so the quality check and the repair pass in notes-pipeline.js share
// ONE definition — a repair gate that disagreed with the detector could "fix" a
// note into text the checker still flags, or vice versa.
//
// Measured against the 215 published golden notes (JOS 1/3, MAL 1, NAM 1):
// 1 false positive total (NAM 1 "tell his readers to actually look").
const SELF_TALK_PATTERNS = [
  [/\bwait,?\s*(actually|no|sorry|hold on)\b/i, 'self-correction ("wait, actually...")'],
  [/\bactually\b/i, 'deliberation marker ("actually")'],
  [/\b(let me|i think|hmm|on second thought|my mistake)\b/i, 'first-person deliberation'],
  [/\bthe (template|issue type|sref)\b/i, 'internal pipeline jargon'],
  [/\b(combine|repetition|generic|poetry) type\b/i, 'template sub-type name leaked'],
  [/\bthis is (a|an) [a-z-]*(parallelism|metaphor|metonymy|idiom|hyperbole|euphemism)\b/i,
    'note labels its own issue type instead of using the template'],
];

/**
 * Returns a human-readable label for the first self-talk signal found in a
 * note, or null when the note looks clean.
 *
 * Bolded verse quotes and bracketed alternate translations are stripped before
 * matching — real verse text legitimately contains first-person pronouns.
 */
function detectSelfTalk(noteText) {
  const prose = String(noteText || '')
    .replace(/\*\*[^*]+\*\*/g, ' ')   // bolded verse quotes
    .replace(/\[[^\]]*\]/g, ' ');     // bracketed alternate translations
  for (const [re, label] of SELF_TALK_PATTERNS) {
    if (re.test(prose)) return label;
  }
  return null;
}

// --- check_tn_quality ---

async function checkTnQuality({ tsvPath, preparedJson, ultUsfm, ustUsfm, book, hebrewUsfm, output }) {
  const tsv = path.resolve(CSKILLBP_DIR, tsvPath);
  const content = fs.readFileSync(tsv, 'utf8');
  const lines = content.split('\n');
  const outPath = output ? path.resolve(CSKILLBP_DIR, output) : '/tmp/claude/tn_quality_findings.json';

  // Parse TSV
  const notes = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = line.split('\t');
    while (cols.length < 7) cols.push('');
    notes.push({ row: i + 1, ref: cols[0], id: cols[1], tags: cols[2], sref: cols[3], quote: cols[4], occurrence: cols[5], note: cols[6] });
  }

  // Load prepared items for cross-reference
  let prepItems = {};
  if (preparedJson) {
    try {
      const prep = JSON.parse(fs.readFileSync(path.resolve(CSKILLBP_DIR, preparedJson), 'utf8'));
      for (const item of (prep.items || [])) prepItems[item.id] = item;
    } catch { /* proceed without */ }
  }

  // Parse USFM verses
  function parseVersesPlain(fp) {
    if (!fp) return {};
    const full = path.resolve(CSKILLBP_DIR, fp);
    if (!fs.existsSync(full)) return {};
    const text = fs.readFileSync(full, 'utf8');
    const verses = {};
    let ch = 0;
    for (const l of text.split('\n')) {
      const cm = l.trim().match(/^\\c\s+(\d+)/);
      if (cm) { ch = parseInt(cm[1], 10); continue; }
      const vm = l.trim().match(/^\\v\s+(\d+[-\d]*)\s*(.*)/);
      if (vm) {
        let txt = vm[2] || '';
        txt = txt.replace(/\\zaln-[se][^*]*\*/g, '').replace(/\\w\s+([^|]*?)\|[^\\]*?\\w\*/g, '$1')
          .replace(/\\[a-z]+\d?\s+/g, ' ').replace(/\\[a-z]+\d?\*/g, '').replace(/\s+/g, ' ').trim();
        verses[`${ch}:${vm[1].split('-')[0]}`] = txt;
      }
    }
    return verses;
  }

  const ultVerses = parseVersesPlain(ultUsfm);
  const ustVerses = parseVersesPlain(ustUsfm);

  // Parse Hebrew verse words for check 19
  const hebrewVerseWords = parseHebrewVerseWords(hebrewUsfm);

  // Load translation issues for SRef validation
  const validIssues = new Set();
  const issuesFile = path.join(CSKILLBP_DIR, 'data', 'translation-issues.csv');
  if (fs.existsSync(issuesFile)) {
    for (const line of fs.readFileSync(issuesFile, 'utf8').split('\n')) {
      const slug = line.split(',')[0];
      if (slug && slug !== 'slug') validIssues.add(slug);
    }
  }

  // Check 3: Fetch upstream IDs to detect collisions
  let upstreamIds = null;
  if (book) {
    upstreamIds = await fetchUpstreamIds(book);
  }

  const findings = [];
  const seenIds = new Set();
  const _templateMap = loadTemplateMap();

  function addFinding(row, ref, id, severity, category, message) {
    findings.push({ row, reference: ref, id, severity, category, message });
  }

  // For check 20c: near-duplicate detection — collect notes by sref slug
  const notesBySrefSlug = {};

  for (const n of notes) {
    // 1. ID format
    if (!ID_RE.test(n.id)) addFinding(n.row, n.ref, n.id, 'error', 'id_format', `Invalid ID: "${n.id}"`);

    // 2. ID uniqueness
    if (seenIds.has(n.id)) addFinding(n.row, n.ref, n.id, 'error', 'id_duplicate', `Duplicate ID: "${n.id}"`);
    seenIds.add(n.id);

    // 3. ID collision with upstream
    if (upstreamIds && upstreamIds.has(n.id)) {
      addFinding(n.row, n.ref, n.id, 'warning', 'id_collision', `ID "${n.id}" collides with upstream TN`);
    }

    // 4. Hebrew quote (RTL check) — empty quote is error, no RTL is error.
    // :intro rows legitimately have an empty Quote column, so exempt them.
    const isIntroRow = /:intro$/.test(n.ref || '');
    if (!n.quote) {
      if (!isIntroRow) addFinding(n.row, n.ref, n.id, 'error', 'empty_quote', 'Quote column is empty');
    } else {
      const hasRtl = /[\u0590-\u05FF\u0600-\u06FF\uFB1D-\uFDFF\uFE70-\uFEFF]/.test(n.quote);
      if (!hasRtl) addFinding(n.row, n.ref, n.id, 'error', 'no_hebrew_in_quote', 'Quote column has no RTL characters');
    }

    // 5. AT bracket syntax
    const atMatch = n.note.match(/Alternate translation:\s*(.*?)(?=\n|$)/);
    if (atMatch) {
      const atText = atMatch[1];
      if (!atText.includes('[') || !atText.includes(']')) {
        addFinding(n.row, n.ref, n.id, 'error', 'at_brackets', 'AT text must use [square brackets]');
      }
    }

    if (/\\u[0-9a-fA-F]{4}/.test(n.note)) {
      addFinding(n.row, n.ref, n.id, 'error', 'unicode_escape_literal', 'Literal unicode escape sequence leaked into note text');
    }

    // Get ULT/UST verse context
    const prepItem = prepItems[n.id] || {};
    const ultVerse = prepItem.ult_verse || ultVerses[n.ref] || '';
    const ustVerse = prepItem.ust_verse || ustVerses[n.ref] || '';
    const glQuote = prepItem.issue_span_gl_quote || prepItem.gl_quote || '';
    const exactSpan = prepItem.exact_ult_span || glQuote;

    // Extract ATs for this note
    const ats = extractAts(n.note);

    // 6. AT text must NOT appear verbatim in UST verse
    if (ustVerse && ats.length) {
      for (const at of ats) {
        const atLower = at.toLowerCase();
        const ustLower = ustVerse.toLowerCase();
        if (atLower && ustLower.includes(atLower)) {
          addFinding(n.row, n.ref, n.id, 'error', 'at_matches_ust', `AT text "${at.slice(0, 50)}" appears verbatim in UST verse`);
          continue;
        }
        // Check >85% word overlap for longer ATs (>10 chars, >2 words)
        if (at.length > 10) {
          const atWords = atLower.split(/\s+/).filter(w => w.length > 2);
          if (atWords.length > 2) {
            const ustWords = new Set(ustLower.split(/\s+/));
            const overlap = atWords.filter(w => ustWords.has(w)).length / atWords.length;
            if (overlap > 0.85) {
              addFinding(n.row, n.ref, n.id, 'warning', 'at_not_ust', `AT text "${at.slice(0, 50)}" has >85% word overlap with UST verse`);
            }
          }
        }
      }
    }

    // 7. gl_quote in ULT
    if (glQuote && ultVerse) {
      const cleanGlq = stripBraces(glQuote);
      if (cleanGlq && !ultVerse.toLowerCase().includes(cleanGlq.toLowerCase())) {
        addFinding(n.row, n.ref, n.id, 'warning', 'gl_quote_not_in_ult', `gl_quote "${cleanGlq.slice(0, 50)}" not found in ULT`);
      }
    }

    if (glQuote && exactSpan) {
      const normalizedGlq = compareNormalizedSpanText(glQuote);
      const normalizedExact = compareNormalizedSpanText(exactSpan);
      if (normalizedExact
        && normalizedGlq
        && normalizedExact !== normalizedGlq
        && normalizedExact.length < normalizedGlq.length
        && normalizedGlq.includes(normalizedExact)) {
        addFinding(n.row, n.ref, n.id, 'warning', 'scope_overreach',
          `Selected quote is broader than exact aligned span "${exactSpan.slice(0, 50)}"`);
      }
    }

    if (glQuote && ats.length) {
      const cleanGlq = stripBraces(glQuote);
      const flattenedGlq = flattenBraces(glQuote);
      const normalizedGlq = normalizeComparableAtText(flattenedGlq || cleanGlq);
      const sourceHasEllipsis = /(?:\.{3}|\u2026| & )/.test(flattenedGlq || cleanGlq);
      for (const at of ats) {
        const normalizedAt = normalizeComparableAtText(at);
        if (normalizedGlq && normalizedAt && normalizedGlq === normalizedAt) {
          addFinding(n.row, n.ref, n.id, 'error', 'at_equals_ult_after_brace_strip', 'AT is identical to the brace-stripped ULT quote');
        }
        const atHasEllipsis = /(?:\.{3}|\u2026| & )/.test(at);
        if (atHasEllipsis && !sourceHasEllipsis) {
          addFinding(n.row, n.ref, n.id, 'warning', 'at_ellipsis_mismatch', 'AT is discontinuous but the source quote is contiguous');
        }
      }
    }

    // 8. Bold accuracy — normalized comparison (curly vs straight quotes,
    // whitespace, case): curly_quotes runs on the TSV before this check, so a
    // raw includes() would flag valid spans whose apostrophes were curled.
    const boldMatches = n.note.match(/\*\*([^*]+)\*\*/g) || [];
    for (const bold of boldMatches) {
      const text = bold.slice(2, -2);
      if (ultVerse && countCaseInsensitiveOccurrences(ultVerse, text) === 0) {
        addFinding(n.row, n.ref, n.id, 'warning', 'bold_not_in_ult', `Bold text "${text.slice(0, 40)}" not in ULT`);
      }
    }

    // 9. rc:// in note
    if (/rc:\/\//.test(n.note)) {
      addFinding(n.row, n.ref, n.id, 'warning', 'rc_in_note', 'rc:// link found in Note (belongs in SupportReference)');
    }

    // 10. Orphaned words after AT substitution into ULT
    if (glQuote && ultVerse && ats.length) {
      const cleanGlq = stripBraces(glQuote);
      const ultStripped = ultVerse.replace(/\{[^}]*\}/g, '');
      const glqIdx = ultStripped.toLowerCase().indexOf(cleanGlq.toLowerCase());
      if (glqIdx >= 0) {
        const simulated = ultStripped.slice(0, glqIdx) + '[AT]' + ultStripped.slice(glqIdx + cleanGlq.length);
        const bracketPos = simulated.indexOf('[');
        const beforeAt = simulated.slice(0, bracketPos);
        const beforeWords = beforeAt.trim().split(/\s+/);
        const wordBefore = beforeWords.length ? beforeWords[beforeWords.length - 1].toLowerCase().replace(/[^a-z]/g, '') : '';
        if (wordBefore) {
          if (CONJUNCTIONS.has(wordBefore)) {
            addFinding(n.row, n.ref, n.id, 'warning', 'orphaned_conjunction', `Word "${wordBefore}" before AT may be orphaned conjunction`);
          } else if (PREPOSITIONS.has(wordBefore)) {
            const glqFirst = cleanGlq.toLowerCase().split(/\s+/)[0] || '';
            if (glqFirst !== wordBefore) {
              addFinding(n.row, n.ref, n.id, 'warning', 'orphaned_preposition', `Preposition "${wordBefore}" before AT may be orphaned`);
            }
          }
        }
      }
    }

    // 10b. Dropped leading conjunction
    if (glQuote && ats.length) {
      const cleanGlq = stripBraces(glQuote);
      const glqFirstWord = cleanGlq.toLowerCase().split(/\s+/)[0] || '';
      if (CONJUNCTIONS.has(glqFirstWord)) {
        for (const at of ats) {
          const atFirstWord = at.toLowerCase().split(/\s+/)[0] || '';
          if (!CONJUNCTIONS.has(atFirstWord)) {
            addFinding(n.row, n.ref, n.id, 'warning', 'dropped_conjunction', `gl_quote starts with conjunction "${glqFirstWord}" but AT does not`);
            break;
          }
        }
      }
    }

    // 11. Psalms writer/author
    if (book && book.toUpperCase() === 'PSA') {
      if (/\bthe writer\b/i.test(n.note) || /\bthe author\b/i.test(n.note)) {
        addFinding(n.row, n.ref, n.id, 'warning', 'psalms_writer', 'Use "the psalmist" instead of "the writer/author" for Psalms');
      }
    }

    // 12. Curly quotes
    if (n.note.includes('"')) {
      addFinding(n.row, n.ref, n.id, 'warning', 'straight_quotes', 'Straight double quotes found (use curly quotes)');
    }

    // 13. AT capitalization
    if (exactSpan && ultVerse && ats.length) {
      const cleanGlq = stripBraces(exactSpan);
      const ultStripped = ultVerse.replace(/\{[^}]*\}/g, '');
      const idx = ultStripped.toLowerCase().indexOf(cleanGlq.toLowerCase());
      let position = 'mid_sentence';
      if (idx === 0) {
        position = 'verse_start';
      } else if (idx > 0) {
        const before = ultStripped.slice(0, idx).trimEnd();
        if (before.length === 0) position = 'verse_start';
        else if (before.endsWith('.')) position = 'after_period';
        else if (/^[A-Z][^.!?]*,\s*$/.test(before)) position = 'after_vocative';
      }
      for (const at of ats) {
        if (!at) continue;
        const firstChar = at[0];
        if ((position === 'verse_start' || position === 'after_period' || position === 'after_vocative') && /[a-z]/.test(firstChar)) {
          addFinding(n.row, n.ref, n.id, 'warning', 'at_capitalization', `AT "${at.slice(0, 40)}" should start with uppercase (${position})`);
        } else if (position === 'mid_sentence' && /[A-Z]/.test(firstChar)) {
          const firstWord = at.split(/\s+/)[0];
          if (!PROPER_NOUNS.has(firstWord)) {
            addFinding(n.row, n.ref, n.id, 'warning', 'at_capitalization', `AT "${at.slice(0, 40)}" starts uppercase mid-sentence`);
          }
        }
      }
    }

    if (ats.length && glQuote && exactSpan) {
      const normalizedGlq = compareNormalizedSpanText(glQuote);
      const normalizedExact = compareNormalizedSpanText(exactSpan);
      if (normalizedExact
        && normalizedGlq
        && normalizedExact !== normalizedGlq
        && normalizedExact.length < normalizedGlq.length
        && normalizedGlq.includes(normalizedExact)) {
        addFinding(n.row, n.ref, n.id, 'warning', 'at_scope_mismatch',
          'AT is being evaluated against a broader selected quote than the exact aligned span');
      }
    }

    // 14. Abstract noun AT (covenant faithfulness / love)
    if (n.sref && n.sref.includes('figs-abstractnouns') && glQuote && glQuote.includes('covenant faithfulness')) {
      for (const at of ats) {
        if (/\blove\b/i.test(at)) {
          addFinding(n.row, n.ref, n.id, 'error', 'abstract_noun_in_at', 'AT uses "love" for "covenant faithfulness" — use the abstract noun form instead');
          break;
        }
      }
    }

    // 15. AT ending punctuation
    if (glQuote && ats.length) {
      const cleanGlq = stripBraces(glQuote);
      const glqLast = cleanGlq.slice(-1);
      const isRquestion = n.sref && n.sref.includes('figs-rquestion');
      for (const at of ats) {
        if (!at) continue;
        const atLast = at.slice(-1);
        if (/[.?,!]/.test(atLast) && atLast !== glqLast) {
          // Intentional exception: rquestion where glq ends ? and at ends . or !
          if (isRquestion && glqLast === '?' && (atLast === '.' || atLast === '!')) continue;
          addFinding(n.row, n.ref, n.id, 'warning', 'at_ending_punctuation', `AT ends with "${atLast}" but gl_quote ends with "${glqLast}"`);
        }
      }
    }

    // 16. Parallelism quote scope
    if (n.sref && n.sref.includes('figs-parallelism')) {
      const cleanGlq = stripBraces(glQuote);
      const glqWords = cleanGlq.trim().split(/\s+/).filter(Boolean);
      const verseWords = ultVerse.trim().split(/\s+/).filter(Boolean);
      if (glqWords.length < 4 && verseWords.length > 8) {
        addFinding(n.row, n.ref, n.id, 'warning', 'narrow_parallelism_quote', `Parallelism gl_quote has only ${glqWords.length} words but verse has ${verseWords.length}`);
      }
    }

    // 17. SupportReference validation
    if (n.sref) {
      const slugMatch = n.sref.match(/rc:\/\/\*\/ta\/man\/translate\/([^\s;,]+)/);
      if (slugMatch && validIssues.size && !validIssues.has(slugMatch[1])) {
        addFinding(n.row, n.ref, n.id, 'error', 'unknown_sref', `Invalid issue type "${slugMatch[1]}" — not in the issue list. Re-select a valid type from data/translation-issues.csv (e.g. wordplay/paronomasia -> writing-poetry) and set it with update_prepared_quote sref. Do not invent slugs.`);
      }
    }

    // 18. AT starting punctuation
    if (glQuote && ats.length) {
      const cleanGlq = stripBraces(glQuote);
      const glqFirst = cleanGlq[0] || '';
      for (const at of ats) {
        if (!at) continue;
        const atFirst = at[0];
        if (/[.,;:!?]/.test(atFirst) && atFirst !== glqFirst) {
          addFinding(n.row, n.ref, n.id, 'warning', 'at_starting_punctuation', `AT starts with "${atFirst}" but gl_quote starts with "${glqFirst}"`);
        }
      }
    }

    // 19. Hebrew quote joiners — check for discontinuous quotes missing " & "
    if (n.quote && /[\u0590-\u05FF]/.test(n.quote) && !n.quote.includes(' & ')) {
      const verseWords = hebrewVerseWords[n.ref] || [];
      if (verseWords.length > 0) {
        const CANT_RE = /[\u0591-\u05AF\u2060\u05BE]/g;
        const quoteTokens = n.quote.split(/\s+/).filter(Boolean);
        const positions = [];
        for (const qt of quoteTokens) {
          const qtStripped = qt.replace(CANT_RE, '');
          const pos = verseWords.findIndex(w => w === qt || w.replace(CANT_RE, '') === qtStripped);
          if (pos >= 0) positions.push(pos);
        }
        if (positions.length >= 2) {
          const sorted = positions.slice().sort((a, b) => a - b);
          for (let p = 1; p < sorted.length; p++) {
            if (sorted[p] - sorted[p - 1] > 1) {
              addFinding(n.row, n.ref, n.id, 'warning', 'hebrew_quote_missing_joiner', 'Discontinuous Hebrew quote may need " & " joiner');
              break;
            }
          }
        }
      }
    }

    // 20. Multiverse notes
    if (n.note) {
      // 20a: multi-verse range language
      if (/\bverses\s+\d+(?:\s*[-,]\s*\d+)*(?:\s*(?:,\s*)?and\s+\d+)/i.test(n.note) ||
          /\bverses\s+\d+\s*[-\u2013]\s*\d+/i.test(n.note)) {
        addFinding(n.row, n.ref, n.id, 'warning', 'multiverse_language', 'Note references multiple verses — may belong in a multi-verse entry');
      }
      // 20b: back-reference to another verse
      if (/\b(?:as in|see|from|refers? to[^.]{0,30})\s+verse\s+\d+/i.test(n.note)) {
        addFinding(n.row, n.ref, n.id, 'warning', 'multiverse_backref', 'Note references another verse number');
      }
    }

    // Accumulate by sref slug for check 20c (near-duplicate detection)
    if (n.sref) {
      const slugM = n.sref.match(/rc:\/\/\*\/ta\/man\/translate\/([^\s;,]+)/);
      if (slugM) {
        const slug = slugM[1];
        if (!notesBySrefSlug[slug]) notesBySrefSlug[slug] = [];
        notesBySrefSlug[slug].push(n);
      }
    }

    // 21. rquestion AT punctuation — only when gl_quote ends with '?'
    const glqForRq = stripBraces(glQuote);
    if (n.sref && n.sref.includes('figs-rquestion') && atMatch && glqForRq.endsWith('?')) {
      for (const at of ats) {
        if (at.endsWith('?')) {
          addFinding(n.row, n.ref, n.id, 'warning', 'rquestion_punctuation', 'Rhetorical question AT should not end with "?"');
        }
      }
    }

    // 22. Missing AT when required.
    // Notes that defer to an earlier rendering ("see how you translated ...")
    // legitimately carry no alternate translation of their own, so exempt them.
    if (resolveAtRequirement(prepItem).at_required) {
      // Only genuine see-how notes are exempt: the programmatic shape starts
      // with the phrase (or the prepared item is typed see_how). A note that
      // merely mentions the phrase mid-text still needs its AT.
      const isSeeHowNote = (prepItem?.note_type === 'see_how') ||
        /^see how you translated/i.test(n.note.trim());
      if (!n.note.includes('Alternate translation:') && !isSeeHowNote) {
        addFinding(n.row, n.ref, n.id, 'error', 'missing_at', 'Note requires Alternate translation but none found');
      }
    }

    // 23. Single quotes used as quotation marks
    {
      const stripped23 = n.note.replace(/\*\*[^*]*\*\*/g, '').replace(/\[[^\]]*\]/g, '');
      if (/\u2018[^\u2019]+\u2019/.test(stripped23) ||
          /(?<!\w)'[^']{2,}'(?!\w)/.test(stripped23)) {
        addFinding(n.row, n.ref, n.id, 'error', 'single_quotes', 'Single quotes used as quotation marks (use double curly quotes)');
      }
    }

    // 24. Opening bold compliance
    {
      const openingBold = _inspectOpeningBold({
        noteText: n.note,
        prepItem,
        ultVerse: prepItem?.ult_verse || ultVerse,
      });
      if (openingBold.expectsOpeningBold) {
        if (openingBold.status === 'invalid' || openingBold.status === 'repairable_invalid') {
          addFinding(n.row, n.ref, n.id, 'warning', 'invalid_opening_bold',
            'Opening bold text is present but does not match the ULT exactly');
        } else if (openingBold.status === 'missing' || openingBold.status === 'repairable_missing') {
          addFinding(n.row, n.ref, n.id, 'warning', 'missing_opening_bold',
            'Canonical opening appears to be missing the expected bold quote');
        } else if (openingBold.status === 'ambiguous') {
          addFinding(n.row, n.ref, n.id, 'warning', 'ambiguous_opening_bold',
            'Canonical opening may need bold, but no safe repair candidate could be derived');
        }
      }
    }

    // 24b. "Here" rule compliance
    //     Whitelist canonical template openings that start with "Here" — these are
    //     structurally correct and should not trigger the "bolded lowercase quote" rule.
    if (/^Here[, ]/.test(n.note)) {
      // Check if this "Here" opening matches a canonical template for this issue type
      let hereWhitelisted = false;
      const srefSlug24 = n.sref ? (n.sref.match(/translate\/([^\s;,]+)/) || [])[1] : '';
      if (srefSlug24) {
        const tpls = _templateMap.get(srefSlug24);
        if (tpls && tpls.length) {
          for (const tpl of tpls) {
            if (/^Here[, ]/.test(tpl.template)) {
              // Build a prefix from the template: replace placeholders with flexible matchers
              const tplPrefix = tpl.template
                .slice(0, 60)
                .replace(/\*\*[^*]+\*\*/g, '\\*\\*[^*]+\\*\\*')
                .replace(/\b[A-Z]{2,}\b/g, '\\S+');
              try {
                if (new RegExp('^' + tplPrefix).test(n.note)) {
                  hereWhitelisted = true;
                  break;
                }
              } catch (_) { /* invalid regex from template — skip */ }
            }
          }
        }
      }
      if (!hereWhitelisted && !/^Here,?\s+\*\*[a-z]/.test(n.note)) {
        addFinding(n.row, n.ref, n.id, 'warning', 'here_rule',
          'Note starts with "Here" but next content is not a bolded lowercase quote');
      }
    }

    // 25. Template conformance — note opening must match the first fixed phrase
    // from the RESOLVED template selected for this note (prepItem.template_text).
    // Falling back to the first templates.csv row for the sref pulls in a
    // different sub-type's filled example when several templates exist (e.g.
    // figs-metaphor "heart") — a false positive. So the fallback applies only
    // when the sref has exactly one template; otherwise, with no resolved
    // template, skip the check.
    let templateFirstPhrase = '';
    {
      let templateText = prepItem?.template_text || '';
      if (!templateText) {
        const srefSlug25 = n.sref ? (n.sref.match(/translate\/([^\s;,]+)/) || [])[1] : '';
        const tpls25 = srefSlug25 ? _templateMap.get(srefSlug25) : null;
        if (tpls25 && tpls25.length === 1) templateText = tpls25[0].template;
      }
      if (templateText) {
        // Extract the first fixed phrase from the template (between start/placeholder boundaries)
        // Strip AT, bold placeholders, and split on ALL-CAPS words
        const cleaned = templateText
          .replace(/Alternate translation:.*$/i, '')
          .replace(/\*\*[^*]+\*\*/g, '\x00')  // mark **bold** placeholder positions
          .replace(/\b[A-Z]{2,}\b/g, '\x00');  // mark ALL-CAPS placeholder positions
        // Split on placeholder markers and take the first substantial segment
        const firstPhrase = cleaned
          .split('\x00')
          .map(s => s.trim().replace(/\s+/g, ' '))
          .find(s => s.length > 15);
        if (firstPhrase) {
          templateFirstPhrase = firstPhrase;
          // Strip bold and brackets from note for comparison
          const noteStripped = n.note
            .replace(/\*\*[^*]+\*\*/g, ' ')
            .replace(/\[[^\]]*\]/g, ' ')
            .replace(/\s+/g, ' ')
            .toLowerCase();
          if (!noteStripped.includes(firstPhrase.toLowerCase())) {
            addFinding(n.row, n.ref, n.id, 'warning', 'template_deviation',
              `Note may deviate from canonical template. Expected opening phrase: "${firstPhrase.slice(0, 80)}"`);
          }
        }
      }
    }

    // 25b. Contamination phrase detection
    {
      const CONTAMINATION_PHRASES = [
        'not looking for information',
        'not seeking information',
        'not asking for information',
        'does not expect an answer',
      ];
      for (const phrase of CONTAMINATION_PHRASES) {
        if (n.note.toLowerCase().includes(phrase)) {
          addFinding(n.row, n.ref, n.id, 'error', 'contamination_phrase',
            `Note contains known contamination phrase: "${phrase}"`);
          break;
        }
      }
    }

    // 25c. Self-talk / reasoning leakage. The per-note generator takes the model's
    // final message verbatim (notes-pipeline.js runPerNoteGeneration) — the only
    // cleanup is trim + trailing-AT strip. When the model deliberates out loud
    // instead of emitting just the note, its reasoning ships to Door43 inside the
    // Note column (MIC 5:7, 2026-08-03: a "wait, actually..." paragraph published
    // above an otherwise-correct figs-parallelism note). Check 25 could not catch
    // it: the template phrase WAS present, in the second paragraph.
    //
    // Deliberately WARNING, not error: an editor rewriting one leaked note a month
    // is far cheaper than a blocked push losing a whole chapter of notes.
    //
    // Measured against the 215 published golden notes (JOS 1/3, MAL 1, NAM 1):
    // 1 false positive total (NAM 1 "tell his readers to actually look"). Bold
    // quotes and bracketed ATs are stripped first — verse text legitimately
    // contains first-person pronouns.
    {
      const leakLabel = detectSelfTalk(n.note);
      if (leakLabel) {
        addFinding(n.row, n.ref, n.id, 'warning', 'self_talk_leak',
          `Note may contain model self-talk rather than note text: ${leakLabel}`);
      }

      // Structural signal for the same failure: a leading paragraph that is not
      // the note, followed by the real note. Only fires when the resolved
      // template is known and its fixed phrase is absent from the FIRST
      // paragraph — 4 of the 215 golden notes are legitimately multi-paragraph,
      // and those keep the template up front.
      if (templateFirstPhrase) {
        const paras = n.note.split(/\\n|\n|<br\s*\/?>/i).map(s => s.trim()).filter(Boolean);
        if (paras.length > 1) {
          const firstPara = paras[0]
            .replace(/\*\*[^*]+\*\*/g, ' ')
            .replace(/\[[^\]]*\]/g, ' ')
            .replace(/\s+/g, ' ')
            .toLowerCase();
          if (!firstPara.includes(templateFirstPhrase.toLowerCase())) {
            addFinding(n.row, n.ref, n.id, 'warning', 'preamble_paragraph',
              'Note has multiple paragraphs and the first does not contain the template phrase — possible preamble before the real note');
          }
        }
      }
    }
  }

  // Check 20c: Near-duplicate detection across adjacent verse notes with same issue slug
  {
    const STOPWORDS = new Set(['the','a','an','and','or','but','in','on','at','to','for','of','is','was','it','this','that','are','be','by','as','with','from','not','have','has','had','he','she','they','we','you','his','her','their','its','our','your','i','me','him','them','us','my','who','what','which']);
    function contentWords(text) {
      return text.toLowerCase()
        .replace(/\*\*[^*]*\*\*/g, ' ')
        .replace(/\[[^\]]*\]/g, ' ')
        .split(/\W+/)
        .filter(w => w.length > 2 && !STOPWORDS.has(w));
    }
    function boldedWords(text) {
      const matches = text.match(/\*\*([^*]+)\*\*/g) || [];
      return matches.map(m => m.replace(/\*\*/g, '').toLowerCase().trim()).filter(Boolean);
    }
    function verseNum(ref) {
      const m = ref.match(/:(\d+)/);
      return m ? parseInt(m[1], 10) : 0;
    }
    for (const [slug, slugNotes] of Object.entries(notesBySrefSlug)) {
      for (let i = 0; i < slugNotes.length; i++) {
        for (let j = i + 1; j < slugNotes.length; j++) {
          const ni = slugNotes[i], nj = slugNotes[j];
          if (Math.abs(verseNum(ni.ref) - verseNum(nj.ref)) > 2) continue;
          const wi = contentWords(ni.note);
          const wj = contentWords(nj.note);
          if (!wi.length || !wj.length) continue;
          const setJ = new Set(wj);
          const overlap = wi.filter(w => setJ.has(w)).length / Math.max(wi.length, wj.length);
          if (overlap >= 0.75) {
            // Suppress cross-verse duplicates when bolded words (variable fill-ins) differ —
            // this means template-faithful notes on different source text, not true duplicates.
            if (verseNum(ni.ref) !== verseNum(nj.ref)) {
              const bi = boldedWords(ni.note);
              const bj = boldedWords(nj.note);
              if (bi.length && bj.length) {
                const setBj = new Set(bj);
                const boldOverlap = bi.filter(w => setBj.has(w)).length / Math.max(bi.length, bj.length);
                if (boldOverlap < 0.75) continue; // Different variable parts — template-driven, not duplicate
              }
            }
            addFinding(nj.row, nj.ref, nj.id, 'warning', 'multiverse_duplicate',
              `Near-duplicate of note ${ni.id} at ${ni.ref} (${Math.round(overlap * 100)}% overlap, same "${slug}" issue)`);
          }
        }
      }
    }
  }

  // Prepend warning if upstream ID fetch failed (check 3)
  if (book && upstreamIds === null) {
    findings.unshift({ row: 0, reference: '', id: '', severity: 'warning', category: 'id_collision',
      message: `Could not fetch upstream TN IDs for ${book} — collision check skipped` });
  }

  const summary = {
    total_notes: notes.length,
    errors: findings.filter(f => f.severity === 'error').length,
    warnings: findings.filter(f => f.severity === 'warning').length,
    clean: notes.length - new Set(findings.filter(f => f.row > 0).map(f => f.row)).size,
  };

  const result = JSON.stringify({ summary, findings }, null, 2);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, result);
  return `Quality check: ${summary.total_notes} notes, ${summary.errors} errors, ${summary.warnings} warnings, ${summary.clean} clean\n${outPath}`;
}

module.exports = {
  validateTnTsv,
  checkTnQuality,
  detectSelfTalk,
  parseHebrewVerseWords,
  normalizeHebrewQuote,
};
