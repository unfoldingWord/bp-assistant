'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The structured edit tools resolve paths against CSKILLBP_DIR; point it at a
// temp dir BEFORE requiring tn-tools (it reads the env var at module load).
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'qedit-'));
process.env.CSKILLBP_DIR = WORK;

const { updateNoteText, updatePreparedQuote, removeNote } = require('../src/workspace-tools/tn-tools');

function writeJson(rel, obj) {
  const p = path.join(WORK, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
  return rel;
}
function readJson(rel) { return JSON.parse(fs.readFileSync(path.join(WORK, rel), 'utf8')); }

test('updateNoteText sets the note text for an existing id and leaves others untouched', () => {
  const rel = writeJson('gen1.json', { ab1c: 'old note', de2f: 'keep' });
  const out = updateNoteText({ generatedJson: rel, id: 'ab1c', note: 'new note' });
  assert.match(out, /Updated note text for id "ab1c"/);
  const after = readJson('gen1.json');
  assert.equal(after.ab1c, 'new note');
  assert.equal(after.de2f, 'keep');
});

test('updateNoteText returns a clear non-throwing message for a missing id (no file change)', () => {
  const rel = writeJson('gen2.json', { ab1c: 'x' });
  const out = updateNoteText({ generatedJson: rel, id: 'zz9z', note: 'n' });
  assert.match(out, /ERROR: id "zz9z" not found/);
  assert.deepEqual(readJson('gen2.json'), { ab1c: 'x' });
});

test('updatePreparedQuote updates only the provided quote fields by id', () => {
  const rel = writeJson('prep1.json', { items: [
    { id: 'ab1c', gl_quote: 'old', gl_quote_roundtripped: 'oldR', orig_quote: 'oldO', other: 'keep' },
    { id: 'de2f', gl_quote: 'untouched' },
  ] });
  const out = updatePreparedQuote({ preparedJson: rel, id: 'ab1c', glQuote: 'new', origQuote: 'newO' });
  assert.match(out, /gl_quote, orig_quote/);
  const item = readJson('prep1.json').items.find((i) => i.id === 'ab1c');
  assert.equal(item.gl_quote, 'new');
  assert.equal(item.orig_quote, 'newO');
  assert.equal(item.gl_quote_roundtripped, 'oldR'); // not provided → unchanged
  assert.equal(item.other, 'keep');
  const untouched = readJson('prep1.json').items.find((i) => i.id === 'de2f');
  assert.equal(untouched.gl_quote, 'untouched');
});

test('updatePreparedQuote returns a clear message for a missing id', () => {
  const rel = writeJson('prep2.json', { items: [{ id: 'ab1c' }] });
  const out = updatePreparedQuote({ preparedJson: rel, id: 'zz9z', glQuote: 'x' });
  assert.match(out, /ERROR: id "zz9z" not found/);
});

test('updatePreparedQuote sets sref and strips the rc:// prefix', () => {
  const rel = writeJson('prep3.json', { items: [
    { id: 'ab1c', gl_quote: 'q', sref: 'figs-paronomasia' },
  ] });
  const out = updatePreparedQuote({ preparedJson: rel, id: 'ab1c', sref: 'rc://*/ta/man/translate/writing-poetry' });
  assert.match(out, /sref/);
  const item = readJson('prep3.json').items.find((i) => i.id === 'ab1c');
  assert.equal(item.sref, 'writing-poetry');
  assert.equal(item.gl_quote, 'q'); // not provided → unchanged
});

test('removeNote drops the entry from generated JSON and the matching TSV row, preserving header', () => {
  const genRel = writeJson('gen3.json', { ab1c: 'note A', de2f: 'note B' });
  const tsvRel = 'notes3.tsv';
  fs.writeFileSync(path.join(WORK, tsvRel),
    'Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote\n' +
    '6:1\tab1c\t\t\tQ1\t1\tnote A\n' +
    '6:2\tde2f\t\t\tQ2\t1\tnote B\n');
  const out = removeNote({ id: 'ab1c', generatedJson: genRel, tsvFile: tsvRel });
  assert.match(out, /removed id "ab1c" from/);
  assert.match(out, /removed 1 row\(s\) with id "ab1c"/);
  assert.deepEqual(readJson('gen3.json'), { de2f: 'note B' });
  const tsv = fs.readFileSync(path.join(WORK, tsvRel), 'utf8');
  assert.doesNotMatch(tsv, /\tab1c\t/);
  assert.match(tsv, /\tde2f\t/);
  assert.match(tsv.split('\n')[0], /^Reference\tID\t/); // header preserved
});

test('removeNote is a no-op message when the id is absent from generated JSON', () => {
  const genRel = writeJson('gen4.json', { de2f: 'note B' });
  const out = removeNote({ id: 'ab1c', generatedJson: genRel });
  assert.match(out, /id "ab1c" not present/);
  assert.deepEqual(readJson('gen4.json'), { de2f: 'note B' });
});
