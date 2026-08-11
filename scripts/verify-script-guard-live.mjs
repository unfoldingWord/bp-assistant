// Live end-to-end check of the script guard against real DCS data.
// Not part of the test suite (it hits the network); run by hand:
//   node scripts/verify-script-guard-live.mjs
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { translateChapters } = require('../src/translate-pipeline.js');
const { getResourceType } = require('../src/lib/resource-types.js');

const rt = getResourceType('tn');
let modelCalls = 0;
// Stub model: echoes the source rows back unchanged. Any real translation work
// would be a call we did NOT want to make.
// Stands in for a real translation: Arabic text, with every rc:// link and digit
// carried over so the deterministic checks pass the same way real output would.
const stubBatch = async ({ batchRows }) => {
  modelCalls++;
  const rows = batchRows.map((r) => {
    const links = (String(r.Note || '').match(/rc:\/\/[^\s\])]+/g) || []);
    const nums = (String(r.Note || '').match(/\d+/g) || []);
    const note = r.Note ? `ترجمة${nums.length ? ' ' + nums.join(' ') : ''}${links.length ? ' ' + links.join(' ') : ''}` : r.Note;
    return { ...r, Note: note };
  });
  return { rows, checks: { ok: true }, attempts: 1 };
};

function params(sourceRef, book = '2TH', chapter = 3) {
  return {
    resourceType: 'tn', family: 'tsv', resourceLabel: rt.label, skill: rt.skill,
    passThroughColumns: rt.passThroughColumns, translateColumns: rt.translateColumns,
    book, startChapter: chapter, endChapter: chapter, verseStart: null, verseEnd: null,
    rowIds: null, mergeMode: 'range',
    targetLang: 'ar', targetLangName: 'Arabic', sourceLang: 'en', sourceLangName: 'English',
    direction: 'rtl', targetOrg: 'BSOJ', repoName: 'ar_tn', sourceRef,
    sourceLiteralRef: 'unfoldingWord/en_ult@master', sourceSimplifiedRef: 'unfoldingWord/en_ust@master',
    targetLiteralRef: 'BSOJ/ar_glt@master', targetSimplifiedRef: 'BSOJ/ar_gst@master',
    contextRef: 'BSOJ/translation-context@master', contextRefExplicit: false,
  };
}

const workDir = path.join(os.tmpdir(), 'verify-script-guard');

async function run(label, sourceRef, book, chapter) {
  modelCalls = 0;
  const lines = [];
  try {
    const out = await translateChapters(params(sourceRef, book, chapter), {
      workDir, onProgress: (m) => lines.push(m), runBatchImpl: stubBatch,
    });
    console.log(`\n=== ${label} (${sourceRef}) ===`);
    for (const l of lines) console.log('  ' + l);
    console.log('  model batch calls:', modelCalls);
    console.log('  scriptGuard:', JSON.stringify(out.scriptGuard));
    console.log('  identicalRate:', JSON.stringify(out.report.identicalRate));
    // The merged book must keep every in-scope row: translated + preserved.
    console.log('  mergedRows:', out.mergedRows.length, 'of', out.sourceRows.length, 'in scope');
    const preserved = out.mergedRows.filter((r) => /[؀-ۿ]/.test(r.Note || ''));
    console.log('  merged rows still holding Arabic (human work preserved):', preserved.length);
  } catch (e) {
    console.log(`\n=== ${label} (${sourceRef}) ===`);
    for (const l of lines) console.log('  ' + l);
    console.log('  model batch calls:', modelCalls);
    console.log('  THREW: ' + e.message);
  }
}

await run('OLD CONFIG — translate-in-place', 'BSOJ/ar_tn@master', '2TH', 3);
await run('NEW CONFIG — English source, finished book', 'unfoldingWord/en_tn@master', '2TH', 3);
// JON is the one partially-translated book (63% Arabic) — the partial-skip path
// must translate the English remainder and preserve the Arabic, NOT error out.
await run('NEW CONFIG — English source, MIXED book', 'unfoldingWord/en_tn@master', 'JON', 1);
// A wholly-English book must be entirely translated: guard stays out of the way.
await run('NEW CONFIG — English source, untranslated book', 'unfoldingWord/en_tn@master', 'ZEC', 1);
