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

const { updateNoteText, updatePreparedQuote, removeNote, findVersesWithoutNotes } = require('../src/workspace-tools/tn-tools');

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
  const genRel = writeJson('gen3.json', { ab1c: 'note A', de2f: 'note B', gh3i: 'note C' });
  const tsvRel = 'notes3.tsv';
  fs.writeFileSync(path.join(WORK, tsvRel),
    'Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote\n' +
    '6:1\tab1c\t\t\tQ1\t1\tnote A\n' +
    '6:1\tgh3i\t\t\tQ3\t1\tnote C\n' +
    '6:2\tde2f\t\t\tQ2\t1\tnote B\n');
  const out = removeNote({ id: 'ab1c', generatedJson: genRel, tsvFile: tsvRel });
  assert.match(out, /removed id "ab1c" from/);
  assert.match(out, /removed 1 row\(s\) with id "ab1c"/);
  assert.deepEqual(readJson('gen3.json'), { de2f: 'note B', gh3i: 'note C' });
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

// --- #444: remove_note must never empty a verse (JER 36:9 / 36:15) ---

const HDR = 'Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote\n';

function setupJer36(dir) {
  const prep = writeJson(`${dir}/prepared_notes.json`, { chapter: '36', items: [
    { id: 'o8f9', reference: '36:9', sref: 'writing-pronouns' },
    { id: 'q4sn', reference: '36:15', sref: 'writing-pronouns' },
    { id: 'a1ib', reference: '36:15', sref: 'figs-idiom' },
    { id: 'vil4', reference: '36:16', sref: 'figs-metonymy' },
  ] });
  const gen = writeJson(`${dir}/generated_notes.json`, { o8f9: 'n9', q4sn: 'n15a', a1ib: 'n15b', vil4: 'n16' });
  const tsv = `${dir}/JER-36.tsv`;
  fs.writeFileSync(path.join(WORK, tsv), HDR +
    '36:intro\tintr\t\t\t\t\t# Intro\n' +
    '36:9\to8f9\t\t\tQ\t1\tn9\n' +
    '36:15\tq4sn\t\t\tQ\t1\tn15a\n' +
    '36:15\ta1ib\t\t\tQ\t1\tn15b\n' +
    '36:16\tvil4\t\t\tQ\t1\tn16\n');
  return { prep, gen, tsv };
}

test('removeNote refuses to remove the only note of a verse (generated JSON + TSV), changing nothing', () => {
  const { gen, tsv } = setupJer36('jer36a');
  const tsvBefore = fs.readFileSync(path.join(WORK, tsv), 'utf8');
  const out = removeNote({ id: 'o8f9', generatedJson: gen, tsvFile: tsv });
  assert.match(out, /REFUSED/);
  assert.match(out, /36:9/);
  assert.ok(readJson(gen).o8f9, 'generated note kept');
  assert.equal(fs.readFileSync(path.join(WORK, tsv), 'utf8'), tsvBefore);
});

test('removeNote allows removing one of two notes in a verse, then refuses the survivor', () => {
  const { gen, tsv } = setupJer36('jer36b');
  assert.match(removeNote({ id: 'a1ib', generatedJson: gen, tsvFile: tsv }), /removed id "a1ib"/);
  const out = removeNote({ id: 'q4sn', generatedJson: gen, tsvFile: tsv });
  assert.match(out, /REFUSED/);
  assert.ok(readJson(gen).q4sn);
  assert.match(fs.readFileSync(path.join(WORK, tsv), 'utf8'), /\tq4sn\t/);
});

test('removeNote guard works with generatedJson alone (sibling prepared_notes.json) and TSV alone', () => {
  const { gen, tsv } = setupJer36('jer36c');
  assert.match(removeNote({ id: 'vil4', generatedJson: gen }), /REFUSED/);
  assert.match(removeNote({ id: 'vil4', tsvFile: tsv }), /REFUSED/);
  assert.ok(readJson(gen).vil4);
});

test('removeNote counts a range row as covering its verses', () => {
  const tsv = 'range.tsv';
  fs.writeFileSync(path.join(WORK, tsv), HDR +
    '5:3\tab1c\t\t\tQ\t1\ta\n' +
    '5:3-4\tde2f\t\t\tQ\t1\tb\n');
  assert.match(removeNote({ id: 'ab1c', tsvFile: tsv }), /removed 1 row/);
});

test('findVersesWithoutNotes names verses whose prepared items all lost their rows (JER 36 replay)', () => {
  const { prep, tsv } = setupJer36('jer36d');
  assert.deepEqual(findVersesWithoutNotes({ preparedJson: prep, notesPath: tsv }), []);
  // Simulate the 2026-10-05 final-review removals bypassing the guard.
  const p = path.join(WORK, tsv);
  const kept = fs.readFileSync(p, 'utf8').split('\n').filter((l) => !/\t(o8f9|q4sn|a1ib)\t/.test(l));
  fs.writeFileSync(p, kept.join('\n'));
  assert.deepEqual(findVersesWithoutNotes({ preparedJson: prep, notesPath: tsv }), ['36:9', '36:15']);
});

test('findVersesWithoutNotes returns [] when files are missing', () => {
  assert.deepEqual(findVersesWithoutNotes({ preparedJson: 'nope.json', notesPath: 'nope.tsv' }), []);
});

// --- #447 review follow-ups: coverage is per verse, not per overlapping row ---

test('removeNote refuses to remove a bridge note when one of its verses would be left empty (TSV)', () => {
  const tsv = 'bridge.tsv';
  fs.writeFileSync(path.join(WORK, tsv), HDR +
    '5:3\tab1c\t\t\tQ\t1\ta\n' +
    '5:3-4\tde2f\t\t\tQ\t1\tb\n');
  const before = fs.readFileSync(path.join(WORK, tsv), 'utf8');
  const out = removeNote({ id: 'de2f', tsvFile: tsv });
  assert.match(out, /REFUSED/);
  assert.match(out, /5:4/);
  assert.equal(fs.readFileSync(path.join(WORK, tsv), 'utf8'), before);
});

test('removeNote refuses to remove a bridge note when one of its verses would be left empty (generated JSON)', () => {
  writeJson('bridge/prepared_notes.json', { items: [
    { id: 'ab1c', reference: '5:3' }, { id: 'de2f', reference: '5:3-4' },
  ] });
  const gen = writeJson('bridge/generated_notes.json', { ab1c: 'a', de2f: 'b' });
  assert.match(removeNote({ id: 'de2f', generatedJson: gen }), /REFUSED[\s\S]*5:4/);
  assert.deepEqual(readJson(gen), { ab1c: 'a', de2f: 'b' });
});

test('removeNote warns when nothing could check verse coverage', () => {
  const gen = writeJson('noprep/generated_notes.json', { ab1c: 'a', de2f: 'b' });
  const out = removeNote({ id: 'ab1c', generatedJson: gen });
  assert.match(out, /removed id "ab1c"/);
  assert.match(out, /WARNING: verse coverage was not checked/);
});

test('findVersesWithoutNotes reports each lost verse of a ranged prepared item', () => {
  const prep = writeJson('range/prepared_notes.json', { items: [{ id: 'ab1c', reference: '36:9-10' }] });
  const tsv = 'range-cov.tsv';
  fs.writeFileSync(path.join(WORK, tsv), HDR + '36:9\tab1c\t\t\tQ\t1\ta\n');
  assert.deepEqual(findVersesWithoutNotes({ preparedJson: prep, notesPath: tsv }), ['36:10']);
});

test('findVersesWithoutNotes ignores a book-code prefix on TSV references (dry-run writer)', () => {
  const prep = writeJson('dry/prepared_notes.json', { items: [{ id: 'ab1c', reference: '36:9' }] });
  const tsv = 'dry.tsv';
  fs.writeFileSync(path.join(WORK, tsv), HDR + 'JER 36:9\t\t\t\t\t1\t[Stub note for dry run]\n');
  assert.deepEqual(findVersesWithoutNotes({ preparedJson: prep, notesPath: tsv }), []);
});

// #466 item 3: a stale TSV with no row for the id used to count as a coverage
// check, so removing a generated note with no prepared entry gave no warning.
test('removeNote warns that coverage was unchecked when the TSV has no row for the id', () => {
  const gen = writeJson('stale-tsv/generated_notes.json', { zz9z: 'only note of 7:2' });
  const tsv = 'stale-tsv/GEN-07.tsv';
  fs.writeFileSync(path.join(WORK, tsv), HDR + '7:1\tab1c\t\t\tQ\t1\ta\n');
  const out = removeNote({ id: 'zz9z', generatedJson: gen, tsvFile: tsv });
  assert.match(out, /removed id "zz9z"/);
  assert.match(out, /WARNING: verse coverage was not checked/);
});
