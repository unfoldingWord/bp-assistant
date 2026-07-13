// Individual-note / subset selection: selectRows, updateRowsById, verse
// parsing, and resolveParams scope grammar.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const { parseTnTsv, serializeTnTsv, refVerseRange } = require('../src/lib/tn-tsv');
const core = require('../src/lib/translate-core');
const { resolveParams } = require('../src/translate-pipeline');

const OBA_PATH = path.join(__dirname, 'fixtures', 'tn_OBA.tsv');
const rows = () => parseTnTsv(fs.readFileSync(OBA_PATH, 'utf8'));

test('refVerseRange parses verse and range, null for intro', () => {
  assert.deepStrictEqual(refVerseRange('1:1'), { start: 1, end: 1 });
  assert.deepStrictEqual(refVerseRange('1:5-7'), { start: 5, end: 7 });
  assert.strictEqual(refVerseRange('front:intro'), null);
  assert.strictEqual(refVerseRange('1:intro'), null);
});

test('selectRows by rowIds keeps only those rows', () => {
  const all = rows();
  const ids = [all[3].ID, all[7].ID];
  const sel = core.selectRows(all, { rowIds: ids });
  assert.deepStrictEqual(sel.map((r) => r.ID).sort(), [...ids].sort());
});

test('selectRows by verse keeps overlapping notes, drops intro', () => {
  const all = core.sliceChapterRows(rows(), 1, 1);
  const sel = core.selectRows(all, { verseStart: 1, verseEnd: 1 });
  assert.ok(sel.length >= 1);
  assert.ok(sel.every((r) => refVerseRange(r.Reference) && refVerseRange(r.Reference).start <= 1 && refVerseRange(r.Reference).end >= 1));
  assert.ok(!sel.some((r) => r.Reference === 'front:intro'));
});

test('selectRows with no criteria returns input unchanged', () => {
  const all = rows();
  assert.strictEqual(core.selectRows(all, {}), all);
});

test('updateRowsById updates only targeted rows, preserving all others exactly', () => {
  const book = rows();
  const bookText = serializeTnTsv(book);
  const victim = book[10];
  const updated = [{ ...victim, Note: 'ملاحظة محدثة' }];
  const merged = core.updateRowsById(bookText, updated);
  const mergedRows = parseTnTsv(merged);

  assert.strictEqual(mergedRows.length, book.length); // no rows added/removed
  for (let i = 0; i < book.length; i++) {
    if (book[i].ID === victim.ID) {
      assert.strictEqual(mergedRows[i].Note, 'ملاحظة محدثة');
      assert.strictEqual(mergedRows[i].Quote, victim.Quote); // pass-through intact
    } else {
      assert.deepStrictEqual(mergedRows[i], book[i]); // byte-identical
    }
  }
});

test('updateRowsById throws when target book absent', () => {
  assert.throws(() => core.updateRowsById(null, [rows()[0]]), /requires an existing target book/);
});

test('updateRowsById throws when a row id is not in the target', () => {
  const bookText = serializeTnTsv(rows());
  assert.throws(
    () => core.updateRowsById(bookText, [{ ...rows()[0], ID: 'zz99' }]),
    /not present in target book: zz99/,
  );
});

// --- resolveParams scope grammar (Zulip) ---
const zmsg = (content) => ({ type: 'stream', content });

test('resolveParams: whole chapter → range mode', () => {
  const p = resolveParams({}, zmsg('translate notes OBA 1 to ar'));
  assert.strictEqual(p.mergeMode, 'range');
  assert.strictEqual(p.verseStart, null);
  assert.strictEqual(p.startChapter, 1);
  assert.strictEqual(p.endChapter, 1);
});

test('resolveParams: chapter range 1-2 → range mode', () => {
  const p = resolveParams({}, zmsg('translate notes OBA 1-2 to ar'));
  assert.strictEqual(p.mergeMode, 'range');
  assert.strictEqual(p.startChapter, 1);
  assert.strictEqual(p.endChapter, 2);
});

test('resolveParams: single verse 1:5 → by-id mode', () => {
  const p = resolveParams({}, zmsg('translate notes OBA 1:5 to ar'));
  assert.strictEqual(p.mergeMode, 'by-id');
  assert.strictEqual(p.startChapter, 1);
  assert.strictEqual(p.endChapter, 1);
  assert.strictEqual(p.verseStart, 5);
  assert.strictEqual(p.verseEnd, 5);
});

test('resolveParams: verse range 1:5-7 → by-id mode', () => {
  const p = resolveParams({}, zmsg('translate notes OBA 1:5-7 into es-419'));
  assert.strictEqual(p.mergeMode, 'by-id');
  assert.strictEqual(p.verseStart, 5);
  assert.strictEqual(p.verseEnd, 7);
  assert.strictEqual(p.targetLang, 'es-419');
});

test('resolveParams: targets config resolves ar to BSOJ, options override', () => {
  const ar = resolveParams({}, zmsg('translate notes OBA 1 to ar'));
  assert.strictEqual(ar.targetOrg, 'BSOJ');       // NOT ar_gl
  assert.strictEqual(ar.repoName, 'ar_tn');
  assert.strictEqual(ar.sourceRef, 'BSOJ/ar_tn@master');
  assert.strictEqual(ar.direction, 'rtl');

  const id = resolveParams({}, zmsg('translate notes OBA 1 to id'));
  assert.strictEqual(id.targetOrg, 'id_gl');
  assert.strictEqual(id.repoName, 'id_tn');

  // Unknown lang falls back to {lang}_gl / {lang}_tn derivation.
  const xx = resolveParams({}, zmsg('translate notes OBA 1 to xyz'));
  assert.strictEqual(xx.targetOrg, 'xyz_gl');
  assert.strictEqual(xx.repoName, 'xyz_tn');

  // Per-call options beat the config.
  const ov = resolveParams({
    _synthetic: true, _book: 'OBA', _startChapter: 1, _endChapter: 1, _verseStart: null, _verseEnd: null,
    _translate: { targetLang: 'ar', targetOrg: 'other_org', repoName: 'other_tn' },
  }, {});
  assert.strictEqual(ov.targetOrg, 'other_org');
  assert.strictEqual(ov.repoName, 'other_tn');
});

test('resolveParams: API rowIds → by-id mode', () => {
  const route = {
    _synthetic: true, _book: 'OBA', _startChapter: 1, _endChapter: 1,
    _verseStart: null, _verseEnd: null,
    _translate: { targetLang: 'ar', rowIds: ['xm1w', 'k9wc'] },
  };
  const p = resolveParams(route, {});
  assert.strictEqual(p.mergeMode, 'by-id');
  assert.deepStrictEqual(p.rowIds, ['xm1w', 'k9wc']);
  assert.strictEqual(p.delivery, 'branch'); // API default
});
