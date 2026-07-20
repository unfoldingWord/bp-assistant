// Tests for scripture-verses.js: fetching source/target USFM and building
// per-verse text maps, plus the renderBatchPack scripture section.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { buildScripturePack } = require('../src/lib/scripture-verses');
const { renderBatchPack } = require('../src/lib/translate-core');

const ULT_USFM = '\\c 1\n\\v 1 \\w In|x-occurrence="1"\\w* \\w the|x-occurrence="1"\\w* \\w beginning|x-occurrence="1"\\w*.\n'
  + '\\v 2 \\w And|x-occurrence="1"\\w* \\w the|x-occurrence="2"\\w* \\w earth|x-occurrence="1"\\w* \\w was|x-occurrence="1"\\w* \\w void|x-occurrence="1"\\w*.\n';
const UST_USFM = '\\c 1\n\\v 1 \\w When|x-occurrence="1"\\w* \\w God|x-occurrence="1"\\w* \\w started|x-occurrence="1"\\w*.\n'
  + '\\v 2 \\w The|x-occurrence="1"\\w* \\w earth|x-occurrence="1"\\w* \\w was|x-occurrence="1"\\w* \\w empty|x-occurrence="1"\\w*.\n';

// Mirrors the fetch-like impl shape fetchResourceFile expects (see
// test/translate-article.test.js fakeFetch): { status, ok, text() }.
function fakeFetch(byRef) {
  return async (url) => {
    for (const [ref, body] of Object.entries(byRef)) {
      if (url.includes(ref)) {
        if (body === null) return { status: 404, ok: false };
        return { status: 200, ok: true, text: async () => body };
      }
    }
    return { status: 404, ok: false };
  };
}

test('buildScripturePack fetches source + target USFM and builds byRef maps; missing target is absent', async () => {
  const fetchImpl = fakeFetch({
    'en_ult': ULT_USFM,
    'en_ust': UST_USFM,
    // no en_gl_glt entry → target literal 404s
  });

  const rows = [
    { Reference: '1:1', ID: 'a1' },
    { Reference: '1:2', ID: 'a2' },
  ];

  const pack = await buildScripturePack({
    book: 'GEN',
    rows,
    sourceLiteralRef: 'unfoldingWord/en_ult@master',
    sourceSimplifiedRef: 'unfoldingWord/en_ust@master',
    targetLiteralRef: 'ar_gl/ar_glt@master',
    targetSimplifiedRef: null,
  }, { fetchImpl });

  assert.strictEqual(pack.targetLiteralFound, false);
  assert.strictEqual(pack.targetSimplifiedFound, false);
  assert.strictEqual(pack.versions.length, 2);

  const sourceLiteral = pack.versions.find((v) => v.role === 'source-literal');
  assert.ok(sourceLiteral);
  assert.strictEqual(sourceLiteral.label, 'Source literal (ULT)');
  assert.strictEqual(sourceLiteral.byRef['1:1'], 'In the beginning');
  assert.strictEqual(sourceLiteral.byRef['1:2'], 'And the earth was void');

  const sourceSimplified = pack.versions.find((v) => v.role === 'source-simplified');
  assert.ok(sourceSimplified);
  assert.strictEqual(sourceSimplified.byRef['1:1'], 'When God started');
});

test('buildScripturePack includes target versions when present, with repo-derived labels', async () => {
  const fetchImpl = fakeFetch({
    'en_ult': ULT_USFM,
    'en_ust': UST_USFM,
    'ar_glt': ULT_USFM,
    'ar_gst': UST_USFM,
  });

  const rows = [{ Reference: '1:1', ID: 'a1' }];

  const pack = await buildScripturePack({
    book: 'GEN',
    rows,
    sourceLiteralRef: 'unfoldingWord/en_ult@master',
    sourceSimplifiedRef: 'unfoldingWord/en_ust@master',
    targetLiteralRef: 'ar_gl/ar_glt@master',
    targetSimplifiedRef: 'ar_gl/ar_gst@master',
  }, { fetchImpl });

  assert.strictEqual(pack.targetLiteralFound, true);
  assert.strictEqual(pack.targetSimplifiedFound, true);
  assert.strictEqual(pack.versions.length, 4);
  const targetLiteral = pack.versions.find((v) => v.role === 'target-literal');
  assert.strictEqual(targetLiteral.label, 'Target literal (ar_glt)');
  const targetSimplified = pack.versions.find((v) => v.role === 'target-simplified');
  assert.strictEqual(targetSimplified.label, 'Target simplified (ar_gst)');
});

test('buildScripturePack never throws when a fetch fails (network error)', async () => {
  const fetchImpl = async () => { throw new Error('network down'); };
  const rows = [{ Reference: '1:1', ID: 'a1' }];
  const pack = await buildScripturePack({
    book: 'GEN',
    rows,
    sourceLiteralRef: 'unfoldingWord/en_ult@master',
    sourceSimplifiedRef: 'unfoldingWord/en_ust@master',
    targetLiteralRef: 'ar_gl/ar_glt@master',
    targetSimplifiedRef: 'ar_gl/ar_gst@master',
  }, { fetchImpl });
  assert.strictEqual(pack.versions.length, 0);
  assert.strictEqual(pack.targetLiteralFound, false);
  assert.strictEqual(pack.targetSimplifiedFound, false);
});

test('renderBatchPack appends the scripture section with per-verse bullets', () => {
  const pack = { templates: new Map(), terms: [], examples: [] };
  const batchRows = [{ Reference: '1:1', ID: 'a1', SupportReference: '' }];
  const scripture = {
    targetLiteralFound: true,
    targetSimplifiedFound: false,
    versions: [
      { role: 'source-literal', label: 'Source literal (ULT)', byRef: { '1:1': 'In the beginning' } },
      { role: 'target-literal', label: 'Target literal (ar_glt)', byRef: { '1:1': 'في البدء' } },
    ],
  };
  const rendered = renderBatchPack({
    batchRows, pack, targetLang: 'ar', targetLangName: 'Arabic', direction: 'rtl', scripture,
  });
  assert.match(rendered.markdown, /## Scripture for these verses/);
  assert.match(rendered.markdown, /### 1:1/);
  assert.match(rendered.markdown, /Source literal \(ULT\): In the beginning/);
  assert.match(rendered.markdown, /Target literal \(ar_glt\): في البدء/);
});

test('renderBatchPack notes when no target scripture is available', () => {
  const pack = { templates: new Map(), terms: [], examples: [] };
  const batchRows = [{ Reference: '1:1', ID: 'a1', SupportReference: '' }];
  const scripture = {
    targetLiteralFound: false,
    targetSimplifiedFound: false,
    versions: [
      { role: 'source-literal', label: 'Source literal (ULT)', byRef: { '1:1': 'In the beginning' } },
    ],
  };
  const rendered = renderBatchPack({
    batchRows, pack, targetLang: 'ar', targetLangName: 'Arabic', direction: 'rtl', scripture,
  });
  assert.match(rendered.markdown, /No target-language literal\/simplified Bible is available/);
});

test('renderBatchPack omits the scripture section when scripture is not provided', () => {
  const pack = { templates: new Map(), terms: [], examples: [] };
  const batchRows = [{ Reference: '1:1', ID: 'a1', SupportReference: '' }];
  const rendered = renderBatchPack({
    batchRows, pack, targetLang: 'ar', targetLangName: 'Arabic', direction: 'rtl',
  });
  assert.ok(!/## Scripture for these verses/.test(rendered.markdown));
});
