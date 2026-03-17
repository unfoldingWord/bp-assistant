// quality-tools.js — Node.js ports of TN quality check scripts
//
// Replaces: check_tn_quality.py, validate_tn_tsv.py

const fs = require('fs');
const path = require('path');

const CSKILLBP_DIR = process.env.CSKILLBP_DIR || '/srv/bot/workspace';

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

// --- check_tn_quality ---

function checkTnQuality({ tsvPath, preparedJson, ultUsfm, ustUsfm, book, hebrewUsfm, output }) {
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

  // Load translation issues for SRef validation
  const validIssues = new Set();
  const issuesFile = path.join(CSKILLBP_DIR, 'data', 'translation-issues.csv');
  if (fs.existsSync(issuesFile)) {
    for (const line of fs.readFileSync(issuesFile, 'utf8').split('\n')) {
      const slug = line.split(',')[0];
      if (slug && slug !== 'slug') validIssues.add(slug);
    }
  }

  const findings = [];
  const seenIds = new Set();

  function addFinding(row, ref, id, severity, category, message) {
    findings.push({ row, reference: ref, id, severity, category, message });
  }

  for (const n of notes) {
    // 1. ID format
    if (!ID_RE.test(n.id)) addFinding(n.row, n.ref, n.id, 'error', 'id_format', `Invalid ID: "${n.id}"`);

    // 2. ID uniqueness
    if (seenIds.has(n.id)) addFinding(n.row, n.ref, n.id, 'error', 'id_duplicate', `Duplicate ID: "${n.id}"`);
    seenIds.add(n.id);

    // 4. Hebrew quote (RTL check)
    if (n.quote) {
      const hasRtl = /[\u0590-\u05FF\u0600-\u06FF\uFB1D-\uFDFF\uFE70-\uFEFF]/.test(n.quote);
      if (!hasRtl) addFinding(n.row, n.ref, n.id, 'warning', 'hebrew_quote', 'Quote column has no RTL characters');
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

    // 7. gl_quote in ULT
    if (glQuote && ultVerse) {
      const cleanGlq = glQuote.replace(/\{[^}]*\}/g, '').trim();
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

    // 17. SupportReference validation
    if (n.sref) {
      const slugMatch = n.sref.match(/rc:\/\/\*\/ta\/man\/translate\/([^\s;,]+)/);
      if (slugMatch && validIssues.size && !validIssues.has(slugMatch[1])) {
        addFinding(n.row, n.ref, n.id, 'warning', 'unknown_sref', `Unknown issue type: "${slugMatch[1]}"`);
      }
    }

    // 21. rquestion AT punctuation
    if (n.sref && n.sref.includes('figs-rquestion') && atMatch) {
      const ats = n.note.match(/\[([^\]]+)\]/g) || [];
      for (const atRaw of ats) {
        const at = atRaw.slice(1, -1).trim();
        if (at.endsWith('?')) {
          addFinding(n.row, n.ref, n.id, 'warning', 'rquestion_punctuation', 'Rhetorical question AT should not end with "?"');
        }
      }
    }
  }

  const summary = {
    total_notes: notes.length,
    errors: findings.filter(f => f.severity === 'error').length,
    warnings: findings.filter(f => f.severity === 'warning').length,
    clean: notes.length - new Set(findings.map(f => f.row)).size,
  };

  const result = JSON.stringify({ summary, findings }, null, 2);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, result);
  return `Quality check: ${summary.total_notes} notes, ${summary.errors} errors, ${summary.warnings} warnings, ${summary.clean} clean\n${outPath}`;
}

module.exports = { validateTnTsv, checkTnQuality };
