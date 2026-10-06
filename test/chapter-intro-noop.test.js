const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { _issuesFileHasIntroRow: hasIntro, _stripIntroRows: stripIntro } = require('../src/notes-pipeline');

function tmpFile(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intro-row-'));
  const file = path.join(dir, 'EZK-40.tsv');
  fs.writeFileSync(file, text);
  return file;
}

test('headerless issues file with a chapter intro row', () => {
  const f = tmpFile('ezk\t40:intro\t\t\t\t\t# Ezekiel 40\nEZK\t40:1\tfigs-idiom\tq\t\t\tx\n');
  assert.equal(hasIntro(f, 40, 'EZK'), true);
});

test('CRLF file and book-prefixed reference', () => {
  const f = tmpFile('Reference\tSupportReference\r\nEZK 40:intro\t\r\nEZK 40:1\tfigs-idiom\r\n');
  assert.equal(hasIntro(f, 40, 'EZK'), true);
});

test('no intro row: chapter-intro still has to write', () => {
  const f = tmpFile('EZK\t40:1\tfigs-idiom\tq\t\t\tx\nEZK\t40:2\tfigs-idiom\tq\t\t\tintro\n');
  assert.equal(hasIntro(f, 40, 'EZK'), false);
});

test('intro row for another chapter does not count', () => {
  const f = tmpFile('EZK\t41:intro\t\t\t\t\t# Ezekiel 41\nEZK\t40:1\tfigs-idiom\tq\t\t\tx\n');
  assert.equal(hasIntro(f, 40, 'EZK'), false);
  assert.equal(hasIntro(f, 4, 'EZK'), false);
});

test('missing file', () => {
  assert.equal(hasIntro(path.join(os.tmpdir(), 'does-not-exist-intro.tsv'), 40, 'EZK'), false);
});

test('strip removes only this chapter\'s intro row, keeping EOL and trailing newline', () => {
  const text = 'EZK\t40:intro\t\t\t\t\t# old\r\nEZK\t40:1\tfigs-idiom\tq\t\t\tx\r\nEZK\t41:intro\t\t\t\t\t# 41\r\n';
  const f = tmpFile(text);
  assert.deepEqual(stripIntro(f, 40, 'EZK'), { removed: 1, before: text });
  assert.equal(fs.readFileSync(f, 'utf8'), 'EZK\t40:1\tfigs-idiom\tq\t\t\tx\r\nEZK\t41:intro\t\t\t\t\t# 41\r\n');
  assert.equal(hasIntro(f, 40, 'EZK'), false);
});

test('strip leaves a file without an intro row untouched', () => {
  const f = tmpFile('EZK\t40:1\tfigs-idiom\tq\t\t\tx\n');
  assert.deepEqual(stripIntro(f, 40, 'EZK'), { removed: 0, before: null });
  assert.equal(fs.readFileSync(f, 'utf8'), 'EZK\t40:1\tfigs-idiom\tq\t\t\tx\n');
  assert.deepEqual(stripIntro(path.join(os.tmpdir(), 'does-not-exist-intro.tsv'), 40, 'EZK'), { removed: 0, before: null });
});

test('strip keeps each line\'s own ending in a mixed-EOL file', () => {
  const f = tmpFile('EZK\t40:intro\t\t\t\t\t# old\nEZK\t40:1\ta\r\nEZK\t40:2\tb\n');
  assert.equal(stripIntro(f, 40, 'EZK').removed, 1);
  assert.equal(fs.readFileSync(f, 'utf8'), 'EZK\t40:1\ta\r\nEZK\t40:2\tb\n');
});

test('intro row as the last line without a trailing newline', () => {
  const f = tmpFile('EZK\t40:1\ta\nEZK\t40:intro\t\t\t\t\t# old');
  assert.equal(hasIntro(f, 40, 'EZK'), true);
  assert.equal(stripIntro(f, 40, 'EZK').removed, 1);
  assert.equal(fs.readFileSync(f, 'utf8'), 'EZK\t40:1\ta\n');
});

test('an intro reference with another book\'s code does not count', () => {
  const f = tmpFile('EZK\tISA 40:intro\t\t\t\t\t# wrong book\nEZK\t40:1\ta\n');
  assert.equal(hasIntro(f, 40, 'EZK'), false);
  assert.equal(stripIntro(f, 40, 'EZK').removed, 0);
});
