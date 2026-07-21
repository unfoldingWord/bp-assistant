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

const {
  resolveMergedChapterAligned,
  assessAlignedChapterCoverage,
  formatVerseRanges,
  cleanupGenerateArtifacts,
  deleteStaleBatches,
} = require('../src/generate-pipeline');

function setMtime(rel, ms) {
  const d = new Date(ms);
  fs.utimesSync(path.join(TMP, rel), d, d);
}

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

// --- source-consistency gate: bank valid batches, drop stale ones -----------

test('source-consistency: a batch older than the source is dropped from the merge', () => {
  const d = 'output/AI-ULT/JER';
  const b1 = writeRel(`${d}/JER-40-v01-v10-aligned.usfm`, batch(40, ['1', '2']));
  const b2 = writeRel(`${d}/JER-40-v11-v20-aligned.usfm`, batch(40, ['11', '12']));
  const now = Date.now();
  setMtime(b1, now - 100000); // stale — predates source
  setMtime(b2, now);          // source-consistent
  // With minMtime = now, only b2 survives → single batch, no merge produced.
  const resolved = resolveMergedChapterAligned('JER', b2, now);
  assert.equal(resolved, b2);
  assert.equal(fs.existsSync(path.join(TMP, `${d}/JER-40-aligned.usfm`)), false);
});

test('source-consistency: all batches stale → null (forces re-align)', () => {
  const d = 'output/AI-ULT/JER';
  const b1 = writeRel(`${d}/JER-41-v01-v10-aligned.usfm`, batch(41, ['1', '2']));
  const now = Date.now();
  setMtime(b1, now - 100000);
  assert.equal(resolveMergedChapterAligned('JER', b1, now), null);
});

test('source-consistency: a full-chapter file older than source is rejected', () => {
  const rel = writeRel('output/AI-ULT/JER/JER-42-aligned.usfm', batch(42, ['1', '2']));
  const now = Date.now();
  setMtime(rel, now - 100000);
  assert.equal(resolveMergedChapterAligned('JER', rel, now), null);
});

// --- coverage gate: catch truncated chapters before push ---------------------

test('coverage: flags missing verses vs source', () => {
  const src = writeRel('output/AI-ULT/JER/JER-50.usfm', batch(50, ['1', '2', '3', '4']));
  const aligned = writeRel('output/AI-ULT/JER/JER-50-aligned.usfm', batch(50, ['1', '2']));
  const now = Date.now();
  setMtime(src, now - 5000);
  setMtime(aligned, now);
  const r = assessAlignedChapterCoverage(aligned, src, { checkCoverage: true });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'incomplete');
  assert.deepEqual(r.missing, [3, 4]);
});

test('coverage: a complete chapter passes', () => {
  const src = writeRel('output/AI-ULT/JER/JER-51.usfm', batch(51, ['1', '2', '3']));
  const aligned = writeRel('output/AI-ULT/JER/JER-51-aligned.usfm', batch(51, ['1', '2', '3']));
  const now = Date.now();
  setMtime(src, now - 5000);
  setMtime(aligned, now);
  assert.equal(assessAlignedChapterCoverage(aligned, src, { checkCoverage: true }).ok, true);
});

test('coverage: bridges (\\v 1-2) count as both verses', () => {
  const src = writeRel('output/AI-ULT/JER/JER-53.usfm', batch(53, ['1-2', '3']));
  const aligned = writeRel('output/AI-ULT/JER/JER-53-aligned.usfm', batch(53, ['1-2', '3']));
  const now = Date.now();
  setMtime(src, now - 5000);
  setMtime(aligned, now);
  assert.equal(assessAlignedChapterCoverage(aligned, src, { checkCoverage: true }).ok, true);
});

test('coverage: aligned older than source is reported stale, not incomplete', () => {
  const src = writeRel('output/AI-ULT/JER/JER-52.usfm', batch(52, ['1', '2']));
  const aligned = writeRel('output/AI-ULT/JER/JER-52-aligned.usfm', batch(52, ['1', '2']));
  const now = Date.now();
  setMtime(src, now);
  setMtime(aligned, now - 100000);
  const r = assessAlignedChapterCoverage(aligned, src, { checkCoverage: true });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'stale');
});

test('coverage: missing aligned file', () => {
  const r = assessAlignedChapterCoverage('output/AI-ULT/JER/does-not-exist-aligned.usfm', 'output/AI-ULT/JER/JER-52.usfm', { checkCoverage: true });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'missing');
});

test('coverage: verse-range runs skip the full-chapter check', () => {
  const src = writeRel('output/AI-ULT/JER/JER-54.usfm', batch(54, ['1', '2', '3', '4']));
  const aligned = writeRel('output/AI-ULT/JER/JER-54-vv1-2-aligned.usfm', batch(54, ['1', '2']));
  const now = Date.now();
  setMtime(src, now - 5000);
  setMtime(aligned, now);
  // checkCoverage:false → only existence + source-consistency, not full 1..N.
  assert.equal(assessAlignedChapterCoverage(aligned, src, { checkCoverage: false }).ok, true);
});

test('formatVerseRanges compacts consecutive runs', () => {
  assert.equal(formatVerseRanges([1, 2, 3, 7]), '1-3, 7');
  assert.equal(formatVerseRanges([5]), '5');
  assert.equal(formatVerseRanges([]), '');
  assert.equal(formatVerseRanges([1, 2, 4, 5, 6, 9]), '1-2, 4-6, 9');
});

// --- --fresh must clear per-batch aligned files ------------------------------

test('cleanupGenerateArtifacts removes per-batch aligned files (D3)', () => {
  const d = 'output/AI-UST/JER';
  writeRel(`${d}/JER-60-v01-v15-aligned.usfm`, batch(60, ['1']));
  writeRel(`${d}/JER-60-v16-v30-aligned.usfm`, batch(60, ['16']));
  writeRel(`${d}/JER-60-aligned.usfm`, batch(60, ['1']));
  writeRel(`${d}/JER-60.usfm`, batch(60, ['1']));
  cleanupGenerateArtifacts({ book: 'JER', chapter: 60 });
  for (const f of ['JER-60-v01-v15-aligned.usfm', 'JER-60-v16-v30-aligned.usfm', 'JER-60-aligned.usfm', 'JER-60.usfm']) {
    assert.equal(fs.existsSync(path.join(TMP, `${d}/${f}`)), false, `${f} should be removed`);
  }
});

test('cleanupGenerateArtifacts sweeps leftover mapping JSON and salvage output (issue #235)', () => {
  // Regression: fresh mode used to leave tmp/alignments/ and tmp/aligned/salvage/
  // untouched. When the coordinator then failed outright, salvage fell back on
  // stale mapping JSON from a prior source generation and rejected most verses
  // via the 0.85 similarity guard (EZK 16, 2026-07-21: 24/63 ULT + 2/63 UST).
  const filesToClear = [
    // Older per-verse mapping JSON (BOOK-CHAPTER-VERSE.json), various padding.
    'tmp/alignments/EZK/EZK-16-001.json',
    'tmp/alignments/EZK/EZK-16-063.json',
    'tmp/alignments/EZK/EZK-016-020.json',
    // Newer per-verse mapping JSON (BOOK-CHAPTER-vVERSE-TYPE.json).
    'tmp/alignments/EZK/EZK-16-v3-ult.json',
    'tmp/alignments/EZK/EZK-16-v45-ust.json',
    // Whole-chapter mapping JSON variants used by the pipeline.
    'tmp/alignments/EZK/EZK-16-mapping.json',
    'tmp/alignments/EZK/EZK-16-ult.json',
    'tmp/alignments/EZK/EZK-16-ust.json',
    'tmp/alignments/EZK/EZK-16-ult-fixed.json',
    // Prior salvage output.
    'tmp/aligned/salvage/EZK-16-001-ult-aligned.usfm',
    'tmp/aligned/salvage/EZK-16-042-ust-aligned.usfm',
  ];
  for (const rel of filesToClear) writeRel(rel, '{}');

  // Sibling chapter/book artifacts must survive — the sweep is scoped by
  // BOOK-CHAPTER prefix, not blanket "tmp/alignments/**".
  const filesToPreserve = [
    'tmp/alignments/EZK/EZK-17-001.json',       // different chapter
    'tmp/alignments/EZK/EZK-160-001.json',      // different chapter (padded to 3)
    'tmp/alignments/JER/JER-16-001.json',       // different book
    'tmp/aligned/salvage/EZK-17-001-ult-aligned.usfm',
    'tmp/aligned/salvage/JER-16-001-ult-aligned.usfm',
  ];
  for (const rel of filesToPreserve) writeRel(rel, '{}');

  cleanupGenerateArtifacts({ book: 'EZK', chapter: 16 });

  for (const rel of filesToClear) {
    assert.equal(fs.existsSync(path.join(TMP, rel)), false, `${rel} should be swept`);
  }
  for (const rel of filesToPreserve) {
    assert.equal(fs.existsSync(path.join(TMP, rel)), true, `${rel} should be preserved`);
  }
});

// --- deleteStaleBatches: clear source-predating batches so the skill re-aligns them

test('deleteStaleBatches removes only batches older than the source', () => {
  const d = 'output/AI-ULT/JER';
  const stale = writeRel(`${d}/JER-70-v01-v15-aligned.usfm`, batch(70, ['1']));
  const fresh = writeRel(`${d}/JER-70-v16-v30-aligned.usfm`, batch(70, ['16']));
  const now = Date.now();
  const sourceMs = now;
  setMtime(stale, now - 100000); // predates source → must be deleted
  setMtime(fresh, now);          // source-consistent → must survive
  deleteStaleBatches('JER', 70, 'output/AI-ULT', sourceMs);
  assert.equal(fs.existsSync(path.join(TMP, stale)), false, 'stale batch should be deleted');
  assert.equal(fs.existsSync(path.join(TMP, fresh)), true, 'source-consistent batch should survive');
});

test('deleteStaleBatches is a no-op when source mtime is unknown (0)', () => {
  const d = 'output/AI-ULT/JER';
  const b = writeRel(`${d}/JER-71-v01-v15-aligned.usfm`, batch(71, ['1']));
  setMtime(b, Date.now() - 100000);
  deleteStaleBatches('JER', 71, 'output/AI-ULT', 0);
  assert.equal(fs.existsSync(path.join(TMP, b)), true, 'nothing deleted without a known source mtime');
});

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});
