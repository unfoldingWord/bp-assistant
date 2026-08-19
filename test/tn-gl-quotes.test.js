// Tests for the GL-quote generation step and the TN keyword index that reads it.
//
// Upstream en_tn is 7-column (Reference..Note) and carries only the
// original-language Hebrew quote. Before these changes, curate-data's
// resolve-quotes step skipped every file (it required a GLQuote column that
// nothing created) and buildTnIndex read the "# Fetched:" comment as the header
// row, so by_keyword came out empty. These tests pin both halves:
//   1. resolveGlQuotes adds the GLQuote column and fills it from ULT alignment.
//   2. buildTnIndex resolves columns by header name and produces keywords.
//
// CSKILLBP_DIR is captured at module load by both modules under test, so it is
// set before the requires below.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-gl-quotes-'));
process.env.CSKILLBP_DIR = WS;

const { extractUnalignedEnglish, resolveGlQuotes } = require('../src/curate-data');
const { buildTnIndex } = require('../src/workspace-tools/index-tools');

const HEBREW = 'מידע';

// Aligned ULT: one zaln milestone per verse mapping HEBREW to two English words.
// Two verses so the keyword clears buildTnIndex's "seen at least twice" filter.
function alignedVerse(verse) {
  return [
    `\\v ${verse}`,
    `\\zaln-s |x-strong="H3045" x-lemma="יָדַע" x-morph="He,VPsmsa" x-occurrence="1" x-occurrences="1" x-content="${HEBREW}"\\*` +
      `\\w a|x-occurrence="1" x-occurrences="1"\\w* \\w relative|x-occurrence="1" x-occurrences="1"\\w*\\zaln-e\\*`,
  ].join('\n');
}

const ULT_USFM = [
  '# Fetched: 2026-08-19',
  '\\id RUT',
  '\\h Ruth',
  '\\c 2',
  '\\p',
  alignedVerse(1),
  alignedVerse(2),
  '',
].join('\n');

const SREF = 'rc://*/ta/man/translate/figs-metaphor';

const TN_7COL = [
  '# Fetched: 2026-08-19',
  'Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote',
  `2:1\tab01\t\t${SREF}\t${HEBREW}\t1\tA note about the word.`,
  `2:2\tab02\t\t${SREF}\t${HEBREW}\t1\tAnother note about the word.`,
  '',
].join('\n');

function seedWorkspace() {
  fs.mkdirSync(path.join(WS, 'data', 'published_ult'), { recursive: true });
  fs.mkdirSync(path.join(WS, 'data', 'published-tns'), { recursive: true });
  fs.writeFileSync(path.join(WS, 'data', 'published_ult', '08-RUT.usfm'), ULT_USFM);
  fs.writeFileSync(path.join(WS, 'data', 'published-tns', 'tn_RUT.tsv'), TN_7COL);
}

function readTn(name) {
  return fs.readFileSync(path.join(WS, 'data', 'published-tns', name), 'utf-8').split('\n');
}

const quiet = () => {};

test('resolveGlQuotes adds a GLQuote column to 7-column en_tn and fills it from ULT alignment', () => {
  seedWorkspace();

  const aligns = extractUnalignedEnglish(quiet);
  assert.ok(aligns.get('RUT'), 'expected ULT alignments for RUT');

  resolveGlQuotes(aligns, quiet);

  const lines = readTn('tn_RUT.tsv');
  assert.equal(lines[0], '# Fetched: 2026-08-19', 'the # Fetched: comment must survive the rewrite');

  const header = lines[1].split('\t');
  const glIdx = header.indexOf('GLQuote');
  assert.ok(glIdx > -1, 'GLQuote column should have been added');
  assert.equal(header.indexOf('Note'), 6, 'existing columns must keep their positions');

  const row = lines[2].split('\t');
  assert.equal(row.length, header.length, 'rows must stay rectangular');
  assert.equal(row[glIdx], 'a relative');
  assert.equal(readTn('tn_RUT.tsv')[3].split('\t')[glIdx], 'a relative');
});

test('resolveGlQuotes is idempotent and does not clobber a populated GLQuote', () => {
  seedWorkspace();
  const aligns = extractUnalignedEnglish(quiet);

  resolveGlQuotes(aligns, quiet);
  const afterFirst = readTn('tn_RUT.tsv').join('\n');

  // Hand-edit one cell, then re-run: an already-populated GLQuote is left alone.
  const lines = readTn('tn_RUT.tsv');
  const glIdx = lines[1].split('\t').indexOf('GLQuote');
  const row = lines[2].split('\t');
  row[glIdx] = 'an editor-chosen phrase';
  lines[2] = row.join('\t');
  fs.writeFileSync(path.join(WS, 'data', 'published-tns', 'tn_RUT.tsv'), lines.join('\n'));

  resolveGlQuotes(aligns, quiet);
  const reread = readTn('tn_RUT.tsv');
  assert.equal(reread[2].split('\t')[glIdx], 'an editor-chosen phrase');
  assert.equal(reread[1].split('\t').filter((h) => h === 'GLQuote').length, 1, 'must not add GLQuote twice');
  assert.notEqual(afterFirst, '', 'sanity: first pass produced content');
});

test('buildTnIndex produces keywords from the generated GLQuote column', async () => {
  seedWorkspace();
  resolveGlQuotes(extractUnalignedEnglish(quiet), quiet);

  const result = await buildTnIndex({ force: true });
  assert.match(result, /Built TN index/);

  const idx = JSON.parse(fs.readFileSync(path.join(WS, 'data', 'cache', 'tn_index.json'), 'utf-8'));
  assert.ok(idx._meta.unique_keywords > 0, `expected keywords, got ${idx._meta.unique_keywords}`);
  assert.ok(idx.by_keyword.relative, 'expected "relative" in by_keyword');
  assert.equal(idx.by_keyword.relative[0].issue, 'figs-metaphor');
  assert.equal(idx.by_issue['figs-metaphor'].count, 2);
  // The "# Fetched:" comment and the header row must not be counted as notes.
  assert.equal(idx._meta.total_notes, 2);
});

test('buildTnIndex still indexes the legacy 9-column layout', async () => {
  seedWorkspace();
  // Legacy form: Book Chapter Verse ID SupportReference OrigQuote Occurrence GLQuote OccurrenceNote
  fs.writeFileSync(path.join(WS, 'data', 'published-tns', 'tn_JOS.tsv'), [
    'Book\tChapter\tVerse\tID\tSupportReference\tOrigQuote\tOccurrence\tGLQuote\tOccurrenceNote',
    `JOS\t1\t1\tcd01\t${SREF}\t${HEBREW}\t1\tthe commander\tA legacy note.`,
    `JOS\t1\t2\tcd02\t${SREF}\t${HEBREW}\t1\tthe commander\tAnother legacy note.`,
    '',
  ].join('\n'));

  await buildTnIndex({ force: true });

  const idx = JSON.parse(fs.readFileSync(path.join(WS, 'data', 'cache', 'tn_index.json'), 'utf-8'));
  assert.ok(idx.by_keyword.commander, 'expected "commander" from the legacy GLQuote column');
  assert.ok(idx.by_issue['figs-metaphor'].books.includes('JOS'));
});
