// alignment-batching.test.js — unit tests for the deterministic align-all-parallel
// batch planner (planAlignmentBatches / assertBatchPlanCoversChapter /
// planAlignmentBatchesTool). Regression coverage for issue #233: EZK 16
// (63 verses) was split by the LLM coordinator into 1-16 / 16-30 / 31-45 / 46-60
// — overlapping at v16 and dropping the tail (61-63 never batched, so no mapping
// JSON existed and salvage could not recover them). Moving boundary computation
// into Node guarantees full, contiguous, tail-inclusive coverage.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'batching-'));
process.env.CSKILLBP_DIR = TMP;

const {
  planAlignmentBatches,
  assertBatchPlanCoversChapter,
  planAlignmentBatchesTool,
} = require('../src/workspace-tools/usfm-tools');

// Every planned chapter must be covered exactly once, contiguously, tail-included.
function assertContiguousFullCoverage(batches, n) {
  assert.equal(batches[0].start, 1, 'first batch must start at verse 1');
  assert.equal(batches[batches.length - 1].end, n, `last batch must end at verse ${n}`);
  for (let i = 1; i < batches.length; i += 1) {
    assert.equal(batches[i].start, batches[i - 1].end + 1, 'batches must be contiguous with no gap/overlap');
  }
  const check = assertBatchPlanCoversChapter(batches, n);
  assert.ok(check.ok, `plan should cover chapter: ${JSON.stringify(check)}`);
  assert.deepEqual(check.missing, []);
  assert.ok(check.reachesLast);
}

test('EZK 16 (63 verses) is split into 4 contiguous batches reaching verse 63 (issue #233)', () => {
  const batches = planAlignmentBatches(63);
  assert.deepEqual(
    batches.map((b) => [b.start, b.end]),
    [[1, 16], [17, 32], [33, 48], [49, 63]],
  );
  assertContiguousFullCoverage(batches, 63);
  // The regression signature: the tail must be batched.
  assert.equal(batches[batches.length - 1].end, 63);
});

test('chapters <= 18 verses stay a single batch', () => {
  assert.deepEqual(planAlignmentBatches(18).map((b) => [b.start, b.end]), [[1, 18]]);
  assert.deepEqual(planAlignmentBatches(1).map((b) => [b.start, b.end]), [[1, 1]]);
  assert.deepEqual(planAlignmentBatches(17).map((b) => [b.start, b.end]), [[1, 17]]);
});

test('documented SKILL.md examples produce the documented boundaries', () => {
  // 22 -> 2 batches of 11
  assert.deepEqual(planAlignmentBatches(22).map((b) => [b.start, b.end]), [[1, 11], [12, 22]]);
  // 56 -> 4 batches of 14
  assert.deepEqual(planAlignmentBatches(56).map((b) => [b.start, b.end]), [[1, 14], [15, 28], [29, 42], [43, 56]]);
  // 176 -> 10 batches, last is 163-176
  const b176 = planAlignmentBatches(176);
  assert.equal(b176.length, 10);
  assert.deepEqual(b176[0], { index: 1, start: 1, end: 18 });
  assert.deepEqual(b176[9], { index: 10, start: 163, end: 176 });
});

test('every chapter length 1..200 yields full, contiguous, tail-inclusive coverage', () => {
  for (let n = 1; n <= 200; n += 1) {
    const batches = planAlignmentBatches(n);
    assertContiguousFullCoverage(batches, n);
    // No batch may exceed the 18-verse cap.
    for (const b of batches) {
      assert.ok(b.end - b.start + 1 <= 18, `batch ${b.start}-${b.end} exceeds 18-verse cap for n=${n}`);
    }
  }
});

test('planAlignmentBatches rejects non-positive / non-integer verse counts', () => {
  assert.throws(() => planAlignmentBatches(0), /positive integer/);
  assert.throws(() => planAlignmentBatches(-5), /positive integer/);
  assert.throws(() => planAlignmentBatches('abc'), /positive integer/);
});

test('assertBatchPlanCoversChapter flags the EZK 16 mis-batch (overlap + dropped tail)', () => {
  // The exact boundaries the coordinator produced on 2026-07-21.
  const bad = [[1, 16], [16, 30], [31, 45], [46, 60]].map(([start, end]) => ({ start, end }));
  const check = assertBatchPlanCoversChapter(bad, 63);
  assert.equal(check.ok, false);
  assert.equal(check.reachesLast, false);
  assert.deepEqual(check.missing, [61, 62, 63]);
  assert.ok(check.problems.some((p) => /overlap at verse 16/.test(p)));
  assert.ok(check.problems.some((p) => /last verse 63 not batched/.test(p)));
});

test('assertBatchPlanCoversChapter flags an interior gap', () => {
  const gapped = [[1, 16], [17, 32], [40, 63]].map(([start, end]) => ({ start, end }));
  const check = assertBatchPlanCoversChapter(gapped, 63);
  assert.equal(check.ok, false);
  assert.deepEqual(check.missing, [33, 34, 35, 36, 37, 38, 39]);
  assert.ok(check.problems.some((p) => /gap before verse 40/.test(p)));
});

test('planAlignmentBatchesTool returns a labeled, self-validated plan from verseCount', () => {
  const out = planAlignmentBatchesTool({ book: 'ezk', chapter: 16, verseCount: 63 });
  assert.equal(out.book, 'EZK');
  assert.equal(out.chapter, 16);
  assert.equal(out.verseCount, 63);
  assert.equal(out.numBatches, 4);
  assert.equal(out.singleBatch, false);
  assert.equal(out.coversChapter, true);
  assert.deepEqual(out.problems, []);
  assert.deepEqual(out.batches.map((b) => b.verses), ['1-16', '17-32', '33-48', '49-63']);
});

test('planAlignmentBatchesTool counts verses from a USFM file + chapter', () => {
  const rel = 'data/hebrew_bible/26-EZK.usfm';
  const abs = path.join(TMP, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  // A tiny 3-verse chapter 16 (plus a neighboring chapter to prove scoping).
  fs.writeFileSync(abs, '\\id EZK\n\\c 15\n\\v 1 x\n\\v 2 y\n\\c 16\n\\q1 \\v 1 a\n\\q1 \\v 2 b\n\\q1 \\v 3 c\n\\c 17\n\\v 1 z\n');
  const out = planAlignmentBatchesTool({ book: 'EZK', chapter: 16, file: rel });
  assert.equal(out.verseCount, 3);
  assert.equal(out.numBatches, 1);
  assert.equal(out.singleBatch, true);
  assert.deepEqual(out.batches.map((b) => b.verses), ['1-3']);
});

test('planAlignmentBatchesTool errors when verse count cannot be determined', () => {
  const out = planAlignmentBatchesTool({ book: 'EZK', chapter: 16 });
  assert.match(String(out), /could not determine verse count/);
});
