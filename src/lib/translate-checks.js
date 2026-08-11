// translate-checks.js — deterministic QA checks for translated resources.
//
// Pure functions, no LLM, no I/O. Two check suites:
//   runChecks(sourceRows, targetRows, opts)  — TSV resources (tN, tQ). Every
//     pass-through column byte-identical; each translate column empty/identical/
//     control-char/rc-link/markdown/number/whitespace checked. Column sets are
//     PARAMETERS (default to tN) so the same suite serves any TSV resource.
//   runArticleChecks(sourceMd, targetMd)     — article resources (tW, tA).
//     Link multiset + heading parity + empty/identical over a whole markdown body.
//
// severity 'error' → must block apply. severity 'warning' → surface, don't block.
// Check IDs are stable strings; a `.column` field disambiguates multi-column
// resources (tQ's Question vs Response) without changing the base IDs tN uses.

'use strict';

const { TN_COLUMNS } = require('./resource-types');

// Default column sets preserve the original tN behavior for callers that don't
// pass explicit sets (the existing translate-tn pipeline + its tests).
const TN_PASS_THROUGH_COLUMNS = TN_COLUMNS.filter((c) => c !== 'Note');
const TN_TRANSLATE_COLUMNS = ['Note'];
// Back-compat export (was TN_COLUMNS.filter(...) in the tN-only version).
const PASS_THROUGH_COLUMNS = TN_PASS_THROUGH_COLUMNS;

// A run returning mostly unchanged rows is essentially always misconfiguration
// (wrong sourceRef pointing at target-language content already), not a valid
// translation — verified case: BSOJ/ar_tn 2TH 3 returned 44/54 = 81% identical.
const IDENTICAL_TO_SOURCE_ABORT_RATIO = 0.5;

// A small run has no statistical signal — a legitimate single-row by-id run
// (bible-editor's "translate this note" flow) whose one note is genuinely
// identical to source (an rc://-link-only Note, a proper-noun-only tQ
// Question) is 1/1 = 100% and would otherwise hard-abort a perfectly valid
// translation. This threshold is about catching a misconfigured BATCH, not
// policing individual rows, so the guard only fires once there are enough
// rows for the rate to mean something.
const IDENTICAL_TO_SOURCE_MIN_ROWS = 10;

// rc:// URIs. Link targets are never localized; display text may be. The body
// of a link (`rc://*/ta/man/translate/figs-metaphor`) contains `*` and `/`, so
// only stop at whitespace or the closing `]`/`)` of the surrounding markdown.
const RC_LINK_RE = /rc:\/\/[^\s\])]+/g;
// Markdown link targets: the (...) part of [text](target). Used by article
// checks so relative links like (../kt/god.md) are preserved byte-for-byte.
const MD_LINK_TARGET_RE = /\]\(([^)]+)\)/g;
// Wiki-style [[...]] link contents (tW/tA cross-references).
const WIKI_LINK_RE = /\[\[([^\]]+)\]\]/g;

// Hebrew (and other combining-mark scripts) can round-trip through the model in
// a different Unicode normalization than the UHB source — visually identical,
// byte-different (e.g. consonant-dagesh-vowel ordering vs NFC). Every pass-through
// compare goes through NFC so a normalization-only difference is not mistaken for
// corruption. Same rule the Bible Editor enforces via web/src/lib/hebrew.ts nfc().
function nfc(s) {
  return String(s ?? '').normalize('NFC');
}

function extractRcLinks(s) {
  return (String(s).match(RC_LINK_RE) || []).map((x) => x.replace(/[).,;]+$/, ''));
}

function extractAll(re, s) {
  const out = [];
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(String(s))) !== null) out.push(m[1]);
  return out;
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

function violation(check, severity, rowId, message, column) {
  const v = { check, severity, rowId, message };
  if (column) v.column = column;
  return v;
}

/**
 * Checks on one translated free-text column (tN Note, tQ Question/Response).
 * `id` is the base check id family; when `multi` is true the column name is
 * appended so violations across columns stay distinguishable.
 */
function checkTextColumn(source, target, col, { rowId, multi }) {
  const v = [];
  const src = source[col] ?? '';
  const tgt = target[col] ?? '';
  const tag = (base) => (multi ? `${base}-${col.toLowerCase()}` : base);

  // Empty translation.
  if (src.trim() !== '' && tgt.trim() === '') {
    v.push(violation(tag('empty-translation'), 'error', rowId, `target ${col} empty while source non-empty`, col));
  }
  // Untranslated pass-through (identical to source). Warning.
  if (src.trim() !== '' && src === tgt) {
    v.push(violation(tag('identical-to-source'), 'warning', rowId, `target ${col} identical to source`, col));
  }
  // Embedded real tab/newline would corrupt the TSV.
  if (/[\t\n\r]/.test(tgt)) {
    v.push(violation(tag('embedded-control-char'), 'error', rowId, `target ${col} contains real tab/newline`, col));
  }
  // rc:// links preserved verbatim (multiset).
  if (!sameMultiset(extractRcLinks(src), extractRcLinks(tgt))) {
    v.push(violation(tag('rc-links'), 'error', rowId,
      `rc:// links differ in ${col}: source [${extractRcLinks(src).join(', ')}], target [${extractRcLinks(tgt).join(', ')}]`, col));
  }

  if (tgt.trim() !== '') {
    // Markdown ** balance (warning).
    const boldCount = (tgt.match(/\*\*/g) || []).length;
    if (boldCount % 2 !== 0) {
      v.push(violation(tag('markdown-bold-balance'), 'warning', rowId, `unbalanced ** markers (${boldCount}) in ${col}`, col));
    }
    // Bracket construct parity (warning).
    const srcOpens = (src.match(/\[/g) || []).length;
    const srcCloses = (src.match(/\]/g) || []).length;
    const tgtOpens = (tgt.match(/\[/g) || []).length;
    const tgtCloses = (tgt.match(/\]/g) || []).length;
    if (tgtOpens !== tgtCloses) {
      v.push(violation(tag('bracket-balance'), 'warning', rowId, `unpaired brackets in target ${col} ([=${tgtOpens}, ]=${tgtCloses})`, col));
    } else if (srcOpens === srcCloses && srcOpens !== tgtOpens) {
      v.push(violation(tag('bracket-count-parity'), 'warning', rowId, `bracket construct count differs in ${col} (source ${srcOpens}, target ${tgtOpens})`, col));
    }
    // Number integrity (warning — Eastern Arabic renumbering is legitimate).
    const srcNums = src.match(/\d+/g) || [];
    const missing = srcNums.filter((num) => !tgt.includes(num));
    if (missing.length) {
      v.push(violation(tag('number-integrity'), 'warning', rowId, `digits from source missing in target ${col}: ${[...new Set(missing)].join(', ')}`, col));
    }
    // Whitespace hygiene (warning).
    if (/^\s|\s$/.test(tgt) || /  /.test(tgt.replace(/\\n/g, ' '))) {
      v.push(violation(tag('whitespace'), 'warning', rowId, `leading/trailing/double spaces in target ${col}`, col));
    }
  }
  return v;
}

/**
 * Per-row checks for a TSV resource. `passThroughColumns` must be byte-identical
 * source→target; `translateColumns` are localized and text-checked.
 */
function checkRow(source, target, { passThroughColumns, translateColumns }) {
  const v = [];
  const id = source.ID;
  const multi = translateColumns.length > 1;

  // 1. Pass-through columns byte-identical (the Aquilla-corruption class).
  //    Compared under NFC so a normalization-only round-trip difference on a
  //    Hebrew Quote isn't flagged as corruption (see nfc()).
  for (const col of passThroughColumns) {
    if (nfc(source[col]) !== nfc(target[col])) {
      v.push(violation(`passthrough-${col.toLowerCase()}`, 'error', id,
        `${col} modified: ${JSON.stringify(source[col])} → ${JSON.stringify(target[col])}`, col));
    }
  }

  // 2. Occurrence parses as a valid integer (when the resource has that column).
  if (Object.prototype.hasOwnProperty.call(target, 'Occurrence')) {
    if (!/^-?\d+$/.test(target.Occurrence) || Number(target.Occurrence) < -1) {
      v.push(violation('occurrence-int', 'error', id, `Occurrence not a valid integer: ${JSON.stringify(target.Occurrence)}`, 'Occurrence'));
    }
  }

  // 3. Each translate column.
  for (const col of translateColumns) {
    v.push(...checkTextColumn(source, target, col, { rowId: id, multi }));
  }
  return v;
}

/**
 * Whole-set TSV check. sourceRows/targetRows are parsed row arrays.
 * opts.passThroughColumns / opts.translateColumns default to tN's sets.
 * Returns { ok, errors, warnings, violations, perRow }.
 */
function runChecks(sourceRows, targetRows, opts = {}) {
  const passThroughColumns = opts.passThroughColumns || TN_PASS_THROUGH_COLUMNS;
  const translateColumns = opts.translateColumns || TN_TRANSLATE_COLUMNS;
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
    if (!tgtById.has(s.ID)) violations.push(violation('missing-row', 'error', s.ID, 'source row has no target row'));
  }
  for (const t of targetRows) {
    if (!srcById.has(t.ID)) violations.push(violation('extra-row', 'error', t.ID, 'target row has no source row'));
  }
  if (sourceRows.length === targetRows.length
      && sourceRows.some((s, i) => targetRows[i] && targetRows[i].ID !== s.ID)) {
    violations.push(violation('row-order', 'error', null, 'target rows out of source order'));
  }

  for (const s of sourceRows) {
    const t = tgtById.get(s.ID);
    if (t) violations.push(...checkRow(s, t, { passThroughColumns, translateColumns }));
  }

  return summarize(violations);
}

/**
 * Whole-body checks for an article markdown file (tW term, tA article file).
 * The article is multi-line, so real newlines are legal (no control-char check).
 * Enforced: link multisets (rc://, markdown targets, [[wiki]]) preserved; body
 * non-empty when source is. Warnings: identical-to-source, heading-count parity.
 */
function runArticleChecks(sourceMd, targetMd, { articleId, path: filePath } = {}) {
  const violations = [];
  const rowId = filePath || articleId || null;
  const src = String(sourceMd ?? '');
  const tgt = String(targetMd ?? '');

  if (src.trim() !== '' && tgt.trim() === '') {
    violations.push(violation('empty-translation', 'error', rowId, 'target article body empty while source non-empty'));
  }
  // Warning, not error: legitimately-unchanged articles exist (link-only or
  // stub tW/tA files whose body is nearly all rc://[[wiki]] links with little
  // free text to translate). Promoting this to 'error' burns a repair pass
  // and then hard-fails the whole article run via MAX_BATCH_ATTEMPTS, and
  // also breaks the resume path that reuses a cached article output only
  // when checks.ok. The TSV aggregate guard (identicalRateGuard) already
  // covers the misconfiguration this was meant to catch, at the batch level
  // where it has statistical signal — a single article has none.
  if (src.trim() !== '' && src === tgt) {
    violations.push(violation('identical-to-source', 'warning', rowId, 'target article identical to source'));
  }

  // Links: three multisets, each compared independently.
  if (!sameMultiset(extractRcLinks(src), extractRcLinks(tgt))) {
    violations.push(violation('rc-links', 'error', rowId,
      `rc:// links differ: source [${extractRcLinks(src).join(', ')}], target [${extractRcLinks(tgt).join(', ')}]`));
  }
  const srcMd = extractAll(MD_LINK_TARGET_RE, src);
  const tgtMd = extractAll(MD_LINK_TARGET_RE, tgt);
  if (!sameMultiset(srcMd, tgtMd)) {
    violations.push(violation('markdown-links', 'error', rowId,
      `markdown link targets differ: source [${srcMd.join(', ')}], target [${tgtMd.join(', ')}]`));
  }
  const srcWiki = extractAll(WIKI_LINK_RE, src);
  const tgtWiki = extractAll(WIKI_LINK_RE, tgt);
  if (!sameMultiset(srcWiki, tgtWiki)) {
    violations.push(violation('wiki-links', 'error', rowId,
      `[[wiki]] links differ: source [${srcWiki.join(', ')}], target [${tgtWiki.join(', ')}]`));
  }

  // Heading count parity (warning): lines beginning with one or more '#'.
  const headings = (s) => (String(s).match(/^#{1,6}\s/gm) || []).length;
  if (headings(src) !== headings(tgt)) {
    violations.push(violation('heading-parity', 'warning', rowId,
      `heading count differs (source ${headings(src)}, target ${headings(tgt)})`));
  }

  return summarize(violations);
}

/**
 * Aggregate guard over a batch/whole-range `checks` result: how many DISTINCT
 * rows came back identical to source, out of `rowCount` rows actually sent to
 * the model. tag() (checkTextColumn, above) appends a column suffix for
 * multi-column resources (tQ: identical-to-source-question / -response), so
 * this counts by check-id PREFIX and de-dupes by rowId — a row that's
 * identical in both Question and Response counts once, not twice.
 * See IDENTICAL_TO_SOURCE_ABORT_RATIO for why this exists.
 */
function identicalRateGuard(checks, rowCount, { ratio = IDENTICAL_TO_SOURCE_ABORT_RATIO, minRows = IDENTICAL_TO_SOURCE_MIN_ROWS } = {}) {
  const rowIds = new Set(
    (checks.warnings || [])
      .filter((w) => typeof w.check === 'string' && w.check.startsWith('identical-to-source'))
      .map((w) => w.rowId),
  );
  const identicalRows = rowIds.size;
  const rate = rowCount ? identicalRows / rowCount : 0;
  const exceeded = rowCount >= minRows && rate > ratio;
  return { identicalRows, rowCount, rate, exceeded, minRows };
}

function summarize(violations) {
  const errors = violations.filter((x) => x.severity === 'error');
  const warnings = violations.filter((x) => x.severity === 'warning');
  const perRow = new Map();
  for (const x of violations) {
    const key = x.rowId ?? '(set)';
    if (!perRow.has(key)) perRow.set(key, []);
    perRow.get(key).push(x);
  }
  return { ok: errors.length === 0, errors, warnings, violations, perRow };
}

module.exports = {
  runChecks,
  runArticleChecks,
  checkRow,
  extractRcLinks,
  nfc,
  identicalRateGuard,
  IDENTICAL_TO_SOURCE_ABORT_RATIO,
  IDENTICAL_TO_SOURCE_MIN_ROWS,
  PASS_THROUGH_COLUMNS,
  TN_PASS_THROUGH_COLUMNS,
  TN_TRANSLATE_COLUMNS,
};
