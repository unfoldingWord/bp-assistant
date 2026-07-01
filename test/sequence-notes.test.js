const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildAlignmentMap,
  normalizeHebrew,
  quotePosition,
  sortRowsBySequence,
} = require('../src/lib/sequence-notes');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sequence-notes-'));
}

test('normalizeHebrew strips vowel points, accents, joiners, and maqaf', () => {
  assert.equal(normalizeHebrew('בְּרֵאשִׁ֖ית'), 'בראשית');
  assert.equal(normalizeHebrew('מֶֽלֶךְ־יִשְׂרָאֵ֗ל\u2060'), 'מלךישראל');
});

test('quotePosition matches full quotes and falls back to first word', () => {
  const alignments = [
    ['ישראל', 1],
    ['בוקק', 2],
    ['גפן', 4],
  ];

  assert.deepEqual(quotePosition('בוקק גפן', alignments), [2, 2]);
  assert.deepEqual(quotePosition('גפן & ישראל', alignments), [1, 2]);
  assert.deepEqual(quotePosition('ישראל לאקיים', alignments), [1, 2]);
  assert.deepEqual(quotePosition('לאקיים', alignments), [null, 1]);
});

test('buildAlignmentMap and sortRowsBySequence port sequence_notes.py ordering', () => {
  const dir = makeTempDir();
  try {
    const usfmPath = path.join(dir, 'HOS.usfm');
    fs.writeFileSync(usfmPath, [
      '\\id HOS',
      '\\c 10',
      '\\v 1 \\zaln-s |x-content="יִשְׂרָאֵ֞ל"\\*\\w Israel|x\\w* \\zaln-s |x-content="בֹּקֵ֥ק"\\*\\w luxuriant|x\\w* \\zaln-s |x-content="גֶּ֙פֶן֙"\\*\\w vine|x\\w*',
    ].join('\n'), 'utf8');

    const verseMap = buildAlignmentMap(usfmPath);
    const rows = [
      ['10:1', 'late', '', '', 'גֶּ֙פֶן֙', '1', 'Late quote'],
      ['10:1', 'early', '', '', 'יִשְׂרָאֵ֞ל', '1', 'Early quote'],
      ['10:1', 'long', '', '', 'בֹּקֵ֥ק גֶּ֙פֶן֙', '1', 'Longer quote'],
    ];

    const sortedIds = sortRowsBySequence(rows, verseMap).map((row) => row[1]);
    assert.deepEqual(sortedIds, ['early', 'long', 'late']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
