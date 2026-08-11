// script-guard.js + the identical-to-source aggregate gate it feeds. Verified
// live case: BSOJ/ar_tn tnSourceRef pointed at finished Arabic tN, so a
// "translate ar tN" run fed Arabic as SOURCE and asked the model to translate
// Arabic to Arabic — 44/54 rows on 2TH 3 came back byte-identical. This guard
// catches that class of misconfiguration before any model call runs, and
// separately protects already-finished target rows from being overwritten.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  scriptOf, hasScript, isInTargetScript, scriptGuardApplicable,
} = require('../src/lib/script-guard');
const { identicalRateGuard, IDENTICAL_TO_SOURCE_ABORT_RATIO, runArticleChecks } = require('../src/lib/translate-checks');
const { partitionRowsByScriptGuard } = require('../src/translate-pipeline');

// A real (representative) Arabic tN note string vs an English one.
const ARABIC_NOTE = 'هذه ملاحظة توضح المعنى البديل لهذه العبارة في السياق.';
const ENGLISH_NOTE = 'This note explains the alternate meaning of this phrase in context.';

// ---------------------------------------------------------------------------
// scriptOf / hasScript basics
// ---------------------------------------------------------------------------

test('scriptOf resolves base language subtag, case-insensitive, ignoring region', () => {
  assert.equal(scriptOf('ar'), 'arabic');
  assert.equal(scriptOf('AR'), 'arabic');
  assert.equal(scriptOf('es-419'), 'latin');
  assert.equal(scriptOf('en'), 'latin');
  assert.equal(scriptOf('xx'), null);
  assert.equal(scriptOf(null), null);
  assert.equal(scriptOf(''), null);
});

test('hasScript detects script presence and is false for empty/whitespace-only text', () => {
  assert.equal(hasScript(ARABIC_NOTE, 'arabic'), true);
  assert.equal(hasScript(ENGLISH_NOTE, 'arabic'), false);
  assert.equal(hasScript('', 'arabic'), false);
  assert.equal(hasScript('   ', 'arabic'), false);
  assert.equal(hasScript('hello', 'unknown-script'), false);
});

// ---------------------------------------------------------------------------
// scriptGuardApplicable — the honesty boundary
// ---------------------------------------------------------------------------

test('scriptGuardApplicable is true only when source and target use different KNOWN scripts', () => {
  assert.equal(scriptGuardApplicable('en', 'ar'), true);
  assert.equal(scriptGuardApplicable('en', 'id'), false); // both Latin — no-op
  assert.equal(scriptGuardApplicable('ar', 'ar'), false); // same lang, same script
  assert.equal(scriptGuardApplicable('xx', 'ar'), false); // unknown source lang
  assert.equal(scriptGuardApplicable('ar', 'xx'), false); // unknown target lang
});

// ---------------------------------------------------------------------------
// isInTargetScript
// ---------------------------------------------------------------------------

test('isInTargetScript classifies a real Arabic tN note vs an English one', () => {
  assert.equal(isInTargetScript(ARABIC_NOTE, 'ar'), true);
  assert.equal(isInTargetScript(ENGLISH_NOTE, 'ar'), false);
  assert.equal(isInTargetScript(ARABIC_NOTE, 'xx'), null); // unknown target lang
});

// ---------------------------------------------------------------------------
// identicalRateGuard
// ---------------------------------------------------------------------------

function warn(check, rowId) {
  return { check, severity: 'warning', rowId, message: 'x' };
}

test('identicalRateGuard: 44/54 identical rows exceeds the 50% ratio', () => {
  const warnings = [];
  for (let i = 0; i < 44; i++) warnings.push(warn('identical-to-source', `r${i}`));
  const res = identicalRateGuard({ warnings }, 54);
  assert.equal(res.identicalRows, 44);
  assert.equal(res.rowCount, 54);
  assert.ok(res.exceeded, JSON.stringify(res));
});

test('identicalRateGuard: 2/54 identical rows does not exceed', () => {
  const warnings = [warn('identical-to-source', 'r0'), warn('identical-to-source', 'r1')];
  const res = identicalRateGuard({ warnings }, 54);
  assert.equal(res.identicalRows, 2);
  assert.equal(res.exceeded, false);
});

test('identicalRateGuard: exactly the 0.5 ratio (27/54) does NOT exceed (strictly greater than)', () => {
  const warnings = [];
  for (let i = 0; i < 27; i++) warnings.push(warn('identical-to-source', `r${i}`));
  const res = identicalRateGuard({ warnings }, 54);
  assert.equal(res.rate, 0.5);
  assert.equal(res.exceeded, false);
});

test('identicalRateGuard: rowCount 0 never exceeds', () => {
  const res = identicalRateGuard({ warnings: [] }, 0);
  assert.equal(res.rate, 0);
  assert.equal(res.exceeded, false);
});

test('identicalRateGuard: multi-column tagged ids on the same rowId count once', () => {
  const warnings = [
    warn('identical-to-source-question', 'r0'),
    warn('identical-to-source-response', 'r0'),
    warn('identical-to-source-question', 'r1'),
  ];
  const res = identicalRateGuard({ warnings }, 2);
  assert.equal(res.identicalRows, 2, 'r0 counted once despite two tagged warnings');
});

test('IDENTICAL_TO_SOURCE_ABORT_RATIO is 0.5', () => {
  assert.equal(IDENTICAL_TO_SOURCE_ABORT_RATIO, 0.5);
});

// ---------------------------------------------------------------------------
// runArticleChecks — identical-to-source promoted to error
// ---------------------------------------------------------------------------

test('runArticleChecks: identical source/target article body is a blocking error', () => {
  const md = '# Heading\n\nSome article body text.\n';
  const res = runArticleChecks(md, md);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.check === 'identical-to-source'),
    JSON.stringify(res.errors));
});

// ---------------------------------------------------------------------------
// partitionRowsByScriptGuard — the pre-flight partition helper
// ---------------------------------------------------------------------------
// No translateChapters test harness with an injectable runBatchImpl exists in
// this suite yet (grepped for translateChapters/runBatchImpl usage in test/ —
// none found), so per the spec's fallback this exercises the partition helper
// directly instead of driving the whole pipeline function.

const TRANSLATE_COLUMNS = ['Note'];

test('partitionRowsByScriptGuard: all-Arabic source rows are all skipped (misconfiguration signal)', () => {
  const rows = [
    { ID: 'a1', Note: ARABIC_NOTE },
    { ID: 'a2', Note: ARABIC_NOTE },
  ];
  const { toTranslate, skipped } = partitionRowsByScriptGuard(rows, {
    targetLang: 'ar', translateColumns: TRANSLATE_COLUMNS, existingById: new Map(),
  });
  assert.equal(toTranslate.length, 0);
  assert.equal(skipped.length, 2);
  assert.ok(skipped.every((s) => s.reason === 'source-already-target-script'));
});

test('partitionRowsByScriptGuard: mixed set — English rows translate, Arabic rows skip', () => {
  const rows = [
    { ID: 'e1', Note: ENGLISH_NOTE },
    { ID: 'a1', Note: ARABIC_NOTE },
    { ID: 'e2', Note: ENGLISH_NOTE },
  ];
  const { toTranslate, skipped } = partitionRowsByScriptGuard(rows, {
    targetLang: 'ar', translateColumns: TRANSLATE_COLUMNS, existingById: new Map(),
  });
  assert.deepStrictEqual(toTranslate.map((r) => r.ID), ['e1', 'e2']);
  assert.deepStrictEqual(skipped.map((s) => s.id), ['a1']);
  assert.equal(skipped[0].reason, 'source-already-target-script');
});

test('partitionRowsByScriptGuard: an existing finished-Arabic target row is preserved (not overwritten)', () => {
  const rows = [{ ID: 'e1', Note: ENGLISH_NOTE }];
  const existingById = new Map([['e1', { ID: 'e1', Note: ARABIC_NOTE }]]);
  const { toTranslate, skipped } = partitionRowsByScriptGuard(rows, {
    targetLang: 'ar', translateColumns: TRANSLATE_COLUMNS, existingById,
  });
  assert.equal(toTranslate.length, 0);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].reason, 'target-already-translated');
});

test('partitionRowsByScriptGuard: no existing target and English source both translate normally', () => {
  const rows = [{ ID: 'e1', Note: ENGLISH_NOTE }];
  const { toTranslate, skipped } = partitionRowsByScriptGuard(rows, {
    targetLang: 'ar', translateColumns: TRANSLATE_COLUMNS, existingById: new Map(),
  });
  assert.equal(toTranslate.length, 1);
  assert.equal(skipped.length, 0);
});
