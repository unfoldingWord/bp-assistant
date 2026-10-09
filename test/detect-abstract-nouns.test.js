// Tests for detectAbstractNouns (bp-assistant#465): word-list matching,
// team rulings from abstract_nouns_review.csv, communication-word exclusions,
// and verse refs / TSV output in text mode.
const os = require('os');
const path = require('path');
const fs = require('fs');

// Must be set BEFORE requiring src modules (CSKILLBP_DIR is read at require time).
const SKILLS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'abstract-nouns-'));
process.env.CSKILLBP_DIR = SKILLS_DIR;

const { test } = require('node:test');
const assert = require('node:assert');
const { detectAbstractNouns } = require('../src/workspace-tools/issue-tools');

const REVIEW_HEADER = 'english_word,in_abstract_nouns_txt,en_tn_tags_total,status,team_decision';

function writeFixture({ reviewRows = [] } = {}) {
  fs.mkdirSync(path.join(SKILLS_DIR, 'data'), { recursive: true });
  // CRLF line endings, like the real file.
  fs.writeFileSync(path.join(SKILLS_DIR, 'data', 'abstract_nouns.txt'),
    ['faith', 'fear', 'pride', 'evil', 'commandment', 'commandments', 'judgment', 'evil intent', ''].join('\r\n'));
  fs.writeFileSync(path.join(SKILLS_DIR, 'data', 'abstract_nouns_review.csv'),
    [REVIEW_HEADER, ...reviewRows, ''].join('\n'));
  const docDir = path.join(SKILLS_DIR, '.claude', 'skills', 'issue-identification');
  fs.mkdirSync(docDir, { recursive: true });
  fs.writeFileSync(path.join(docDir, 'figs-abstractnouns.md'), [
    '## NOT figs-abstractnouns',
    '',
    '**Words for spoken or written communication**: Do not flag these:',
    '- "commandment(s)", "statute(s)", "decree(s)"',
    '- "testimony/testimonies", "law(s)"',
    '',
  ].join('\n'));
}

function words(text, format) {
  const out = detectAbstractNouns({ text, format });
  return JSON.parse(out).map(r => r.english_word.toLowerCase());
}

test('flags list words with no abstract suffix (pride, fear)', () => {
  writeFixture();
  const found = words('Their pride and their fears were great.');
  assert.ok(found.includes('pride'));
  assert.ok(found.includes('fears'), 'plural fold should match fear');
});

test('does not flag communication words or concrete -ment/-ure nouns', () => {
  writeFixture();
  const found = words('He kept the commandments and the commandment, wore a garment, and found treasure in the pasture.');
  assert.deepStrictEqual(found, []);
});

test('disaster is flagged only when the team approves it', () => {
  writeFixture({ reviewRows: ['disaster,no,6,borderline: team decides,'] });
  assert.deepStrictEqual(words('I will bring disaster on them.'), []);

  writeFixture({ reviewRows: ['disaster,no,6,borderline: team decides,abstract'] });
  assert.deepStrictEqual(words('I will bring disaster on them.'), ['disaster']);
});

test('pending borderline list words are held back; "not abstract" rulings suppress suffix hits', () => {
  writeFixture({
    reviewRows: [
      'evil,yes,133,borderline: team decides,',
      'kingdom,no,12,hold: team decides,',
      'salvation,no,1,rare,not abstract',
    ],
  });
  assert.deepStrictEqual(words('the evil and the kingdom and salvation'), []);
});

test('multi-word list entries match as phrases', () => {
  writeFixture({ reviewRows: ['evil,yes,133,borderline: team decides,'] });
  assert.deepStrictEqual(words('their evil intent'), ['evil intent']);
});

test('suffix match is a low-confidence fallback; list match is medium', () => {
  writeFixture();
  const rows = JSON.parse(detectAbstractNouns({ text: 'faith and holiness' }));
  const byWord = Object.fromEntries(rows.map(r => [r.english_word, r.confidence]));
  assert.strictEqual(byWord.faith, 'medium');
  assert.strictEqual(byWord.holiness, 'low');
});

test('text mode parses \\c/\\v markers into refs and honors format=tsv', () => {
  writeFixture();
  const usfm = '\\id JER\n\\c 3\n\\p\n\\v 1 In \\w pride|x-occurrence="1"\\w* they spoke.\n\\v 2 Then came fear.\\f + \\ft note about faith\\f*\n';
  const tsv = detectAbstractNouns({ text: usfm, format: 'tsv' });
  const lines = tsv.split('\n');
  assert.strictEqual(lines[0], 'Ref\tEnglish\tSource\tMorph\tConfidence\tReason');
  assert.deepStrictEqual(lines.slice(1).map(l => l.split('\t').slice(0, 2)), [['3:1', 'pride'], ['3:2', 'fear']]);
});

test('alignment mode uses the word list and bumps confidence for source nouns', () => {
  writeFixture();
  const rel = 'alignments.json';
  fs.writeFileSync(path.join(SKILLS_DIR, rel), JSON.stringify({
    alignments: [
      { ref: '1:1', englishWords: ['pride'], source: { word: 'גָּאוֹן', morph: 'He,Ncmsc' } },
      { ref: '1:2', englishWords: ['garment'], source: { word: 'בֶּגֶד', morph: 'He,Ncmsa' } },
    ],
  }));
  const rows = JSON.parse(detectAbstractNouns({ alignmentJson: rel }));
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].ref, '1:1');
  assert.strictEqual(rows[0].confidence, 'high');
});
