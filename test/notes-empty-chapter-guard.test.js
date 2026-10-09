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
    const coverage = mod._assessWrittenNoteCoverage('output/notes/JER/JER-32.tsv', { chapter: 32 });
    assert.equal(coverage.ok, false);
    assert.equal(coverage.writtenRows, 0);
    assert.equal(coverage.pointerRows, 58);
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
    const coverage = mod._assessWrittenNoteCoverage('output/notes/JER/JER-32.tsv', { chapter: 32 });
    assert.equal(coverage.ok, true);
    assert.equal(coverage.writtenRows, 4);
    assert.equal(coverage.pointerRows, 2);
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
    const coverage = mod._assessWrittenNoteCoverage(rel, { chapter: 32 });
    assert.equal(coverage.ok, false);
    assert.match(coverage.reason, /0 written notes/);
    assert.equal(coverage.pointerRows, 2);

    // F4: a legitimately pointer-only chapter (no LLM-needed items) passes.
    assert.equal(mod._assessWrittenNoteCoverage(rel, { chapter: 32, expectedWritten: 0 }).ok, true);
    // ... but not when LLM-written notes were expected.
    const expected = mod._assessWrittenNoteCoverage(rel, { chapter: 32, expectedWritten: 6 });
    assert.equal(expected.ok, false);
    assert.match(expected.reason, /6 item\(s\) needed/);

    // F3: one written note passes, and sparse coverage is not flagged.
    fs.appendFileSync(path.join(tempDir, rel), '32:4\tgh78\t\trc://*/ta/man/translate/figs-metaphor\tיָד\t1\tHere **hand** represents power.\n');
    const thin = mod._assessWrittenNoteCoverage(rel, { chapter: 32, expectedWritten: 6 });
    assert.equal(thin.ok, true);
    assert.equal(thin.writtenRows, 1);
    assert.equal(thin.warning, undefined);
    assert.equal(thin.versesWithoutRows, undefined);
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
    const coverage = mod._assessWrittenNoteCoverage(rel, { chapter: 32 });
    assert.equal(coverage.writtenRows, 0);
    assert.equal(coverage.ok, false);
  } finally {
    restore();
  }
}));

test('push guard accepts a book-prefixed Reference column (F5)', withTempDir('push-guard-prefix-', async (tempDir) => {
  const rel = 'output/notes/JER/JER-32.tsv';
  fs.mkdirSync(path.join(tempDir, 'output/notes/JER'), { recursive: true });
  fs.writeFileSync(path.join(tempDir, rel), [
    HEADER,
    'JER 32:intro\tab12\t\t\t\t\t# Jeremiah 32 General Notes',
    'JER 32:1\tcd34\t\trc://*/ta/man/translate/figs-idiom\tהַדָּבָר\t1\tHere **word** means the message.',
    'JER 33:1\tzz99\t\t\t\t1\tWrong chapter note.',
  ].join('\n') + '\n');
  const { mod, restore } = loadPipeline(tempDir);
  try {
    const coverage = mod._assessWrittenNoteCoverage(rel, { chapter: 32 });
    assert.equal(coverage.writtenRows, 1);
    assert.equal(coverage.verseRows, 1);
    assert.equal(coverage.ok, true);
  } finally {
    restore();
  }
}));

test('countExpectedWrittenNotes counts only LLM-needed items, within the verse range', withTempDir('expected-written-', async (tempDir) => {
  const pipeDir = writePipeDir(tempDir, makeItems({ pointers: 3, written: 3 })); // pointers 32:1-3, written 32:4-6
  const { mod, restore } = loadPipeline(tempDir);
  try {
    assert.equal(mod._countExpectedWrittenNotes(pipeDir), 3);
    assert.equal(mod._countExpectedWrittenNotes(pipeDir, { verseStart: 1, verseEnd: 3 }), 0);
    assert.equal(mod._countExpectedWrittenNotes(pipeDir, { verseStart: 5, verseEnd: 6 }), 2);
    assert.equal(mod._countExpectedWrittenNotes('tmp/does-not-exist'), null);
  } finally {
    restore();
  }
}));

test('AT generation leaves the written TSV alone when the generated notes JSON is gone (F1)', withTempDir('at-stale-', async (tempDir) => {
  const pipeDir = writePipeDir(tempDir, makeItems({ pointers: 1, written: 2 }));
  const rel = 'output/notes/JER/JER-32.tsv';
  fs.mkdirSync(path.join(tempDir, 'output/notes/JER'), { recursive: true });
  const claudeTsv = `${HEADER}\n32:4\tw1\t\t\tדָּבָר\t1\tClaude-written note. Alternate translation: [x]\n`;
  fs.writeFileSync(path.join(tempDir, rel), claudeTsv);
  const genRel = `${pipeDir}/generated_notes.json`;
  // Stale output of a failed per-note run: failed items are absent/empty.
  fs.writeFileSync(path.join(tempDir, genRel), JSON.stringify({ p1: 'See how you translated this.' }));
  const { mod, restore } = loadPipeline(tempDir);
  try {
    mod._discardGeneratedNotes(pipeDir);
    assert.equal(fs.existsSync(path.join(tempDir, genRel)), false);
    const summary = await mod._runATGeneration({ notesPath: rel, pipeDir, status: async () => {} });
    assert.match(summary, /0 ATs needed/);
    assert.equal(fs.readFileSync(path.join(tempDir, rel), 'utf8'), claudeTsv);

    // An empty "{}" (what mechanical prep writes) is treated the same way.
    fs.writeFileSync(path.join(tempDir, genRel), '{}');
    await mod._runATGeneration({ notesPath: rel, pipeDir, status: async () => {} });
    assert.equal(fs.readFileSync(path.join(tempDir, rel), 'utf8'), claudeTsv);
  } finally {
    restore();
  }
}));

test('push pre-flight restores a missing source from .bak before the content guard runs (F2)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/notes-pipeline.js'), 'utf8');
  const restoreAt = src.indexOf('Restore a wiped source from its .bak first');
  const guardAt = src.indexOf('assessWrittenNoteCoverage(notesSource');
  assert.ok(restoreAt > 0 && guardAt > 0);
  assert.ok(restoreAt < guardAt, 'restore from .bak must come before the content guard');
  assert.match(src.slice(restoreAt, guardAt), /copyFileSync\(srcAbs \+ '\.bak', srcAbs\)/);
});
