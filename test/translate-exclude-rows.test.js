// options.excludeRowIds (#493): whole-chapter translate runs that leave out
// rows the caller keeps (e.g. editor-approved). Excluded rows must never reach
// the model, must not appear in the merged output, and are reported as retained.
'use strict';

process.env.BT_API_TOKEN = 'test-bt-api-token';
delete process.env.BT_API_TOKEN_FILE;
delete process.env.BOT_SECRETS_DIR;

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseTnTsv, serializeTnTsv } = require('../src/lib/tn-tsv');
const core = require('../src/lib/translate-core');

const HEADER = 'Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote\n';
// Chapter 1 has four rows; chapter 2 is outside the run's range.
const SRC = HEADER
  + '1:1\taaa1\t\t\t\t1\tNote one.\n'
  + '1:2\taaa2\t\t\t\t1\tNote two.\n'
  + '1:3\taaa3\t\t\t\t1\tNote three.\n'
  + '1:4\taaa4\t\t\t\t1\tNote four.\n'
  + '2:1\tbbb1\t\t\t\t1\tChapter two.\n';
// Existing target book: an older translation of chapter 1 plus chapter 2.
const EXISTING = HEADER
  + '1:1\taaa1\t\t\t\t1\tOLD one.\n'
  + '1:2\taaa2\t\t\t\t1\tOLD two.\n'
  + '1:3\taaa3\t\t\t\t1\tOLD three.\n'
  + '1:4\taaa4\t\t\t\t1\tOLD four.\n'
  + '2:1\tbbb1\t\t\t\t1\tOLD chapter two.\n';

test('selectRows drops excludeRowIds and leaves everything else in order', () => {
  const rows = core.sliceChapterRows(parseTnTsv(SRC), 1, 1);
  const sel = core.selectRows(rows, { excludeRowIds: ['aaa2', 'zzz9'] });
  assert.deepStrictEqual(sel.map((r) => r.ID), ['aaa1', 'aaa3', 'aaa4']);
  assert.strictEqual(core.selectRows(rows, { excludeRowIds: [] }), rows);
});

// --- API schema --------------------------------------------------------------
const { StartBodySchema } = require('../src/api/pipeline');
const base = { pipelineType: 'translate', book: 'OBA', startChapter: 1, username: 'tester', sessionKey: 'bible-editor/u1/run-1' };
const issues = (r) => (r.success ? [] : r.error.issues.map((i) => i.message));

test('excludeRowIds accepted on a whole-chapter translate start', () => {
  const r = StartBodySchema.safeParse({ ...base, options: { targetLang: 'ar', excludeRowIds: ['xm1w', 'k9wc'] } });
  assert.ok(r.success, JSON.stringify(issues(r)));
  const editor = StartBodySchema.safeParse({ ...base, options: { targetLang: 'ar', delivery: 'editor', excludeRowIds: [] } });
  assert.ok(editor.success, JSON.stringify(issues(editor)));
});

test('excludeRowIds combined with rowIds is rejected', () => {
  const r = StartBodySchema.safeParse({ ...base, options: { targetLang: 'ar', rowIds: ['xm1w'], excludeRowIds: ['k9wc'] } });
  assert.ok(!r.success);
  assert.ok(issues(r).some((m) => /cannot be combined with options\.rowIds/.test(m)));
});

test('excludeRowIds with a verse range, a push delivery, an article or a non-translate pipeline is rejected', () => {
  const verse = StartBodySchema.safeParse({ ...base, verseStart: 3, options: { targetLang: 'ar', excludeRowIds: ['k9wc'] } });
  assert.ok(issues(verse).some((m) => /whole-chapter runs/.test(m)));
  const branch = StartBodySchema.safeParse({ ...base, options: { targetLang: 'ar', delivery: 'branch', excludeRowIds: ['k9wc'] } });
  assert.ok(issues(branch).some((m) => /requires editor delivery/.test(m)));
  const article = StartBodySchema.safeParse({ ...base, options: { resourceType: 'tw', targetLang: 'ar', articleId: 'kt/god', excludeRowIds: ['k9wc'] } });
  assert.ok(issues(article).some((m) => /not valid for article resources/.test(m)));
  const notes = StartBodySchema.safeParse({ ...base, pipelineType: 'notes', options: { excludeRowIds: ['k9wc'] } });
  assert.ok(issues(notes).some((m) => /only valid for pipelineType "translate"/.test(m)));
  const badShape = StartBodySchema.safeParse({ ...base, options: { targetLang: 'ar', excludeRowIds: ['BAD-ID'] } });
  assert.ok(!badShape.success);
});

// --- Pipeline ---------------------------------------------------------------
function loadPipeline() {
  try {
    const contextPack = require('../src/lib/context-pack');
    const scriptureVerses = require('../src/lib/scripture-verses');
    const pipeline = require('../src/translate-pipeline');
    return { pipeline, contextPack, scriptureVerses };
  } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND') return null;
    throw e;
  }
}

const syntheticRoute = (translate, extra = {}) => ({
  _synthetic: true, _book: 'OBA', _startChapter: 1, _endChapter: 1, _verseStart: null, _verseEnd: null,
  _translate: { targetLang: 'ar', ...translate }, ...extra,
});

test('resolveParams carries excludeRowIds on range runs and refuses unsafe combinations', (t) => {
  const mods = loadPipeline();
  if (!mods) return t.skip('translate-pipeline runtime deps not installed');
  const { resolveParams } = mods.pipeline;
  const p = resolveParams(syntheticRoute({ excludeRowIds: ['aaa2', 'aaa2', 'aaa3'] }), {});
  assert.strictEqual(p.mergeMode, 'range');
  assert.deepStrictEqual(p.excludeRowIds, ['aaa2', 'aaa3']);
  assert.strictEqual(resolveParams(syntheticRoute({ excludeRowIds: [] }), {}).excludeRowIds, null);
  assert.throws(() => resolveParams(syntheticRoute({ rowIds: ['aaa1'], excludeRowIds: ['aaa2'] }), {}), /whole-chapter/);
  assert.throws(() => resolveParams(syntheticRoute({ excludeRowIds: ['aaa2'] }, { _verseStart: 2, _verseEnd: 2 }), {}), /whole-chapter/);
  assert.throws(() => resolveParams(syntheticRoute({ excludeRowIds: ['aaa2'], delivery: 'branch' }), {}), /editor delivery/);
});

async function runChapter(t, params) {
  const { pipeline, contextPack, scriptureVerses } = loadPipeline();
  const origFetch = core.fetchResourceFile;
  const origLoad = contextPack.loadContextPack;
  const origScripture = scriptureVerses.buildScripturePack;
  core.fetchResourceFile = async () => SRC;
  contextPack.loadContextPack = async () => ({ hasContent: true, sha: 'a'.repeat(40), templates: new Map(), terms: [], examples: [] });
  scriptureVerses.buildScripturePack = async () => ({ markdown: '', targetLiteralFound: true, targetSimplifiedFound: true });
  t.after(() => {
    core.fetchResourceFile = origFetch;
    contextPack.loadContextPack = origLoad;
    scriptureVerses.buildScripturePack = origScripture;
  });

  const sentToModel = [];
  const runBatchImpl = async ({ files, batchRows }) => {
    sentToModel.push(...batchRows.map((r) => r.ID));
    const rows = batchRows.map((r) => ({ ...r, Note: `NEW ${r.ID}` }));
    fs.writeFileSync(files.outputFile, serializeTnTsv(rows), 'utf8');
    return { rows, attempts: 1, llmCalls: [] };
  };
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'translate-exclude-'));
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));
  const result = await pipeline.translateChapters(params, {
    workDir, existingTargetText: EXISTING, onProgress: () => {}, runBatchImpl,
  });
  return { ...result, sentToModel };
}

const baseParams = {
  resourceType: 'tn', book: 'OBA', startChapter: 1, endChapter: 1, mergeMode: 'range',
  verseStart: null, verseEnd: null, rowIds: null,
  sourceRef: 'unfoldingWord/en_tn@master', contextRef: 'BSOJ/translation-context@master',
  targetLang: 'ar', targetLangName: 'Arabic', sourceLangName: 'English',
  direction: 'rtl', model: 'sonnet', targetOrg: 'BSOJ', repoName: 'ar_tn',
  sourceLiteralRef: 'unfoldingWord/en_ult@master', sourceSimplifiedRef: 'unfoldingWord/en_ust@master',
  targetLiteralRef: 'BSOJ/ar_glt@master', targetSimplifiedRef: 'BSOJ/ar_gst@master',
};

test('whole-chapter run with excludeRowIds never sends the row to the model and omits it from the output', async (t) => {
  if (!loadPipeline()) return t.skip('translate-pipeline runtime deps not installed');
  const { sentToModel, bookText, report, targetRows } = await runChapter(t, { ...baseParams, excludeRowIds: ['aaa2'] });

  assert.ok(!sentToModel.includes('aaa2'), 'excluded row must not reach the model');
  assert.deepStrictEqual(sentToModel, ['aaa1', 'aaa3', 'aaa4']);

  const out = parseTnTsv(bookText);
  assert.ok(!out.some((r) => r.ID === 'aaa2'), 'output must have no entry for the excluded row');
  // Range merge kept: chapter 1 replaced by the new rows, chapter 2 untouched.
  assert.deepStrictEqual(out.map((r) => r.ID), ['aaa1', 'aaa3', 'aaa4', 'bbb1']);
  assert.strictEqual(out.find((r) => r.ID === 'bbb1').Note, 'OLD chapter two.');

  // Chapter row count holds once excluded rows count as retained.
  const chapterSourceCount = core.sliceChapterRows(parseTnTsv(SRC), 1, 1).length;
  assert.deepStrictEqual(report.selection.retainedRowIds, ['aaa2']);
  assert.deepStrictEqual(report.selection.excludeRowIds, ['aaa2']);
  assert.strictEqual(targetRows.length + report.selection.retainedRowIds.length, chapterSourceCount);
  assert.strictEqual(report.selection.mergeMode, 'range');
});

test('excludeRowIds covering every row in scope fails with a clear message', async (t) => {
  if (!loadPipeline()) return t.skip('translate-pipeline runtime deps not installed');
  await assert.rejects(
    runChapter(t, { ...baseParams, excludeRowIds: ['aaa1', 'aaa2', 'aaa3', 'aaa4'] }),
    /all 4 row\(s\) in scope are in excludeRowIds/,
  );
});

test('runs without excludeRowIds keep the report selection shape unchanged', async (t) => {
  if (!loadPipeline()) return t.skip('translate-pipeline runtime deps not installed');
  const { report, sentToModel } = await runChapter(t, { ...baseParams });
  assert.deepStrictEqual(sentToModel, ['aaa1', 'aaa2', 'aaa3', 'aaa4']);
  assert.deepStrictEqual(Object.keys(report.selection).sort(), ['mergeMode', 'rowIds', 'verseEnd', 'verseStart']);
});
