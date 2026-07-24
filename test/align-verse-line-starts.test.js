// align-verse-line-starts.test.js
//
// Regression guard for the gap #247 left open. normalizeVerseLineStarts was
// wired into mergeAlignedUsfm only, which runs on the MULTI-batch path
// (chapters > 18 verses). Chapters of <= 18 verses take the single-batch path,
// where the sub-agent writes the whole-chapter file directly via
// create_aligned_usfm — no merge, no normalization. AMO 8 shipped to en_ult
// master on 2026-07-24 with 11 of 14 verse markers mid-line as a result.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  normalizeVerseLineStarts,
  normalizeVerseLineStartsInFile,
} = require('../src/workspace-tools/usfm-tools');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-verse-lines-'));
const tmpFile = (name, content) => {
  const p = path.join(tmpRoot, name);
  fs.writeFileSync(p, content);
  return p;
};

// Shaped like the real AMO 8 ULT defect: \v 1 at line start, later markers
// trailing the end of the previous verse's alignment run.
const MIDLINE_SAMPLE = [
  '\\c 8',
  '\\p',
  '\\v 1 \\zaln-s |x-strong="H3541"\\*\\w Thus|x-occurrence="1"\\w*\\zaln-e\\*',
  '\\zaln-s |x-strong="H0136"\\*\\w the Lord|x-occurrence="1"\\w*\\zaln-e\\* \\v 2 \\zaln-s |x-strong="H0559"\\*\\w And he said|x-occurrence="1"\\w*\\zaln-e\\* \\v 3 \\zaln-s |x-strong="H1961"\\*\\w And they will be|x-occurrence="1"\\w*\\zaln-e\\*',
].join('\n');

test('normalizeVerseLineStartsInFile moves mid-line verse markers to line start', () => {
  const p = tmpFile('midline.usfm', MIDLINE_SAMPLE);
  const changed = normalizeVerseLineStartsInFile(p);
  assert.equal(changed, true, 'reports that it rewrote the file');

  const out = fs.readFileSync(p, 'utf8');
  const anywhere = [...out.matchAll(/\\v\s+(\d+)/g)].map((m) => Number(m[1]));
  const atLineStart = [...out.matchAll(/(^|\n)\\v\s+(\d+)/g)].map((m) => Number(m[2]));
  assert.deepEqual(anywhere, [1, 2, 3], 'all three verses still present');
  assert.deepEqual(atLineStart, [1, 2, 3], 'and every one now begins its line');
});

test('normalization is newline-only — no non-newline byte changes', () => {
  const p = tmpFile('bytes.usfm', MIDLINE_SAMPLE);
  normalizeVerseLineStartsInFile(p);
  const out = fs.readFileSync(p, 'utf8');
  assert.equal(
    out.replace(/\n/g, ''),
    MIDLINE_SAMPLE.replace(/\n/g, ''),
    'stripping newlines from input and output yields identical bytes',
  );
});

test('an already-clean file is left untouched (no needless mtime churn)', () => {
  const clean = ['\\c 8', '\\p', '\\v 1 \\w Thus|x-occurrence="1"\\w*', '\\v 2 \\w And|x-occurrence="1"\\w*'].join('\n');
  const p = tmpFile('clean.usfm', clean);
  const before = fs.statSync(p).mtimeMs;
  const changed = normalizeVerseLineStartsInFile(p);
  assert.equal(changed, false, 'reports no change');
  assert.equal(fs.readFileSync(p, 'utf8'), clean, 'content identical');
  assert.equal(fs.statSync(p).mtimeMs, before, 'mtime untouched — staleness checks compare aligned-file mtimes');
});

test('normalization is idempotent, so applying it on several routes is safe', () => {
  const once = normalizeVerseLineStarts(MIDLINE_SAMPLE);
  assert.equal(normalizeVerseLineStarts(once), once);
});

test('a legitimate line-start \\v after a paragraph marker is not split', () => {
  const withMarker = '\\p \\v 4 \\w Hear|x-occurrence="1"\\w*';
  assert.equal(normalizeVerseLineStarts(withMarker), withMarker);
});

test('normalizeVerseLineStartsInFile returns false on an unreadable path', () => {
  assert.equal(normalizeVerseLineStartsInFile(path.join(tmpRoot, 'does-not-exist.usfm')), false);
});

test.after(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
});
