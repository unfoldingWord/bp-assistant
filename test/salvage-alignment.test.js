// salvage-alignment.test.js — unit tests for salvageAlignedFromMappingJson's
// fixture-free paths (guards, source parsing, missing-verse reporting). The
// full JSON→USFM conversion is exercised end-to-end against real data on the
// bot machine; here we cover the pure logic that needs no create_aligned_usfm
// script or Hebrew source.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'salvage-'));
process.env.CSKILLBP_DIR = TMP;

const { salvageAlignedFromMappingJson, salvageDroppedVerses, versesPresentInUsfm, summarizeSalvageMissingReasons } = require('../src/workspace-tools/usfm-tools');

function writeRel(rel, content) {
  const abs = path.join(TMP, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

test('salvage returns a source-missing note when the source file is absent', () => {
  const r = salvageAlignedFromMappingJson({
    book: 'AMO', chapter: 5, type: 'ult',
    sourceRel: 'output/AI-ULT/AMO/nope.usfm', hebrewRel: 'data/hebrew_bible/30-AMO.usfm',
  });
  assert.equal(r.converted.length, 0);
  assert.equal(r.mergedOutput, null);
  assert.match(r.note, /source missing/);
});

test('salvage returns a hebrew-missing note when the Hebrew source is absent', () => {
  writeRel('output/AI-ULT/AMO/AMO-05.usfm', '\\id AMO\n\\c 5\n\\q1 \\v 1 Hear this word\n');
  const r = salvageAlignedFromMappingJson({
    book: 'AMO', chapter: 5, type: 'ult',
    sourceRel: 'output/AI-ULT/AMO/AMO-05.usfm', hebrewRel: 'data/hebrew_bible/nope.usfm',
  });
  assert.match(r.note, /hebrew missing/);
});

test('salvage parses mid-line \\v markers and reports every verse missing when no mapping JSON exists', () => {
  // \v markers follow poetry/paragraph markers on the same line — the parser
  // must find them anywhere, not just at line start (regression: the first
  // implementation anchored to ^\\v and parsed zero verses).
  writeRel('output/AI-ULT/AMO/AMO-05.usfm',
    '\\id AMO\n\\usfm 3.0\n\\c 5\n\\p\n\\q1 \\v 1 Hear this word,\n\\q2 a lamentation.\n\\q1 \\v 2 She has fallen;\n\\q1 \\v 3 For thus says the Lord.\n');
  writeRel('data/hebrew_bible/30-AMO.usfm', '\\id AMO\n\\c 5\n\\v 1 x\n');
  // no tmp/alignments dir at all
  const r = salvageAlignedFromMappingJson({
    book: 'AMO', chapter: 5, type: 'ult',
    sourceRel: 'output/AI-ULT/AMO/AMO-05.usfm', hebrewRel: 'data/hebrew_bible/30-AMO.usfm',
  });
  assert.equal(r.converted.length, 0);
  assert.deepEqual(r.missing, [1, 2, 3]);   // all three verses parsed, none salvageable
  assert.equal(r.mergedOutput, null);
});

test('salvage restricts to the requested chapter in a multi-chapter source', () => {
  writeRel('output/AI-ULT/AMO/multi.usfm',
    '\\id AMO\n\\c 4\n\\q1 \\v 1 chapter four verse one\n\\c 5\n\\q1 \\v 1 chapter five verse one\n\\q1 \\v 2 chapter five verse two\n');
  writeRel('data/hebrew_bible/30-AMO.usfm', '\\id AMO\n\\c 5\n\\v 1 x\n');
  const r = salvageAlignedFromMappingJson({
    book: 'AMO', chapter: 5, type: 'ult',
    sourceRel: 'output/AI-ULT/AMO/multi.usfm', hebrewRel: 'data/hebrew_bible/30-AMO.usfm',
  });
  assert.deepEqual(r.missing, [1, 2]);       // only chapter 5's verses, not chapter 4's
});

// --- non-regression guard for the 'incomplete' gap-fill path ---

test('versesPresentInUsfm finds mid-line \\v markers, deduped and sorted', () => {
  const usfm = '\\c 5\n\\q1 \\v 3 c\n\\q1 \\v 1 a\n\\v 1 dup\n\\q1 \\v 2 b\n';
  assert.deepEqual(versesPresentInUsfm(usfm), [1, 2, 3]);
  assert.deepEqual(versesPresentInUsfm(''), []);
});

test('salvageDroppedVerses: superset overwrite is safe (no drops)', () => {
  const existing = '\\c 1\n\\v 1 a\n\\v 2 b\n';
  // salvage recovered v1,v2,v3 — strict superset of the existing v1,v2 → safe
  assert.deepEqual(salvageDroppedVerses(existing, [1, 2, 3]), []);
  // exact-equal set is also safe (harmless identical overwrite)
  assert.deepEqual(salvageDroppedVerses(existing, [1, 2]), []);
});

test('salvageDroppedVerses: overwrite that omits an existing verse is flagged', () => {
  const existing = '\\c 1\n\\v 1 a\n\\v 2 b\n\\v 8 h\n';
  // salvage only found v1,v2 (v8's mapping JSON stale/missing) — overwriting
  // would drop v8, so the guard reports it and the caller keeps the existing file
  assert.deepEqual(salvageDroppedVerses(existing, [1, 2]), [8]);
});

// --- per-verse missing-reason categorization (issue #222) ---

test('salvage records missing reason "no_mapping_json" when candidate JSON is absent', () => {
  // Reuse the existing "every verse missing" fixture: no tmp/alignments at all,
  // so every verse in the source falls into the no-candidate branch and must
  // carry the `no_mapping_json` reason for the templated failure summary.
  writeRel('output/AI-ULT/AMO/AMO-05-nocands.usfm',
    '\\id AMO\n\\c 5\n\\q1 \\v 1 Hear this word\n\\q1 \\v 2 She has fallen\n');
  writeRel('data/hebrew_bible/30-AMO.usfm', '\\id AMO\n\\c 5\n\\v 1 x\n');
  const r = salvageAlignedFromMappingJson({
    book: 'AMO', chapter: 5, type: 'ult',
    sourceRel: 'output/AI-ULT/AMO/AMO-05-nocands.usfm', hebrewRel: 'data/hebrew_bible/30-AMO.usfm',
    alignmentsDir: 'tmp/alignments-absent',
  });
  assert.deepEqual(r.missing, [1, 2]);
  assert.equal(r.missingReasons[1], 'no_mapping_json');
  assert.equal(r.missingReasons[2], 'no_mapping_json');
});

test('salvage records "low_similarity(score)" when candidate JSON exists but scores below threshold', () => {
  // Write a mapping JSON whose english_text is completely different from the
  // source verse (Jaccard similarity ≈ 0) so it is rejected by the 0.85 gate.
  writeRel('output/AI-ULT/JOL/JOL-01.usfm',
    '\\id JOL\n\\c 1\n\\q1 \\v 1 The word of the LORD that came to Joel\n');
  writeRel('data/hebrew_bible/29-JOL.usfm', '\\id JOL\n\\c 1\n\\v 1 x\n');
  writeRel('tmp/alignments-lowsim/JOL-01-v01-ult.json', JSON.stringify({
    reference: 'JOL 1:1',
    english_text: 'entirely unrelated text about mangoes',
    alignments: [],
  }));
  const r = salvageAlignedFromMappingJson({
    book: 'JOL', chapter: 1, type: 'ult',
    sourceRel: 'output/AI-ULT/JOL/JOL-01.usfm', hebrewRel: 'data/hebrew_bible/29-JOL.usfm',
    alignmentsDir: 'tmp/alignments-lowsim',
  });
  assert.deepEqual(r.missing, [1]);
  assert.match(r.missingReasons[1], /^low_similarity\(\d\.\d\d\)$/);
});

test('summarizeSalvageMissingReasons buckets by reason, groups low-similarity by score, orders known reasons first', () => {
  const s = summarizeSalvageMissingReasons({
    13: 'no_mapping_json',
    14: 'low_similarity(0.62)',
    18: 'low_similarity(0.62)',
    22: 'invalid_output',
  });
  // no-JSON bucket first, invalid_output next (in the known-order list), then
  // low_similarity — verses within a bucket are ascending, and 14/18 share a
  // score so they collapse into a single bucket, not one per verse.
  assert.equal(s, '1 no JSON (13); 1 invalid output (22); 2 low similarity 0.62 (14,18)');
});

test('summarizeSalvageMissingReasons returns empty string for empty/undefined input', () => {
  assert.equal(summarizeSalvageMissingReasons({}), '');
  assert.equal(summarizeSalvageMissingReasons(undefined), '');
  assert.equal(summarizeSalvageMissingReasons(null), '');
});
