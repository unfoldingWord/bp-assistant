// Issue rules gate: editor-kept notes in the prompt and KEPT drops (#446).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SRC_DIR = path.resolve(__dirname, '../src') + path.sep;

function freshModule(workspaceDir) {
  process.env.CSKILLBP_DIR = workspaceDir;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(SRC_DIR)) delete require.cache[key];
  }
  const trackerPath = require.resolve('../src/usage-tracker');
  require.cache[trackerPath] = { id: trackerPath, filename: trackerPath, loaded: true, exports: { recordMetrics() {} } };
  return require('../src/issue-rules-gate');
}

const CATALOG = [
  'issue,last_updated',
  ...['figs-metaphor', 'figs-metonymy', 'figs-idiom', 'figs-explicit', 'figs-possession', 'figs-ellipsis',
    'figs-parallelism', 'figs-activepassive', 'writing-pronouns'].map((s) => `${s},2026-01-01`),
].join('\n') + '\n';

const G_RULES = '- **G4 Keep this active rule**\n';

const ULT = [
  '\\c 3',
  '\\v 1 And the king said to the people a word.',
  '\\v 2 The people heard the word of the LORD.',
  '\\v 3 He went out to the city and the gate.',
  '\\v 4 They kept the covenant of the LORD.',
  '\\v 5 Peace be upon the house of the king.',
].join('\n') + '\n';

const LINES = [
  /* 0 */ 'Book\tReference\tSRef\tGLQuote\t\t\tExplanation',
  /* 1 */ 'JER\t3:intro\t\t\t\t\t# chapter introduction',
  /* 2 */ '',
  /* 3 */ 'JER\t3:1\tfigs-metaphor\tthe king\t\t\tking = Yahweh',
  /* 4 */ 'JER\t3:2\tfigs-idiom\tthe word of the LORD\t\t\tidiom here',
  /* 5 */ 'JER\t3:2\tfigs-parallelism\tthe word\t\t\tparallel lines',
  /* 6 */ 'JER\t3:3\tfigs-explicit\tto the city and the gate\t\t\tcity of Jerusalem',
  /* 7 */ 'JER\t3:3\tfigs-possession\tthe gate\t\t\tgate of the city',
  /* 8 */ 'JER\t3:4\tfigs-metonymy\tthe covenant\t\t\tcovenant = promise',
  /* 9 */ 'JER\t3:4\tfigs-activepassive\tkept\t\t\tagent is the people',
  /* 10 */ 'JER\t3:5\tfigs-explicit\tthe house of the king\t\t\thouse = family',
  /* 11 */ 'JER\t3:5\twriting-pronouns\tthe king\t\t\tking = Yahweh',
];
const FILE_TEXT = LINES.join('\n') + '\n';

const KEPT = [
  { rowId: 'hk52', ref: '3:3', supportReference: 'rc://*/ta/man/translate/figs-explicit', quote: 'הָעִיר', note: 'The city is Jerusalem. Alternate translation: “to Jerusalem”' },
  { rowId: 'k35a', ref: '3:4-5', supportReference: 'figs-metonymy', quote: 'בֵּית הַמֶּלֶךְ', note: 'House means family.' },
  { rowId: 'k99z', ref: '3:9', supportReference: 'figs-idiom', quote: 'x', note: 'Not in this list.' },
  { rowId: 'kint', ref: '3:intro', supportReference: '', quote: '', note: 'Intro.' },
];

const DEFAULTS = { rulesGate: { mode: 'apply', books: 'all' } };

async function ws(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-gate-kept-'));
  const oldDir = process.env.CSKILLBP_DIR;
  try {
    fs.mkdirSync(path.join(dir, '.claude/skills/issue-identification'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude/skills/issue-identification/rules-gate.md'), G_RULES);
    fs.mkdirSync(path.join(dir, 'data/quick-ref'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'data/quick-ref/issue_decisions.csv'), 'Phrase,IssueType,Book,Context,Notes\n');
    fs.writeFileSync(path.join(dir, 'data/translation-issues.csv'), CATALOG);
    fs.writeFileSync(path.join(dir, 'ult.usfm'), ULT);
    fs.mkdirSync(path.join(dir, 'output/issues'), { recursive: true });
    const abs = path.join(dir, 'output/issues/JER-03.tsv');
    fs.writeFileSync(abs, FILE_TEXT);
    const mod = freshModule(dir);
    const ctx = { sources: { ultPlain: 'ult.usfm' } };
    const run = (extra = {}) => mod.runIssueRulesGate({
      issuesPath: 'output/issues/JER-03.tsv', book: 'JER', chapter: 3, ctx, hints: null,
      config: DEFAULTS, env: {}, dryRun: false, model: 'test-model', status: async () => {}, ...extra,
    });
    const sidecar = () => JSON.parse(fs.readFileSync(path.join(dir, 'output/review/JER/JER-03-rules-gate.json'), 'utf8'));
    return await fn({ dir, mod, run, abs, sidecar, read: () => fs.readFileSync(abs, 'utf8'), reset: () => fs.writeFileSync(abs, FILE_TEXT) });
  } finally {
    if (oldDir === undefined) delete process.env.CSKILLBP_DIR; else process.env.CSKILLBP_DIR = oldDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function fakeRunner({ overrides = {} } = {}) {
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    const indexes = [...args.prompt.matchAll(/^#(\d+) (?!\[protected\])/gm)].map((m) => Number(m[1]));
    const verdicts = indexes.map((i) => ({ row: i, action: 'keep', reason: 'fine', rule: null, ...(overrides[i] || {}) }));
    return { subtype: 'success', result: { text: JSON.stringify({ verdicts, adds: [] }) }, usage: { input_tokens: 1, output_tokens: 1 } };
  };
  fn.calls = calls;
  return fn;
}

const keptDrop = (id, reason = 'same point as the kept note') => ({ action: 'drop', rule: 'KEPT', kept: id, reason });

test('the prompt lists kept notes on the chunk verses only, with id, sref, quote and a 300-char note', async () => {
  await ws(async ({ run }) => {
    const longNote = 'n'.repeat(400);
    const kept = [...KEPT, { rowId: 'long', ref: '3:1', supportReference: 'figs-metaphor', quote: 'הַמֶּלֶךְ', note: longNote }];
    const runner = fakeRunner();
    await run({ runClaudeImpl: runner, kept });
    const p = runner.calls[0].prompt;
    assert.match(p, /^KEPT NOTES \(already in en_tn; a translator wrote or approved these; never write a second note on the same issue\)/m);
    assert.match(p, /^\[hk52\] 3:3 \| figs-explicit \| הָעִיר \| The city is Jerusalem\./m);
    assert.match(p, /^\[k35a\] 3:4-5 \| figs-metonymy \| בֵּית הַמֶּלֶךְ \| House means family\.$/m);
    assert.ok(p.includes(`[long] 3:1 | figs-metaphor | הַמֶּלֶךְ | ${'n'.repeat(300)}\n`));
    assert.ok(!p.includes('n'.repeat(301)));
    assert.ok(!p.includes('k99z'), 'a kept note on a verse outside the chunk is not listed');
    assert.ok(!p.includes('kint'), 'an intro kept note is not listed');
    assert.match(p, /"kept":"<kept note id, KEPT drops only>"/);
    assert.match(p, /When unsure, keep the row\./);
  });
});

test('(a)(b)(e) KEPT drops apply without a G-rule and outside the 25% drop cap', async () => {
  await ws(async ({ run, read, sidecar, dir }) => {
    // Two KEPT drops plus one G-rule drop is 3 of 7 gateable rows (43%), over
    // MAX_DROP_SHARE; only the G-rule drop counts against it (1/7).
    const runner = fakeRunner({
      overrides: {
        6: keptDrop('hk52', 'wider quote, same point'), // (a) same sref, wider quote
        10: keptDrop('k35a', 'metonymy note says the same'), // (b) different overlapping sref
        3: { action: 'drop', rule: 'G4', reason: 'g rule drop' }, // a G-rule drop: 1/7 is within the cap
      },
    });
    const res = await run({ runClaudeImpl: runner, kept: KEPT });
    assert.equal(res.changed, true);
    assert.equal(res.counts.dropped, 3);
    assert.equal(res.keptDropped, 2);
    const out = read();
    assert.ok(!out.includes('to the city and the gate'));
    assert.ok(!out.includes('the house of the king'));
    assert.ok(!out.includes('JER\t3:1\t'));
    assert.match(res.prBody, /^Issue rules check: kept 4, dropped 3 \(2 as duplicates of kept notes\)/);
    assert.match(res.prBody, /^- 3:3 figs-explicit dropped: duplicates kept note hk52 "to the city and the gate" \(wider quote, same point\)$/m);
    assert.match(res.prBody, /^- 3:5 figs-explicit dropped: duplicates kept note k35a/m);
    const report = fs.readFileSync(path.join(dir, res.reportPath), 'utf8');
    assert.match(report, /\| KEPT hk52 \|/);
    assert.equal(sidecar().keptDropped, 2);
    assert.equal(sidecar().keptDropsTotal, 2);
  });
});

test('(e) KEPT drops past 25% of the chapter still apply when kept notes justify them', async () => {
  await ws(async ({ run }) => {
    const runner = fakeRunner({ overrides: { 6: keptDrop('hk52'), 7: keptDrop('hk52'), 10: keptDrop('k35a') } });
    const res = await run({ runClaudeImpl: runner, kept: [...KEPT, { rowId: 'k3b', ref: '3:3', supportReference: 'figs-possession', quote: 'הַשַּׁעַר', note: 'n' }] });
    assert.equal(res.keptDropped, 3, '3 of 7 gateable rows is 43%, over MAX_DROP_SHARE, but within 3 kept notes');
  });
});

test('more KEPT drops than kept notes in the chapter applies none of them', async () => {
  await ws(async ({ run, read }) => {
    const runner = fakeRunner({ overrides: { 6: keptDrop('hk52'), 7: keptDrop('hk52'), 10: keptDrop('k35a') } });
    const res = await run({ runClaudeImpl: runner, kept: KEPT });
    assert.equal(res.keptDropped, 0);
    assert.equal(res.counts.dropped, 0);
    assert.equal(res.counts.declined, 3);
    assert.equal(read(), FILE_TEXT);
  });
});

test('(c) the model keeping a row on the same words as a kept note leaves it', async () => {
  await ws(async ({ run, read }) => {
    const res = await run({ runClaudeImpl: fakeRunner(), kept: KEPT });
    assert.equal(res.changed, false);
    assert.equal(res.keptDropped, 0);
    assert.equal(read(), FILE_TEXT);
  });
});

test('(d) a KEPT verdict naming an unknown id, a kept note at another verse, or no id is rejected', async () => {
  await ws(async ({ run, read, dir }) => {
    const runner = fakeRunner({
      overrides: {
        6: keptDrop('nope'), // unknown id
        3: keptDrop('hk52'), // hk52 is at 3:3, row is 3:1 (and hk52 is not in this row's verse)
        8: keptDrop('k99z'), // a real kept id that was not given to this chunk
        11: { action: 'drop', rule: 'KEPT', reason: 'no id' },
      },
    });
    const res = await run({ runClaudeImpl: runner, kept: KEPT });
    assert.equal(res.counts.dropped, 0);
    assert.equal(res.counts.declined, 4);
    assert.equal(read(), FILE_TEXT);
    const report = fs.readFileSync(path.join(dir, res.reportPath), 'utf8');
    assert.match(report, /kept_drop_rejected:unknown_kept:6:nope/);
    assert.match(report, /kept_drop_rejected:verse:3:hk52/);
    assert.match(report, /kept_drop_rejected:unknown_kept:8:k99z/);
    assert.match(report, /kept_drop_rejected:unknown_kept:11:none/);
  });
});

test('(f) with no kept list (or none on these verses) the prompt and hash are unchanged', async () => {
  await ws(async ({ run, mod, sidecar, reset }) => {
    const r0 = fakeRunner();
    await run({ runClaudeImpl: r0 });
    const hash0 = sidecar().rulesHash;
    const prompt0 = r0.calls[0].prompt;
    assert.ok(!/KEPT/.test(prompt0));
    assert.ok(!prompt0.includes('"kept"'));
    for (const kept of [null, [], [KEPT[2], KEPT[3]]]) {
      reset();
      const r = fakeRunner();
      const res = await run({ runClaudeImpl: r, kept });
      assert.equal(res.reason, 'already_applied', `kept=${JSON.stringify(kept)} must not change the hash`);
    }
    // The prompt builder itself is byte-identical without a kept list.
    const args = {
      book: 'JER', chapter: 3, rules: [], catalog: new Set(['figs-explicit']), requireGRule: true,
      verseText: { verses: [3], hebrew: new Map(), ult: new Map([[3, 'x']]), ust: new Map() },
      rows: [{ index: 6, ref: '3:3', sref: 'figs-explicit', quote: 'q', explanation: 'e' }],
    };
    assert.equal(mod.buildPrompt(args), mod.buildPrompt({ ...args, kept: [] }));
    assert.equal(mod.buildPrompt(args), mod.buildPrompt({ ...args, kept: null }));
    assert.equal(hash0.length, 64);
  });
});

test('(f) without a kept list a KEPT-cited drop is handled as before: uncited under requireGRule', async () => {
  await ws(async ({ run, read, dir }) => {
    const res = await run({ runClaudeImpl: fakeRunner({ overrides: { 6: keptDrop('hk52') } }) });
    assert.equal(res.counts.dropped, 0);
    assert.equal(res.keptDropped, 0);
    assert.equal(read(), FILE_TEXT);
    assert.match(fs.readFileSync(path.join(dir, res.reportPath), 'utf8'), /uncited_ignored:6:drop:KEPT/);
  });
});

test('a changed kept set re-runs the gate instead of reporting already_applied', async () => {
  await ws(async ({ run }) => {
    await run({ runClaudeImpl: fakeRunner(), kept: KEPT });
    const same = await run({ runClaudeImpl: fakeRunner(), kept: KEPT });
    assert.equal(same.reason, 'already_applied');
    const edited = KEPT.map((k) => (k.rowId === 'hk52' ? { ...k, note: 'Edited note text.' } : k));
    const again = await run({ runClaudeImpl: fakeRunner(), kept: edited });
    assert.notEqual(again.reason, 'already_applied');
  });
});

test('rows at hinted verses stay protected: no verdict asked, so no KEPT drop', async () => {
  await ws(async ({ run }) => {
    const runner = fakeRunner();
    await run({ runClaudeImpl: runner, kept: KEPT, hints: [{ chapter: 3, verse: 3 }] });
    assert.match(runner.calls[0].prompt, /^#6 \[protected\]/m);
    assert.ok(!runner.calls[0].prompt.includes('[hk52]'), 'kept notes only on protected verses are not listed');
  });
});

test('earlier KEPT drops do not count against the 25% cap on a later rerun', async () => {
  await ws(async ({ run, dir }) => {
    await run({ runClaudeImpl: fakeRunner({ overrides: { 6: keptDrop('hk52'), 10: keptDrop('k35a') } }), kept: KEPT });
    // New rules: the gate re-runs on the thinned list (5 gateable of the first 7).
    fs.writeFileSync(path.join(dir, '.claude/skills/issue-identification/rules-gate.md'), G_RULES + '- **G5 Another**\n');
    const res = await run({ runClaudeImpl: fakeRunner({ overrides: { 3: { action: 'drop', rule: 'G4', reason: 'r' } } }), kept: KEPT });
    // Without the adjustment priorDrops=2, so (2+1)/7 > 25% would block the G4 drop.
    assert.equal(res.counts.dropped, 1);
  });
});
