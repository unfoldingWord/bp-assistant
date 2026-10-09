// #415 — JER 32 shipped with only "See how" pointer rows because every
// per-note LLM call failed but runPerNoteGeneration's result was still
// treated as success. These tests pin the two guards added for it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HEADER = 'Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote';

function loadPipeline(tempDir, runClaudeStub) {
  process.env.CSKILLBP_DIR = tempDir;
  const paths = ['../src/notes-pipeline', '../src/pipeline-utils', '../src/workspace-tools/tn-tools', '../src/pipeline-context']
    .map((p) => require.resolve(p));
  for (const p of paths) delete require.cache[p];
  const runner = require('../src/claude-runner');
  const original = runner.runClaude;
  if (runClaudeStub) runner.runClaude = runClaudeStub;
  const mod = require('../src/notes-pipeline');
  return {
    mod,
    restore() {
      runner.runClaude = original;
      for (const p of paths) delete require.cache[p];
    },
  };
}

function withTempDir(prefix, fn) {
  return async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const oldBaseDir = process.env.CSKILLBP_DIR;
    try {
      await fn(tempDir);
    } finally {
      if (oldBaseDir == null) delete process.env.CSKILLBP_DIR;
      else process.env.CSKILLBP_DIR = oldBaseDir;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  };
}

function writePipeDir(tempDir, items) {
  const pipeDir = 'tmp/pipeline-JER-32';
  const abs = path.join(tempDir, pipeDir);
  fs.mkdirSync(abs, { recursive: true });
  const runtime = {
    preparedNotes: `${pipeDir}/prepared_notes.json`,
    generatedNotes: `${pipeDir}/generated_notes.json`,
  };
  fs.writeFileSync(path.join(abs, 'context.json'), JSON.stringify({ runtime }));
  fs.writeFileSync(path.join(tempDir, runtime.preparedNotes), JSON.stringify({ chapter: 32, items }));
  return pipeDir;
}

function makeItems({ pointers, written }) {
  const items = [];
  for (let i = 1; i <= pointers; i++) {
    items.push({
      id: `p${i}`, reference: `32:${i}`, sref: 'figs-metaphor', gl_quote: 'hand', orig_quote: 'יָד',
      programmatic_note: `See how you translated the similar expression in [31:${i}](../31/${i}.md).`,
    });
  }
  for (let i = 1; i <= written; i++) {
    items.push({ id: `w${i}`, reference: `32:${pointers + i}`, sref: 'figs-idiom', gl_quote: 'word', orig_quote: 'דָּבָר' });
  }
  return items;
}

test('runPerNoteGeneration reports failure when every LLM call throws, even with many pointers', withTempDir('per-note-fail-', async (tempDir) => {
  const pipeDir = writePipeDir(tempDir, makeItems({ pointers: 58, written: 6 }));
  const { mod, restore } = loadPipeline(tempDir, async () => { throw new Error('simulated API outage'); });
  try {
    const result = await mod._runPerNoteGeneration({
      pipeDir, outputPath: 'output/notes/JER/JER-32.tsv', status: async () => {}, book: 'JER',
    });
    // Old rule (failed < items * 0.1 → 6 < 6.4) called this a success.
    assert.equal(result.success, false);
    assert.equal(result.failed, 6);
    assert.equal(result.llmItems, 6);
    assert.deepEqual(result.failureReasons, ['simulated API outage']);

    // The assembled TSV is pointer-only, and the push guard refuses it.
    const coverage = mod._assessWrittenNoteCoverage('output/notes/JER/JER-32.tsv', { chapter: 32, verseCount: 64 });
    assert.equal(coverage.ok, false);
    assert.equal(coverage.writtenRows, 0);
    assert.equal(coverage.pointerRows, 58);
    assert.deepEqual(coverage.versesWithoutRows, [59, 60, 61, 62, 63, 64]);
  } finally {
    restore();
  }
}));

test('runPerNoteGeneration still succeeds when LLM calls succeed', withTempDir('per-note-ok-', async (tempDir) => {
  const pipeDir = writePipeDir(tempDir, makeItems({ pointers: 2, written: 4 }));
  const { mod, restore } = loadPipeline(tempDir, async () => ({ result: 'The speaker uses an idiom here.' }));
  try {
    const result = await mod._runPerNoteGeneration({
      pipeDir, outputPath: 'output/notes/JER/JER-32.tsv', status: async () => {}, book: 'JER',
    });
    assert.equal(result.success, true);
    assert.equal(result.failed, 0);
    const coverage = mod._assessWrittenNoteCoverage('output/notes/JER/JER-32.tsv', { chapter: 32, verseCount: 6 });
    assert.equal(coverage.ok, true);
    assert.equal(coverage.writtenRows, 4);
    assert.equal(coverage.pointerRows, 2);
    assert.equal(coverage.warning, '');
  } finally {
    restore();
  }
}));

test('push guard rejects a chapter TSV containing only "See how" rows', withTempDir('push-guard-', async (tempDir) => {
  const rel = 'output/notes/JER/JER-32.tsv';
  fs.mkdirSync(path.join(tempDir, 'output/notes/JER'), { recursive: true });
  fs.writeFileSync(path.join(tempDir, rel), [
    HEADER,
    '32:intro\tab12\t\t\t\t\t# Jeremiah 32 General Notes',
    '32:1\tcd34\t\trc://*/ta/man/translate/figs-idiom\tהַדָּבָר\t1\tSee how you translated the similar expression in [21:1](../21/01.md).',
    '32:2-3\tef56\t\t\tמֶלֶךְ\t1\tSee how you translated **king** in [1:2](../01/02.md).',
  ].join('\n') + '\n');
  const { mod, restore } = loadPipeline(tempDir);
  try {
    const coverage = mod._assessWrittenNoteCoverage(rel, { chapter: 32, verseCount: 5 });
    assert.equal(coverage.ok, false);
    assert.match(coverage.reason, /0 written notes/);
    assert.equal(coverage.pointerRows, 2);
    assert.deepEqual(coverage.versesWithoutRows, [4, 5]);

    // One written note flips it to ok, but thin coverage is flagged.
    fs.appendFileSync(path.join(tempDir, rel), '32:4\tgh78\t\trc://*/ta/man/translate/figs-metaphor\tיָד\t1\tHere **hand** represents power.\n');
    const thin = mod._assessWrittenNoteCoverage(rel, { chapter: 32, verseCount: 5 });
    assert.equal(thin.ok, true);
    assert.equal(thin.writtenRows, 1);
    assert.match(thin.warning, /only 1 written note/);
    assert.deepEqual(thin.versesWithoutRows, [5]);

    // Verse-range runs measure coverage only within the range.
    const ranged = mod._assessWrittenNoteCoverage(rel, { chapter: 32, verseStart: 3, verseEnd: 4 });
    assert.deepEqual(ranged.versesWithoutRows, []);
  } finally {
    restore();
  }
}));

test('push guard does not count a blank Note cell as a written note', withTempDir('push-guard-blank-', async (tempDir) => {
  const rel = 'output/notes/JER/JER-32.tsv';
  fs.mkdirSync(path.join(tempDir, 'output/notes/JER'), { recursive: true });
  fs.writeFileSync(path.join(tempDir, rel), [
    HEADER,
    '32:1\tcd34\t\trc://*/ta/man/translate/figs-idiom\tהַדָּבָר\t1\t',
  ].join('\n') + '\n');
  const { mod, restore } = loadPipeline(tempDir);
  try {
    const coverage = mod._assessWrittenNoteCoverage(rel, { chapter: 32, verseCount: 1 });
    assert.equal(coverage.writtenRows, 0);
    assert.equal(coverage.ok, false);
  } finally {
    restore();
  }
}));
