const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeIntroRow,
  INTRO_ID_RE,
  INTRO_REF_RE,
} = require('../src/lib/insert-tn-rows');

test('normalizeIntroRow: canonical 7-col row passes through unchanged', () => {
  const row = '3:intro\tab1c\t\t\t\t\t# ZEC 3 Introduction\\n\\n...';
  const out = normalizeIntroRow(row, { chapter: 3 });
  assert.equal(out, row);
});

test('normalizeIntroRow: issue-TSV format (Book\\tRef\\t...) is rewritten to canonical with valid ID', () => {
  // Format emitted by chapter-intro skill: book, ref, issue, quote, flag, at, content
  const row = 'zec\t3:intro\t\t\t\t\t# ZEC 3 Intro\\n\\nBody';
  const out = normalizeIntroRow(row, { chapter: 3 });
  const cols = out.split('\t');
  assert.equal(cols.length, 7);
  assert.equal(cols[0], '3:intro');
  assert.ok(INTRO_ID_RE.test(cols[1]), `expected valid 4-char id, got "${cols[1]}"`);
  assert.equal(cols[6], '# ZEC 3 Intro\\n\\nBody');
});

test('normalizeIntroRow: id="intro" (column drift) gets regenerated', () => {
  const row = '3:intro\tintro\t\t\t\t\t# ZEC 3';
  const out = normalizeIntroRow(row, { chapter: 3 });
  const cols = out.split('\t');
  assert.equal(cols[0], '3:intro');
  assert.ok(INTRO_ID_RE.test(cols[1]));
  assert.notEqual(cols[1], 'intro');
});

test('normalizeIntroRow: blank Reference is reconstructed from chapter', () => {
  const row = '\t\t\t\t\t\tintro body text';
  const out = normalizeIntroRow(row, { chapter: 7 });
  const cols = out.split('\t');
  assert.equal(cols[0], '7:intro');
  assert.ok(INTRO_ID_RE.test(cols[1]));
  assert.equal(cols[6], 'intro body text');
});

test('normalizeIntroRow: reuses existing valid 4-char ID if present', () => {
  const row = '3:intro\txy9z\t\t\t\t\tnote';
  const out = normalizeIntroRow(row, { chapter: 3 });
  assert.equal(out.split('\t')[1], 'xy9z');
});

test('normalizeIntroRow: avoids collision with existingIds across many calls', () => {
  // normalizeIntroRow mutates existingIds as part of its contract.
  // After 20 calls against the same set, we should have 20 unique ids.
  const existing = new Set();
  for (let i = 0; i < 20; i++) {
    normalizeIntroRow('3:intro\tintro\t\t\t\t\tbody', { chapter: 3, existingIds: existing });
  }
  assert.equal(existing.size, 20);
});

test('INTRO_REF_RE matches valid intro refs and rejects non-intro', () => {
  assert.ok(INTRO_REF_RE.test('3:intro'));
  assert.ok(INTRO_REF_RE.test('front:intro'));
  assert.ok(INTRO_REF_RE.test('front:front'));
  assert.ok(!INTRO_REF_RE.test('3:1'));
  assert.ok(!INTRO_REF_RE.test('intro'));
  assert.ok(!INTRO_REF_RE.test(''));
});

test('INTRO_ID_RE matches 4-char ids and rejects "intro"', () => {
  assert.ok(INTRO_ID_RE.test('ab1c'));
  assert.ok(INTRO_ID_RE.test('zzzz'));
  assert.ok(!INTRO_ID_RE.test('intro'));
  assert.ok(!INTRO_ID_RE.test('1abc'));
  assert.ok(!INTRO_ID_RE.test('abc'));
  assert.ok(!INTRO_ID_RE.test('abcde'));
});
