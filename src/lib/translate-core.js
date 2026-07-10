// translate-core.js — deterministic core of the translate pipeline.
//
// Everything here is pure/O(files) logic shared by translate-pipeline.js
// (production) and scripts/translate-dry-run.js (local, push stubbed):
// fetch + slice source rows, batch them, render the per-batch context pack,
// parse/validate skill output, and merge the chapter into the whole-book
// target TSV. The LLM call itself is injected by the caller.

'use strict';

const fs = require('fs');
const path = require('path');
const { parseTnTsv, serializeTnTsv, refChapter, refVerseRange, sliceChapterRows } = require('./tn-tsv');
const { runChecks } = require('./translate-checks');

const DCS_BASE = 'https://git.door43.org';

// Batch bounds: rows are cheap to pass through but Notes vary from one line
// to a 5 KB book intro. Cap by both row count and cumulative Note size so a
// batch stays well inside one focused skill session.
const BATCH_MAX_ROWS = 15;
const BATCH_MAX_NOTE_CHARS = 7000;

// Few-shot budget per batch (spec §2.2 item 4 starts at 15; per-batch we use
// fewer because batches are SupportReference-clustered already).
const MAX_EXAMPLES_PER_BATCH = 10;

function slugFromSupportReference(sr) {
  if (!sr) return null;
  const m = /([a-z0-9-]+)\s*$/i.exec(String(sr).trim());
  return m ? m[1] : null;
}

/** Fetch a whole tN book TSV from DCS at a pinned ref ("org/repo@ref"). */
async function fetchTnBook(sourceRef, book, { fetchImpl } = {}) {
  const m = /^([^/@\s]+)\/([^/@\s]+)@(.+)$/.exec(String(sourceRef || '').trim());
  if (!m) throw new Error(`sourceRef must be "org/repo@ref", got: ${sourceRef}`);
  const [, org, repo, ref] = m;
  const kind = /^[0-9a-f]{40}$/i.test(ref) ? 'commit' : 'branch';
  const url = `${DCS_BASE}/${org}/${repo}/raw/${kind}/${encodeURIComponent(ref)}/tn_${book.toUpperCase()}.tsv`;
  const res = await (fetchImpl || fetch)(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`fetch ${url} → HTTP ${res.status}`);
  return await res.text();
}

/** Split rows into batches bounded by count and cumulative Note size. */
function buildBatches(rows, { maxRows = BATCH_MAX_ROWS, maxNoteChars = BATCH_MAX_NOTE_CHARS } = {}) {
  const batches = [];
  let current = [];
  let chars = 0;
  for (const row of rows) {
    const noteLen = (row.Note || '').length;
    if (current.length > 0 && (current.length >= maxRows || chars + noteLen > maxNoteChars)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(row);
    chars += noteLen;
  }
  if (current.length) batches.push(current);
  return batches;
}

/**
 * Render the per-batch context markdown the skill reads: standing
 * instructions, standards, terminology constraints, the templates matching
 * this batch's SupportReference slugs, and matching validated examples.
 * Deterministic selection happens HERE (in code), not in the skill, so runs
 * are reproducible given (sourceRef, contextRef).
 */
function renderBatchPack({ batchRows, pack, targetLang, targetLangName, direction }) {
  const slugs = [...new Set(batchRows.map((r) => slugFromSupportReference(r.SupportReference)).filter(Boolean))];

  const templateLines = [];
  const templateFallbacks = [];
  for (const slug of slugs) {
    const t = pack.templates.get(slug);
    if (t) {
      templateLines.push(`- \`${slug}\`: ${t.template}`);
    } else {
      templateFallbacks.push(slug);
    }
  }

  const approvedTerms = pack.terms.filter((t) => t.status === 'approved');
  const candidateTerms = pack.terms.filter((t) => t.status !== 'approved');

  // Examples: SupportReference-slug match first, newest-last order preserved
  // from the pack file; cap the total.
  const bySlug = pack.examples.filter((e) => slugs.includes(slugFromSupportReference(e.supportReference)));
  const general = pack.examples.filter((e) => !bySlug.includes(e));
  const examples = [...bySlug, ...general].slice(0, MAX_EXAMPLES_PER_BATCH);

  const parts = [];
  parts.push(`# Translation context — ${targetLangName} (${targetLang}, ${direction === 'rtl' ? 'right-to-left' : 'left-to-right'})`);
  if (pack.brief) parts.push(`## Translation brief\n\n${pack.brief.trim()}`);
  if (pack.instructions) parts.push(`## Standing instructions\n\n${pack.instructions.trim()}`);
  if (pack.standards) parts.push(`## Quality standards (self-check your drafts against these)\n\n${pack.standards.trim()}`);

  if (approvedTerms.length) {
    parts.push('## Terminology — HARD CONSTRAINTS (approved renderings; always use these)\n\n'
      + approvedTerms.map((t) => `- "${t.source}" → "${t.target}"${t.notes ? ` (${t.notes})` : ''}`).join('\n'));
  }
  if (candidateTerms.length) {
    parts.push('## Terminology — candidates (prefer these unless context demands otherwise)\n\n'
      + candidateTerms.map((t) => `- "${t.source}" → "${t.target}"`).join('\n'));
  }

  if (templateLines.length) {
    parts.push('## Note templates for this batch\n\nEach note type has a standard phrasing pattern in '
      + `${targetLangName}. Follow the matching template's structure:\n\n` + templateLines.join('\n'));
  }
  if (templateFallbacks.length) {
    parts.push('## Untranslated note types in this batch\n\nNo '
      + `${targetLangName} template exists yet for: ${templateFallbacks.map((s) => `\`${s}\``).join(', ')}. `
      + 'Follow the English note\'s structure directly.');
  }

  if (examples.length) {
    parts.push('## Validated examples (human-approved translations — imitate their style and register)\n\n'
      + examples.map((e, i) =>
        `### Example ${i + 1}${e.supportReference ? ` (${slugFromSupportReference(e.supportReference)})` : ''}\n`
        + `**English source:**\n${e.source}\n\n**${targetLangName} translation:**\n${e.target}`).join('\n\n'));
  }

  return {
    markdown: parts.join('\n\n') + '\n',
    templateFallbacks,
    slugs,
  };
}

/**
 * Materialize one batch's working files under workDir:
 *   batch-NN.tsv        the source rows (7-col TSV)
 *   batch-NN-pack.md    the rendered context
 *   batch-NN-task.json  machine-readable task descriptor the skill reads first
 * Output contract: the skill writes batch-NN-out.tsv (same 7 columns, same
 * rows in order, only Note translated).
 */
function writeBatchFiles(workDir, index, { batchRows, packMarkdown, targetLang, targetLangName, direction, book }) {
  const nn = String(index + 1).padStart(2, '0');
  const batchFile = path.join(workDir, `batch-${nn}.tsv`);
  const packFile = path.join(workDir, `batch-${nn}-pack.md`);
  const taskFile = path.join(workDir, `batch-${nn}-task.json`);
  const outputFile = path.join(workDir, `batch-${nn}-out.tsv`);

  fs.writeFileSync(batchFile, serializeTnTsv(batchRows), 'utf8');
  fs.writeFileSync(packFile, packMarkdown, 'utf8');
  fs.writeFileSync(taskFile, JSON.stringify({
    task: 'translate-tn-batch',
    book,
    targetLang,
    targetLangName,
    direction,
    rowCount: batchRows.length,
    batchFile,
    packFile,
    outputFile,
  }, null, 2), 'utf8');

  return { batchFile, packFile, taskFile, outputFile, nn };
}

/**
 * Read and structurally validate a batch's skill output. Returns
 * { rows, checks } — checks is the translate-checks result vs batchRows.
 * Throws only on unreadable/unparseable output (structural failure);
 * check violations are returned for the caller's repair loop.
 */
function readBatchOutput(outputFile, batchRows) {
  if (!fs.existsSync(outputFile)) {
    throw new Error(`skill produced no output file: ${outputFile}`);
  }
  const rows = parseTnTsv(fs.readFileSync(outputFile, 'utf8'));
  const checks = runChecks(batchRows, rows);
  return { rows, checks };
}

/**
 * Merge translated chapter-range rows into the whole-book target TSV.
 * existingBookText may be null (no target book yet → fresh file).
 * Replacement semantics mirror sliceChapterRows: rows in [startChapter,
 * endChapter] (plus front rows when startChapter === 1) are replaced by
 * newRows in their canonical position; all other chapters pass through
 * untouched. Row order inside the range is exactly newRows' order.
 */
function mergeChapterIntoBook(existingBookText, newRows, { startChapter, endChapter }) {
  const existing = existingBookText ? parseTnTsv(existingBookText) : [];

  const inRange = (r) => {
    const ch = refChapter(r.Reference);
    if (ch === 'front') return startChapter === 1;
    return typeof ch === 'number' && ch >= startChapter && ch <= endChapter;
  };

  const before = [];
  const after = [];
  for (const r of existing) {
    if (inRange(r)) continue; // replaced
    const ch = refChapter(r.Reference);
    const sortKey = ch === 'front' ? 0 : ch;
    if (sortKey < startChapter || ch === 'front') before.push(r);
    else after.push(r);
  }

  return serializeTnTsv([...before, ...newRows, ...after]);
}

/**
 * Narrow a chapter-sliced row set to a subset by explicit row IDs and/or a
 * verse range. Used for individual-note / single-verse translation. With no
 * criteria, returns the input unchanged.
 * - rowIds: keep only rows whose ID is in the list (precise single-note).
 * - verseStart/verseEnd: keep rows whose reference verse range OVERLAPS
 *   [verseStart, verseEnd]; intro/front rows (no verse) are excluded.
 */
function selectRows(rows, { rowIds, verseStart, verseEnd } = {}) {
  let out = rows;
  if (Array.isArray(rowIds) && rowIds.length) {
    const want = new Set(rowIds);
    out = out.filter((r) => want.has(r.ID));
  }
  if (verseStart != null) {
    const vEnd = verseEnd != null ? verseEnd : verseStart;
    out = out.filter((r) => {
      const vr = refVerseRange(r.Reference);
      return vr && vr.start <= vEnd && vr.end >= verseStart;
    });
  }
  return out;
}

/**
 * Update specific rows in an existing whole-book target TSV by ID, leaving
 * every other row — and all row positions — untouched. This is the merge for
 * individual-note / single-verse translation (generalizes the English
 * applyTnHintExpansion by-id UPDATE pattern). Requires the target book to
 * already contain each row being updated.
 */
function updateRowsById(existingBookText, newRows) {
  if (!existingBookText) {
    throw new Error('by-id update requires an existing target book (none found). '
      + 'Translate the whole chapter first, or run in whole-chapter mode.');
  }
  const existing = parseTnTsv(existingBookText);
  const newById = new Map(newRows.map((r) => [r.ID, r]));
  const applied = new Set();
  const merged = existing.map((r) => {
    if (newById.has(r.ID)) { applied.add(r.ID); return newById.get(r.ID); }
    return r;
  });
  const missing = newRows.filter((r) => !applied.has(r.ID));
  if (missing.length) {
    throw new Error(`by-id update: row id(s) not present in target book: ${missing.map((r) => r.ID).join(', ')}`);
  }
  return serializeTnTsv(merged);
}

/** Machine-readable per-run report (spec §2.3 sidecar, adapted — see PLAN.md). */
function buildTranslateReport({ book, startChapter, endChapter, targetLang, sourceRef, contextRef, contextSha, batches, checks, selection }) {
  return {
    version: 1,
    generatedBy: 'bp-assistant/translate',
    book,
    startChapter,
    endChapter,
    targetLang,
    sourceRef,
    contextRef,
    contextSha: contextSha || null,
    selection: selection || { mergeMode: 'range', verseStart: null, verseEnd: null, rowIds: null },
    rowCount: batches.reduce((s, b) => s + b.rowCount, 0),
    batches: batches.map((b) => ({
      batch: b.nn,
      rowCount: b.rowCount,
      attempts: b.attempts,
      templateFallbacks: b.templateFallbacks,
      slugs: b.slugs,
    })),
    checks: {
      ok: checks.ok,
      errorCount: checks.errors.length,
      warningCount: checks.warnings.length,
      errors: checks.errors,
      warnings: checks.warnings,
    },
  };
}

module.exports = {
  fetchTnBook,
  buildBatches,
  renderBatchPack,
  writeBatchFiles,
  readBatchOutput,
  mergeChapterIntoBook,
  updateRowsById,
  selectRows,
  buildTranslateReport,
  slugFromSupportReference,
  sliceChapterRows,
  BATCH_MAX_ROWS,
  BATCH_MAX_NOTE_CHARS,
};
