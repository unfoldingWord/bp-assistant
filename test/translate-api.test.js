// StartBodySchema rules for pipelineType "translate".
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { StartBodySchema } = require('../src/api/pipeline');

const base = {
  pipelineType: 'translate',
  book: 'OBA',
  startChapter: 1,
  username: 'tester',
  sessionKey: 'bible-editor/u1/run-1',
};

test('translate start body accepts full options', () => {
  const res = StartBodySchema.safeParse({
    ...base,
    options: {
      targetLang: 'ar',
      targetOrg: 'ar_gl',
      sourceRef: 'unfoldingWord/en_tn@master',
      contextRef: 'ar_gl/translation-context@0123456789012345678901234567890123456789',
      branchOnly: true,
    },
  });
  assert.ok(res.success, JSON.stringify(res.error?.issues));
});

test('translate requires options.targetLang', () => {
  const res = StartBodySchema.safeParse({ ...base, options: {} });
  assert.ok(!res.success);
  assert.ok(res.error.issues.some((i) => i.path.join('.') === 'options.targetLang'));
});

test('targetLang accepts region subtags, rejects garbage', () => {
  const ok = StartBodySchema.safeParse({ ...base, options: { targetLang: 'es-419' } });
  assert.ok(ok.success, JSON.stringify(ok.error?.issues));
  const bad = StartBodySchema.safeParse({ ...base, options: { targetLang: 'ARABIC LANGUAGE' } });
  assert.ok(!bad.success);
});

test('translate-only fields rejected on notes', () => {
  const res = StartBodySchema.safeParse({
    ...base,
    pipelineType: 'notes',
    options: { targetLang: 'ar' },
  });
  assert.ok(!res.success);
  assert.ok(res.error.issues.some((i) => /only valid for pipelineType "translate"/.test(i.message)));
});

test('notes-only hints rejected on translate', () => {
  const res = StartBodySchema.safeParse({
    ...base,
    options: {
      targetLang: 'ar',
      hints: [{ rowId: 'ab12', verse: 1, quote: 'x', supportReference: null, seed: null }],
    },
  });
  assert.ok(!res.success);
  assert.ok(res.error.issues.some((i) => /only valid for pipelineType "notes"/.test(i.message)));
});

test('rowIds accepted on translate, rejected elsewhere, shape-checked', () => {
  const ok = StartBodySchema.safeParse({ ...base, options: { targetLang: 'ar', rowIds: ['xm1w', 'k9wc'] } });
  assert.ok(ok.success, JSON.stringify(ok.error?.issues));
  const badShape = StartBodySchema.safeParse({ ...base, options: { targetLang: 'ar', rowIds: ['BAD-ID'] } });
  assert.ok(!badShape.success);
  const onNotes = StartBodySchema.safeParse({ ...base, pipelineType: 'notes', options: { rowIds: ['xm1w'] } });
  assert.ok(!onNotes.success);
});

test('delivery/direction accepted on translate only', () => {
  const ok = StartBodySchema.safeParse({ ...base, options: { targetLang: 'ar', delivery: 'path', direction: 'rtl' } });
  assert.ok(ok.success, JSON.stringify(ok.error?.issues));
  const bad = StartBodySchema.safeParse({ ...base, pipelineType: 'tqs', options: { delivery: 'path' } });
  assert.ok(!bad.success);
});

test('verse range spanning multiple chapters is rejected', () => {
  const res = StartBodySchema.safeParse({
    ...base, startChapter: 1, endChapter: 2,
    verseStart: 1, verseEnd: 3,
    options: { targetLang: 'ar' },
  });
  assert.ok(!res.success);
  assert.ok(res.error.issues.some((i) => /single chapter/.test(i.message)));
});

test('verseEnd without verseStart is rejected', () => {
  const res = StartBodySchema.safeParse({
    ...base, startChapter: 1, endChapter: 1, verseEnd: 5,
    options: { targetLang: 'ar' },
  });
  assert.ok(!res.success);
  assert.ok(res.error.issues.some((i) => /verseEnd requires verseStart/.test(i.message)));
});

test('verse scope within a single chapter is accepted', () => {
  const res = StartBodySchema.safeParse({
    ...base, startChapter: 1, endChapter: 1,
    verseStart: 5, verseEnd: 7,
    options: { targetLang: 'ar' },
  });
  assert.ok(res.success, JSON.stringify(res.error?.issues));
});

test('sourceRef/contextRef must be org/repo@ref shaped', () => {
  const res = StartBodySchema.safeParse({
    ...base,
    options: { targetLang: 'ar', sourceRef: 'not-a-ref' },
  });
  assert.ok(!res.success);
});

// --- resourceType / articles ---

test('tq resourceType still requires book + startChapter', () => {
  const ok = StartBodySchema.safeParse({ ...base, options: { resourceType: 'tq', targetLang: 'ar' } });
  assert.ok(ok.success, JSON.stringify(ok.error?.issues));
  const noBook = StartBodySchema.safeParse({ pipelineType: 'translate', username: 'u', sessionKey: 's', options: { resourceType: 'tq', targetLang: 'ar' } });
  assert.ok(!noBook.success);
  assert.ok(noBook.error.issues.some((i) => i.path.join('.') === 'book'));
});

test('tw article accepts articleId without book/startChapter', () => {
  const res = StartBodySchema.safeParse({
    pipelineType: 'translate', username: 'u', sessionKey: 's',
    options: { resourceType: 'tw', targetLang: 'ar', articleId: 'kt/god' },
  });
  assert.ok(res.success, JSON.stringify(res.error?.issues));
});

test('ta article accepts a Door43 articleUrl', () => {
  const res = StartBodySchema.safeParse({
    pipelineType: 'translate', username: 'u', sessionKey: 's',
    options: { resourceType: 'ta', targetLang: 'ar', articleUrl: 'https://git.door43.org/unfoldingWord/en_ta/src/branch/master/translate/figs-aside' },
  });
  assert.ok(res.success, JSON.stringify(res.error?.issues));
});

test('article requires exactly one of articleId / articleUrl', () => {
  const both = StartBodySchema.safeParse({
    pipelineType: 'translate', username: 'u', sessionKey: 's',
    options: { resourceType: 'tw', targetLang: 'ar', articleId: 'kt/god', articleUrl: 'https://git.door43.org/x/y/src/branch/master/a.md' },
  });
  assert.ok(!both.success);
  const neither = StartBodySchema.safeParse({
    pipelineType: 'translate', username: 'u', sessionKey: 's',
    options: { resourceType: 'tw', targetLang: 'ar' },
  });
  assert.ok(!neither.success);
});

test('articleId rejected on tsv resources; rowIds rejected on articles', () => {
  const idOnTn = StartBodySchema.safeParse({ ...base, options: { resourceType: 'tn', targetLang: 'ar', articleId: 'kt/god' } });
  assert.ok(!idOnTn.success);
  const rowsOnTw = StartBodySchema.safeParse({
    pipelineType: 'translate', username: 'u', sessionKey: 's',
    options: { resourceType: 'tw', targetLang: 'ar', articleId: 'kt/god', rowIds: ['xm1w'] },
  });
  assert.ok(!rowsOnTw.success);
});

test('sourceLang accepted on translate only', () => {
  const ok = StartBodySchema.safeParse({ ...base, options: { targetLang: 'ka', sourceLang: 'ru', sourceRef: 'ru_gl/ru_tn@master' } });
  assert.ok(ok.success, JSON.stringify(ok.error?.issues));
  const bad = StartBodySchema.safeParse({ ...base, pipelineType: 'notes', options: { sourceLang: 'ru' } });
  assert.ok(!bad.success);
});
