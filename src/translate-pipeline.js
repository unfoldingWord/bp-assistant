// translate-pipeline.js — translate published unfoldingWord resources into a
// gateway language with deterministic pass-through / structure-preserving checks.
//
// Resource types (the `resourceType` dimension):
//   tn  translationNotes    — 7-col TSV, translate Note                (family tsv)
//   tq  translationQuestions— 7-col TSV, translate Question + Response (family tsv)
//   tw  translationWords    — markdown article (one file per term)     (family article)
//   ta  translationAcademy  — markdown article (folder of .md files)   (family article)
//
// Triggered by:
//   Zulip:  "translate notes OBA 1 to ar"     (tn)
//           "translate questions OBA 1 to ar"  (tq)
//           "translate word kt/god to ar"      (tw)
//           "translate article figs-aside to ar" | "translate ta <door43-url> to ar" (ta)
//   HTTP:   POST /api/pipeline/start { pipelineType: "translate", options: {
//             resourceType, targetLang, articleId?|articleUrl?, sourceRef?, ... } }
//
// Contract (bp-bot/translate-pipeline/PLAN.md, DECISION.md, CONTEXT-REPO-CONTRACT.md):
// - Source is fetched from the PUBLISHED source repo at a pinned ref (sourceRef;
//   default unfoldingWord/en_{resource}@master) — not inline (32 KB body cap).
//   The source LANGUAGE is a first-class parameter (sourceLang/sourceLangName,
//   default English) so a future Russian→Georgian run works unchanged.
// - TSV: exactly one target row per source row, same order; pass-through columns
//   byte-identical; only the translate columns localized. Article: whole-body
//   translation preserving headings + every rc://, [[wiki]], and ](target) link.
//   Enforced by src/lib/translate-checks.js — error-severity violations BLOCK.
// - Per-language context pack pinned by contextRef, injected per batch/article.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sendMessage, sendDM } = require('./zulip-client');
const { runClaude } = require('./claude-runner');
const { CSKILLBP_DIR, getDoor43Username, emailToFallbackUsername } = require('./pipeline-utils');
const { setCheckpoint } = require('./pipeline-checkpoints');
const { publishAdminStatus } = require('./admin-status');
const { door43Push } = require('./door43-push');
const { loadContextPack } = require('./lib/context-pack');
const { runChecks, runArticleChecks } = require('./lib/translate-checks');
const { makeTsvCodec } = require('./lib/tsv-resource');
const { getResourceType, ROUTE_RESOURCE_TYPE, articleScopeBook } = require('./lib/resource-types');
const { resolveArticle } = require('./lib/article-resolver');
const { buildSuggestionInbox, shouldWriteContextBack } = require('./lib/translate-suggestions');
const { writeContextArtifactsSafe } = require('./lib/context-write');
const core = require('./lib/translate-core');
const scriptureVerses = require('./lib/scripture-verses');

const LOG_PREFIX = '[translate]';

// Zulip scope grammar for TSV resources (book + chapter/verse scope + lang).
//   "1" chapter · "1-2" range · "1:5" verse · "1:5-7" verse range
const TSV_COMMAND_RE = /translate\s+(?:notes?|questions?|tn|tq)\s+(\w{3})\s+(\d+)(?::(\d+(?:\s*[-–—]\s*\d+)?))?(?:\s*[-–—]\s*(\d+))?\s+(?:to|into)\s+([A-Za-z0-9-]+)/i;
// Zulip grammar for article resources (article name or Door43 URL + lang).
const ARTICLE_COMMAND_RE = /translate\s+(?:words?|tw|articles?|ta)\s+(\S+)\s+(?:to|into)\s+([A-Za-z0-9-]+)/i;
// Kept for backward compatibility (tests import COMMAND_RE).
const COMMAND_RE = TSV_COMMAND_RE;

const LANG_NAMES = {
  ar: 'Arabic', 'es-419': 'Latin American Spanish', es: 'Spanish', ru: 'Russian',
  fr: 'French', hi: 'Hindi', sw: 'Swahili', pt: 'Portuguese', id: 'Indonesian',
  zh: 'Chinese', vi: 'Vietnamese', bn: 'Bengali', ur: 'Urdu', fa: 'Persian',
  he: 'Hebrew', am: 'Amharic', ne: 'Nepali', my: 'Burmese', th: 'Thai',
  en: 'English', ka: 'Georgian',
};
const RTL_LANGS = new Set(['ar', 'he', 'fa', 'ur', 'ps', 'sd', 'ug', 'yi', 'dv', 'ckb', 'arc', 'syr', 'prs']);

let TRANSLATE_TARGETS = {};
try {
  TRANSLATE_TARGETS = require('../config/translate-targets.json');
} catch (err) {
  console.warn(`${LOG_PREFIX} no translate-targets.json (${err.message}) — using {lang}_{resource} derivation`);
}

const MAX_BATCH_ATTEMPTS = 2; // 1 draft + 1 repair pass

function langName(code) {
  return LANG_NAMES[code] || code;
}

function resolveParams(route, message) {
  const opts = route._translate || {};
  // resourceType: synthetic carries it explicitly; Zulip derives from route name.
  const resourceType = opts.resourceType || ROUTE_RESOURCE_TYPE[route.name] || 'tn';
  const rt = getResourceType(resourceType);
  const family = rt.family;

  let book = null; let startChapter = null; let endChapter = null;
  let verseStart = null; let verseEnd = null; let rowIds = null;
  let articleId = null; let articleUrl = null;
  let zulipLang = null;

  if (family === 'article') {
    if (route._synthetic) {
      articleId = opts.articleId || null;
      articleUrl = opts.articleUrl || null;
    } else {
      const m = ARTICLE_COMMAND_RE.exec(String(message.content || ''));
      if (!m) throw new Error('Could not parse translate command. Usage: translate word kt/god to ar  |  translate article figs-aside to ar');
      const ref = m[1];
      if (/^https?:\/\//i.test(ref)) articleUrl = ref; else articleId = ref;
      zulipLang = m[2].toLowerCase();
    }
  } else if (route._synthetic && route._book) {
    book = route._book;
    startChapter = route._startChapter;
    endChapter = route._endChapter;
    verseStart = route._verseStart ?? null;
    verseEnd = route._verseEnd ?? null;
    rowIds = Array.isArray(opts.rowIds) && opts.rowIds.length ? opts.rowIds : null;
  } else {
    const m = TSV_COMMAND_RE.exec(String(message.content || ''));
    if (!m) throw new Error('Could not parse translate command. Usage: translate notes OBA 1 to ar (or OBA 1:5 / OBA 1:5-7 / OBA 1-2); questions likewise');
    book = m[1].toUpperCase();
    startChapter = parseInt(m[2], 10);
    if (m[3]) {
      const [vs, ve] = m[3].split(/[-–—]/).map((x) => parseInt(x.trim(), 10));
      endChapter = startChapter;
      verseStart = vs;
      verseEnd = Number.isInteger(ve) ? ve : vs;
    } else {
      endChapter = m[4] ? parseInt(m[4], 10) : startChapter;
    }
    zulipLang = m[5].toLowerCase();
  }

  const targetLang = opts.targetLang || zulipLang;
  if (!targetLang) throw new Error('translate: targetLang is required');

  const hasSubset = (rowIds && rowIds.length > 0) || verseStart != null;
  const mergeMode = hasSubset ? 'by-id' : 'range';
  // Synthetic (API) runs default to 'editor': results stay on the bot and are
  // pulled by bible-editor via GET /api/pipeline/{jobId}/output — unapproved AI
  // output never touches Door43. 'branch' remains an explicit expert override.
  const delivery = opts.delivery || (route._synthetic ? 'editor' : 'path');

  const cfg = TRANSLATE_TARGETS[targetLang] || {};
  const targetOrg = opts.targetOrg || cfg.targetOrg || `${targetLang}_gl`;
  const repoName = opts.repoName || cfg[rt.configRepoKey] || rt.defaultRepo(targetLang);
  const sourceLang = opts.sourceLang || cfg.sourceLang || 'en';
  // Per-resource source ref only (no generic cfg.sourceRef — it would bleed one
  // resource's source, e.g. TN's translate-in-place BSOJ/ar_tn, into others).
  const sourceRef = opts.sourceRef || cfg[`${resourceType}SourceRef`]
    || `unfoldingWord/${rt.defaultSourceRepo}@master`;
  const sourceLiteralRef = opts.sourceLiteralRef || cfg.sourceLiteralRef || 'unfoldingWord/en_ult@master';
  const sourceSimplifiedRef = opts.sourceSimplifiedRef || cfg.sourceSimplifiedRef || 'unfoldingWord/en_ust@master';
  const targetLiteralRef = opts.literalRef || cfg.literalRef || `${targetOrg}/${cfg.literalRepo || `${targetLang}_glt`}@master`;
  const targetSimplifiedRef = opts.simplifiedRef || cfg.simplifiedRef || `${targetOrg}/${cfg.simplifiedRepo || `${targetLang}_gst`}@master`;
  const contextRef = opts.contextRef || cfg.contextRef || `${targetOrg}/translation-context@master`;
  const contextRefExplicit = !!(opts.contextRef || cfg.contextRef);

  return {
    resourceType,
    family,
    resourceLabel: rt.label,
    skill: rt.skill,
    pushType: rt.pushType,
    passThroughColumns: rt.passThroughColumns,
    translateColumns: rt.translateColumns,
    // tsv scope
    book: book ? book.toUpperCase() : null,
    startChapter,
    endChapter,
    verseStart,
    verseEnd,
    rowIds,
    mergeMode,
    // article scope
    articleId,
    articleUrl,
    // common
    targetLang,
    targetLangName: langName(targetLang),
    sourceLang,
    sourceLangName: langName(sourceLang),
    direction: opts.direction || cfg.direction || (RTL_LANGS.has(targetLang.split('-')[0]) ? 'rtl' : 'ltr'),
    targetOrg,
    repoName,
    sourceRef,
    sourceLiteralRef,
    sourceSimplifiedRef,
    targetLiteralRef,
    targetSimplifiedRef,
    contextRef,
    contextRefExplicit,
    writeContextBack: opts.writeContextBack === true ? true
      : opts.writeContextBack === false ? false
        : null,
    jobId: opts.jobId || route._jobId || null,
    model: opts.model || route.model || 'opus',
    delivery,
    branchOnly: opts.branchOnly !== false,
  };
}

function buildSessionKey(message, params) {
  const base = message.type === 'stream'
    ? `stream-${message.display_recipient}-${message.subject}`
    : `dm-${message.sender_id}`;
  return `${base}${core.translateSessionSuffix(params.targetLang, params.rowIds, {
    resourceType: params.resourceType,
    articleId: params.articleId || params.articleUrl || null,
  })}`;
}

// ---------------------------------------------------------------------------
// TSV family (tn, tq)
// ---------------------------------------------------------------------------

function tsvResource(params) {
  const rt = getResourceType(params.resourceType);
  const codec = makeTsvCodec(rt.columns);
  return {
    resourceType: params.resourceType,
    passThroughColumns: rt.passThroughColumns,
    translateColumns: rt.translateColumns,
    file: rt.file,
    _codec: codec,
    checkOpts: { passThroughColumns: rt.passThroughColumns, translateColumns: rt.translateColumns },
    sizeOf: (r) => rt.translateColumns.reduce((s, c) => s + (r[c] || '').length, 0),
  };
}

async function runTsvBatch({ files, batchRows, params, resource, guard }) {
  let lastChecks = null;
  const cols = params.translateColumns.join(' + ');

  for (let attempt = 1; attempt <= MAX_BATCH_ATTEMPTS; attempt++) {
    const isRepair = attempt > 1 && lastChecks;
    const repairNote = isRepair
      ? `\n\nYour previous output FAILED deterministic validation. Violations:\n${
        lastChecks.errors.map((e) => `- [${e.check}]${e.column ? ` (${e.column})` : ''} row ${e.rowId}: ${e.message}`).join('\n')
      }\nRewrite ${files.outputFile} fixing every violation. Translate ONLY these columns: ${cols}. Every other column must be byte-identical to the source.`
      : '';

    const result = await runClaude({
      prompt: `${files.taskFile}${repairNote}`,
      skill: params.skill,
      cwd: CSKILLBP_DIR,
      model: params.model,
      thinking: 'medium',
      tools: ['Read', 'Write'],
      enableBash: false,
      disableLocalSettings: true,
      mcpToolSet: 'none',
      maxTurns: 50,
      timeoutMs: 20 * 60 * 1000,
      label: `translate-${params.resourceType}-${params.targetLang}-batch${files.nn}${isRepair ? '-repair' : ''}`,
      guardrails: guard,
    });
    if (result?.subtype !== 'success') {
      throw new Error(`${params.skill} batch ${files.nn} failed: ${result?.error || result?.subtype || 'unknown'}`);
    }

    const { rows, checks } = core.readBatchOutput(files.outputFile, batchRows, {
      parse: resource._codec.parse, checkOpts: resource.checkOpts,
    });
    if (checks.ok) return { rows, checks, attempts: attempt };
    lastChecks = checks;
    console.warn(`${LOG_PREFIX} batch ${files.nn} attempt ${attempt}: ${checks.errors.length} blocking violation(s)`
      + (attempt < MAX_BATCH_ATTEMPTS ? ' — running repair pass' : ''));
  }
  const summary = lastChecks.errors.slice(0, 5).map((e) => `[${e.check}] ${e.rowId}: ${e.message}`).join('; ');
  throw new Error(`batch ${files.nn} still failing deterministic checks after repair pass: ${summary}`);
}

/**
 * Core TSV run, independent of Zulip/checkpoint plumbing (dry-run driveable).
 * Returns { sourceRows, targetRows, checks, report, bookText, existingBookText }.
 */
async function translateChapters(params, { workDir, onProgress, runBatchImpl, maxRows, existingTargetText } = {}) {
  const progress = onProgress || (() => {});
  const resource = tsvResource(params);

  // 1. Source rows at the pinned ref, sliced to the chapter range then optionally
  //    narrowed to a subset (rowIds and/or verse range).
  const sourceText = await core.fetchResourceFile(params.sourceRef, resource.file(params.book));
  if (!sourceText) throw new Error(`source not found: ${params.sourceRef} ${resource.file(params.book)}`);
  const allRows = resource._codec.parse(sourceText);
  let rows = core.sliceChapterRows(allRows, params.startChapter, params.endChapter);
  rows = core.selectRows(rows, { rowIds: params.rowIds, verseStart: params.verseStart, verseEnd: params.verseEnd });
  if (!rows.length) {
    const sel = params.rowIds ? `rowIds ${params.rowIds.join(',')}`
      : params.verseStart != null ? `${params.startChapter}:${params.verseStart}${params.verseEnd !== params.verseStart ? `-${params.verseEnd}` : ''}`
        : `${params.startChapter}-${params.endChapter}`;
    throw new Error(`no source rows for ${params.book} ${sel}`);
  }
  if (maxRows && rows.length > maxRows) rows = rows.slice(0, maxRows);
  progress(`source: ${rows.length} row(s) from ${params.sourceRef}${params.mergeMode === 'by-id' ? ' (by-id subset)' : ''}`);

  // 2. Context pack.
  const pack = await loadContextPack(params.contextRef, { allowEmpty: !params.contextRefExplicit });
  if (!pack.hasContent) {
    progress(`WARNING: no context pack at ${params.contextRef} (repo absent/empty) — translating as a RAW BASELINE.`);
  } else {
    progress(`context pack: ${params.contextRef}${pack.sha ? ` @ ${pack.sha.slice(0, 10)}` : ''}`
      + ` — ${pack.templates.size} templates, ${pack.terms.length} terms, ${pack.examples.length} examples`);
  }

  // 3. Batch → translate → validate (+1 repair) per batch.
  fs.mkdirSync(workDir, { recursive: true });
  const batches = core.buildBatches(rows, { sizeOf: resource.sizeOf });
  progress(`translating ${params.resourceType} in ${batches.length} batch(es)`);

  let scripture = null;
  try {
    scripture = await scriptureVerses.buildScripturePack({
      book: params.book, rows,
      sourceLiteralRef: params.sourceLiteralRef,
      sourceSimplifiedRef: params.sourceSimplifiedRef,
      targetLiteralRef: params.targetLiteralRef,
      targetSimplifiedRef: params.targetSimplifiedRef,
    });
    progress(`scripture: target literal ${scripture.targetLiteralFound ? 'found' : 'MISSING'} (${params.targetLiteralRef}), simplified ${scripture.targetSimplifiedFound ? 'found' : 'MISSING'} (${params.targetSimplifiedRef})`);
  } catch (e) {
    progress(`scripture: skipped (${e.message})`);
    scripture = null;
  }

  const batchMeta = [];
  const targetRows = [];
  for (let i = 0; i < batches.length; i++) {
    const batchRows = batches[i];
    const rendered = core.renderBatchPack({ batchRows, pack, scripture, ...params });
    const files = core.writeBatchFiles(workDir, i, {
      batchRows,
      packMarkdown: rendered.markdown,
      targetLang: params.targetLang,
      targetLangName: params.targetLangName,
      sourceLangName: params.sourceLangName,
      direction: params.direction,
      book: params.book,
      resource,
    });
    let outRows = null;
    let attempts = 0;
    if (fs.existsSync(files.outputFile)) {
      try {
        const prev = core.readBatchOutput(files.outputFile, batchRows, { parse: resource._codec.parse, checkOpts: resource.checkOpts });
        if (prev.checks.ok) { outRows = prev.rows; progress(`batch ${files.nn} reused from previous run (checks ok)`); }
      } catch { /* retranslate */ }
    }
    if (!outRows) {
      const impl = runBatchImpl || runTsvBatch;
      ({ rows: outRows, attempts } = await impl({ files, batchRows, params, resource }));
    }
    targetRows.push(...outRows);
    batchMeta.push({ nn: files.nn, rowCount: batchRows.length, attempts, templateFallbacks: rendered.templateFallbacks, slugs: rendered.slugs });
    progress(`batch ${files.nn}/${String(batches.length).padStart(2, '0')} done (${batchRows.length} rows, ${attempts} attempt(s))`);
  }

  // 4. Whole-range validation.
  const checks = runChecks(rows, targetRows, resource.checkOpts);
  if (!checks.ok) {
    const summary = checks.errors.slice(0, 5).map((e) => `[${e.check}] ${e.rowId}: ${e.message}`).join('; ');
    throw new Error(`whole-range deterministic checks failed: ${summary}`);
  }

  // 5. Merge into the whole-book target file.
  let existingBookText = existingTargetText ?? null;
  if (existingBookText == null) {
    const targetRepoRef = `${params.targetOrg}/${params.repoName}@master`;
    existingBookText = await core.fetchResourceFile(targetRepoRef, resource.file(params.book));
    if (existingBookText == null) progress(`no existing target book at ${targetRepoRef} — starting fresh`);
  }
  const bookText = params.mergeMode === 'by-id'
    ? core.updateRowsById(existingBookText, targetRows, { parse: resource._codec.parse, serialize: resource._codec.serialize })
    : core.mergeChapterIntoBook(existingBookText, targetRows, { ...params, parse: resource._codec.parse, serialize: resource._codec.serialize });

  const report = core.buildTranslateReport({
    resourceType: params.resourceType,
    book: params.book, startChapter: params.startChapter, endChapter: params.endChapter,
    targetLang: params.targetLang, sourceLang: params.sourceLang,
    sourceRef: params.sourceRef, contextRef: params.contextRef, contextSha: pack.sha,
    targetOrg: params.targetOrg, targetRepo: params.repoName,
    jobId: params.jobId || null,
    batches: batchMeta, checks,
    selection: { mergeMode: params.mergeMode, verseStart: params.verseStart ?? null, verseEnd: params.verseEnd ?? null, rowIds: params.rowIds ?? null },
  });

  return { sourceRows: rows, targetRows, checks, report, bookText, existingBookText, pack };
}

// ---------------------------------------------------------------------------
// Article family (tw, ta)
// ---------------------------------------------------------------------------

async function runArticleFile({ files, sourceMarkdown, params, guard }) {
  let lastChecks = null;
  for (let attempt = 1; attempt <= MAX_BATCH_ATTEMPTS; attempt++) {
    const isRepair = attempt > 1 && lastChecks;
    const repairNote = isRepair
      ? `\n\nYour previous output FAILED deterministic validation. Violations:\n${
        lastChecks.errors.map((e) => `- [${e.check}]: ${e.message}`).join('\n')
      }\nRewrite ${files.outputFile} fixing every violation. Preserve every rc://, [[wiki]], and ](link) target byte-for-byte and keep the heading structure.`
      : '';
    const result = await runClaude({
      prompt: `${files.taskFile}${repairNote}`,
      skill: params.skill,
      cwd: CSKILLBP_DIR,
      model: params.model,
      thinking: 'medium',
      tools: ['Read', 'Write'],
      enableBash: false,
      disableLocalSettings: true,
      mcpToolSet: 'none',
      maxTurns: 50,
      timeoutMs: 20 * 60 * 1000,
      label: `translate-${params.resourceType}-${params.targetLang}-${files.nn}${isRepair ? '-repair' : ''}`,
      guardrails: guard,
    });
    if (result?.subtype !== 'success') {
      throw new Error(`${params.skill} file ${files.nn} failed: ${result?.error || result?.subtype || 'unknown'}`);
    }
    const { markdown, checks } = core.readArticleOutput(files.outputFile, sourceMarkdown, { articleId: params.articleId, path: files.path });
    if (checks.ok) return { markdown, checks, attempts: attempt };
    lastChecks = checks;
    console.warn(`${LOG_PREFIX} ${files.nn} attempt ${attempt}: ${checks.errors.length} blocking violation(s)`
      + (attempt < MAX_BATCH_ATTEMPTS ? ' — running repair pass' : ''));
  }
  const summary = lastChecks.errors.slice(0, 5).map((e) => `[${e.check}]: ${e.message}`).join('; ');
  throw new Error(`article file ${files.nn} still failing checks after repair pass: ${summary}`);
}

/**
 * Core article run (dry-run driveable). Returns
 * { articleId, files: [{path, markdown, checks}], report, allChecks }.
 * opts.resolveImpl / opts.runFileImpl let tests stub network + LLM.
 */
async function translateArticles(params, { workDir, onProgress, resolveImpl, runFileImpl, maxFiles } = {}) {
  const progress = onProgress || (() => {});

  // 1. Resolve the article to its concrete files.
  const resolved = await (resolveImpl || resolveArticle)({
    resourceType: params.resourceType,
    articleId: params.articleId,
    articleUrl: params.articleUrl,
    sourceRef: params.sourceRef,
  });
  let sourceFiles = resolved.files;
  if (maxFiles && sourceFiles.length > maxFiles) sourceFiles = sourceFiles.slice(0, maxFiles);
  progress(`article ${resolved.articleId}: ${sourceFiles.length} file(s) from ${params.sourceRef}`);

  // 2. Context pack.
  const pack = await loadContextPack(params.contextRef, { allowEmpty: !params.contextRefExplicit });
  if (!pack.hasContent) progress(`WARNING: no context pack at ${params.contextRef} — RAW BASELINE.`);
  else progress(`context pack: ${params.contextRef}${pack.sha ? ` @ ${pack.sha.slice(0, 10)}` : ''}`);

  // 3. Translate each file (per-file checks + 1 repair pass).
  fs.mkdirSync(workDir, { recursive: true });
  // resolved.articleId (the canonical path-keyed id) must win over params.articleId
  // (null for URL-triggered runs) — spread params FIRST, then override.
  const rendered = core.renderArticlePack({ ...params, pack, articleId: resolved.articleId });
  const outFiles = [];
  const fileMeta = [];
  for (let i = 0; i < sourceFiles.length; i++) {
    const { path: filePath, sourceMarkdown } = sourceFiles[i];
    const files = core.writeArticleFiles(workDir, i, {
      sourceMarkdown,
      packMarkdown: rendered.markdown,
      articleId: resolved.articleId,
      filePath,
      targetLang: params.targetLang,
      targetLangName: params.targetLangName,
      sourceLangName: params.sourceLangName,
      direction: params.direction,
    });
    files.path = filePath;
    let markdown = null; let checks = null; let attempts = 0;
    if (fs.existsSync(files.outputFile)) {
      try {
        const prev = core.readArticleOutput(files.outputFile, sourceMarkdown, { articleId: resolved.articleId, path: filePath });
        if (prev.checks.ok) { markdown = prev.markdown; checks = prev.checks; progress(`${files.nn} (${filePath}) reused from previous run`); }
      } catch { /* retranslate */ }
    }
    if (markdown == null) {
      const impl = runFileImpl || runArticleFile;
      ({ markdown, checks, attempts } = await impl({ files, sourceMarkdown, params }));
    }
    outFiles.push({ path: filePath, markdown, checks });
    fileMeta.push({ nn: files.nn, path: filePath, attempts, rowCount: 1, templateFallbacks: rendered.templateFallbacks, slugs: rendered.slug ? [rendered.slug] : [] });
    progress(`file ${files.nn}/${String(sourceFiles.length).padStart(2, '0')} done (${filePath}, ${attempts} attempt(s))`);
  }

  // 4. Aggregate checks (per-file already enforced; this rolls warnings up).
  const allViol = outFiles.flatMap((f) => f.checks.violations);
  const allChecks = {
    ok: allViol.every((v) => v.severity !== 'error'),
    errors: allViol.filter((v) => v.severity === 'error'),
    warnings: allViol.filter((v) => v.severity === 'warning'),
    violations: allViol,
  };
  if (!allChecks.ok) throw new Error(`article checks failed: ${allChecks.errors.slice(0, 5).map((e) => e.message).join('; ')}`);

  const report = core.buildTranslateReport({
    resourceType: params.resourceType,
    articleId: resolved.articleId, files: outFiles.map((f) => f.path),
    targetLang: params.targetLang, sourceLang: params.sourceLang,
    sourceRef: params.sourceRef, contextRef: params.contextRef, contextSha: pack.sha,
    targetOrg: params.targetOrg, targetRepo: params.repoName,
    jobId: params.jobId || null,
    batches: fileMeta, checks: allChecks,
    selection: { mergeMode: 'article', verseStart: null, verseEnd: null, rowIds: null },
  });

  return { articleId: resolved.articleId, files: outFiles, report, allChecks, pack };
}

// ---------------------------------------------------------------------------
// Pipeline entrypoint (Zulip + API)
// ---------------------------------------------------------------------------

async function translatePipeline(route, message) {
  const params = resolveParams(route, message);
  const isArticle = params.family === 'article';
  const sessionKey = buildSessionKey(message, params);

  const scope = isArticle
    ? { book: articleScopeBook(params.resourceType), startChapter: 1, endChapter: 1, verseStart: null, verseEnd: null }
    : { book: params.book, startChapter: params.startChapter, endChapter: params.endChapter, verseStart: params.verseStart, verseEnd: params.verseEnd };
  const ckptId = { sessionKey, pipelineType: 'translate', scope };

  const scopeLabel = isArticle
    ? (params.articleId || params.articleUrl)
    : params.rowIds ? `${params.startChapter} [${params.rowIds.join(',')}]`
      : params.verseStart != null ? `${params.startChapter}:${params.verseStart}${params.verseEnd !== params.verseStart ? `-${params.verseEnd}` : ''}`
        : params.startChapter === params.endChapter ? `${params.startChapter}` : `${params.startChapter}-${params.endChapter}`;
  const label = isArticle
    ? `${params.resourceLabel} ${scopeLabel} → ${params.targetLangName}`
    : `${params.book} ${scopeLabel} ${params.resourceType.toUpperCase()} → ${params.targetLangName}`;

  const post = (text) => {
    const p = message.type === 'stream'
      ? sendMessage(message.display_recipient, message.subject, text)
      : sendDM(message.sender_id, text);
    return p.catch((err) => console.error(`${LOG_PREFIX} post failed: ${err.message}`));
  };

  const username = getDoor43Username(message.sender_email)
    || emailToFallbackUsername(message.sender_email || '')
    || message.sender_full_name
    || 'bp-assistant';

  // runHash separates distinct logical runs in the batch-reuse cache + branch name.
  const selTag = isArticle
    ? `-a-${(params.articleId || params.articleUrl || '').replace(/[^A-Za-z0-9]+/g, '_').slice(0, 40)}`
    : params.rowIds ? `-ids-${params.rowIds.join('-')}`
      : params.verseStart != null ? `-v${params.verseStart}-${params.verseEnd}` : '';
  const runHash = crypto.createHash('sha1')
    .update([params.resourceType, params.sourceRef, params.contextRef, params.model, params.direction, selTag].join('|'))
    .digest('hex').slice(0, 8);
  const scopePart = isArticle
    ? `${params.resourceType}${selTag}`
    : `${params.book}-${params.startChapter}-${params.endChapter}${selTag}`;
  const workDir = path.join(CSKILLBP_DIR, 'tmp', `translate-${params.targetLang}-${scopePart}-${runHash}`);

  console.log(`${LOG_PREFIX} Starting ${label} (org=${params.targetOrg}/${params.repoName}, source=${params.sourceRef}, context=${params.contextRef})`);
  setCheckpoint(ckptId, { state: 'running', current: { chapter: scope.startChapter, skill: params.skill, status: 'running' } });

  try {
    if (isArticle) {
      return await runArticleDelivery({ params, ckptId, scope, workDir, runHash, label, username, post });
    }
    return await runTsvDelivery({ params, ckptId, scope, workDir, runHash, label, username, post });
  } catch (err) {
    console.error(`${LOG_PREFIX} ${label} failed: ${err.message}`);
    setCheckpoint(ckptId, { state: 'failed', current: { chapter: scope.startChapter, skill: params.skill, status: 'failed', error: String(err.message).slice(0, 300) } });
    await publishAdminStatus({ source: 'translate-pipeline', pipelineType: 'translate', scope: label, phase: 'run', severity: 'error', message: err.message }).catch(() => {});
    await post(`:cross_mark: Translate **${label}** failed: ${err.message}`);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Post-delivery context-repo write-back (non-fatal)
// ---------------------------------------------------------------------------

async function finalizeContextWriteBack({
  params, pack, report, sourceRows = [], targetRows = [], deliveryBranch = null, label,
}) {
  if (!shouldWriteContextBack(params, pack)) {
    return { ok: true, written: [], skipped: 'write-back-not-eligible' };
  }

  const runId = crypto.randomUUID();
  report.runId = runId;
  report.jobId = report.jobId || params.jobId || null;
  report.generatedAt = report.generatedAt || new Date().toISOString();
  report.targetOrg = report.targetOrg || params.targetOrg;
  report.targetRepo = report.targetRepo || params.repoName;
  report.branch = deliveryBranch || report.branch || null;
  report.scope = report.scope || {
    book: params.book || null,
    startChapter: params.startChapter ?? null,
    endChapter: params.endChapter ?? null,
    articleId: params.articleId || null,
  };

  // Article runs pass no TSV rows — reconstruct template-needed signals from report batches.
  let rowsForSuggestions = sourceRows;
  if (!rowsForSuggestions.length && report.batches) {
    rowsForSuggestions = [];
    for (const b of report.batches) {
      for (const slug of b.templateFallbacks || []) {
        rowsForSuggestions.push({ SupportReference: slug, ID: b.path || String(b.batch || b.nn || '') });
      }
    }
  }

  const inbox = buildSuggestionInbox({
    runId,
    jobId: report.jobId,
    generatedAt: report.generatedAt,
    contextRef: params.contextRef,
    contextSha: report.contextSha,
    sourceRef: params.sourceRef,
    targetOrg: params.targetOrg,
    targetRepo: params.repoName,
    branch: deliveryBranch,
    resourceType: params.resourceType,
    scope: report.scope,
    pack,
    sourceRows: rowsForSuggestions,
    targetRows,
  });

  return writeContextArtifactsSafe({
    contextRef: params.contextRef,
    runId,
    report,
    inbox,
  }, {
    onError: async (err) => {
      await publishAdminStatus({
        source: 'translate-pipeline',
        pipelineType: 'translate',
        scope: label,
        phase: 'context-write',
        severity: 'warn',
        message: `context write-back failed: ${err.message}`,
      });
    },
  });
}

async function runTsvDelivery({ params, ckptId, scope, workDir, runHash, label, username, post }, deps = {}) {
  const translateImpl = deps.translateImpl || translateChapters;
  const pushImpl = deps.pushImpl || door43Push;
  const { sourceRows, targetRows, report, bookText, pack } = await translateImpl(params, {
    workDir,
    onProgress: (msg) => {
      console.log(`${LOG_PREFIX} ${msg}`);
      setCheckpoint(ckptId, { state: 'running', current: { chapter: scope.startChapter, skill: params.skill, status: msg.slice(0, 120) } });
    },
  });

  const outDir = path.join(workDir, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const bookFile = path.join(outDir, getResourceType(params.resourceType).file(params.book));
  const reportFile = path.join(outDir, `translate-report-${params.startChapter}-${params.endChapter}.json`);

  let deliveryBranch = null;
  let pushResult = null;

  // The merged book file is written unconditionally, before any delivery
  // branching — every mode ('path', 'branch', 'editor') serves it from disk.
  fs.writeFileSync(bookFile, bookText, 'utf8');

  if (params.delivery === 'branch') {
    const chapterTag = params.startChapter === params.endChapter
      ? String(params.startChapter).padStart(2, '0')
      : `${String(params.startChapter).padStart(2, '0')}-${String(params.endChapter).padStart(2, '0')}`;
    deliveryBranch = `AI-translate-${params.targetLang}-${params.resourceType}-${params.book}-${chapterTag}-${runHash}`;
    pushResult = await pushImpl({
      type: params.pushType, book: params.book, chapter: params.startChapter, username, branch: deliveryBranch,
      source: path.relative(CSKILLBP_DIR, bookFile), org: params.targetOrg, repoName: params.repoName,
      wholeFile: true, endChapter: params.endChapter, pipeline: 'translate', branchOnly: params.branchOnly,
    });
    if (!pushResult.success) throw new Error(`Door43 push failed: ${pushResult.details}`);
  }

  await finalizeContextWriteBack({
    params, pack, report, sourceRows, targetRows, deliveryBranch, label,
  });
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), 'utf8');

  const donePatch = { state: 'done', current: { chapter: params.endChapter, skill: params.skill, status: 'done' } };
  let output = null;
  if (params.delivery === 'editor') {
    // Editor delivery: no Door43 push. The done checkpoint carries the output
    // manifest; bible-editor fetches each entry's `file` from
    // GET /api/pipeline/{jobId}/output?file=… (the manifest is the allowlist).
    output = [
      {
        delivery: 'editor',
        type: params.resourceType,
        repo: `${params.targetOrg}/${params.repoName}`,
        path: path.basename(bookFile),
        file: path.basename(bookFile),
      },
      { delivery: 'editor', type: 'report', file: path.basename(reportFile) },
    ];
    donePatch.outDir = path.relative(CSKILLBP_DIR, outDir);
    donePatch.output = output;
  }
  setCheckpoint(ckptId, donePatch);
  const summary = `${targetRows.length} rows, ${report.checks.warningCount} warning(s), 0 blocking violations`;

  if (params.delivery === 'path') {
    await post(`:check: Translated **${label}** — ${summary}.\nFile: \`${bookFile}\`\nReport: \`${reportFile}\``);
    console.log(`${LOG_PREFIX} ${label} delivered as path: ${bookFile}`);
    return { bookFile, reportFile, delivery: 'path', runId: report.runId || null };
  }

  if (params.delivery === 'editor') {
    await post(`:check: Translated **${label}** — ${summary}. Delivered to bible-editor as drafts (no Door43 push).`);
    console.log(`${LOG_PREFIX} ${label} delivered to bible-editor: ${bookFile}`);
    return { bookFile, reportFile, delivery: 'editor', output, runId: report.runId || null };
  }

  const where = pushResult.branchUrl ? `branch [${deliveryBranch}](${pushResult.branchUrl}) (review before merge)` : `PR #${pushResult.prNumber || '?'} (merged)`;
  await post(`:check: Translated **${label}** — ${summary}. Landed on ${where}.`);
  return { bookFile, reportFile, delivery: 'branch', branch: deliveryBranch, prNumber: pushResult.prNumber, runId: report.runId || null };
}

async function runArticleDelivery({ params, ckptId, scope, workDir, runHash, label, username, post }, deps = {}) {
  const translateImpl = deps.translateImpl || translateArticles;
  const pushImpl = deps.pushImpl || door43Push;
  const { articleId, files, report, pack } = await translateImpl(params, {
    workDir,
    onProgress: (msg) => {
      console.log(`${LOG_PREFIX} ${msg}`);
      setCheckpoint(ckptId, { state: 'running', current: { chapter: 1, skill: params.skill, status: msg.slice(0, 120) } });
    },
  });

  const outDir = path.join(workDir, 'out');
  const staged = [];
  for (const f of files) {
    const local = path.join(outDir, f.path);
    fs.mkdirSync(path.dirname(local), { recursive: true });
    fs.writeFileSync(local, f.markdown, 'utf8');
    staged.push({ path: f.path, local });
  }
  const reportFile = path.join(outDir, `translate-report-${articleId.replace(/[^A-Za-z0-9]+/g, '_')}.json`);

  let deliveryBranch = null;
  let pushResult = null;
  if (params.delivery === 'branch') {
    deliveryBranch = `AI-translate-${params.targetLang}-${params.resourceType}-${articleId.replace(/[^A-Za-z0-9]+/g, '-')}-${runHash}`;
    pushResult = await pushImpl({
      type: 'article',
      files: staged.map((s) => ({ path: s.path, source: path.relative(CSKILLBP_DIR, s.local) })),
      username, branch: deliveryBranch, org: params.targetOrg, repoName: params.repoName,
      pipeline: 'translate', branchOnly: params.branchOnly,
    });
    if (!pushResult.success) throw new Error(`Door43 push failed: ${pushResult.details}`);
  }

  // Article runs have no TSV source/target rows for term harvest; templates only.
  await finalizeContextWriteBack({
    params, pack, report, sourceRows: [], targetRows: [], deliveryBranch, label,
  });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), 'utf8');

  const donePatch = { state: 'done', current: { chapter: 1, skill: params.skill, status: 'done' } };
  let output = null;
  if (params.delivery === 'editor') {
    // Editor delivery: one manifest entry per staged article file. `file` is
    // the repo-relative md path (may be nested, e.g. bible/kt/god.md) — the
    // output endpoint resolves it under outDir, so nesting round-trips.
    output = [
      ...staged.map((s) => ({
        delivery: 'editor',
        type: params.resourceType,
        repo: `${params.targetOrg}/${params.repoName}`,
        path: s.path,
        file: s.path,
      })),
      { delivery: 'editor', type: 'report', file: path.basename(reportFile) },
    ];
    donePatch.outDir = path.relative(CSKILLBP_DIR, outDir);
    donePatch.output = output;
  }
  setCheckpoint(ckptId, donePatch);
  const summary = `${files.length} file(s), ${report.checks.warningCount} warning(s), 0 blocking violations`;

  if (params.delivery === 'path') {
    await post(`:check: Translated **${label}** — ${summary}.\nFiles:\n${staged.map((s) => `- \`${s.local}\``).join('\n')}\nReport: \`${reportFile}\``);
    console.log(`${LOG_PREFIX} ${label} delivered as path (${staged.length} files)`);
    return { articleId, files: staged, reportFile, delivery: 'path', runId: report.runId || null };
  }

  if (params.delivery === 'editor') {
    await post(`:check: Translated **${label}** — ${summary}. Delivered to bible-editor as drafts (no Door43 push).`);
    console.log(`${LOG_PREFIX} ${label} delivered to bible-editor (${staged.length} files)`);
    return { articleId, files: staged, reportFile, delivery: 'editor', output, runId: report.runId || null };
  }

  const where = pushResult.branchUrl ? `branch [${deliveryBranch}](${pushResult.branchUrl}) (review before merge)` : `PR #${pushResult.prNumber || '?'} (merged)`;
  await post(`:check: Translated **${label}** — ${summary}. Landed on ${where}.`);
  return { articleId, files: staged, reportFile, delivery: 'branch', branch: deliveryBranch, prNumber: pushResult.prNumber, runId: report.runId || null };
}

module.exports = {
  translatePipeline,
  translateChapters,
  translateArticles,
  runTsvDelivery,
  runArticleDelivery,
  resolveParams,
  articleScopeBook,
  ROUTE_RESOURCE_TYPE,
  COMMAND_RE,
  TSV_COMMAND_RE,
  ARTICLE_COMMAND_RE,
};
