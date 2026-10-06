const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { _issuesFileHasIntroRow: hasIntro } = require('../src/notes-pipeline');

function tmpFile(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intro-row-'));
  const file = path.join(dir, 'EZK-40.tsv');
  fs.writeFileSync(file, text);
  return file;
}

test('headerless issues file with a chapter intro row', () => {
  const f = tmpFile('ezk\t40:intro\t\t\t\t\t# Ezekiel 40\nEZK\t40:1\tfigs-idiom\tq\t\t\tx\n');
  assert.equal(hasIntro(f, 40), true);
});

test('CRLF file and book-prefixed reference', () => {
  const f = tmpFile('Reference\tSupportReference\r\nEZK 40:intro\t\r\nEZK 40:1\tfigs-idiom\r\n');
  assert.equal(hasIntro(f, 40), true);
});

test('no intro row: chapter-intro still has to write', () => {
  const f = tmpFile('EZK\t40:1\tfigs-idiom\tq\t\t\tx\nEZK\t40:2\tfigs-idiom\tq\t\t\tintro\n');
  assert.equal(hasIntro(f, 40), false);
});

test('intro row for another chapter does not count', () => {
  const f = tmpFile('EZK\t41:intro\t\t\t\t\t# Ezekiel 41\nEZK\t40:1\tfigs-idiom\tq\t\t\tx\n');
  assert.equal(hasIntro(f, 40), false);
  assert.equal(hasIntro(f, 4), false);
});

test('missing file', () => {
  assert.equal(hasIntro(path.join(os.tmpdir(), 'does-not-exist-intro.tsv'), 40), false);
});
