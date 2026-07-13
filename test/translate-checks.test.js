// Deterministic-check + TSV round-trip tests for the translate pipeline.
// Fixture: real unfoldingWord/en_tn tn_OBA.tsv (fetched 2026-07-10).
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const { parseTnTsv, serializeTnTsv, sliceChapterRows } = require('../src/lib/tn-tsv');
const { runChecks, extractRcLinks } = require('../src/lib/translate-checks');

const OBA_PATH = path.join(__dirname, 'fixtures', 'tn_OBA.tsv');

function loadOba() {
  return parseTnTsv(fs.readFileSync(OBA_PATH, 'utf8'));
}

// A fake "perfect translation": pass-through columns untouched, Note replaced
// with a marker that preserves rc:// links, digits, and bracket structure.
function fakeTranslateNote(note) {
  if (!note) return note;
  const links = extractRcLinks(note);
  const digits = [...new Set(note.match(/\d+/g) || [])];
  const opens = (note.match(/\[/g) || []).length;
  const closes = (note.match(/\]/g) || []).length;
  const pairs = Math.min(opens, closes);
  return 'ترجمة ' + digits.join(' ') + ' ' + links.join(' ') + ' '
    + '[]'.repeat(pairs) + ' ' + '['.repeat(Math.max(0, opens - pairs))
    + ']'.repeat(Math.max(0, closes - pairs)) + ' **م**';
}

test('tn_OBA.tsv parses and round-trips byte-identically', () => {
  const raw = fs.readFileSync(OBA_PATH, 'utf8').replace(/\r\n/g, '\n');
  const rows = parseTnTsv(raw);
  assert.ok(rows.length > 100, `expected >100 rows, got ${rows.length}`);
  const out = serializeTnTsv(rows);
  assert.strictEqual(out, raw.endsWith('\n') ? raw : raw + '\n');
});

test('sliceChapterRows includes front matter only from chapter 1', () => {
  const rows = loadOba();
  const withFront = sliceChapterRows(rows, 1, 1);
  assert.ok(withFront.some((r) => r.Reference === 'front:intro'));
  const noFront = sliceChapterRows(rows, 2, 3);
  assert.ok(!noFront.some((r) => r.Reference === 'front:intro'));
});

test('perfect fake translation passes all error checks', () => {
  const src = loadOba();
  const tgt = src.map((r) => ({ ...r, Note: fakeTranslateNote(r.Note) }));
  const res = runChecks(src, tgt);
  assert.deepStrictEqual(res.errors, [], JSON.stringify(res.errors.slice(0, 5), null, 2));
  assert.ok(res.ok);
});

test('Quote column corruption is a blocking error (the Aquilla failure)', () => {
  const src = loadOba().slice(0, 5);
  const tgt = src.map((r) => ({ ...r, Note: fakeTranslateNote(r.Note) }));
  const victim = tgt.find((r) => r.Quote.trim() !== '');
  victim.Quote = 'Авдий'; // what Aquilla actually did to עֹֽבַדְיָ֑ה
  const res = runChecks(src, tgt);
  assert.ok(res.errors.some((e) => e.check === 'passthrough-quote' && e.rowId === victim.ID));
  assert.ok(!res.ok);
});

test('ID drop / row loss is a blocking error', () => {
  const src = loadOba().slice(0, 5);
  const tgt = src.slice(0, 4).map((r) => ({ ...r, Note: fakeTranslateNote(r.Note) }));
  const res = runChecks(src, tgt);
  assert.ok(res.errors.some((e) => e.check === 'missing-row' && e.rowId === src[4].ID));
});

test('extra invented row is a blocking error', () => {
  const src = loadOba().slice(0, 3);
  const tgt = src.map((r) => ({ ...r, Note: fakeTranslateNote(r.Note) }));
  tgt.push({ ...src[0], ID: 'zz99' });
  const res = runChecks(src, tgt);
  assert.ok(res.errors.some((e) => e.check === 'extra-row' && e.rowId === 'zz99'));
});

test('extractRcLinks captures the full link body (not just the scheme)', () => {
  const links = extractRcLinks('see [[rc://*/ta/man/translate/figs-metaphor]] and rc://*/tw/dict/bible/kt/god.');
  assert.deepStrictEqual(links, ['rc://*/ta/man/translate/figs-metaphor', 'rc://*/tw/dict/bible/kt/god']);
});

test('CHANGED rc:// link target is a blocking error (not just add/remove)', () => {
  const src = [{ Reference: '1:1', ID: 'ab12', Tags: '', SupportReference: 'rc://*/ta/man/translate/figs-metaphor', Quote: 'x', Occurrence: '1', Note: 'See [[rc://*/ta/man/translate/figs-metaphor]].' }];
  const tgt = [{ ...src[0], Note: 'انظر [[rc://*/ta/man/translate/figs-simile]].' }]; // target slug corrupted
  const res = runChecks(src, tgt);
  assert.ok(res.errors.some((e) => e.check === 'rc-links' && e.rowId === 'ab12'),
    'a changed rc:// target must be caught: ' + JSON.stringify(res.errors));
});

test('dropped rc:// link is a blocking error', () => {
  const src = loadOba().filter((r) => /rc:\/\//.test(r.Note)).slice(0, 3);
  assert.ok(src.length >= 1, 'fixture must contain rc:// notes');
  const tgt = src.map((r) => ({ ...r, Note: 'ترجمة بدون روابط' }));
  const res = runChecks(src, tgt);
  assert.ok(res.errors.some((e) => e.check === 'rc-links'));
});

test('empty translation is a blocking error; identical passthrough is a warning', () => {
  const src = loadOba().slice(0, 2);
  const tgt = [
    { ...src[0], Note: '' },
    { ...src[1] }, // untouched note
  ];
  const res = runChecks(src, tgt);
  assert.ok(res.errors.some((e) => e.check === 'empty-translation' && e.rowId === src[0].ID));
  assert.ok(res.warnings.some((w) => w.check === 'identical-to-source' && w.rowId === src[1].ID));
});

test('SupportReference / Reference / Occurrence tampering all block', () => {
  const src = loadOba().slice(0, 3);
  const tgt = src.map((r) => ({ ...r, Note: fakeTranslateNote(r.Note) }));
  tgt[0].SupportReference = 'rc://*/ta/man/translate/figs-idiom';
  tgt[1].Reference = '9:9';
  tgt[2].Occurrence = '2';
  const res = runChecks(src, tgt);
  const checks = res.errors.map((e) => e.check);
  assert.ok(checks.includes('passthrough-supportreference'), checks.join(','));
  assert.ok(checks.includes('passthrough-reference'));
  assert.ok(checks.includes('passthrough-occurrence'));
});

test('row order shuffle is a blocking error', () => {
  const src = loadOba().slice(0, 4);
  const tgt = src.map((r) => ({ ...r, Note: fakeTranslateNote(r.Note) }));
  [tgt[0], tgt[1]] = [tgt[1], tgt[0]];
  const res = runChecks(src, tgt);
  assert.ok(res.errors.some((e) => e.check === 'row-order'));
});
