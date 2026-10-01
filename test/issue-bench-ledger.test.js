'use strict';
const test = require('node:test');
const assert = require('node:assert');
const lib = require('../scripts/issue-bench/lib');

const HEADER = 'Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote';
const P = 'rc://*/ta/man/translate/';
const tsv = (...rows) => [HEADER, ...rows.map((r) => r.join('\t'))].join('\r\n') + '\r\n';
const row = (ref, id, slug, quote, note, occ = '1') => [ref, id, '', slug ? P + slug : '', quote, occ, note];

test('parseTsv strips CR, skips intro handling flags, flags pointers, strips slug prefix', () => {
  const rows = lib.parseTsv(tsv(
    ['front:intro', 'aaaa', '', '', '', '0', '# Intro'],
    ['1:intro', 'bbbb', '', '', '', '', '# Ch 1'],
    row('1:2', 'cccc', 'figs-metaphor', 'x  y', 'A note'),
    row('1:3-5', 'dddd', 'figs-idiom', 'q', 'See how you translated this in [Jeremiah 2:1](../02/01.md).'),
  ));
  assert.strictEqual(rows.length, 4);
  assert.ok(rows[0].intro && rows[1].intro);
  assert.strictEqual(rows[2].slug, 'figs-metaphor');
  assert.strictEqual(rows[2].quote, 'x y');
  assert.strictEqual(rows[2].note, 'A note');
  assert.ok(!rows[2].note.includes('\r'));
  assert.ok(rows[3].pointer);
  assert.strictEqual(rows[3].verseEnd, 5);
  assert.strictEqual(rows[2].chapter, '1');
});

test('norm applies NFC and collapses whitespace', () => {
  assert.strictEqual(lib.norm('  á  b '), 'á b');
});

test('classifyCommit: ai, ours, human', () => {
  const bot = 'bot@unfoldingword.org';
  assert.strictEqual(lib.classifyCommit({ email: bot, message: 'TN: JER 32 [ju..7@api.bp-assistant]\n\nX-AI-Pipeline: bp-assistant/notes\n' }, 'JER'), 'ai');
  assert.strictEqual(lib.classifyCommit({ email: bot, message: 'TN: JER 32' }, 'JER'), 'ai');
  assert.strictEqual(lib.classifyCommit({ email: 'someone@x.org', message: 'TN: JER 32 [x]' }, 'JER'), 'human');
  assert.strictEqual(lib.classifyCommit({ email: bot, message: 'TN: EZK 3 [x]' }, 'JER'), 'human');
  assert.strictEqual(lib.classifyCommit({ email: 'x@y', message: 'whatever\n\nX-AI-Pipeline: bp-assistant/notes' }, 'JER'), 'ai');
  assert.strictEqual(lib.classifyCommit({ email: '9089+d@noreply.door43.org', message: 'bible-editor: JER tn → master (#7796)' }, 'JER'), 'ours');
  assert.strictEqual(lib.classifyCommit({ email: 'x@y', message: 'bible-editor export: JER' }, 'JER'), 'ours');
  assert.strictEqual(lib.classifyCommit({ email: 'x@y', message: 'Fixes punctuation (#5969)' }, 'JER'), 'human');
});

test('aiSubjectChapters handles single, range, and verse-range shards', () => {
  assert.deepStrictEqual(lib.aiSubjectChapters('TN: JER 32 [ju..7@api.bp-assistant]', 'JER'), ['32']);
  assert.deepStrictEqual(lib.aiSubjectChapters('TN: PSA 119-121', 'PSA'), ['119', '120', '121']);
  assert.deepStrictEqual(lib.aiSubjectChapters('TN: JER 23:1-7 [x]', 'JER'), ['23']);
  assert.deepStrictEqual(lib.aiSubjectChapters('UST: JER 23', 'JER'), []);
});

test('isolateAiRows excludes rows already present at the parent', () => {
  const parent = lib.parseTsv(tsv(row('5:1', 'old1', 'figs-idiom', 'q', 'n')));
  const atAi = lib.parseTsv(tsv(
    row('5:1', 'old1', 'figs-idiom', 'q', 'n'),
    row('5:2', 'new1', 'figs-metaphor', 'q2', 'n2'),
    row('5:3', 'new2', '', 'q3', 'See how you translated this'),
    row('6:1', 'other', 'figs-idiom', 'q', 'n'),
  ));
  const r = lib.isolateAiRows(atAi, parent, '5');
  assert.deepStrictEqual(r.aiRows.map((x) => x.id), ['new1']);
  assert.deepStrictEqual(r.pointerRowsAi.map((x) => x.id), ['new2']);
});

function pairFixture(finalRows) {
  const atAi = lib.parseTsv(tsv(
    row('5:1', 'keep', 'figs-idiom', 'alpha beta', 'note one'),
    row('5:2', 'word', 'figs-idiom', 'gamma', 'note two'),
    row('5:3', 'scop', 'figs-idiom', 'delta', 'note three'),
    row('5:4', 'rela', 'figs-idiom', 'eps', 'note four'),
    row('5:5', 'gone', 'figs-idiom', 'zeta', 'note five'),
    row('5:6', 'prec', 'figs-idiom', 'eta', 'note six'),
    row('5:7', 'legc', 'figs-idiom', 'theta', 'legacy'),
  ));
  const parent = lib.parseTsv(tsv(row('5:7', 'legc', 'figs-idiom', 'theta', 'legacy')));
  const { aiRows, atAi: at } = lib.isolateAiRows(atAi, parent, '5');
  return lib.pairRows(aiRows, lib.parseTsv(tsv(...finalRows)), at);
}

test('pairing by ID with precedence relabeled > rescoped > reworded > kept', () => {
  const res = pairFixture([
    row('5:1', 'keep', 'figs-idiom', 'alpha beta', 'note one'),
    row('5:2', 'word', 'figs-idiom', 'gamma', 'changed note'),
    row('5:3', 'scop', 'figs-idiom', 'delta more', 'note three'),
    row('5:4', 'rela', 'figs-metaphor', 'eps', 'note four'),
    row('5:6', 'prec', 'figs-metonymy', 'eta changed', 'note changed'),
    row('5:7', 'legc', 'figs-idiom', 'theta', 'legacy'),
  ]);
  const kinds = Object.fromEntries(res.pairs.map((p) => [p.ai.id, p.kind]));
  assert.deepStrictEqual(kinds, { keep: 'kept', word: 'reworded', scop: 'rescoped', rela: 'relabeled', gone: 'deleted', prec: 'relabeled' });
  assert.strictEqual(res.humanAdded.length, 0);
  assert.deepStrictEqual(res.legacyFinal.map((r) => r.id), ['legc']);
});

test('kept-reid fallback: new ID, same ref+slug, quote overlap >= 0.5', () => {
  const res = pairFixture([
    row('5:1', 'keep', 'figs-idiom', 'alpha beta', 'note one'),
    row('5:5', 'nw01', 'figs-idiom', 'zeta', 'note five'),
    row('5:7', 'legc', 'figs-idiom', 'theta', 'legacy'),
  ]);
  const gone = res.pairs.find((p) => p.ai.id === 'gone');
  assert.strictEqual(gone.kind, 'kept-reid');
  assert.strictEqual(gone.fin.id, 'nw01');
  assert.ok(!res.humanAdded.some((r) => r.id === 'nw01'));
});

test('no fallback when slug differs or overlap is low', () => {
  const res = pairFixture([
    row('5:5', 'nw01', 'figs-metaphor', 'zeta', 'x'),
    row('5:2', 'nw02', 'figs-idiom', 'completely different', 'x'),
  ]);
  assert.strictEqual(res.pairs.find((p) => p.ai.id === 'gone').kind, 'deleted');
  assert.strictEqual(res.pairs.find((p) => p.ai.id === 'word').kind, 'deleted');
});

test('human-added: final rows not at the ai commit and not used by fallback', () => {
  const res = pairFixture([
    row('5:1', 'keep', 'figs-idiom', 'alpha beta', 'note one'),
    row('5:5', 'nw01', 'figs-idiom', 'zeta', 'note five'),
    row('5:8', 'hum1', 'figs-simile', 'new quote', 'human note'),
    row('5:9', 'hum2', '', 'x', 'See how you translated this'),
    row('5:7', 'legc', 'figs-idiom', 'theta', 'legacy'),
  ]);
  assert.deepStrictEqual(res.humanAdded.map((r) => r.id), ['hum1']);
});

test('diffChapters reads changed lines of the target file only', () => {
  const diff = [
    'diff --git a/tn_JER.tsv b/tn_JER.tsv', 'index 1..2 100644', '--- a/tn_JER.tsv', '+++ b/tn_JER.tsv',
    '@@ -1,3 +1,3 @@ front:intro\tx', ' 4:1\tctx\t', '-5:2\told\t', '+5:2\tnew\t', '+7:intro\tz\t',
    'diff --git a/tn_EZK.tsv b/tn_EZK.tsv', '--- a/tn_EZK.tsv', '+++ b/tn_EZK.tsv', '+9:1\tother\t',
  ].join('\n');
  assert.deepStrictEqual([...lib.diffChapters(diff, 'JER')].sort(), ['5', '7']);
});

test('passive regex on sample sentences', () => {
  assert.strictEqual(lib.passiveMatches('The city was destroyed by the army.').length, 1);
  assert.strictEqual(lib.passiveMatches('He has been taken and they were quickly defeated.').length, 2);
  assert.strictEqual(lib.passiveMatches('The word of Yahweh came to me.').length, 0);
  assert.strictEqual(lib.passiveMatches('They are strong and he is king.').length, 0);
});

test('usfmToVerses strips alignment markup and passiveCoverage counts', () => {
  const usfm = [
    '\\c 1', '\\p',
    '\\v 1 \\zaln-s | x-strong="H1" x-content="a"\\*\\w The|x-occurrence="1"\\w* \\w city|x-occurrence="1"\\w* \\w was|x-occurrence="1"\\w* \\w destroyed|x-occurrence="1"\\w*\\zaln-e\\*.',
    '\\v 2 He went home.',
  ].join('\n');
  const v = lib.usfmToVerses(usfm);
  assert.strictEqual(v['1:1'], 'The city was destroyed.');
  const rows = lib.parseTsv(tsv(row('1:1', 'aaaa', 'figs-activepassive', 'q', 'n')));
  const cov = lib.passiveCoverage(v, rows);
  assert.strictEqual(cov.passive_verses, 1);
  assert.strictEqual(cov.passive_verses_with_note, 1);
  assert.strictEqual(cov.ap_rows, 1);
});
