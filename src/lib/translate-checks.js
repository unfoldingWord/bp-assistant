// translate-checks.js — deterministic QA checks for translated tN rows.
//
// Pure functions, no LLM, no I/O. Implements PIPELINE-SPEC.md §5 (blocking
// subset + warnings), adapted where the spec met reality:
// - Input is (sourceRows, targetRows) keyed by the ID column. Every check is
//   per-row; runChecks also emits row-set-level violations (missing/extra IDs).
// - severity 'error' → must block apply. severity 'warning' → surface, don't block.
//
// Check IDs are stable strings so callers can allowlist/deny specific checks.

'use strict';

const { TN_COLUMNS } = require('./tn-tsv');

// Everything except the Note column must pass through byte-identical.
const PASS_THROUGH_COLUMNS = TN_COLUMNS.filter((c) => c !== 'Note');

// rc:// URIs. Link targets are never localized; display text may be. The body
// of a link (`rc://*/ta/man/translate/figs-metaphor`) contains `*` and `/`, so
// only stop at whitespace or the closing `]`/`)` of the surrounding markdown.
const RC_LINK_RE = /rc:\/\/[^\s\])]+/g;

function extractRcLinks(s) {
  return (s.match(RC_LINK_RE) || []).map((x) => x.replace(/[).,;]+$/, ''));
}

// Multiset compare of two string arrays.
function sameMultiset(a, b) {
  if (a.length !== b.length) return false;
  const count = new Map();
  for (const x of a) count.set(x, (count.get(x) || 0) + 1);
  for (const x of b) {
    const n = count.get(x);
    if (!n) return false;
    count.set(x, n - 1);
  }
  return true;
}

function violation(check, severity, rowId, message) {
  return { check, severity, rowId, message };
}

/**
 * Per-row checks. source and target are parsed tN row objects sharing an ID.
 * Returns array of violations (possibly empty).
 */
function checkRow(source, target) {
  const v = [];
  const id = source.ID;

  // 1. Pass-through columns byte-identical (the Aquilla-corruption class).
  for (const col of PASS_THROUGH_COLUMNS) {
    if (source[col] !== target[col]) {
      v.push(violation(`passthrough-${col.toLowerCase()}`, 'error', id,
        `${col} modified: ${JSON.stringify(source[col])} → ${JSON.stringify(target[col])}`));
    }
  }

  // 2. Occurrence parses as non-negative integer (defense in depth; if
  //    pass-through held, this only fails when the source itself is corrupt).
  if (!/^-?\d+$/.test(target.Occurrence) || Number(target.Occurrence) < -1) {
    // -1 is legal in tN TSVs ("all occurrences"); anything below is not.
    v.push(violation('occurrence-int', 'error', id,
      `Occurrence not a valid integer: ${JSON.stringify(target.Occurrence)}`));
  }

  const src = source.Note ?? '';
  const tgt = target.Note ?? '';

  // 3. Empty translation.
  if (src.trim() !== '' && tgt.trim() === '') {
    v.push(violation('empty-translation', 'error', id, 'target Note empty while source non-empty'));
  }

  // 4. Untranslated pass-through (identical to source). Warning: legitimate
  //    for notes that are pure rc:// link lists or names.
  if (src.trim() !== '' && src === tgt) {
    v.push(violation('identical-to-source', 'warning', id, 'target Note identical to source'));
  }

  // 5. Embedded real tab/newline would corrupt the TSV. (Parsed rows can
  //    only carry these if constructed programmatically — still check.)
  if (/[\t\n\r]/.test(tgt)) {
    v.push(violation('embedded-control-char', 'error', id, 'target Note contains real tab/newline'));
  }

  // 6. rc:// links preserved verbatim (multiset).
  const srcLinks = extractRcLinks(src);
  const tgtLinks = extractRcLinks(tgt);
  if (!sameMultiset(srcLinks, tgtLinks)) {
    v.push(violation('rc-links', 'error', id,
      `rc:// links differ: source has [${srcLinks.join(', ')}], target has [${tgtLinks.join(', ')}]`));
  }

  if (tgt.trim() !== '') {
    // 7. Markdown structure parity: balanced ** in target; alternate-translation
    //    bracket-construct count parity with source. Warning severity.
    const boldCount = (tgt.match(/\*\*/g) || []).length;
    if (boldCount % 2 !== 0) {
      v.push(violation('markdown-bold-balance', 'warning', id, `unbalanced ** markers (${boldCount})`));
    }
    // en_tn alternate translations use [bracketed] segments after "Alternate
    // translation:"; count parity of [ and ] within each note.
    const srcAltOpens = (src.match(/\[/g) || []).length;
    const srcAltCloses = (src.match(/\]/g) || []).length;
    const tgtAltOpens = (tgt.match(/\[/g) || []).length;
    const tgtAltCloses = (tgt.match(/\]/g) || []).length;
    if (tgtAltOpens !== tgtAltCloses) {
      v.push(violation('bracket-balance', 'warning', id,
        `unpaired brackets in target ([=${tgtAltOpens}, ]=${tgtAltCloses})`));
    } else if (srcAltOpens === srcAltCloses && srcAltOpens !== tgtAltOpens) {
      v.push(violation('bracket-count-parity', 'warning', id,
        `bracket construct count differs (source ${srcAltOpens}, target ${tgtAltOpens})`));
    }

    // 8. Number integrity: digit runs in source Note should appear in target
    //    (verse refs inside notes). Warning — legit renumbering exists (e.g.
    //    Eastern Arabic numerals), so never block on this.
    const srcNums = src.match(/\d+/g) || [];
    const missing = srcNums.filter((n) => !tgt.includes(n));
    if (missing.length) {
      v.push(violation('number-integrity', 'warning', id,
        `digits from source missing in target: ${[...new Set(missing)].join(', ')}`));
    }

    // 9. Whitespace hygiene. Warning.
    if (/^\s|\s$/.test(tgt) || /  /.test(tgt.replace(/\\n/g, ' '))) {
      v.push(violation('whitespace', 'warning', id, 'leading/trailing/double spaces in target Note'));
    }
  }

  return v;
}

/**
 * Whole-batch check. sourceRows/targetRows are parsed tN row arrays.
 * Returns { ok, errors, warnings, violations, perRow } where ok means
 * zero error-severity violations.
 */
function runChecks(sourceRows, targetRows) {
  const violations = [];

  const srcById = new Map(sourceRows.map((r) => [r.ID, r]));
  const tgtById = new Map();
  for (const t of targetRows) {
    if (tgtById.has(t.ID)) {
      violations.push(violation('duplicate-id', 'error', t.ID, 'duplicate ID in target rows'));
    }
    tgtById.set(t.ID, t);
  }

  // Row-set parity: exactly one target row per source row, same IDs, same order.
  for (const s of sourceRows) {
    if (!tgtById.has(s.ID)) {
      violations.push(violation('missing-row', 'error', s.ID, 'source row has no target row'));
    }
  }
  for (const t of targetRows) {
    if (!srcById.has(t.ID)) {
      violations.push(violation('extra-row', 'error', t.ID, 'target row has no source row'));
    }
  }
  if (sourceRows.length === targetRows.length
      && sourceRows.some((s, i) => targetRows[i] && targetRows[i].ID !== s.ID)) {
    violations.push(violation('row-order', 'error', null, 'target rows out of source order'));
  }

  for (const s of sourceRows) {
    const t = tgtById.get(s.ID);
    if (t) violations.push(...checkRow(s, t));
  }

  const errors = violations.filter((x) => x.severity === 'error');
  const warnings = violations.filter((x) => x.severity === 'warning');
  const perRow = new Map();
  for (const x of violations) {
    const key = x.rowId ?? '(batch)';
    if (!perRow.has(key)) perRow.set(key, []);
    perRow.get(key).push(x);
  }
  return { ok: errors.length === 0, errors, warnings, violations, perRow };
}

module.exports = { runChecks, checkRow, extractRcLinks, PASS_THROUGH_COLUMNS };
