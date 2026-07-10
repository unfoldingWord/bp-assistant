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

test('sourceRef/contextRef must be org/repo@ref shaped', () => {
  const res = StartBodySchema.safeParse({
    ...base,
    options: { targetLang: 'ar', sourceRef: 'not-a-ref' },
  });
  assert.ok(!res.success);
});
