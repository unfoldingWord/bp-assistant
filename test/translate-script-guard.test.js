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
const {
  identicalRateGuard, IDENTICAL_TO_SOURCE_ABORT_RATIO, IDENTICAL_TO_SOURCE_MIN_ROWS, runArticleChecks,
} = require('../src/lib/translate-checks');
const { partitionRowsByScriptGuard } = require('../src/translate-pipeline');
const { buildMergedRows, assertNoDroppedRangeRows } = require('../src/lib/translate-core');

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
// isInTargetScript — DOMINANCE, not mere presence
// ---------------------------------------------------------------------------

test('isInTargetScript: an Arabic note with several Latin rc:// links is still true', () => {
  const note = `${ARABIC_NOTE} rc://*/ta/man/translate/figs-metaphor rc://*/ta/man/translate/figs-abstractnouns`;
  assert.equal(isInTargetScript(note, 'ar'), true);
});

test('isInTargetScript: an English note with one stray BOM (U+FEFF) is false', () => {
  assert.equal(isInTargetScript(`${ENGLISH_NOTE}﻿`, 'ar'), false);
});

test('isInTargetScript: an English note quoting Hebrew or Greek is false for ar', () => {
  assert.equal(isInTargetScript('This word (שלום) means peace.', 'ar'), false);
  assert.equal(isInTargetScript('The Greek term is λόγος.', 'ar'), false);
});

test('isInTargetScript: a string of only Arabic-Indic digits is false', () => {
  assert.equal(isInTargetScript('١٢٣٤٥', 'ar'), false);
});

test('isInTargetScript: empty and punctuation-only strings are false', () => {
  assert.equal(isInTargetScript('', 'ar'), false);
  assert.equal(isInTargetScript('   ', 'ar'), false);
  assert.equal(isInTargetScript('...,,,!!!', 'ar'), false);
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

test('identicalRateGuard: a 1/1 run does NOT fire — below the minimum sample size', () => {
  const warnings = [warn('identical-to-source', 'r0')];
  const res = identicalRateGuard({ warnings }, 1);
  assert.equal(res.identicalRows, 1);
  assert.equal(res.rate, 1);
  assert.equal(res.exceeded, false, 'a single-row run has no statistical signal and must not hard-abort');
});

test('identicalRateGuard: a 10/10 run DOES fire — at the minimum sample size', () => {
  const warnings = [];
  for (let i = 0; i < 10; i++) warnings.push(warn('identical-to-source', `r${i}`));
  const res = identicalRateGuard({ warnings }, 10);
  assert.equal(res.exceeded, true);
});

test('identicalRateGuard: the minRows option is respected', () => {
  const warnings = [warn('identical-to-source', 'r0'), warn('identical-to-source', 'r1')];
  const res = identicalRateGuard({ warnings }, 2, { minRows: 2 });
  assert.equal(res.exceeded, true, 'lowering minRows to 2 makes a 2/2 run fire');
  const res2 = identicalRateGuard({ warnings }, 2, { minRows: 3 });
  assert.equal(res2.exceeded, false, 'raising minRows to 3 keeps a 2-row run from firing');
});

test('IDENTICAL_TO_SOURCE_MIN_ROWS is 10', () => {
  assert.equal(IDENTICAL_TO_SOURCE_MIN_ROWS, 10);
});

// ---------------------------------------------------------------------------
// runArticleChecks — identical-to-source is a WARNING, not a blocking error
// ---------------------------------------------------------------------------
// Legitimately-unchanged articles exist (link-only or stub tW/tA files).
// Promoting this to 'error' burns a repair pass and hard-fails the whole
// article run via MAX_BATCH_ATTEMPTS, and breaks the resume path that reuses
// a cached article output only when checks.ok. The TSV aggregate guard
// (identicalRateGuard, above) already covers the misconfiguration this was
// meant to catch, with actual statistical signal.

test('runArticleChecks: identical source/target article body is ok, with a warning', () => {
  const md = '# Heading\n\nSome article body text.\n';
  const res = runArticleChecks(md, md);
  assert.equal(res.ok, true);
  assert.ok(res.warnings.some((w) => w.check === 'identical-to-source' && w.severity === 'warning'),
    JSON.stringify(res.warnings));
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

test('partitionRowsByScriptGuard: a two-column (tQ-like) row with only one column already in the target script gets the partial-target-script reason', () => {
  const TQ_COLUMNS = ['Question', 'Response'];
  // Existing target row: Response already translated to Arabic, Question still English.
  const rows = [{ ID: 'q1', Question: ENGLISH_NOTE, Response: ENGLISH_NOTE }];
  const existingById = new Map([['q1', { ID: 'q1', Question: ENGLISH_NOTE, Response: ARABIC_NOTE }]]);
  const { toTranslate, skipped } = partitionRowsByScriptGuard(rows, {
    targetLang: 'ar', translateColumns: TQ_COLUMNS, existingById,
  });
  assert.equal(toTranslate.length, 0);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].reason, 'partial-target-script');
});

// ---------------------------------------------------------------------------
// buildMergedRows / assertNoDroppedRangeRows — the range-mode union merge.
// Verified live case: BSOJ/ar_tn vs unfoldingWord/en_tn have different ID
// sets because the partner adds their own notes; a naive source-order
// replace deletes every partner-only row in the translated chapter range.
// ---------------------------------------------------------------------------

test('buildMergedRows: keeps target-only rows in target order, splices new source rows at their anchor, no duplicates', () => {
  // Target file order (all chapter 1): tOnlyA, s1 (existing), tOnlyB, s2 (existing).
  const tOnlyA = { ID: 'tOnlyA', Reference: '1:1', Note: 'partner note A' };
  const s1Existing = { ID: 's1', Reference: '1:2', Note: 'old s1' };
  const tOnlyB = { ID: 'tOnlyB', Reference: '1:3', Note: 'partner note B' };
  const s2Existing = { ID: 's2', Reference: '1:4', Note: 'old s2' };
  const existingInRange = [tOnlyA, s1Existing, tOnlyB, s2Existing];

  // Source file order: s1, s2, s3 (s3 has no counterpart in the target).
  const s1Source = { ID: 's1', Reference: '1:2', Note: 'old s1' };
  const s2Source = { ID: 's2', Reference: '1:4', Note: 'old s2' };
  const s3Source = { ID: 's3', Reference: '1:5', Note: 'new note' };
  const rows = [s1Source, s2Source, s3Source];

  const s1Chosen = { ID: 's1', Reference: '1:2', Note: 'TRANSLATED s1' };
  const s2Chosen = { ID: 's2', Reference: '1:4', Note: 'TRANSLATED s2' };
  const s3Chosen = { ID: 's3', Reference: '1:5', Note: 'TRANSLATED s3' };
  const chosenById = new Map([['s1', s1Chosen], ['s2', s2Chosen], ['s3', s3Chosen]]);

  const merged = buildMergedRows({ rows, chosenById, existingInRange });
  const ids = merged.map((r) => r.ID);

  assert.ok(ids.includes('tOnlyA'), 'target-only row A survives');
  assert.ok(ids.includes('tOnlyB'), 'target-only row B survives');
  assert.ok(ids.includes('s3'), 'new source row is spliced in');
  assert.equal(new Set(ids).size, ids.length, 'no duplicate IDs');

  // Target order preserved for target rows: tOnlyA before s1 before tOnlyB before s2.
  assert.deepStrictEqual(
    ids.filter((id) => ['tOnlyA', 's1', 'tOnlyB', 's2'].includes(id)),
    ['tOnlyA', 's1', 'tOnlyB', 's2'],
  );
  // s3 (no target counterpart) is spliced in right after its nearest
  // preceding source-order neighbor that IS present in the target — s2.
  assert.equal(ids[ids.indexOf('s2') + 1], 's3');

  // Values used are the chosen/translated ones, not the stale existing ones.
  const bys1 = merged.find((r) => r.ID === 's1');
  assert.equal(bys1.Note, 'TRANSLATED s1');

  // Shrink-guard: dropping an existing in-range row from the merged result throws.
  const shrunk = merged.filter((r) => r.ID !== 'tOnlyB');
  assert.throws(() => assertNoDroppedRangeRows(shrunk, existingInRange, { book: 'GEN', startChapter: 1, endChapter: 1 }),
    /would drop 1 existing target row/);
  // The real (non-shrunk) merge must NOT throw.
  assert.doesNotThrow(() => assertNoDroppedRangeRows(merged, existingInRange, { book: 'GEN', startChapter: 1, endChapter: 1 }));
});

test('buildMergedRows: empty existingInRange degrades to source order', () => {
  const s1 = { ID: 's1', Reference: '1:1', Note: 'a' };
  const s2 = { ID: 's2', Reference: '1:2', Note: 'b' };
  const rows = [s1, s2];
  const chosenById = new Map([['s1', s1], ['s2', s2]]);
  const merged = buildMergedRows({ rows, chosenById, existingInRange: [] });
  assert.deepStrictEqual(merged.map((r) => r.ID), ['s1', 's2']);
});
