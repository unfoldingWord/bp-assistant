// translate-pipeline.js — translate published translationNotes into a
// gateway language, chapter-batched, with deterministic pass-through checks.
//
// Triggered by:
//   Zulip:  "translate notes OBA 1 to ar"  /  "translate notes OBA 1-2 into es-419"
//   HTTP:   POST /api/pipeline/start { pipelineType: "translate", ... options:
//           { targetLang, targetOrg?, sourceRef?, contextRef? } }
//
// Contract (see bp-bot/translate-pipeline/PLAN.md and DECISION.md):
// - Source rows come from the PUBLISHED source repo at a pinned ref
//   (sourceRef, default unfoldingWord/en_tn@master) — not inline in the
//   request (32 KB body cap; published repo is the source of truth).
// - Output: exactly one target row per source row, same order;
//   Reference/ID/Tags/SupportReference/Quote/Occurrence byte-identical;
//   only Note is translated. Enforced by src/lib/translate-checks.js —
//   error-severity violations BLOCK the push.
// - Per-language context pack (templates/terminology/instructions/examples)
//   pinned by contextRef and injected per batch (src/lib/context-pack.js).

'use strict';

const fs = require('fs');
const path = require('path');
const { sendMessage, sendDM } = require('./zulip-client');
const { runClaude } = require('./claude-runner');
const { CSKILLBP_DIR, getDoor43Username, emailToFallbackUsername } = require('./pipeline-utils');
const { setCheckpoint } = require('./pipeline-checkpoints');
const { publishAdminStatus } = require('./admin-status');
const { door43Push } = require('./door43-push');
const { loadContextPack } = require('./lib/context-pack');
const { parseTnTsv } = require('./lib/tn-tsv');
const { runChecks } = require('./lib/translate-checks');
const core = require('./lib/translate-core');

const LOG_PREFIX = '[translate]';

// Scope forms accepted after the book:
//   "1"      whole chapter        "1-2"    chapter range
//   "1:5"    one verse            "1:5-7"  verse range (single chapter)
// Groups: 1=book 2=startChapter 3=verse-or-verse-range 4=endChapter 5=lang.
const COMMAND_RE = /translate\s+notes?\s+(\w{3})\s+(\d+)(?::(\d+(?:\s*[-–—]\s*\d+)?))?(?:\s*[-–—]\s*(\d+))?\s+(?:to|into)\s+([A-Za-z0-9-]+)/i;

// Display names are a convenience only; any ISO 639-1/639-3 code (optionally
// with a region/script subtag, e.g. es-419, zh-Hans) is accepted, and an
// unknown code simply falls back to showing the code itself.
const LANG_NAMES = {
  ar: 'Arabic', 'es-419': 'Latin American Spanish', es: 'Spanish', ru: 'Russian',
  fr: 'French', hi: 'Hindi', sw: 'Swahili', pt: 'Portuguese', id: 'Indonesian',
  zh: 'Chinese', vi: 'Vietnamese', bn: 'Bengali', ur: 'Urdu', fa: 'Persian',
  he: 'Hebrew', am: 'Amharic', ne: 'Nepali', my: 'Burmese', th: 'Thai',
};
// Base subtags whose default script is right-to-left. Direction can always be
// overridden per run via options.direction.
const RTL_LANGS = new Set(['ar', 'he', 'fa', 'ur', 'ps', 'sd', 'ug', 'yi', 'dv', 'ckb', 'arc', 'syr', 'prs']);

const MAX_BATCH_ATTEMPTS = 2; // 1 draft + 1 repair pass

function resolveParams(route, message) {
  let book, startChapter, endChapter, targetLang;
  let verseStart = null;
  let verseEnd = null;
  let rowIds = null;
  const opts = route._translate || {};

  if (route._synthetic && route._book) {
    book = route._book;
    startChapter = route._startChapter;
    endChapter = route._endChapter;
    targetLang = opts.targetLang;
    verseStart = route._verseStart ?? null;
    verseEnd = route._verseEnd ?? null;
    rowIds = Array.isArray(opts.rowIds) && opts.rowIds.length ? opts.rowIds : null;
  } else {
    const m = COMMAND_RE.exec(String(message.content || ''));
    if (!m) throw new Error('Could not parse translate command. Usage: translate notes OBA 1 to ar (or OBA 1:5 / OBA 1:5-7 / OBA 1-2)');
    book = m[1].toUpperCase();
    startChapter = parseInt(m[2], 10);
    if (m[3]) {
      // verse or verse range within a single chapter
      const [vs, ve] = m[3].split(/[-–—]/).map((x) => parseInt(x.trim(), 10));
      endChapter = startChapter;
      verseStart = vs;
      verseEnd = Number.isInteger(ve) ? ve : vs;
    } else {
      endChapter = m[4] ? parseInt(m[4], 10) : startChapter;
    }
    targetLang = m[5].toLowerCase();
  }
  if (!targetLang) throw new Error('translate: targetLang is required');

  // A subset selection (specific rows, or a verse narrower than the whole
  // chapter) switches the merge from whole-range replacement to update-by-ID,
  // so untouched notes in the same chapter are preserved in place.
  const hasSubset = (rowIds && rowIds.length > 0) || verseStart != null;
  const mergeMode = hasSubset ? 'by-id' : 'range';

  // Delivery mode:
  //   'path'   — stage the file locally and return its path; NO Door43 push.
  //   'branch' — push to a review branch in the GL org (no auto-merge).
  // Beta default is per-origin: Zulip-triggered runs return a path (fast
  // loop, no GL repo required); API-triggered runs push to a branch (Bible
  // Editor consumes the DCS branch). Either can be forced via options.delivery.
  const delivery = opts.delivery || (route._synthetic ? 'branch' : 'path');

  return {
    book: book.toUpperCase(),
    startChapter,
    endChapter,
    verseStart,
    verseEnd,
    rowIds,
    mergeMode,
    targetLang,
    targetLangName: LANG_NAMES[targetLang] || targetLang,
    direction: opts.direction || (RTL_LANGS.has(targetLang.split('-')[0]) ? 'rtl' : 'ltr'),
    targetOrg: opts.targetOrg || `${targetLang}_gl`,
    sourceRef: opts.sourceRef || 'unfoldingWord/en_tn@master',
    contextRef: opts.contextRef || `${(opts.targetOrg || `${targetLang}_gl`)}/translation-context@master`,
    model: opts.model || route.model || 'opus',
    delivery,
    branchOnly: opts.branchOnly !== false, // when delivery==='branch': land on a branch, no auto-merge (unlike en pipelines)
  };
}

function buildSessionKey(message, targetLang) {
  const base = message.type === 'stream'
    ? `stream-${message.display_recipient}-${message.subject}`
    : `dm-${message.sender_id}`;
  // The language is part of the run's identity: ar OBA 1 and es OBA 1 are
  // different work and must never share a checkpoint (see DECISION.md §dev-3).
  return `${base}-${targetLang}`;
}

/**
 * Run the translate-tn skill over one batch, with one repair pass on
 * deterministic-check errors. Returns { rows, checks, attempts }.
 */
async function runBatch({ files, batchRows, params, guard }) {
  let lastChecks = null;

  for (let attempt = 1; attempt <= MAX_BATCH_ATTEMPTS; attempt++) {
    const isRepair = attempt > 1 && lastChecks;
    const repairNote = isRepair
      ? `\n\nYour previous output FAILED deterministic validation. Violations:\n${
        lastChecks.errors.map((e) => `- [${e.check}] row ${e.rowId}: ${e.message}`).join('\n')
      }\nRewrite ${files.outputFile} fixing every violation. Do not change any column except Note.`
      : '';

    const result = await runClaude({
      prompt: `${files.taskFile}${repairNote}`,
      skill: 'translate-tn',
      cwd: CSKILLBP_DIR,
      model: params.model,
      thinking: 'medium',
      tools: ['Read', 'Write'],
      enableBash: false,
      disableLocalSettings: true,
      mcpToolSet: 'none',
      maxTurns: 50,
      timeoutMs: 20 * 60 * 1000,
      label: `translate-${params.targetLang}-batch${files.nn}${isRepair ? '-repair' : ''}`,
      guardrails: guard,
    });
    if (result?.subtype !== 'success') {
      throw new Error(`translate-tn batch ${files.nn} failed: ${result?.error || result?.subtype || 'unknown'}`);
    }

    const { rows, checks } = core.readBatchOutput(files.outputFile, batchRows);
    if (checks.ok) return { rows, checks, attempts: attempt };
    lastChecks = checks;
    console.warn(`${LOG_PREFIX} batch ${files.nn} attempt ${attempt}: ${checks.errors.length} blocking violation(s)`
      + (attempt < MAX_BATCH_ATTEMPTS ? ' — running repair pass' : ''));
  }

  const summary = lastChecks.errors.slice(0, 5).map((e) => `[${e.check}] ${e.rowId}: ${e.message}`).join('; ');
  throw new Error(`batch ${files.nn} still failing deterministic checks after repair pass: ${summary}`);
}

/**
 * Core run, independent of Zulip/checkpoint plumbing so the dry-run script
 * can drive it. Returns { targetRows, checks, report, bookText }.
 * opts.runBatchImpl allows tests to stub the LLM step.
 */
async function translateChapters(params, { workDir, onProgress, runBatchImpl, maxRows, existingTargetText } = {}) {
  const progress = onProgress || (() => {});

  // 1. Source rows at the pinned ref, sliced to the chapter range then
  //    optionally narrowed to a subset (specific rowIds and/or a verse range)
  //    for individual-note / single-verse translation.
  const sourceText = await core.fetchTnBook(params.sourceRef, params.book);
  if (!sourceText) throw new Error(`source not found: ${params.sourceRef} tn_${params.book}.tsv`);
  const allRows = parseTnTsv(sourceText);
  let rows = core.sliceChapterRows(allRows, params.startChapter, params.endChapter);
  rows = core.selectRows(rows, { rowIds: params.rowIds, verseStart: params.verseStart, verseEnd: params.verseEnd });
  if (!rows.length) {
    const sel = params.rowIds ? `rowIds ${params.rowIds.join(',')}`
      : params.verseStart != null ? `${params.startChapter}:${params.verseStart}${params.verseEnd !== params.verseStart ? `-${params.verseEnd}` : ''}`
        : `${params.startChapter}-${params.endChapter}`;
    throw new Error(`no source rows for ${params.book} ${sel}`);
  }
  if (maxRows && rows.length > maxRows) rows = rows.slice(0, maxRows); // dry-run trimming only
  progress(`source: ${rows.length} row(s) from ${params.sourceRef}${params.mergeMode === 'by-id' ? ' (by-id subset)' : ''}`);

  // 2. Context pack at the pinned ref.
  const pack = await loadContextPack(params.contextRef);
  progress(`context pack: ${params.contextRef}${pack.sha ? ` @ ${pack.sha.slice(0, 10)}` : ''}`
    + ` — ${pack.templates.size} templates, ${pack.terms.length} terms, ${pack.examples.length} examples`
    + (pack.missing.length ? ` (missing: ${pack.missing.join(', ')})` : ''));

  // 3. Batch → translate → validate (+1 repair pass) per batch.
  fs.mkdirSync(workDir, { recursive: true });
  const batches = core.buildBatches(rows);
  progress(`translating in ${batches.length} batch(es)`);

  const batchMeta = [];
  const targetRows = [];
  for (let i = 0; i < batches.length; i++) {
    const batchRows = batches[i];
    const rendered = core.renderBatchPack({ batchRows, pack, ...params });
    const files = core.writeBatchFiles(workDir, i, {
      batchRows,
      packMarkdown: rendered.markdown,
      targetLang: params.targetLang,
      targetLangName: params.targetLangName,
      direction: params.direction,
      book: params.book,
    });
    // Resume support: a batch whose output already exists and passes checks
    // (from an interrupted earlier run over the same workDir) is reused
    // instead of re-translated. Batch files are deterministic for a given
    // (sourceRef, contextRef, scope), so reuse is safe.
    let outRows = null;
    let attempts = 0;
    if (fs.existsSync(files.outputFile)) {
      try {
        const prev = core.readBatchOutput(files.outputFile, batchRows);
        if (prev.checks.ok) {
          outRows = prev.rows;
          progress(`batch ${files.nn} reused from previous run (checks ok)`);
        }
      } catch { /* unreadable partial output — retranslate */ }
    }
    if (!outRows) {
      const impl = runBatchImpl || runBatch;
      ({ rows: outRows, attempts } = await impl({ files, batchRows, params }));
    }
    targetRows.push(...outRows);
    batchMeta.push({
      nn: files.nn,
      rowCount: batchRows.length,
      attempts,
      templateFallbacks: rendered.templateFallbacks,
      slugs: rendered.slugs,
    });
    progress(`batch ${files.nn}/${String(batches.length).padStart(2, '0')} done (${batchRows.length} rows, ${attempts} attempt(s))`);
  }

  // 4. Whole-range validation (belt over the per-batch suspenders).
  const checks = runChecks(rows, targetRows);
  if (!checks.ok) {
    const summary = checks.errors.slice(0, 5).map((e) => `[${e.check}] ${e.rowId}: ${e.message}`).join('; ');
    throw new Error(`whole-range deterministic checks failed: ${summary}`);
  }

  // 5. Merge into the whole-book target file.
  //    - range mode: replace the whole chapter range (default, whole-chapter).
  //    - by-id mode: update only the selected rows in the existing target,
  //      leaving all other notes in place (individual-note / single-verse).
  //    existingTargetText (tests/dry-run) short-circuits the DCS fetch.
  let existingBookText = existingTargetText ?? null;
  if (existingBookText == null) {
    const targetRepoRef = `${params.targetOrg}/${params.targetLang}_tn@master`;
    try {
      existingBookText = await core.fetchTnBook(targetRepoRef, params.book);
    } catch (err) {
      console.warn(`${LOG_PREFIX} could not fetch existing target book (${err.message}) — starting fresh`);
    }
  }
  const bookText = params.mergeMode === 'by-id'
    ? core.updateRowsById(existingBookText, targetRows)
    : core.mergeChapterIntoBook(existingBookText, targetRows, params);

  const report = core.buildTranslateReport({
    book: params.book,
    startChapter: params.startChapter,
    endChapter: params.endChapter,
    targetLang: params.targetLang,
    sourceRef: params.sourceRef,
    contextRef: params.contextRef,
    contextSha: pack.sha,
    batches: batchMeta,
    checks,
    selection: {
      mergeMode: params.mergeMode,
      verseStart: params.verseStart ?? null,
      verseEnd: params.verseEnd ?? null,
      rowIds: params.rowIds ?? null,
    },
  });

  return { sourceRows: rows, targetRows, checks, report, bookText, existingBookText };
}

async function translatePipeline(route, message) {
  const params = resolveParams(route, message);
  const sessionKey = buildSessionKey(message, params.targetLang);
  const scope = {
    book: params.book,
    startChapter: params.startChapter,
    endChapter: params.endChapter,
    verseStart: params.verseStart,
    verseEnd: params.verseEnd,
  };
  const ckptId = { sessionKey, pipelineType: 'translate', scope };
  const scopeLabel = params.rowIds
    ? `${params.startChapter} [${params.rowIds.join(',')}]`
    : params.verseStart != null
      ? `${params.startChapter}:${params.verseStart}${params.verseEnd !== params.verseStart ? `-${params.verseEnd}` : ''}`
      : params.startChapter === params.endChapter
        ? `${params.startChapter}` : `${params.startChapter}-${params.endChapter}`;
  const label = `${params.book} ${scopeLabel} → ${params.targetLangName}`;

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

  // Selection discriminant keeps subset runs from colliding with each other
  // or with the whole-chapter run in the resume-reuse batch cache.
  const selTag = params.rowIds
    ? `-ids-${params.rowIds.join('-')}`
    : params.verseStart != null
      ? `-v${params.verseStart}-${params.verseEnd}`
      : '';
  const workDir = path.join(CSKILLBP_DIR, 'tmp',
    `translate-${params.targetLang}-${params.book}-${params.startChapter}-${params.endChapter}${selTag}`);

  console.log(`${LOG_PREFIX} Starting ${label} (org=${params.targetOrg}, source=${params.sourceRef}, context=${params.contextRef})`);
  setCheckpoint(ckptId, { state: 'running', current: { chapter: params.startChapter, skill: 'translate-tn', status: 'running' } });

  try {
    const { targetRows, report, bookText } = await translateChapters(params, {
      workDir,
      onProgress: (msg) => {
        console.log(`${LOG_PREFIX} ${msg}`);
        setCheckpoint(ckptId, { state: 'running', current: { chapter: params.startChapter, skill: 'translate-tn', status: msg.slice(0, 120) } });
      },
    });

    // Stage the whole-book file + report.
    const outDir = path.join(CSKILLBP_DIR, 'output', `notes-${params.targetLang}`, params.book);
    fs.mkdirSync(outDir, { recursive: true });
    const bookFile = path.join(outDir, `tn_${params.book}.tsv`);
    const reportFile = path.join(outDir, `translate-report-${params.startChapter}-${params.endChapter}.json`);
    fs.writeFileSync(bookFile, bookText, 'utf8');
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), 'utf8');

    setCheckpoint(ckptId, { state: 'done', current: { chapter: params.endChapter, skill: 'translate-tn', status: 'done' } });
    const summary = `${targetRows.length} notes, ${report.checks.warningCount} warning(s), 0 blocking violations`;

    if (params.delivery === 'path') {
      // Beta path-return mode: no Door43 push. Report where the files landed
      // in the bot workspace so a human can fetch/inspect them.
      await post(`:check: Translated **${label}** — ${summary}.\n`
        + `File: \`${bookFile}\`\nReport: \`${reportFile}\``);
      console.log(`${LOG_PREFIX} ${label} delivered as path: ${bookFile}`);
      return { bookFile, reportFile, delivery: 'path' };
    }

    // Push to the GL org. branchOnly by default: a human (or Bible Editor's
    // apply step) reviews before merge — translated drafts are not
    // auto-published the way English pipeline output is.
    const branch = `AI-translate-${params.targetLang}-${params.book}-${String(params.startChapter).padStart(2, '0')}`;
    const pushResult = await door43Push({
      type: 'tn',
      book: params.book,
      chapter: params.startChapter,
      username,
      branch,
      source: path.relative(CSKILLBP_DIR, bookFile),
      org: params.targetOrg,
      repoName: `${params.targetLang}_tn`,
      wholeFile: true,
      branchOnly: params.branchOnly,
    });
    if (!pushResult.success) {
      throw new Error(`Door43 push failed: ${pushResult.details}`);
    }
    // NOTE: verifyRepoPush is unfoldingWord-org-hardcoded (repo-verify.js:12-13)
    // and translate defaults to branchOnly (no merge to verify). Parameterize
    // repo-verify when auto-merge mode is enabled for a GL org.

    const where = pushResult.branchUrl
      ? `branch [${branch}](${pushResult.branchUrl}) (review before merge)`
      : `PR #${pushResult.prNumber || '?'} (merged)`;
    await post(`:check: Translated **${label}** — ${summary}. Landed on ${where}.`);
    return { bookFile, reportFile, delivery: 'branch', branch, prNumber: pushResult.prNumber };
  } catch (err) {
    console.error(`${LOG_PREFIX} ${label} failed: ${err.message}`);
    setCheckpoint(ckptId, {
      state: 'failed',
      current: { chapter: params.startChapter, skill: 'translate-tn', status: 'failed', error: String(err.message).slice(0, 300) },
    });
    await publishAdminStatus({
      source: 'translate-pipeline', pipelineType: 'translate', scope: label,
      phase: 'run', severity: 'error', message: err.message,
    }).catch(() => {});
    await post(`:cross_mark: Translate **${label}** failed: ${err.message}`);
    throw err;
  }
}

module.exports = { translatePipeline, translateChapters, resolveParams, COMMAND_RE };
