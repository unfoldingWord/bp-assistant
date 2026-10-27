// #485 — a "This could mean" note short of per-option ATs gets one writer
// retry in the AT stage instead of a single generic AT appended at the end.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NOTES_REL = 'output/notes/JOB/JOB-09.tsv';
const PIPE_DIR = 'tmp/pipeline-JOB-9';

const FULL = 'This could mean: (1) God is wise. Alternate translation: [God is wise] or (2) God is powerful. Alternate translation: [God is strong]';
const NONE = 'This could mean: (1) God is wise or (2) God is powerful.';
const PARTIAL = 'This could mean: (1) God is wise. Alternate translation: [God is wise] or (2) God is powerful.';

function loadPipeline(tempDir, runClaudeStub) {
  process.env.CSKILLBP_DIR = tempDir;
  // Several src modules capture CSKILLBP_DIR at load time, so drop them all.
  const srcDir = path.join(__dirname, '..', 'src') + path.sep;
  const clear = () => {
    for (const p of Object.keys(require.cache)) if (p.startsWith(srcDir)) delete require.cache[p];
  };
  clear();
  const runner = require('../src/claude-runner');
  runner.runClaude = runClaudeStub;
  const mod = require('../src/notes-pipeline');
  return { mod, restore: clear };
}

function withTempDir(fn) {
  return async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcm-repair-'));
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

function setup(tempDir, note) {
  const abs = path.join(tempDir, PIPE_DIR);
  fs.mkdirSync(abs, { recursive: true });
  const runtime = {
    preparedNotes: `${PIPE_DIR}/prepared_notes.json`,
    generatedNotes: `${PIPE_DIR}/generated_notes.json`,
  };
  fs.writeFileSync(path.join(abs, 'context.json'), JSON.stringify({ runtime, sources: {} }));
  const item = {
    id: 't1', reference: '9:4', sref: 'figs-abstractnouns', gl_quote: 'wise in heart', orig_quote: 'חֲכַם לֵבָב',
    ult_verse: 'He is wise in heart and mighty in strength.', tcm_mode: true,
    writer_packet: { tcm_mode: true, tcm_instruction: 'Write one AT per option.' },
  };
  fs.writeFileSync(path.join(tempDir, runtime.preparedNotes), JSON.stringify({ book: 'JOB', chapter: 9, items: [item] }));
  fs.writeFileSync(path.join(tempDir, runtime.generatedNotes), JSON.stringify({ t1: note }));
  return runtime;
}

function readNote(tempDir, runtime) {
  return JSON.parse(fs.readFileSync(path.join(tempDir, runtime.generatedNotes), 'utf8')).t1;
}

function stub(retryText) {
  const calls = [];
  const fn = async (opts) => {
    calls.push(opts.label);
    if (/TCM-retry/.test(opts.label)) return { result: retryText };
    if (/AT-gen/.test(opts.label)) return { result: 'God is wise' };
    if (/AT-val/.test(opts.label)) return { result: 'YES' };
    return { result: '' };
  };
  return { fn, calls };
}

for (const [label, note] of [['0 ATs', NONE], ['1 AT', PARTIAL]]) {
  test(`TCM note with 2 options and ${label} gets a writer retry, not a single appended AT`, withTempDir(async (tempDir) => {
    const runtime = setup(tempDir, note);
    const { fn, calls } = stub(FULL);
    const { mod, restore } = loadPipeline(tempDir, fn);
    try {
      const summary = await mod._runATGeneration({ notesPath: NOTES_REL, pipeDir: PIPE_DIR, status: async () => {} });
      assert.equal(calls.filter((c) => /TCM-retry/.test(c)).length, 1);
      assert.equal(calls.filter((c) => /AT-gen/.test(c)).length, 0, 'repaired note needs no appended AT');
      assert.equal(readNote(tempDir, runtime), FULL);
      assert.match(summary, /1\/1 TCM notes re-written/);
      // The assembled TSV carries the repaired note.
      assert.ok(fs.readFileSync(path.join(tempDir, NOTES_REL), 'utf8').includes(FULL));
    } finally {
      restore();
    }
  }));
}

test('well-formed TCM note (2 options, 2 ATs) is left alone', withTempDir(async (tempDir) => {
  const runtime = setup(tempDir, FULL);
  const { fn, calls } = stub(FULL);
  const { mod, restore } = loadPipeline(tempDir, fn);
  try {
    const summary = await mod._runATGeneration({ notesPath: NOTES_REL, pipeDir: PIPE_DIR, status: async () => {} });
    assert.deepEqual(calls, []);
    assert.equal(readNote(tempDir, runtime), FULL);
    assert.equal(summary, '0 ATs needed');
  } finally {
    restore();
  }
}));

test('a retry still short of ATs is discarded; a 0-AT note falls back to the single-AT append', withTempDir(async (tempDir) => {
  const runtime = setup(tempDir, NONE);
  const { fn, calls } = stub(PARTIAL);
  const { mod, restore } = loadPipeline(tempDir, fn);
  try {
    await mod._runATGeneration({ notesPath: NOTES_REL, pipeDir: PIPE_DIR, status: async () => {} });
    assert.equal(calls.filter((c) => /TCM-retry/.test(c)).length, 1);
    assert.equal(calls.filter((c) => /AT-gen/.test(c)).length, 1);
    assert.equal(readNote(tempDir, runtime), `${NONE} Alternate translation: [God is wise]`);
  } finally {
    restore();
  }
}));

test('a partial-AT note whose retry fails keeps its original text', withTempDir(async (tempDir) => {
  const runtime = setup(tempDir, PARTIAL);
  const { fn, calls } = stub('');
  const { mod, restore } = loadPipeline(tempDir, fn);
  try {
    await mod._runATGeneration({ notesPath: NOTES_REL, pipeDir: PIPE_DIR, status: async () => {} });
    assert.equal(calls.filter((c) => /TCM-retry/.test(c)).length, 1);
    assert.equal(calls.filter((c) => /AT-gen/.test(c)).length, 0);
    assert.equal(readNote(tempDir, runtime), PARTIAL);
  } finally {
    restore();
  }
}));
