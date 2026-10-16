// tn-modernize: link splitting and the Note-only splice.
//
// The modernize PR must change Note cells and nothing else. These pin the
// splice against the byte shapes en_tn actually has (no trailing newline in
// tn_1JN / tn_2JN), stale rows, and the diff proof that guards a publish.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { splitLinks, applyResults, diffOnlyNotes } = require('../scripts/tn-modernize/rows');
const { parseTnTsv } = require('../src/lib/tn-tsv');

const HEADER = 'Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote';
const row = (ref, id, note, quote = 'קוֹל') => [ref, id, '', 'rc://*/ta/man/translate/figs-metaphor', quote, '1', note].join('\t');
const TSV = [HEADER, row('1:1', 'ab12', 'Old note one.'), row('1:2', 'cd34', 'Old note two.\\nAlternate translation: [x]'), row('1:3', 'ef56', 'Untouched.')].join('\n') + '\n';
const changed = (ID, old, nw) => ({ ID, old, new: nw, status: 'changed' });

test('applyResults changes only the target Note cells, byte for byte elsewhere', () => {
  const res = applyResults(TSV, [changed('cd34', 'Old note two.\\nAlternate translation: [x]', 'New note two. Alternate translation: [x]')]);
  assert.deepEqual(res.applied, ['cd34']);
  const want = TSV.replace('Old note two.\\nAlternate translation: [x]', 'New note two. Alternate translation: [x]');
  assert.equal(res.text, want);
  assert.deepEqual(diffOnlyNotes(TSV, res.text, res.applied, parseTnTsv), []);
});

test('applyResults keeps a missing trailing newline and CRLF line endings', () => {
  const noNl = TSV.slice(0, -1);
  assert.equal(applyResults(noNl, [changed('ab12', 'Old note one.', 'N.')]).text, noNl.replace('Old note one.', 'N.'));
  const crlf = TSV.replace(/\n/g, '\r\n');
  assert.equal(applyResults(crlf, [changed('ab12', 'Old note one.', 'N.')]).text, crlf.replace('Old note one.', 'N.'));
});

test('a row whose Note changed upstream is reported stale and left alone', () => {
  const res = applyResults(TSV, [changed('ab12', 'What the note said at extract time.', 'N.'), changed('zz99', 'x', 'y')]);
  assert.deepEqual(res.applied, []);
  assert.deepEqual(res.stale, ['ab12']);
  assert.deepEqual(res.missing, ['zz99']);
  assert.equal(res.text, TSV);
});

test('unchanged results are never applied', () => {
  const res = applyResults(TSV, [{ ID: 'ab12', old: 'Old note one.', new: null, status: 'unchanged' }]);
  assert.deepEqual(res.applied, []);
  assert.equal(res.text, TSV);
});

test('diffOnlyNotes catches any non-Note change and any unapplied Note change', () => {
  const quoteEdit = TSV.replace('1:3\tef56\t\trc://*/ta/man/translate/figs-metaphor\tקוֹל', '1:3\tef56\t\trc://*/ta/man/translate/figs-metaphor\tאֵל');
  assert.match(diffOnlyNotes(TSV, quoteEdit, [], parseTnTsv).join(' '), /Quote changed/);
  const stray = TSV.replace('Untouched.', 'Touched.');
  assert.match(diffOnlyNotes(TSV, stray, [], parseTnTsv).join(' '), /Note changed but was not applied/);
});

test('a new note with a raw newline or tab is refused', () => {
  assert.throws(() => applyResults(TSV, [changed('ab12', 'Old note one.', 'two\nlines')]), /raw tab or newline/);
});

test('splitLinks drops See also tA and See tW groups and counts any other link', () => {
  const s = splitLinks('Here **x** is a metaphor. (See also: [[rc://*/ta/man/translate/figs-metonymy]])\\nAlternate translation: [y]');
  assert.equal(s.prose, 'Here **x** is a metaphor.\\nAlternate translation: [y]');
  assert.deepEqual(s.links.map((l) => l.kind), ['see-also-ta']);
  assert.equal(s.otherLinks, 0);

  const tw = splitLinks('**John** refers to John the Baptist. (See: [[rc://*/tw/dict/bible/names/johnthebaptist]])');
  assert.equal(tw.prose, '**John** refers to John the Baptist.');
  assert.deepEqual(tw.links[0].targets, ['rc://*/tw/dict/bible/names/johnthebaptist']);

  const two = splitLinks('A note. (See also: [[rc://*/ta/man/translate/figs-idiom]] and [[rc://*/ta/man/translate/figs-metaphor]])');
  assert.equal(two.links[0].targets.length, 2);
  assert.equal(two.prose, 'A note.');

  const other = splitLinks('Compare [1 Samuel 15:10](rc://*/tn/help/1sa/15/10).');
  assert.equal(other.otherLinks, 1);
});
