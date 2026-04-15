// issue-normalizer.js — Deterministic chapter-level normalization for issue TSVs

const fs = require('fs');
const path = require('path');
const { CSKILLBP_DIR } = require('./pipeline-utils');

const DEFAULTS = {
  highParallelismThreshold: 5,
  exceptionCap: 1,
  duplicateSimilarityThreshold: 0.75,
  uniqueReasonCodes: new Set(['tricola', 'pivot', 'ellipsis-critical', 'structure-shift']),
};

function parseTsvLine(line) {
  const cols = line.split('\t');
  while (cols.length < 7) cols.push('');
  return cols;
}

function toTsvLine(cols) {
  return cols.join('\t');
}

function normalizeIssueType(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  const rc = text.match(/translate\/([^\s;,]+)/i);
  if (rc) return rc[1].trim().toLowerCase();
  return text.toLowerCase();
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function jaccardSimilarity(aText, bText) {
  const a = new Set(tokenize(aText));
  const b = new Set(tokenize(bText));
  if (!a.size && !b.size) return 1;
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

function hasFirstInstanceTag(explanation) {
  const txt = String(explanation || '');
  return /\bt:\s*first\s+instance\b/i.test(txt) || /\bfirst\s+instance\b/i.test(txt);
}

function stripFirstInstanceTag(explanation) {
  let txt = String(explanation || '');
  txt = txt
    .replace(/\b(?:;\s*)?t:\s*first\s+instance\b(?:\s*[-–—:]\s*)?/ig, ' ')
    .replace(/\b(?:;\s*)?first\s+instance\b(?:\s*[-–—:]\s*)?/ig, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();
  return txt;
}

function extractUniqueReason(explanation, reasonCodes) {
  const m = String(explanation || '').match(/\breason:\s*([a-z-]+)/i);
  if (!m) return null;
  const code = m[1].toLowerCase();
  return reasonCodes.has(code) ? code : null;
}

function classifyParallelism(explanation) {
  const text = String(explanation || '').toLowerCase();
  if (/\bsynthetic\s+parallelism\b/.test(text)) return 'synthetic';
  if (/\bantithetical\s+parallelism\b/.test(text)) return 'antithetical';
  return 'synonymous_or_unspecified';
}

function buildIntroSignal(rawSynonymousCount, threshold) {
  return rawSynonymousCount >= threshold
    ? { parallelism_signal: 'high', parallelism_synonymous_count: rawSynonymousCount }
    : { parallelism_signal: null, parallelism_synonymous_count: rawSynonymousCount };
}

function normalizeDiscontinuousQuoteSyntax(quote) {
  return String(quote || '')
    .replace(/\s*(?:\.{3}|\u2026)\s*/g, ' & ')
    .replace(/\s*&\s*/g, ' & ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function normalizeComparableText(text) {
  return String(text || '')
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/\s*(?:\.{3}|\u2026)\s*/g, ' & ')
    .toLowerCase()
    .replace(/[^a-z0-9&\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function quoteWordTokens(text) {
  return normalizeComparableText(text)
    .replace(/\s*&\s*/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function quoteIsCoveredByLargerQuote(smaller, larger) {
  const smallNorm = normalizeComparableText(smaller);
  const largeNorm = normalizeComparableText(larger);
  if (!smallNorm || !largeNorm || smallNorm === largeNorm) return false;
  if (largeNorm.includes(smallNorm)) return true;

  const smallTokens = quoteWordTokens(smaller);
  const largeTokenSet = new Set(quoteWordTokens(larger));
  if (!smallTokens.length) return false;
  return smallTokens.every((token) => largeTokenSet.has(token));
}

function normalizeExplanationStem(explanation) {
  return normalizeComparableText(
    String(explanation || '')
      .replace(/\bq:\s*[a-z-]+/ig, ' ')
      .replace(/\breason:\s*[a-z-]+/ig, ' ')
      .replace(/\bt:\s*first\s+instance\b/ig, ' ')
  );
}

function normalizeIssueRows(lines, options = {}) {
  const cfg = {
    highParallelismThreshold: options.highParallelismThreshold ?? DEFAULTS.highParallelismThreshold,
    exceptionCap: options.exceptionCap ?? DEFAULTS.exceptionCap,
    duplicateSimilarityThreshold: options.duplicateSimilarityThreshold ?? DEFAULTS.duplicateSimilarityThreshold,
    uniqueReasonCodes: options.uniqueReasonCodes || DEFAULTS.uniqueReasonCodes,
  };

  const output = [];
  const summary = {
    total_rows: 0,
    total_parallelism_rows: 0,
    raw_synonymous_parallelism_rows: 0,
    kept_parallelism_rows: 0,
    kept_parallelism_exceptions: 0,
    dropped_parallelism_rows: 0,
    dropped_nonsynonymous_parallelism_rows: 0,
    dropped_unqualified_parallelism_rows: 0,
    dropped_duplicate_parallelism_rows: 0,
    dropped_exception_cap_parallelism_rows: 0,
    dropped_invalid_reason_parallelism_rows: 0,
    first_instance_tags_removed: 0,
    dropped_braced_ellipsis_rows: 0,
    dropped_parallelism_overlap_doublets: 0,
    dropped_split_snippet_rows: 0,
    normalized_discontinuous_quotes: 0,
  };

  let firstKeptParallelism = null;
  const keptParallelismRows = [];
  let keptExceptionCount = 0;
  let firstInstanceAssigned = false;

  for (const line of lines) {
    if (!line.trim()) continue;
    const cols = parseTsvLine(line);
    const isHeader = cols[0].toLowerCase() === 'book' && String(cols[1] || '').toLowerCase() === 'reference';
    if (isHeader) {
      output.push(toTsvLine(cols));
      continue;
    }
    summary.total_rows++;

    const issueType = normalizeIssueType(cols[2]);
    if (issueType !== 'figs-parallelism') {
      output.push(toTsvLine(cols));
      continue;
    }

    summary.total_parallelism_rows++;
    const explanation = cols[6] || '';
    const quote = cols[3] || '';
    const classification = classifyParallelism(explanation);
    if (classification === 'synonymous_or_unspecified') {
      summary.raw_synonymous_parallelism_rows++;
    }

    if (classification === 'synthetic' || classification === 'antithetical') {
      summary.dropped_parallelism_rows++;
      summary.dropped_nonsynonymous_parallelism_rows++;
      continue;
    }

    if (!firstKeptParallelism) {
      firstKeptParallelism = { quote, explanation, ref: cols[1] };
      keptParallelismRows.push(firstKeptParallelism);
      if (hasFirstInstanceTag(explanation)) {
        firstInstanceAssigned = true;
      }
      summary.kept_parallelism_rows++;
      output.push(toTsvLine(cols));
      continue;
    }

    const hasUniqueQualifier = /\bq:\s*unique-parallelism\b/i.test(explanation);
    const reasonCode = extractUniqueReason(explanation, cfg.uniqueReasonCodes);
    if (!hasUniqueQualifier) {
      summary.dropped_parallelism_rows++;
      summary.dropped_unqualified_parallelism_rows++;
      continue;
    }

    if (!reasonCode) {
      summary.dropped_parallelism_rows++;
      summary.dropped_invalid_reason_parallelism_rows++;
      continue;
    }

    if (keptExceptionCount >= cfg.exceptionCap) {
      summary.dropped_parallelism_rows++;
      summary.dropped_exception_cap_parallelism_rows++;
      continue;
    }

    const candidateText = `${quote} ${explanation}`;
    const isNearDuplicate = keptParallelismRows.some((k) => {
      const baseText = `${k.quote} ${k.explanation}`;
      return jaccardSimilarity(baseText, candidateText) >= cfg.duplicateSimilarityThreshold;
    });
    if (isNearDuplicate) {
      summary.dropped_parallelism_rows++;
      summary.dropped_duplicate_parallelism_rows++;
      continue;
    }

    if (hasFirstInstanceTag(explanation)) {
      if (firstInstanceAssigned) {
        cols[6] = stripFirstInstanceTag(explanation);
        summary.first_instance_tags_removed++;
      } else {
        firstInstanceAssigned = true;
      }
    }

    const kept = { quote, explanation: cols[6] || '', ref: cols[1] };
    keptParallelismRows.push(kept);
    keptExceptionCount++;
    summary.kept_parallelism_rows++;
    summary.kept_parallelism_exceptions++;
    output.push(toTsvLine(cols));
  }

  // Second pass: ensure only one first-instance marker among kept rows.
  if (summary.kept_parallelism_rows > 0) {
    let seen = false;
    for (let i = 0; i < output.length; i++) {
      const cols = parseTsvLine(output[i]);
      if (normalizeIssueType(cols[2]) !== 'figs-parallelism') continue;
      const exp = cols[6] || '';
      if (!hasFirstInstanceTag(exp)) continue;
      if (!seen) {
        seen = true;
      } else {
        cols[6] = stripFirstInstanceTag(exp);
        output[i] = toTsvLine(cols);
        summary.first_instance_tags_removed++;
      }
    }
  }

  const postProcessed = [];
  const dataRows = [];
  for (const line of output) {
    const cols = parseTsvLine(line);
    const isHeader = cols[0].toLowerCase() === 'book' && String(cols[1] || '').toLowerCase() === 'reference';
    if (isHeader) {
      postProcessed.push(toTsvLine(cols));
      continue;
    }
    const normalizedQuote = normalizeDiscontinuousQuoteSyntax(cols[3] || '');
    if (normalizedQuote !== (cols[3] || '')) {
      cols[3] = normalizedQuote;
      summary.normalized_discontinuous_quotes++;
    }
    dataRows.push({
      cols,
      issueType: normalizeIssueType(cols[2]),
      ref: cols[1] || '',
      quote: cols[3] || '',
      explanation: cols[6] || '',
      drop: false,
    });
  }

  const keptParallelismByRef = new Map();
  for (const row of dataRows) {
    if (row.issueType !== 'figs-parallelism' || row.drop) continue;
    if (!keptParallelismByRef.has(row.ref)) keptParallelismByRef.set(row.ref, []);
    keptParallelismByRef.get(row.ref).push(row);
  }

  for (const row of dataRows) {
    if (row.issueType === 'figs-ellipsis' && /\{[^}]+\}/.test(row.quote)) {
      row.drop = true;
      summary.dropped_braced_ellipsis_rows++;
      continue;
    }

    if (row.issueType === 'figs-doublet') {
      const parallelismRows = keptParallelismByRef.get(row.ref) || [];
      if (parallelismRows.some((parallelismRow) => quoteIsCoveredByLargerQuote(row.quote, parallelismRow.quote))) {
        row.drop = true;
        summary.dropped_parallelism_overlap_doublets++;
      }
    }
  }

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    if (row.drop) continue;
    for (let j = 0; j < dataRows.length; j++) {
      if (i === j) continue;
      const candidate = dataRows[j];
      if (candidate.drop) continue;
      if (row.ref !== candidate.ref || row.issueType !== candidate.issueType) continue;
      if (!quoteIsCoveredByLargerQuote(row.quote, candidate.quote)) continue;

      const rowStem = normalizeExplanationStem(row.explanation);
      const candidateStem = normalizeExplanationStem(candidate.explanation);
      if (!rowStem || !candidateStem) continue;
      if (rowStem !== candidateStem) continue;

      row.drop = true;
      summary.dropped_split_snippet_rows++;
      break;
    }
  }

  for (const row of dataRows) {
    if (!row.drop) postProcessed.push(toTsvLine(row.cols));
  }

  const introSignal = buildIntroSignal(
    summary.raw_synonymous_parallelism_rows,
    cfg.highParallelismThreshold
  );

  return { lines: postProcessed, summary, introSignal };
}

/**
 * Detect the column format and normalize to canonical 7-col:
 *   Book  Reference  SRef  GLQuote  NeedsAT  AT  Explanation
 *
 * When a Hebrew column is present, appends its value as [heb:...] in the explanation.
 * Returns the normalized lines array (no header row in output).
 */
function normalizeColumnFormat(lines, fileBook) {
  if (!lines.length) return { lines: [], reformatted: false };

  const firstCols = lines[0].split('\t');
  const firstLower = firstCols.map(c => (c || '').trim().toLowerCase());

  // Check for header row
  const headerKeywords = ['reference', 'issue', 'hebrew', 'ult_quote', 'hint', 'quote', 'note', 'occurrence', 'supportreference', 'id', 'tags'];
  const hasHeader = firstLower.some(h => headerKeywords.includes(h));

  // If it already looks like canonical format (first col is a book code or 'Book'), pass through
  if (!hasHeader) {
    const first = firstCols[0]?.trim();
    // Canonical: starts with book code (3 letters) or is a chapter:verse reference
    if (/^[A-Z0-9]{2,3}$/i.test(first) || (first?.toLowerCase() === 'book')) {
      return { lines, reformatted: false };
    }
    // If first col is a reference like "2:1", it's a headerless new format
    if (/^\d+:\d+/.test(first)) {
      // No header, Reference in col 0. Map columns heuristically.
      const output = [];
      for (const line of lines) {
        const cols = line.split('\t');
        while (cols.length < 4) cols.push('');
        const ref = cols[0]?.trim();
        const sref = cols[1]?.trim() || '';
        // Detect Hebrew in any column — append as hint
        let hebrew = '';
        let glQuote = '';
        let explanation = '';
        for (let i = 2; i < cols.length; i++) {
          const val = (cols[i] || '').trim();
          if (/[\u0590-\u05FF]/.test(val) && !hebrew) { hebrew = val; }
          else if (!glQuote && !hebrew && val && !/^\d+$/.test(val)) { glQuote = val; }
          else if (!glQuote && val && !/^\d+$/.test(val) && !/[\u0590-\u05FF]/.test(val)) { glQuote = val; }
          else if (val && val.length > glQuote.length && !/[\u0590-\u05FF]/.test(val) && !/^\d+$/.test(val)) { explanation = val; }
        }
        // If no clear explanation, use last non-empty non-Hebrew non-numeric column
        if (!explanation) {
          for (let i = cols.length - 1; i >= 2; i--) {
            const val = (cols[i] || '').trim();
            if (val && !/[\u0590-\u05FF]/.test(val) && val !== glQuote && !/^\d+$/.test(val)) {
              explanation = val;
              break;
            }
          }
        }
        if (hebrew) explanation = (explanation ? explanation + ' ' : '') + `[heb:${hebrew}]`;
        output.push(`${fileBook}\t${ref}\t${sref}\t${glQuote}\t\t\t${explanation}`);
      }
      return { lines: output, reformatted: true };
    }
    return { lines, reformatted: false };
  }

  // Has header — build column map
  const hMap = {};
  firstLower.forEach((h, i) => { hMap[h] = i; });

  const refIdx = hMap['reference'] ?? hMap['ref'] ?? -1;
  const srefIdx = hMap['issue'] ?? hMap['supportreference'] ?? hMap['sref'] ?? hMap['issue_type'] ?? -1;
  const glIdx = hMap['ult_quote'] ?? hMap['glquote'] ?? hMap['gl_quote'] ?? hMap['quote'] ?? -1;
  const hebIdx = hMap['hebrew'] ?? hMap['heb'] ?? -1;
  const noteIdx = hMap['explanation'] ?? hMap['hint'] ?? hMap['note'] ?? -1;
  const needsAtIdx = hMap['needs_at'] ?? hMap['go?'] ?? -1;
  const atIdx = hMap['at'] ?? hMap['at_provided'] ?? -1;

  const output = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t');
    const get = (idx) => (idx >= 0 && idx < cols.length) ? (cols[idx] || '').trim() : '';

    let ref = get(refIdx);
    // Strip book prefix from reference (e.g., "ZEC 2:1" → "2:1")
    ref = ref.replace(/^[A-Z0-9]{2,3}\s+/i, '');
    if (!ref || !/\d/.test(ref)) continue; // skip non-data rows

    const sref = get(srefIdx);
    const glQuote = get(glIdx);
    const needsAt = get(needsAtIdx);
    const at = get(atIdx);
    let explanation = get(noteIdx);
    const hebrew = get(hebIdx);

    if (hebrew) explanation = (explanation ? explanation + ' ' : '') + `[heb:${hebrew}]`;

    output.push(`${fileBook}\t${ref}\t${sref}\t${glQuote}\t${needsAt}\t${at}\t${explanation}`);
  }
  return { lines: output, reformatted: true };
}

function normalizeIssuesFile({ issuesPath, options = {} }) {
  const absPath = path.resolve(CSKILLBP_DIR, issuesPath);
  const content = fs.readFileSync(absPath, 'utf8');
  const hadTrailingNewline = content.endsWith('\n');
  const lines = content.split('\n').filter((line) => line.trim().length > 0);

  // Step 0: Normalize column format to canonical 7-col
  const fnMatch = path.basename(absPath).match(/([A-Z0-9]+)-(\d+)/i);
  const fileBook = fnMatch ? fnMatch[1].toUpperCase() : '';
  const colResult = normalizeColumnFormat(lines, fileBook);
  const normalizedLines = colResult.lines;

  const result = normalizeIssueRows(normalizedLines, options);
  const outputText = result.lines.join('\n') + (hadTrailingNewline ? '\n' : '');
  fs.writeFileSync(absPath, outputText);
  return {
    normalizedPath: issuesPath,
    summary: { ...result.summary, columnFormatReformatted: colResult.reformatted },
    introSignal: result.introSignal,
  };
}

function buildParallelismIntroHintArgs(introSignal) {
  if (!introSignal || introSignal.parallelism_signal !== 'high') return '';
  const count = Number(introSignal.parallelism_synonymous_count || 0);
  return ` --parallelism-signal high --parallelism-count ${count}`;
}

module.exports = {
  normalizeIssueRows,
  normalizeIssuesFile,
  buildParallelismIntroHintArgs,
};
