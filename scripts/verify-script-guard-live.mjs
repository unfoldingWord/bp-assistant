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
    // THE data-integrity assertion: no row that existed in the partner's book
    // may be missing from the book we would push back. ar_tn carries notes that
    // en_tn does not (GEN: 327, JON: 9, TIT: 3), so a source-ordered merge
    // silently deletes them.
    const ids = (text) => new Set((text || '').split(/\r?\n/).slice(1).filter((l) => l.trim()).map((l) => l.split('\t')[1]));
    const beforeIds = ids(out.existingBookText);
    const afterIds = ids(out.bookText);
    const dropped = [...beforeIds].filter((id) => !afterIds.has(id));
    console.log(`  book rows: ${beforeIds.size} before -> ${afterIds.size} after`);
    console.log(`  DROPPED partner rows: ${dropped.length}${dropped.length ? ' !! ' + dropped.slice(0, 8).join(',') : ' (none)'}`);
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
// GEN 1 is the row-divergence case: ar_tn has 16 notes in chapter 1 that en_tn
// does not. A source-ordered merge deletes all 16.
await run('NEW CONFIG — row divergence (GEN has 327 ar-only rows)', 'unfoldingWord/en_tn@master', 'GEN', 1);
