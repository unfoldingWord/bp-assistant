// translate-core.js — deterministic core of the translate pipeline.
//
// Everything here is pure/O(files) logic shared by translate-pipeline.js
// (production) and scripts/translate-dry-run.js (local, push stubbed). Two
// families:
//   - TSV resources (tN, tQ): fetch + slice source rows, batch, render the
//     per-batch context pack, parse/validate skill output, merge the chapter
//     into the whole-book target. Column schema is a parameter (default tN).
//   - Article resources (tW, tA): render the per-article pack, materialize the
//     source markdown + task, parse/validate the translated markdown. Article
//     resolution lives in article-resolver.js.
// The LLM call itself is injected by the caller.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseTnTsv, serializeTnTsv, refChapter, refVerseRange, sliceChapterRows } = require('./tn-tsv');
const { runChecks, runArticleChecks, PASS_THROUGH_COLUMNS } = require('./translate-checks');

/**
 * Session/job-key suffix that makes translate runs distinguishable by target
 * language, resource type, and (for individual-note runs) the exact row set
 * or (for articles) the article id. Used identically by the router (API
 * jobId/checkpoint key) and the pipeline (checkpoint write) so a status poll
 * finds the right job and distinct runs don't alias.
 *   - targetLang is always included when present.
 *   - resourceType is included only for non-tN resources, so existing tN
 *     checkpoints/jobIds are unchanged (backward compatible).
 *   - rowIds (sorted) and articleId are hashed in when present.
 * (sourceRef/contextRef/model/direction are NOT folded in — they resolve from
 * defaults downstream of the router; hashing them here would desync the two
 * sides. Documented low-severity limitation, PLAN.md §5a.)
 */
function translateSessionSuffix(targetLang, rowIds, opts = {}) {
  if (!targetLang) return '';
  let s = `-${targetLang}`;
  const rt = opts.resourceType;
  if (rt && rt !== 'tn') s += `-${rt}`;
  if (opts.articleId) {
    s += `-a${crypto.createHash('sha1').update(String(opts.articleId)).digest('hex').slice(0, 8)}`;
  }
  if (Array.isArray(rowIds) && rowIds.length) {
    s += `-r${crypto.createHash('sha1').update(rowIds.slice().sort().join(',')).digest('hex').slice(0, 8)}`;
  }
  return s;
}

const DCS_BASE = 'https://git.door43.org';

// Batch bounds: rows are cheap to pass through but free-text columns vary from
// one line to a 5 KB book intro. Cap by both row count and cumulative
// translate-column size so a batch stays well inside one focused skill session.
const BATCH_MAX_ROWS = 15;
const BATCH_MAX_NOTE_CHARS = 7000;

// Few-shot budget per batch (CONTEXT-REPO-CONTRACT.md §3.4 — start at 15).
const MAX_EXAMPLES_PER_BATCH = 15;

function slugFromSupportReference(sr) {
  if (!sr) return null;
  const m = /([a-z0-9-]+)\s*$/i.exec(String(sr).trim());
  return m ? m[1] : null;
}

/** Format terminology sections from the concept-oriented status vocab. */
function renderTerminologySections(terms) {
  const preferred = terms.filter((t) => t.status === 'preferred');
  const admitted = terms.filter((t) => t.status === 'admitted');
  const deprecated = terms.filter((t) => t.status === 'deprecated');
  const forbidden = terms.filter((t) => t.status === 'forbidden');
  const doNotTranslate = terms.filter((t) => t.status === 'do_not_translate');
  const parts = [];

  if (preferred.length) {
    parts.push('## Terminology — HARD CONSTRAINTS (preferred renderings; always use these)\n\n'
      + preferred.map((t) => `- "${t.source}" → "${t.target}"${t.comment ? ` (${t.comment})` : ''}`).join('\n'));
  }
  if (admitted.length) {
    parts.push('## Terminology — admitted (valid; prefer a preferred sibling when drafting fresh)\n\n'
      + admitted.map((t) => `- "${t.source}" → "${t.target}"`).join('\n'));
  }
  if (forbidden.length) {
    parts.push('## Terminology — FORBIDDEN (never emit; use the replacement)\n\n'
      + forbidden.map((t) => `- never "${t.target || t.source}"; use "${t.replacement || '?'}" instead`
        + `${t.comment ? ` (${t.comment})` : ''}`).join('\n'));
  }
  if (deprecated.length) {
    parts.push('## Terminology — deprecated (do not emit in new drafts)\n\n'
      + deprecated.map((t) => `- do not use "${t.target}" for "${t.source}"`).join('\n'));
  }
  if (doNotTranslate.length) {
    parts.push('## Terminology — do not translate (leave the source term as-is)\n\n'
      + doNotTranslate.map((t) => `- leave "${t.source}" untranslated / untransliterated`).join('\n'));
  }
  return parts;
}

/** Select up to N live examples: SupportReference match first, then recency. */
function selectExamples(examples, slugs, max = MAX_EXAMPLES_PER_BATCH) {
  const live = (examples || []).slice().sort(
    (a, b) => (b.validated_at - a.validated_at) || ((b._seq || 0) - (a._seq || 0)));
  const slugSet = new Set(slugs || []);
  const bySlug = live.filter((e) => slugSet.has(slugFromSupportReference(e.supportReference)));
  const general = live.filter((e) => !bySlug.includes(e));
  return [...bySlug, ...general].slice(0, max);
}

function renderPackPreamble({ pack, targetLang, targetLangName, direction }) {
  const parts = [];
  parts.push(`# Translation context — ${targetLangName} (${targetLang}, ${direction === 'rtl' ? 'right-to-left' : 'left-to-right'})`);
  if (pack.register) {
    parts.push(`## Formality register\n\nUse **${pack.register}** register throughout this draft.`);
  }
  if (pack.brief) parts.push(`## Translation brief\n\n${pack.brief.trim()}`);
  if (pack.instructions) parts.push(`## Standing instructions\n\n${pack.instructions.trim()}`);
  if (pack.standards) parts.push(`## Quality standards (self-check your drafts against these)\n\n${pack.standards.trim()}`);
  parts.push(...renderTerminologySections(pack.terms || []));
  return parts;
}

/** Fetch a file from DCS at a pinned ref ("org/repo@ref"); null on 404. */
async function fetchResourceFile(sourceRef, filename, { fetchImpl } = {}) {
  const m = /^([^/@\s]+)\/([^/@\s]+)@(.+)$/.exec(String(sourceRef || '').trim());
  if (!m) throw new Error(`sourceRef must be "org/repo@ref", got: ${sourceRef}`);
  const [, org, repo, ref] = m;
  const kind = /^[0-9a-f]{40}$/i.test(ref) ? 'commit' : 'branch';
  const url = `${DCS_BASE}/${org}/${repo}/raw/${kind}/${encodeURIComponent(ref)}/${filename}`;
  const res = await (fetchImpl || fetch)(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`fetch ${url} → HTTP ${res.status}`);
  return await res.text();
}

/** Fetch a whole tN book TSV from DCS at a pinned ref (back-compat wrapper). */
async function fetchTnBook(sourceRef, book, opts = {}) {
  return fetchResourceFile(sourceRef, `tn_${book.toUpperCase()}.tsv`, opts);
}

/**
 * Split rows into batches bounded by count and cumulative translate-column
 * size. sizeOf(row) returns the char weight (default = the tN Note column).
 */
function buildBatches(rows, { maxRows = BATCH_MAX_ROWS, maxNoteChars = BATCH_MAX_NOTE_CHARS, sizeOf } = {}) {
  const weight = sizeOf || ((r) => (r.Note || '').length);
  const batches = [];
  let current = [];
  let chars = 0;
  for (const row of rows) {
    const len = weight(row);
    if (current.length > 0 && (current.length >= maxRows || chars + len > maxNoteChars)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(row);
    chars += len;
  }
  if (current.length) batches.push(current);
  return batches;
}

/**
 * Render the per-batch context markdown the skill reads. Deterministic
 * selection happens HERE (in code), not in the skill, so runs are reproducible
 * given (sourceRef, contextRef). `sourceLangName` (default English) makes the
 * wording source-language-agnostic (a future Russian→Georgian run says
 * "Russian source"). `resource` (from the registry) supplies the free-text
 * column names so the batch preview shows the right columns; when omitted the
 * tN Note column is assumed.
 */
function renderBatchPack({ batchRows, pack, targetLang, targetLangName, direction, sourceLangName = 'English' }) {
  const slugs = [...new Set(batchRows.map((r) => slugFromSupportReference(r.SupportReference)).filter(Boolean))];

  const templateLines = [];
  const templateFallbacks = [];
  for (const slug of slugs) {
    const t = pack.templates.get(slug); // Map only holds status=active
    if (t) templateLines.push(`- \`${slug}\`: ${t.template}`);
    else templateFallbacks.push(slug);
  }

  const examples = selectExamples(pack.examples, slugs);

  const parts = renderPackPreamble({ pack, targetLang, targetLangName, direction });

  if (templateLines.length) {
    parts.push('## Note templates for this batch\n\nEach note type has a standard phrasing pattern in '
      + `${targetLangName}. Follow the matching template's structure:\n\n` + templateLines.join('\n'));
  }
  if (templateFallbacks.length) {
    parts.push('## Untranslated note types in this batch\n\nNo '
      + `${targetLangName} template exists yet for: ${templateFallbacks.map((s) => `\`${s}\``).join(', ')}. `
      + `Follow the ${sourceLangName} note's structure directly.`);
  }

  if (examples.length) {
    parts.push('## Validated examples (human-approved translations — imitate their style and register)\n\n'
      + examples.map((e, i) =>
        `### Example ${i + 1}${e.supportReference ? ` (${slugFromSupportReference(e.supportReference)})` : ''}\n`
        + `**${sourceLangName} source:**\n${e.source}\n\n**${targetLangName} translation:**\n${e.target}`).join('\n\n'));
  }

  return { markdown: parts.join('\n\n') + '\n', templateFallbacks, slugs };
}

/**
 * Render the per-article context markdown (tW/tA). Same pack, but there is no
 * SupportReference to match templates against — instead the article id itself
 * may match a template slug (e.g. tA "figs-aside"). Terminology + examples +
 * brief/instructions/standards are always injected.
 */
function renderArticlePack({ articleId, pack, targetLang, targetLangName, direction, sourceLangName = 'English' }) {
  const slug = slugFromSupportReference(articleId) || String(articleId || '').split('/').pop();
  const templateFallbacks = [];
  const templateLines = [];
  const t = slug && pack.templates.get(slug);
  if (t) templateLines.push(`- \`${slug}\`: ${t.template}`);
  else if (slug) templateFallbacks.push(slug);

  const examples = selectExamples(pack.examples, slug ? [slug] : []);
  const parts = renderPackPreamble({ pack, targetLang, targetLangName, direction });

  if (templateLines.length) {
    parts.push(`## Phrasing template for this article\n\nFollow this ${targetLangName} phrasing pattern:\n\n` + templateLines.join('\n'));
  }
  if (examples.length) {
    parts.push('## Validated examples (human-approved translations — imitate their style and register)\n\n'
      + examples.map((e, i) => `### Example ${i + 1}\n**${sourceLangName} source:**\n${e.source}\n\n**${targetLangName} translation:**\n${e.target}`).join('\n\n'));
  }
  return { markdown: parts.join('\n\n') + '\n', templateFallbacks, slug };
}

/**
 * Materialize one TSV batch's working files under workDir:
 *   batch-NN.tsv        the source rows
 *   batch-NN-pack.md    the rendered context
 *   batch-NN-task.json  machine-readable task descriptor the skill reads first
 * Output contract: the skill writes batch-NN-out.tsv (same columns, same rows
 * in order, only translate columns localized). `resource` supplies the codec +
 * column lists baked into the task JSON so the skill knows what to touch.
 */
function writeBatchFiles(workDir, index, { batchRows, packMarkdown, targetLang, targetLangName, direction, book, resource, sourceLangName = 'English' }) {
  const nn = String(index + 1).padStart(2, '0');
  const serialize = resource ? resource._codec.serialize : serializeTnTsv;
  const batchFile = path.join(workDir, `batch-${nn}.tsv`);
  const packFile = path.join(workDir, `batch-${nn}-pack.md`);
  const taskFile = path.join(workDir, `batch-${nn}-task.json`);
  const outputFile = path.join(workDir, `batch-${nn}-out.tsv`);

  fs.writeFileSync(batchFile, serialize(batchRows), 'utf8');
  fs.writeFileSync(packFile, packMarkdown, 'utf8');
  fs.writeFileSync(taskFile, JSON.stringify({
    task: 'translate-tsv-batch',
    resourceType: resource ? resource.resourceType : 'tn',
    passThroughColumns: resource ? resource.passThroughColumns : undefined,
    translateColumns: resource ? resource.translateColumns : ['Note'],
    book,
    targetLang,
    targetLangName,
    sourceLangName,
    direction,
    rowCount: batchRows.length,
    batchFile,
    packFile,
    outputFile,
  }, null, 2), 'utf8');

  return { batchFile, packFile, taskFile, outputFile, nn };
}

/**
 * Materialize one article file's working files under workDir:
 *   article-NN.md        the source markdown
 *   article-NN-pack.md   the rendered context
 *   article-NN-task.json the task descriptor
 * Output contract: the skill writes article-NN-out.md (translated body,
 * structure + links preserved).
 */
function writeArticleFiles(workDir, index, { sourceMarkdown, packMarkdown, articleId, filePath, targetLang, targetLangName, direction, sourceLangName = 'English' }) {
  const nn = String(index + 1).padStart(2, '0');
  const srcFile = path.join(workDir, `article-${nn}.md`);
  const packFile = path.join(workDir, `article-${nn}-pack.md`);
  const taskFile = path.join(workDir, `article-${nn}-task.json`);
  const outputFile = path.join(workDir, `article-${nn}-out.md`);

  fs.writeFileSync(srcFile, sourceMarkdown, 'utf8');
  fs.writeFileSync(packFile, packMarkdown, 'utf8');
  fs.writeFileSync(taskFile, JSON.stringify({
    task: 'translate-article',
    articleId,
    filePath,
    targetLang,
    targetLangName,
    sourceLangName,
    direction,
    sourceFile: srcFile,
    packFile,
    outputFile,
  }, null, 2), 'utf8');

  return { srcFile, packFile, taskFile, outputFile, nn };
}

/**
 * Read and structurally validate a TSV batch's skill output. Returns
 * { rows, checks }. `parse` + `checkOpts` (passThrough/translate columns)
 * default to tN. Throws only on unreadable/unparseable output.
 */
function readBatchOutput(outputFile, batchRows, { parse = parseTnTsv, checkOpts = {} } = {}) {
  if (!fs.existsSync(outputFile)) throw new Error(`skill produced no output file: ${outputFile}`);
  const rows = parse(fs.readFileSync(outputFile, 'utf8'));
  // Byte-preserve pass-through columns by construction. The skill round-trips
  // whole rows, so a pass-through cell — e.g. a Hebrew UHB Quote — can come back
  // in a different Unicode normalization (visually identical, byte-different) or
  // otherwise mangled. Copy each pass-through cell straight from the source row
  // so passthrough is exact, not merely re-emitted; the passthrough checks then
  // only guard rows the model failed to round-trip by ID at all.
  const passThroughColumns = checkOpts.passThroughColumns || PASS_THROUGH_COLUMNS;
  const srcById = new Map(batchRows.map((r) => [r.ID, r]));
  for (const row of rows) {
    const src = srcById.get(row.ID);
    if (!src) continue;
    for (const col of passThroughColumns) {
      if (Object.prototype.hasOwnProperty.call(src, col)) row[col] = src[col];
    }
  }
  const checks = runChecks(batchRows, rows, checkOpts);
  return { rows, checks };
}

/** Read + validate one translated article file. Returns { markdown, checks }. */
function readArticleOutput(outputFile, sourceMarkdown, { articleId, path: filePath } = {}) {
  if (!fs.existsSync(outputFile)) throw new Error(`skill produced no output file: ${outputFile}`);
  const markdown = fs.readFileSync(outputFile, 'utf8');
  const checks = runArticleChecks(sourceMarkdown, markdown, { articleId, path: filePath });
  return { markdown, checks };
}

/**
 * Merge translated chapter-range rows into the whole-book target TSV. `parse`/
 * `serialize` default to tN's codec. existingBookText may be null (fresh file).
 */
function mergeChapterIntoBook(existingBookText, newRows, { startChapter, endChapter, parse = parseTnTsv, serialize = serializeTnTsv }) {
  const existing = existingBookText ? parse(existingBookText) : [];

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
  return serialize([...before, ...newRows, ...after]);
}

/**
 * Narrow a chapter-sliced row set to a subset by explicit row IDs and/or a
 * verse range (individual-note / single-verse translation). No criteria →
 * input unchanged.
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
 * every other row — and all row positions — untouched. `parse`/`serialize`
 * default to tN's codec. Requires each updated row to already exist in target.
 */
function updateRowsById(existingBookText, newRows, { parse = parseTnTsv, serialize = serializeTnTsv } = {}) {
  if (!existingBookText) {
    throw new Error('by-id update requires an existing target book (none found). '
      + 'Translate the whole chapter first, or run in whole-chapter mode.');
  }
  const existing = parse(existingBookText);
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
  return serialize(merged);
}

/** Machine-readable per-run report (CONTEXT-REPO-CONTRACT.md §4.2). */
function buildTranslateReport({
  resourceType = 'tn', book, startChapter, endChapter, articleId, files,
  targetLang, sourceLang, sourceRef, contextRef, contextSha, batches, checks, selection,
  runId = null, jobId = null, generatedAt = null, targetOrg = null, targetRepo = null, branch = null,
}) {
  return {
    version: 1,
    generatedBy: 'bp-assistant/translate',
    runId: runId || null,
    jobId: jobId || null,
    generatedAt: generatedAt || new Date().toISOString(),
    resourceType,
    book: book || null,
    startChapter: startChapter ?? null,
    endChapter: endChapter ?? null,
    articleId: articleId || null,
    files: files || null,
    targetLang,
    sourceLang: sourceLang || 'en',
    sourceRef,
    contextRef,
    contextSha: contextSha || null,
    targetOrg: targetOrg || null,
    targetRepo: targetRepo || null,
    branch: branch || null,
    scope: {
      book: book || null,
      startChapter: startChapter ?? null,
      endChapter: endChapter ?? null,
      articleId: articleId || null,
    },
    selection: selection || { mergeMode: 'range', verseStart: null, verseEnd: null, rowIds: null },
    rowCount: (batches || []).reduce((s, b) => s + (b.rowCount || 0), 0),
    batches: (batches || []).map((b) => ({
      batch: b.nn,
      rowCount: b.rowCount,
      attempts: b.attempts,
      templateFallbacks: b.templateFallbacks,
      slugs: b.slugs,
      path: b.path,
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
  translateSessionSuffix,
  fetchResourceFile,
  fetchTnBook,
  buildBatches,
  renderBatchPack,
  renderArticlePack,
  renderTerminologySections,
  selectExamples,
  writeBatchFiles,
  writeArticleFiles,
  readBatchOutput,
  readArticleOutput,
  mergeChapterIntoBook,
  updateRowsById,
  selectRows,
  buildTranslateReport,
  slugFromSupportReference,
  sliceChapterRows,
  BATCH_MAX_ROWS,
  BATCH_MAX_NOTE_CHARS,
  MAX_EXAMPLES_PER_BATCH,
};
