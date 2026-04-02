// quality-tools.js — Node.js ports of TN quality check scripts
//
// Replaces: check_tn_quality.py, validate_tn_tsv.py

const fs = require('fs');
const path = require('path');
const https = require('https');

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

    // 4. Hebrew quote (RTL check) — empty quote is error, no RTL is error
    if (!n.quote) {
      addFinding(n.row, n.ref, n.id, 'error', 'empty_quote', 'Quote column is empty');
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

    // Get ULT/UST verse context
    const prepItem = prepItems[n.id] || {};
    const ultVerse = prepItem.ult_verse || ultVerses[n.ref] || '';
    const ustVerse = prepItem.ust_verse || ustVerses[n.ref] || '';
    const glQuote = prepItem.gl_quote || '';

    // Extract ATs for this note
    const ats = extractAts(n.note);

    // 6. AT text must NOT appear verbatim in UST verse
    if (ustVerse && ats.length) {
      for (const at of ats) {
        const atLower = at.toLowerCase();
        const ustLower = ustVerse.toLowerCase();
        if (atLower && ustLower.includes(atLower)) {
          addFinding(n.row, n.ref, n.id, 'warning', 'at_not_ust', `AT text "${at.slice(0, 50)}" appears verbatim in UST verse`);
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

    // 8. Bold accuracy
    const boldMatches = n.note.match(/\*\*([^*]+)\*\*/g) || [];
    for (const bold of boldMatches) {
      const text = bold.slice(2, -2);
      if (ultVerse && !ultVerse.includes(text)) {
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
    if (glQuote && ultVerse && ats.length) {
      const cleanGlq = stripBraces(glQuote);
      const ultStripped = ultVerse.replace(/\{[^}]*\}/g, '');
      const idx = ultStripped.toLowerCase().indexOf(cleanGlq.toLowerCase());
      let position = 'mid_sentence';
      if (idx === 0) {
        position = 'verse_start';
      } else if (idx > 0) {
        const before = ultStripped.slice(0, idx).trimEnd();
        if (before.length === 0) position = 'verse_start';
        else if (before.endsWith('.')) position = 'after_period';
      }
      for (const at of ats) {
        if (!at) continue;
        const firstChar = at[0];
        if ((position === 'verse_start' || position === 'after_period') && /[a-z]/.test(firstChar)) {
          addFinding(n.row, n.ref, n.id, 'warning', 'at_capitalization', `AT "${at.slice(0, 40)}" should start with uppercase (${position})`);
        } else if (position === 'mid_sentence' && /[A-Z]/.test(firstChar)) {
          const firstWord = at.split(/\s+/)[0];
          if (!PROPER_NOUNS.has(firstWord)) {
            addFinding(n.row, n.ref, n.id, 'warning', 'at_capitalization', `AT "${at.slice(0, 40)}" starts uppercase mid-sentence`);
          }
        }
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
        addFinding(n.row, n.ref, n.id, 'warning', 'unknown_sref', `Unknown issue type: "${slugMatch[1]}"`);
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

    // 22. Missing AT when required
    if (prepItem.needs_at || prepItem.tcm_mode) {
      if (!n.note.includes('Alternate translation:')) {
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

    // 24. "Here" rule compliance
    if (/^Here[, ]/.test(n.note)) {
      if (!/^Here,?\s+\*\*[a-z]/.test(n.note)) {
        addFinding(n.row, n.ref, n.id, 'warning', 'here_rule',
          'Note starts with "Here" but next content is not a bolded lowercase quote');
      }
    }

    // 25. Template fixed-phrase adherence
    {
      const srefSlug = n.sref ? (n.sref.match(/translate\/([^\s;,]+)/) || [])[1] : '';
      const TEMPLATE_PHRASES = {
        'figs-abstractnouns': [/you could express the same idea/i],
        'figs-rquestion': [/rhetorical question/i],
        'figs-metaphor': [/speak/i],
      };
      const phrases = TEMPLATE_PHRASES[srefSlug];
      if (phrases && !phrases.some(re => re.test(n.note))) {
        addFinding(n.row, n.ref, n.id, 'warning', 'template_phrase_missing',
          `Note for "${srefSlug}" missing expected template phrase`);
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

module.exports = { validateTnTsv, checkTnQuality };
