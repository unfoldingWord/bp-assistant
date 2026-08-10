#!/usr/bin/env node
// translate-dry-run.js — drive the translate pipeline core end-to-end locally:
// real DCS source fetch, real context pack, real Claude skill runs, real
// deterministic checks — but NO Door43 push and no Zulip/checkpoints.
//
// TSV resources (tn, tq):
//   CSKILLBP_DIR=<skills> node scripts/translate-dry-run.js \
//     --resource tq --book OBA --start 1 --end 1 --lang ar \
//     --context <dir|org/repo@ref> --out ./dry-run-ar-tq [--model sonnet] [--max-rows N]
//
// Article resources (tw, ta):
//   CSKILLBP_DIR=<skills> node scripts/translate-dry-run.js \
//     --resource tw --article kt/god --lang ar --context <ctx> --out ./dry-run-ar-tw
//   CSKILLBP_DIR=<skills> node scripts/translate-dry-run.js \
//     --resource ta --article figs-aside --lang ar --context <ctx> --out ./dry-run-ar-ta
//   (--article also accepts a Door43 URL.)
//
// Source language is a first-class knob: --source-lang ru --source <ru_gl/ru_tn@master>.
// Requires a Claude Code login (Agent SDK uses local CLI auth) or ANTHROPIC_API_KEY.
//
// Direct multi-provider path (one API completion per batch/article instead of the
// agentic skill run), mirroring what POST /api/pipeline/start does:
//   --provider claude|openai|gemini|xai --api-key-env <ENV_NAME> [--model <catalog id>]
// The key is read from the NAMED ENV VAR, never from argv (argv is world-readable
// in the process table). Without --provider nothing changes.

'use strict';

const fs = require('fs');
const path = require('path');
const { getResourceType } = require('../src/lib/resource-types');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const LANG_NAMES = {
  ar: 'Arabic', 'es-419': 'Latin American Spanish', es: 'Spanish', ru: 'Russian',
  id: 'Indonesian', en: 'English', ka: 'Georgian',
};
const RTL = new Set(['ar', 'he', 'fa', 'ur', 'ps', 'arc', 'syr']);
const langName = (c) => LANG_NAMES[c] || c;

let TARGETS = {};
try { TARGETS = require('../config/translate-targets.json'); } catch { /* optional */ }

async function main() {
  const resourceType = (arg('resource', 'tn')).toLowerCase();
  const rt = getResourceType(resourceType);
  const targetLang = arg('lang', 'ar');
  const sourceLang = arg('source-lang', 'en');
  const contextRef = arg('context');
  const provider = arg('provider') || null;
  const modelArg = arg('model');
  const outDir = path.resolve(arg('out', `./dry-run-${targetLang}-${resourceType}`));
  const cfg = TARGETS[targetLang] || {};

  // Provider run: resolve the model against the catalog up front (same gate the
  // API applies) and take the key from the named env var only.
  let model = modelArg || 'sonnet';
  let apiKey = null;
  if (provider) {
    const keyEnv = arg('api-key-env');
    if (!keyEnv) { console.error('--provider requires --api-key-env <ENV_NAME>'); process.exit(2); }
    apiKey = process.env[keyEnv];
    if (!apiKey) { console.error(`--api-key-env ${keyEnv} is not set in the environment`); process.exit(2); }
    try {
      model = require('../src/api-runner/provider-config').assertProviderModel(provider, modelArg);
    } catch (err) {
      console.error(`[dry-run] ${err.message}`);
      process.exit(2);
    }
  }

  if (!contextRef) { console.error('Missing --context <dir | org/repo@ref>'); process.exit(2); }
  if (!process.env.CSKILLBP_DIR) {
    console.error('CSKILLBP_DIR must point at the bp-assistant-skills checkout (skill discovery).');
    process.exit(2);
  }

  const { translateChapters, translateArticles } = require('../src/translate-pipeline');

  const common = {
    resourceType,
    family: rt.family,
    skill: rt.skill,
    pushType: rt.pushType,
    targetLang,
    targetLangName: langName(targetLang),
    sourceLang,
    sourceLangName: langName(sourceLang),
    direction: arg('direction', RTL.has(targetLang.split('-')[0]) ? 'rtl' : 'ltr'),
    targetOrg: arg('org', cfg.targetOrg || `${targetLang}_gl`),
    repoName: arg('repo', cfg[rt.configRepoKey] || rt.defaultRepo(targetLang)),
    sourceRef: arg('source', cfg[`${resourceType}SourceRef`] || `unfoldingWord/${rt.defaultSourceRepo}@master`),
    contextRef,
    contextRefExplicit: true,
    model,
    provider,
    thinking: 'medium',
  };

  // Non-enumerable, exactly as the API path attaches it: the key must survive
  // into translate-llm without being visible to a spread, a log or a report.
  const attachApiKey = (params) => {
    if (provider && apiKey) Object.defineProperty(params, 'apiKey', { value: apiKey, enumerable: false });
    return params;
  };

  fs.mkdirSync(outDir, { recursive: true });
  const workDir = path.join(outDir, 'work');
  fs.mkdirSync(workDir, { recursive: true });
  const t0 = Date.now();

  if (rt.family === 'article') {
    const articleRef = arg('article');
    if (!articleRef) { console.error('article resources need --article <name|url>'); process.exit(2); }
    const isUrl = /^https?:\/\//i.test(articleRef);
    const params = attachApiKey({ ...common, articleId: isUrl ? null : articleRef, articleUrl: isUrl ? articleRef : null });
    console.log(`[dry-run] ${resourceType} ${articleRef} → ${params.targetLangName} (${provider || 'subscription'}, model=${model}); source ${params.sourceRef}`);
    const maxFiles = arg('max-files') ? parseInt(arg('max-files'), 10) : null;
    const { articleId, files, report } = await translateArticles(params, {
      workDir, maxFiles, onProgress: (m) => console.log(`[dry-run] ${m}`),
    });
    const outArticleDir = path.join(outDir, 'out');
    for (const f of files) {
      const local = path.join(outArticleDir, f.path);
      fs.mkdirSync(path.dirname(local), { recursive: true });
      fs.writeFileSync(local, f.markdown, 'utf8');
    }
    const reportFile = path.join(outDir, 'translate-report.json');
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), 'utf8');
    const mins = ((Date.now() - t0) / 60000).toFixed(1);
    console.log(`\n[dry-run] ===== RESULT (${articleId}) =====`);
    console.log(`[dry-run] ${files.length} file(s) in ${mins} min; checks ok=${report.checks.ok} errors=${report.checks.errorCount} warnings=${report.checks.warningCount}`);
    if (report.llm) console.log(`[dry-run] llm: ${report.llm.provider}/${report.llm.model}, ${report.llm.calls} call(s), ${report.llm.inputTokens} in / ${report.llm.outputTokens} out tokens, est cost ${report.llm.estimatedCostUsd == null ? 'unpriced' : `$${report.llm.estimatedCostUsd.toFixed(4)}`}`);
    for (const f of files) console.log(`[dry-run]   ${f.path}`);
    console.log(`[dry-run] out: ${outArticleDir}\n[dry-run] report: ${reportFile}`);
    console.log('[dry-run] NO push performed (dry run by design).');
    return;
  }

  // TSV family.
  const book = (arg('book', 'OBA')).toUpperCase();
  const startChapter = parseInt(arg('start', '1'), 10);
  const endChapter = parseInt(arg('end', String(startChapter)), 10);
  const maxRows = arg('max-rows') ? parseInt(arg('max-rows'), 10) : null;
  const rowIds = arg('rows') ? arg('rows').split(',').map((s) => s.trim()).filter(Boolean) : null;
  const verseArg = arg('verse');
  let verseStart = null; let verseEnd = null;
  if (verseArg) { const [vs, ve] = verseArg.split('-').map((x) => parseInt(x.trim(), 10)); verseStart = vs; verseEnd = Number.isInteger(ve) ? ve : vs; }
  const hasSubset = (rowIds && rowIds.length) || verseStart != null;
  const existingTargetPath = arg('existing-target');
  const existingTargetText = existingTargetPath ? fs.readFileSync(existingTargetPath, 'utf8') : undefined;
  if (hasSubset && existingTargetText === undefined) {
    console.error('[dry-run] by-id (subset) mode needs --existing-target <file> in a dry run.');
    process.exit(2);
  }

  const params = attachApiKey({
    ...common,
    book, startChapter, endChapter, verseStart, verseEnd, rowIds,
    mergeMode: hasSubset ? 'by-id' : 'range',
    passThroughColumns: rt.passThroughColumns,
    translateColumns: rt.translateColumns,
  });

  console.log(`[dry-run] ${resourceType} ${book} ${startChapter}-${endChapter} → ${params.targetLangName} (${provider || 'subscription'}, model=${model}${maxRows ? `, max-rows=${maxRows}` : ''}); source ${params.sourceRef}`);
  const { sourceRows, targetRows, checks, report, bookText } = await translateChapters(params, {
    workDir, maxRows, existingTargetText, onProgress: (m) => console.log(`[dry-run] ${m}`),
  });

  const bookFile = path.join(outDir, rt.file(book));
  const reportFile = path.join(outDir, 'translate-report.json');
  fs.writeFileSync(bookFile, bookText, 'utf8');
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), 'utf8');
  const mins = ((Date.now() - t0) / 60000).toFixed(1);
  console.log('\n[dry-run] ===== RESULT =====');
  console.log(`[dry-run] rows: ${sourceRows.length} source → ${targetRows.length} target in ${mins} min`);
  console.log(`[dry-run] checks: ok=${checks.ok} errors=${checks.errors.length} warnings=${checks.warnings.length}`);
  if (report.llm) console.log(`[dry-run] llm: ${report.llm.provider}/${report.llm.model}, ${report.llm.calls} call(s), ${report.llm.inputTokens} in / ${report.llm.outputTokens} out tokens, est cost ${report.llm.estimatedCostUsd == null ? 'unpriced' : `$${report.llm.estimatedCostUsd.toFixed(4)}`}`);
  for (const w of checks.warnings.slice(0, 15)) console.log(`[dry-run]   warn [${w.check}] ${w.rowId}: ${String(w.message).slice(0, 140)}`);
  console.log(`[dry-run] book file: ${bookFile}\n[dry-run] report: ${reportFile}`);
  console.log('[dry-run] NO push performed (dry run by design).');
}

main().catch((err) => { console.error(`[dry-run] FAILED: ${err.stack || err.message}`); process.exit(1); });
