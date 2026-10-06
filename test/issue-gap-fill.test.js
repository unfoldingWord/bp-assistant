const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SRC_DIR = path.resolve(__dirname, '../src') + path.sep;

// CSKILLBP_DIR is a load-time constant in pipeline-utils, so point it at a temp
// workspace and reload every src module.
function fresh(workspaceDir) {
  process.env.CSKILLBP_DIR = workspaceDir;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(SRC_DIR)) delete require.cache[key];
  }
  return require('../src/notes-pipeline');
}

const ULT = [
  '\\id EZK', '\\c 40',
  '\\p', '\\v 1 In the year', '\\v 2 In visions', '\\v 3 He brought me',
  '\\v 4 The man said', '\\v 5 There was a wall', '\\v 6-7 He went',
  '\\v 8 He measured', '', '\\v 9 Then he came',
].join('\n');

const row = (ref, sref, q, expl) => `EZK\t${ref}\t${sref}\t${q}\t\t\t${expl}`;
const HEADERLESS = [
  row('40:intro', 'figs-intro', '', 'intro'),
  row('40:1', 'figs-metaphor', 'year', 'a'),
  row('40:2', 'figs-metaphor', 'visions', 'b'),
  row('40:3', 'figs-metaphor', 'brought', 'c'),
  row('40:5', 'figs-metaphor', 'wall', 'd'),
  row('40:6-7', 'figs-metaphor', 'went', 'e'),
  row('41:4', 'figs-metaphor', 'other chapter', 'f'),
].join('\n') + '\n';

test('findEmptyVerses: bridges, intro rows, other chapters (headerless)', () => {
  const { _findEmptyVerses } = fresh(fs.mkdtempSync(path.join(os.tmpdir(), 'gap-')));
  // 4, 8, 9 empty: 6-7 bridge covers 6 and 7; 41:4 must not cover 40:4
  assert.deepEqual(_findEmptyVerses({ issuesText: HEADERLESS, ultPlainText: ULT, chapter: 40 }), [4, 8, 9]);
});

test('findEmptyVerses: headered file', () => {
  const { _findEmptyVerses } = fresh(fs.mkdtempSync(path.join(os.tmpdir(), 'gap-')));
  const text = [
    'Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote',
    '40:1\ta\t\tfigs-metaphor\tyear\t1\tx',
    '40:4-5\tb\t\tfigs-metaphor\tman\t1\ty',
  ].join('\n');
  assert.deepEqual(_findEmptyVerses({ issuesText: text, ultPlainText: ULT, chapter: 40 }), [2, 3, 6, 8, 9]);
});

test('findEmptyVerses: empty ULT yields no gaps', () => {
  const { _findEmptyVerses } = fresh(fs.mkdtempSync(path.join(os.tmpdir(), 'gap-')));
  assert.deepEqual(_findEmptyVerses({ issuesText: HEADERLESS, ultPlainText: '', chapter: 40 }), []);
  assert.deepEqual(_findEmptyVerses({ issuesText: HEADERLESS, ultPlainText: ULT, chapter: 39 }), []);
});

test('mergeGapIssues: verse order, existing order kept, non-gap shard rows dropped', () => {
  const { _mergeGapIssues } = fresh(fs.mkdtempSync(path.join(os.tmpdir(), 'gap-')));
  const shard = [
    row('40:8', 'figs-idiom', 'measured', 'new8'),
    row('40:5', 'figs-idiom', 'wall', 'not a gap verse'),
    row('40:4', 'figs-idiom', 'said', 'new4'),
    row('40:8', 'figs-idiom', 'measured2', 'new8b'),
    row('41:8', 'figs-idiom', 'x', 'other chapter'),
  ].join('\n') + '\n';
  const res = _mergeGapIssues({ chapterText: HEADERLESS, shardText: shard, verses: [4, 8, 9], chapter: 40 });
  assert.equal(res.added, 3);
  const lines = res.text.split('\n');
  assert.equal(lines[0], row('40:intro', 'figs-intro', '', 'intro'));
  const expl = lines.filter(Boolean).map((l) => l.split('\t')[6]);
  assert.deepEqual(expl, ['intro', 'a', 'b', 'c', 'new4', 'd', 'e', 'new8', 'new8b', 'f']);
  assert.ok(res.text.endsWith('\n'));
});

test('mergeGapIssues: headered CRLF file keeps header and line endings', () => {
  const { _mergeGapIssues } = fresh(fs.mkdtempSync(path.join(os.tmpdir(), 'gap-')));
  const head = 'Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote';
  const chapter = [head, '40:1\ta\t\tfigs-metaphor\tyear\t1\tx', '40:9\tb\t\tfigs-metaphor\tthen\t1\ty'].join('\r\n') + '\r\n';
  const shard = [head, '40:3\tc\t\tfigs-idiom\tbrought\t1\tz'].join('\n');
  const res = _mergeGapIssues({ chapterText: chapter, shardText: shard, verses: [3], chapter: 40 });
  assert.equal(res.added, 1);
  assert.equal(res.text, [head, '40:1\ta\t\tfigs-metaphor\tyear\t1\tx', '40:3\tc\t\tfigs-idiom\tbrought\t1\tz', '40:9\tb\t\tfigs-metaphor\tthen\t1\ty'].join('\r\n') + '\r\n');
});

// Workspace with a chapter issues file and ULT plain file.
async function ws(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gap-fill-'));
  const mod = fresh(dir);
  const pipeDir = 'tmp/pipeline/EZK-40';
  fs.mkdirSync(path.join(dir, pipeDir), { recursive: true });
  fs.mkdirSync(path.join(dir, 'output/issues/EZK'), { recursive: true });
  fs.writeFileSync(path.join(dir, pipeDir, 'ult_chapter_plain.usfm'), ULT);
  const issuesPath = 'output/issues/EZK/EZK-40.tsv';
  const write = (t) => fs.writeFileSync(path.join(dir, issuesPath), t);
  const read = () => fs.readFileSync(path.join(dir, issuesPath), 'utf8');
  write(HEADERLESS);
  const messages = [];
  const base = {
    book: 'EZK', ch: 40, issuesPath, contextPath: null, ctxFlag: '',
    ultPlainPath: `${pipeDir}/ult_chapter_plain.usfm`, pipeDir, model: 'm',
    status: async (m) => { messages.push(m); }, recordMetricsImpl() {},
  };
  await fn({ dir, mod, base, write, read, messages, pipeDir });
}

test('fillIssueGaps does nothing for 0 or 1 empty verse', async () => {
  await ws(async ({ mod, base, write, read }) => {
    let calls = 0;
    const runClaudeImpl = async () => { calls++; return { subtype: 'success' }; };
    // 0 empty: cover 4, 8, 9
    const full = HEADERLESS + [row('40:4', 'a', 'q', 'x'), row('40:8', 'a', 'q', 'x'), row('40:9', 'a', 'q', 'x')].join('\n') + '\n';
    write(full);
    await mod._fillIssueGaps({ ...base, runClaudeImpl });
    // 1 empty: only 9 missing
    const one = HEADERLESS + [row('40:4', 'a', 'q', 'x'), row('40:8', 'a', 'q', 'x')].join('\n') + '\n';
    write(one);
    const res = await mod._fillIssueGaps({ ...base, runClaudeImpl });
    assert.equal(calls, 0);
    assert.equal(read(), one);
    assert.deepEqual(res.empty, [9]);
  });
});

test('fillIssueGaps runs once over min-max, merges, moves the shard out', async () => {
  await ws(async ({ dir, mod, base, read, messages }) => {
    const prompts = [];
    const runClaudeImpl = async (opts) => {
      prompts.push(opts);
      const shardAbs = path.join(dir, 'output/issues/EZK/EZK-40-v4-9.tsv');
      assert.ok(fs.existsSync(shardAbs), 'stub pre-created');
      fs.writeFileSync(shardAbs, [
        row('40:4', 'figs-idiom', 'said', 'new4'),
        row('40:5', 'figs-idiom', 'wall', 'ignored, 5 already covered'),
        row('40:9', 'figs-idiom', 'then', 'new9'),
      ].join('\n') + '\n');
      return { subtype: 'success' };
    };
    const res = await mod._fillIssueGaps({ ...base, runClaudeImpl });
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].prompt, 'EZK 40 --verses 4-9');
    assert.equal(prompts[0].thinking, 'xhigh');
    assert.equal(prompts[0].mcpToolSet, 'issue-id');
    assert.equal(res.added, 2);
    assert.deepEqual(res.remaining, [8]);
    const expl = read().split('\n').filter(Boolean).map((l) => l.split('\t')[6]);
    assert.deepEqual(expl, ['intro', 'a', 'b', 'c', 'new4', 'd', 'e', 'new9', 'f']);
    assert.equal(fs.existsSync(path.join(dir, 'output/issues/EZK/EZK-40-v4-9.tsv')), false);
    assert.ok(fs.existsSync(path.join(dir, 'tmp/pipeline/EZK-40/gapfill-v4-9.tsv')));
    assert.ok(messages.some((m) => /added 2 row/.test(m) && /8/.test(m)));
  });
});

test('fillIssueGaps: thrown or non-success run leaves issues unchanged and does not throw', async () => {
  await ws(async ({ mod, base, read }) => {
    const before = read();
    let res = await mod._fillIssueGaps({ ...base, runClaudeImpl: async () => { throw new Error('boom'); } });
    assert.equal(read(), before);
    assert.equal(res.pause, null);
    assert.equal(res.added, 0);
    res = await mod._fillIssueGaps({ ...base, runClaudeImpl: async () => ({ subtype: 'error_max_turns' }) });
    assert.equal(read(), before);
    assert.equal(res.added, 0);
    // success but zero rows
    res = await mod._fillIssueGaps({ ...base, runClaudeImpl: async () => ({ subtype: 'success' }) });
    assert.equal(read(), before);
    assert.equal(res.added, 0);
  });
});

test('fillIssueGaps: usage limit is reported as a pause', async () => {
  await ws(async ({ mod, base, read }) => {
    const before = read();
    const res = await mod._fillIssueGaps({
      ...base,
      runClaudeImpl: async () => { throw new Error("You've hit your usage limit"); },
    });
    assert.equal(read(), before);
    assert.equal(res.pause, 'usage_limit');
  });
});

test('mergeGapIssues: a bridge row touching a covered verse is dropped', () => {
  const { _mergeGapIssues } = fresh(fs.mkdtempSync(path.join(os.tmpdir(), 'gap-')));
  const shard = [row('40:8-9', 'figs-idiom', 'both', 'bridge ok'), row('40:4-5', 'figs-idiom', 'x', 'bridge touches 5')].join('\n') + '\n';
  const res = _mergeGapIssues({ chapterText: HEADERLESS, shardText: shard, verses: [4, 8, 9], chapter: 40 });
  assert.equal(res.added, 1);
  assert.match(res.text, /bridge ok/);
  assert.doesNotMatch(res.text, /bridge touches 5/);
});

const STUB = 'output/issues/EZK/EZK-40-v4-9.tsv';
const MARKER = 'tmp/pipeline/EZK-40/gapfill-done.json';

test('stub never remains in output/issues after throw, non-success, pause, or success; marker only on non-pause', async () => {
  await ws(async ({ dir, mod, base, messages }) => {
    const cases = [
      ['throw', async () => { throw new Error('boom'); }, false],
      ['non-success', async () => ({ subtype: 'error_max_turns' }), false],
      ['pause', async () => { throw new Error("You've hit your usage limit"); }, true],
      ['success', async (o) => {
        fs.writeFileSync(path.join(dir, STUB), row('40:4', 'a', 'q', 'new4') + '\n');
        return { subtype: 'success' };
      }, false],
    ];
    for (const [name, runClaudeImpl, isPause] of cases) {
      try { fs.unlinkSync(path.join(dir, MARKER)); } catch (_) { /* none */ }
      messages.length = 0;
      await mod._fillIssueGaps({ ...base, runClaudeImpl });
      assert.equal(fs.existsSync(path.join(dir, STUB)), false, `${name}: stub removed`);
      assert.equal(fs.existsSync(path.join(dir, MARKER)), !isPause, `${name}: marker`);
      if (isPause) assert.ok(!messages.some((m) => /continuing with the original/.test(m)), 'pause posts no continuing status');
      else if (name !== 'success') assert.ok(messages.some((m) => /continuing with the original/.test(m)));
      // reset issues file for the next case
      fs.writeFileSync(path.join(dir, 'output/issues/EZK/EZK-40.tsv'), HEADERLESS);
    }
  });
});

test('pre-existing non-empty shard is restored after the run', async () => {
  await ws(async ({ dir, mod, base }) => {
    fs.writeFileSync(path.join(dir, STUB), 'someone else\n');
    await mod._fillIssueGaps({ ...base, runClaudeImpl: async () => ({ subtype: 'success' }) });
    assert.equal(fs.readFileSync(path.join(dir, STUB), 'utf8'), 'someone else\n');
    assert.ok(fs.existsSync(path.join(dir, 'tmp/pipeline/EZK-40/gapfill-preexisting-v4-9.tsv')));
  });
});

test('missing ULT verse list posts one skipped warning', async () => {
  await ws(async ({ mod, base, messages }) => {
    let calls = 0;
    await mod._fillIssueGaps({ ...base, ultPlainPath: 'tmp/nope.usfm', runClaudeImpl: async () => { calls++; return {}; } });
    assert.equal(calls, 0);
    assert.equal(messages.filter((m) => /no ULT verse list/.test(m)).length, 1);
  });
});
