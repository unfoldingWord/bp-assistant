// aligned-batch-merge.test.js — regression test for the JER 29 perfect storm.
// When a chapter is aligned in batches, the pipeline must merge them into one
// full-chapter file before pushing, never select a single batch (which pushed
// only verses 1-16 of JER 29 and truncated en_ult master).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// CSKILLBP_DIR is captured at module load by pipeline-utils/usfm-tools, so it
// must be set before requiring generate-pipeline.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-merge-'));
process.env.CSKILLBP_DIR = TMP;

const { resolveMergedChapterAligned } = require('../src/generate-pipeline');

function writeRel(rel, content) {
  const full = path.join(TMP, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  return rel;
}

const DIR = 'output/AI-UST/JER';

function batch(ch, verses) {
  return [
    '\\id JER EN_UST - Aligned',
    '\\usfm 3.0',
    '\\h Jeremiah',
    `\\c ${ch}`,
    '\\p',
    ...verses.map((v) => `\\v ${v} \\zaln-s |x-strong="H1"\\*\\w word|x-occurrence="1" x-occurrences="1"\\w*\\zaln-e\\*`),
    '',
  ].join('\n');
}

test('merges sibling batches into a single full-chapter file', () => {
  writeRel(`${DIR}/JER-29-v01-v16-aligned.usfm`, batch(29, ['1-2', '3', '4']));
  writeRel(`${DIR}/JER-29-v17-v32-aligned.usfm`, batch(29, ['17', '18', '32']));

  // discoverFreshOutput would return the freshest batch; pretend that's v01-v16.
  const resolved = resolveMergedChapterAligned('JER', `${DIR}/JER-29-v01-v16-aligned.usfm`);

  assert.equal(resolved, `${DIR}/JER-29-aligned.usfm`);
  const merged = fs.readFileSync(path.join(TMP, resolved), 'utf8');
  // Full verse sequence, batch headers stripped from the second part.
  for (const v of ['1-2', '3', '4', '17', '18', '32']) {
    assert.match(merged, new RegExp(`\\\\v ${v}\\b`));
  }
  // Only one \c 29 (second batch's header was stripped).
  assert.equal((merged.match(/\\c 29/g) || []).length, 1);
});

test('passes a full-chapter file through unchanged', () => {
  const rel = writeRel(`${DIR}/JER-30-aligned.usfm`, batch(30, ['1', '2', '3']));
  const resolved = resolveMergedChapterAligned('JER', rel);
  assert.equal(resolved, rel);
});

test('passes a verse-range (vv) file through unchanged', () => {
  const rel = writeRel(`${DIR}/JER-31-vv3-4-aligned.usfm`, batch(31, ['3', '4']));
  const resolved = resolveMergedChapterAligned('JER', rel);
  assert.equal(resolved, rel); // must NOT be treated as a batch
});

test('a lone batch with no sibling is left as-is (push guard handles it)', () => {
  const rel = writeRel(`${DIR}/JER-32-v01-v16-aligned.usfm`, batch(32, ['1', '2']));
  const resolved = resolveMergedChapterAligned('JER', rel);
  assert.equal(resolved, rel); // fewer than 2 batches → nothing to merge
});

test('throws (instead of returning a non-existent path) when a merge fails', () => {
  // Two "batches" exist, but one is a directory — the merge cannot read it, so
  // resolveMergedChapterAligned must throw rather than return the canonical
  // path to a file that was never written (which would mask the cause behind a
  // misleading "missing file" alignment retry).
  writeRel(`${DIR}/JER-33-v01-v16-aligned.usfm`, batch(33, ['1', '2']));
  fs.mkdirSync(path.join(TMP, DIR, 'JER-33-v17-v32-aligned.usfm'), { recursive: true });

  assert.throws(() => resolveMergedChapterAligned('JER', `${DIR}/JER-33-v01-v16-aligned.usfm`));
  // The canonical merged file must NOT have been left behind as a valid result.
  assert.equal(fs.existsSync(path.join(TMP, DIR, 'JER-33-aligned.usfm')), false);
});

test('null input returns null', () => {
  assert.equal(resolveMergedChapterAligned('JER', null), null);
});

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});
