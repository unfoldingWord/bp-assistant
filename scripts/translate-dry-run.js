#!/usr/bin/env node
// translate-dry-run.js — drive the translate pipeline core end-to-end
// locally: real DCS source fetch, real context pack, real Claude skill runs,
// real deterministic checks — but NO Door43 push and no Zulip/checkpoints.
//
// Usage:
//   CSKILLBP_DIR=<path-to-bp-assistant-skills> node scripts/translate-dry-run.js \
//     --book OBA --start 1 --end 1 --lang ar \
//     --context <path-to-context-pack-dir-or-org/repo@ref> \
//     --out <output-dir> [--model sonnet] [--max-rows 20]
//
// Requires a Claude Code login (the Agent SDK uses the local CLI auth) or
// ANTHROPIC_API_KEY.

'use strict';

const fs = require('fs');
const path = require('path');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const LANG_NAMES = { ar: 'Arabic', 'es-419': 'Latin American Spanish', es: 'Spanish' };

async function main() {
  const book = (arg('book', 'OBA')).toUpperCase();
  const startChapter = parseInt(arg('start', '1'), 10);
  const endChapter = parseInt(arg('end', String(startChapter)), 10);
  const targetLang = arg('lang', 'ar');
  const contextRef = arg('context');
  const outDir = path.resolve(arg('out', `./dry-run-${targetLang}-${book}`));
  const model = arg('model', 'sonnet');
  const maxRows = arg('max-rows') ? parseInt(arg('max-rows'), 10) : null;

  if (!contextRef) {
    console.error('Missing --context <dir | org/repo@ref>');
    process.exit(2);
  }
  if (!process.env.CSKILLBP_DIR) {
    console.error('CSKILLBP_DIR must point at the bp-assistant-skills checkout (skill discovery).');
    process.exit(2);
  }

  const { translateChapters } = require('../src/translate-pipeline');

  const params = {
    book,
    startChapter,
    endChapter,
    targetLang,
    targetLangName: LANG_NAMES[targetLang] || targetLang,
    direction: targetLang.split('-')[0] === 'ar' ? 'rtl' : 'ltr',
    targetOrg: `${targetLang}_gl`,
    sourceRef: arg('source', 'unfoldingWord/en_tn@master'),
    contextRef,
    model,
  };

  const workDir = path.join(outDir, 'work');
  fs.mkdirSync(workDir, { recursive: true });
  console.log(`[dry-run] ${book} ${startChapter}-${endChapter} → ${params.targetLangName} (model=${model}${maxRows ? `, max-rows=${maxRows}` : ''})`);
  console.log(`[dry-run] context: ${contextRef}`);
  console.log(`[dry-run] workDir: ${workDir}`);
  const t0 = Date.now();

  const { sourceRows, targetRows, checks, report, bookText } = await translateChapters(params, {
    workDir,
    maxRows,
    onProgress: (m) => console.log(`[dry-run] ${m}`),
  });

  const bookFile = path.join(outDir, `tn_${book}.tsv`);
  const reportFile = path.join(outDir, `translate-report.json`);
  fs.writeFileSync(bookFile, bookText, 'utf8');
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), 'utf8');

  const mins = ((Date.now() - t0) / 60000).toFixed(1);
  console.log('\n[dry-run] ===== RESULT =====');
  console.log(`[dry-run] rows: ${sourceRows.length} source → ${targetRows.length} target in ${mins} min`);
  console.log(`[dry-run] checks: ok=${checks.ok} errors=${checks.errors.length} warnings=${checks.warnings.length}`);
  for (const w of checks.warnings.slice(0, 15)) {
    console.log(`[dry-run]   warn [${w.check}] ${w.rowId}: ${w.message.slice(0, 140)}`);
  }
  console.log(`[dry-run] book file:   ${bookFile}`);
  console.log(`[dry-run] report:      ${reportFile}`);
  console.log('[dry-run] NO push performed (dry run by design).');
}

main().catch((err) => {
  console.error(`[dry-run] FAILED: ${err.stack || err.message}`);
  process.exit(1);
});
