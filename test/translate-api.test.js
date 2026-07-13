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
