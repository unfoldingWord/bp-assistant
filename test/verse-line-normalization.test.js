// verse-line-normalization.test.js — regression test for #245.
//
// Batch sub-agents sometimes emit a `\v N` marker mid-line (appended to the
// previous verse's alignment text) rather than at line start. The align
// coverage gate tolerates that and reports full coverage, but the push guard
// (collectCoveredVerses in insert-usfm-verses.js) only detected line-start
// `\v` and falsely rejected the chapter as partial (EZK 16: missing 2-5,
// 7-14, 16). merge_aligned_usfm now normalizes every marker to line start so
// the on-disk artifact is always clean.
//
// The normalization must be whitespace-only: it inserts newlines and never
// adds or removes any other byte. These tests assert that property directly
// (newline-stripped content is byte-identical before/after), plus full
// coverage on a fixture mirroring the real EZK 16 layout.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'verse-norm-'));
process.env.CSKILLBP_DIR = TMP;

const {
  normalizeVerseLineStarts,
  mergeAlignedUsfm,
} = require('../src/workspace-tools/usfm-tools');
const { insertUsfmVerses } = require('../src/lib/insert-usfm-verses');

const stripNewlines = (s) => s.replace(/[\r\n]/g, '');

function writeRel(rel, content) {
  const full = path.join(TMP, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  return rel;
}

// A fixture line mirroring the real EZK 16 output: verse 1 opens the line,
// verses 2 and 3 appear mid-line after the prior verse's closing alignment.
const MIDLINE = '\\v 1 \\zaln-s\\*\\w one\\w*\\zaln-e\\*, \\v 2 "\\zaln-s\\*\\w two\\w*\\zaln-e\\* \\v 3 \\zaln-s\\*\\w three\\w*\\zaln-e\\*';

// ---------------------------------------------------------------------------
// Core property: whitespace-only (newline-inserting) transform
// ---------------------------------------------------------------------------

test('normalizeVerseLineStarts moves every mid-line \\v to line start', () => {
  const out = normalizeVerseLineStarts(MIDLINE);
  const lines = out.split('\n');
  assert.equal(lines.length, 3, 'three verses → three lines');
  for (const line of lines) {
    assert.match(line.trim(), /^\\v \d/, `each line begins with \\v: ${line}`);
  }
});

test('normalization is whitespace-only — newline-stripped content is byte-identical', () => {
  const out = normalizeVerseLineStarts(MIDLINE);
  assert.notEqual(out, MIDLINE, 'the transform actually changed line breaks');
  assert.equal(stripNewlines(out), stripNewlines(MIDLINE),
    'no non-newline byte added or removed');
});

test('leaves a legitimate line-start \\v untouched (incl. paragraph prefix)', () => {
  const already = ['\\v 1 alpha', '\\q1 \\v 2 beta', '\\p \\v 3 gamma'].join('\n');
  assert.equal(normalizeVerseLineStarts(already), already);
});

test('a bare full-chapter with no mid-line markers is unchanged', () => {
  const clean = ['\\c 16', '\\p', '\\v 1 a', '\\v 2 b'].join('\n');
  assert.equal(normalizeVerseLineStarts(clean), clean);
});

test('is idempotent', () => {
  const once = normalizeVerseLineStarts(MIDLINE);
  assert.equal(normalizeVerseLineStarts(once), once);
});

// ---------------------------------------------------------------------------
// merge_aligned_usfm writes a clean artifact
// ---------------------------------------------------------------------------

test('mergeAlignedUsfm normalizes mid-line \\v in the written artifact', () => {
  const part = writeRel('output/AI-ULT/EZK/EZK-16-v01-v16-aligned.usfm', [
    '\\id EZK EN_ULT - Aligned', '\\usfm 3.0', '\\h Ezekiel', '\\c 16', '\\p',
    MIDLINE, '',
  ].join('\n'));

  const before = fs.readFileSync(path.join(TMP, part), 'utf8');
  const msg = mergeAlignedUsfm({ parts: [part], output: 'output/AI-ULT/EZK/EZK-16-aligned.usfm' });
  assert.match(msg, /3 verses/);

  const merged = fs.readFileSync(path.join(TMP, 'output/AI-ULT/EZK/EZK-16-aligned.usfm'), 'utf8');
  // Every \v marker lands at line start.
  for (const line of merged.split('\n')) {
    if (line.includes('\\v ')) assert.match(line.trim(), /^\\v \d/, `mid-line \\v survived: ${line}`);
  }
  // Whitespace-only: the merge only strips the surrounding blank lines and
  // inserts line breaks — verse content is byte-identical modulo newlines.
  assert.equal(stripNewlines(merged), stripNewlines(before));
});

// ---------------------------------------------------------------------------
// End-to-end: a merged-then-pushed chapter passes the coverage guard
// ---------------------------------------------------------------------------

test('a normalized merge output passes the insertUsfmVerses coverage guard', () => {
  const part = writeRel('output/AI-ULT/EZK/EZK-16b-v01-v16-aligned.usfm', [
    '\\id EZK EN_ULT - Aligned', '\\c 16', '\\p', MIDLINE, '',
  ].join('\n'));
  mergeAlignedUsfm({ parts: [part], output: 'output/AI-ULT/EZK/EZK-16b-aligned.usfm' });
  const sourceFile = path.join(TMP, 'output/AI-ULT/EZK/EZK-16b-aligned.usfm');

  const bookFile = path.join(TMP, '26-EZK.usfm');
  fs.writeFileSync(bookFile, [
    '\\id EZK', '\\h Ezekiel', '\\c 16', '\\p', '\\v 1 a', '\\v 2 b', '\\v 3 c',
    '\\c 17', '\\p', '\\v 1 next', '',
  ].join('\n'), 'utf8');

  // Must not throw — coverage of 1-3 is complete after normalization.
  insertUsfmVerses({ bookFile, sourceFile, chapter: 16, verses: '1-3' });
  const out = fs.readFileSync(bookFile, 'utf8');
  assert.match(out, /\\w three/);
  assert.match(out, /\\c 17[\s\S]*next/);
});

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});
