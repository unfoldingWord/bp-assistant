// insert-usfm-verses.test.js — regression tests for the JER 29 perfect storm.
// Covers: (1) verse-bridge matching at the chapter's start verse (\v 1 must
// match a \v 1-2 bridge), and (2) the hard guard that refuses to push a
// chapter whose source is missing verses in the requested range — which
// previously truncated en_ult JER 29 from 32 verses to 16.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { insertUsfmVerses } = require('../src/lib/insert-usfm-verses');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'insert-usfm-'));
}

function write(dir, name, content) {
  const full = path.join(dir, name);
  fs.writeFileSync(full, content, 'utf8');
  return full;
}

// A minimal two-chapter book file. The marker after \c lives on its own line
// so findChapterRange's `^\c N$` anchor matches.
function bookFile(ch29Verses) {
  return [
    '\\id JER',
    '\\h Jeremiah',
    '\\c 29',
    '\\p',
    ...ch29Verses,
    '\\c 30',
    '\\p',
    '\\v 1 Chapter thirty verse one.',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Bridge matching at the start verse
// ---------------------------------------------------------------------------

test('replaces a chapter that opens with a verse bridge (\\v 1-2)', () => {
  const dir = makeTempDir();
  try {
    const book = write(dir, '24-JER.usfm', bookFile([
      '\\v 1-2 old one and two',
      '\\v 3 old three',
    ]));
    const source = write(dir, 'src.usfm', [
      '\\id JER EN_UST - Aligned',
      '\\c 29',
      '\\p',
      '\\v 1-2 new one and two',
      '\\v 3 new three',
      '',
    ].join('\n'));

    insertUsfmVerses({ bookFile: book, sourceFile: source, chapter: 29, verses: '1-3' });

    const out = fs.readFileSync(book, 'utf8');
    assert.match(out, /\\v 1-2 new one and two/);
    assert.match(out, /\\v 3 new three/);
    assert.doesNotMatch(out, /old one and two/);
    // chapter 30 must be left intact
    assert.match(out, /\\c 30[\s\S]*Chapter thirty verse one\./);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Truncation guard — the core of the JER 29 regression
// ---------------------------------------------------------------------------

test('throws when the source is missing verses in the requested range', () => {
  const dir = makeTempDir();
  try {
    const book = write(dir, '24-JER.usfm', bookFile([
      '\\v 1 a', '\\v 2 b', '\\v 3 c', '\\v 4 d',
    ]));
    // Source only covers verses 1-2 (a single batch of a split chapter).
    const source = write(dir, 'src.usfm', [
      '\\id JER', '\\c 29', '\\p', '\\v 1 new a', '\\v 2 new b', '',
    ].join('\n'));

    assert.throws(
      () => insertUsfmVerses({ bookFile: book, sourceFile: source, chapter: 29, verses: '1-4' }),
      /missing verse\(s\) 3, 4 for chapter 29/,
    );

    // The book file must be untouched — the guard fires before any write.
    const out = fs.readFileSync(book, 'utf8');
    assert.match(out, /\\v 3 c/);
    assert.match(out, /\\v 4 d/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a bridge in the source counts for every verse it spans', () => {
  const dir = makeTempDir();
  try {
    const book = write(dir, '24-JER.usfm', bookFile([
      '\\v 1 a', '\\v 2 b', '\\v 3 c',
    ]));
    // Source covers 1,2 (via bridge) and 3 — full coverage of 1-3.
    const source = write(dir, 'src.usfm', [
      '\\id JER', '\\c 29', '\\p', '\\v 1-2 new bridge', '\\v 3 new three', '',
    ].join('\n'));

    // Should NOT throw — coverage is complete once the bridge is expanded.
    insertUsfmVerses({ bookFile: book, sourceFile: source, chapter: 29, verses: '1-3' });
    const out = fs.readFileSync(book, 'utf8');
    assert.match(out, /\\v 1-2 new bridge/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Existing behaviour preserved
// ---------------------------------------------------------------------------

test('full-chapter replacement with complete source still works', () => {
  const dir = makeTempDir();
  try {
    const book = write(dir, '24-JER.usfm', bookFile([
      '\\v 1 a', '\\v 2 b', '\\v 3 c',
    ]));
    const source = write(dir, 'src.usfm', [
      '\\id JER', '\\c 29', '\\p', '\\v 1 A', '\\v 2 B', '\\v 3 C', '',
    ].join('\n'));

    insertUsfmVerses({ bookFile: book, sourceFile: source, chapter: 29, verses: '1-3' });
    const out = fs.readFileSync(book, 'utf8');
    assert.match(out, /\\v 1 A/);
    assert.match(out, /\\v 3 C/);
    assert.doesNotMatch(out, /\\v 1 a\b/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('verse-range (subset) push only replaces the requested verses', () => {
  const dir = makeTempDir();
  try {
    const book = write(dir, '24-JER.usfm', bookFile([
      '\\v 1 a', '\\v 2 b', '\\v 3 c', '\\v 4 d', '\\v 5 e',
    ]));
    // Requesting only 3-4; source covers exactly 3-4.
    const source = write(dir, 'src.usfm', [
      '\\id JER', '\\c 29', '\\p', '\\v 3 NEW3', '\\v 4 NEW4', '',
    ].join('\n'));

    insertUsfmVerses({ bookFile: book, sourceFile: source, chapter: 29, verses: '3-4' });
    const out = fs.readFileSync(book, 'utf8');
    assert.match(out, /\\v 3 NEW3/);
    assert.match(out, /\\v 4 NEW4/);
    // Surrounding verses untouched
    assert.match(out, /\\v 1 a/);
    assert.match(out, /\\v 2 b/);
    assert.match(out, /\\v 5 e/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Mid-line \v marker — the EZK 16 regression (issue #245).
// Aligned USFM often places the next verse's marker on the same line as the
// previous verse's closing \zaln-e\* / \w*, e.g.:
//   \w foo|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*, \v 2 "\zaln-s ...
// The old line-start-anchored regex missed those \v markers and reported a
// fully-aligned chapter as partial. All mid-line \v markers must be counted.
// ---------------------------------------------------------------------------

test('counts \\v markers that appear mid-line in aligned source (EZK 16 regression)', () => {
  const dir = makeTempDir();
  try {
    const book = write(dir, '26-EZK.usfm', bookFile([
      '\\v 1 old one', '\\v 2 old two', '\\v 3 old three',
    ]));
    // Source mimics real aligned output: \v 2 and \v 3 land mid-line, right
    // after the previous verse's closing \zaln-e\* — no line break between
    // verses. If collectCoveredVerses only matches at line start, verses 2
    // and 3 are treated as missing and the push is refused.
    const source = write(dir, 'src.usfm', [
      '\\id EZK EN_ULT - Aligned',
      '\\c 29',
      '\\p',
      '\\v 1 \\zaln-s |x-strong="H1234"\\*\\w new-one|x-occurrence="1"\\w*\\zaln-e\\*, \\v 2 "\\zaln-s |x-strong="H5678"\\*\\w new-two|x-occurrence="1"\\w*\\zaln-e\\*. \\v 3 \\zaln-s |x-strong="H9012"\\*\\w new-three|x-occurrence="1"\\w*\\zaln-e\\*.',
      '',
    ].join('\n'));

    // Must NOT throw — every verse is present, just mid-line.
    insertUsfmVerses({ bookFile: book, sourceFile: source, chapter: 29, verses: '1-3' });
    const out = fs.readFileSync(book, 'utf8');
    assert.match(out, /new-one/);
    assert.match(out, /new-two/);
    assert.match(out, /new-three/);
    assert.doesNotMatch(out, /old one/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('multi-digit start verse anchors exactly (\\v 10 boundary)', () => {
  const dir = makeTempDir();
  try {
    // Requesting 10-11 must anchor at \v 10 and stop before \v 12, leaving the
    // earlier verses and \v 12 intact. Exercises the bridge-tolerant regex on a
    // multi-digit start verse without matching \v 1.
    const book = write(dir, '24-JER.usfm', bookFile([
      '\\v 1 a', '\\v 10 old ten', '\\v 11 old eleven', '\\v 12 l',
    ]));
    const source = write(dir, 'src.usfm', [
      '\\id JER', '\\c 29', '\\p', '\\v 10 NEW10', '\\v 11 NEW11', '',
    ].join('\n'));

    insertUsfmVerses({ bookFile: book, sourceFile: source, chapter: 29, verses: '10-11' });
    const out = fs.readFileSync(book, 'utf8');
    assert.match(out, /\\v 10 NEW10/);
    assert.match(out, /\\v 11 NEW11/);
    assert.match(out, /\\v 1 a/);   // earlier verse untouched
    assert.match(out, /\\v 12 l/);  // next verse untouched
    assert.doesNotMatch(out, /old ten/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
