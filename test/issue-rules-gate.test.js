const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SRC_DIR = path.resolve(__dirname, '../src') + path.sep;

// CSKILLBP_DIR is read when pipeline-utils loads, so each test points the env
// var at its own temp workspace and reloads every src module.
function freshModule(workspaceDir) {
  process.env.CSKILLBP_DIR = workspaceDir;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(SRC_DIR)) delete require.cache[key];
  }
  return require('../src/issue-rules-gate');
}

const CATALOG = [
  'issue,last_updated',
  ...['figs-metaphor', 'figs-metonymy', 'figs-idiom', 'figs-explicit', 'figs-possession',
    'figs-parallelism', 'figs-activepassive', 'writing-pronouns'].map((s) => `${s},2026-01-01`),
].join('\n') + '\n';

const DECISIONS = [
  'Phrase,IssueType,Book,Context,Notes,Date,Source',
  'figs-abstractnouns,rc://*/ta/man/translate/figs-abstractnouns,ALL,"LAM+HAB overall, drop","Over-flagged, apply a high bar.",2026-07-02,editor-history',
  'the king,rc://*/ta/man/translate/figs-metonymy,JER,JER 3 keep,Keep royal metonymy.,2026-07-03,editor-history',
  'psa only,rc://*/ta/man/translate/figs-idiom,PSA,PSA 1,Psalms only.,2026-07-04,editor-history',
].join('\n') + '\n';

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
  /* 1 */ 'JER\t3:intro\t\t\t\t\t# INTRO-MARKER chapter introduction',
  /* 2 */ '',
  /* 3 */ 'JER\t3:1\tfigs-metaphor\tthe king\t\t\tking = Yahweh',
  /* 4 */ 'JER\t3:2\tfigs-idiom\tthe word of the LORD\t\t\tidiom here',
  /* 5 */ 'JER\t3:2\tfigs-parallelism\tthe word\t\t\tparallel lines',
  /* 6 */ 'JER\t3:3\tfigs-explicit\tthe city\t\t\tcity of Jerusalem',
  /* 7 */ 'JER\t3:3\tfigs-possession\tthe gate\t\t\tgate of the city',
  /* 8 */ 'JER\t3:4\tfigs-metonymy\tthe covenant\t\t\tcovenant = promise',
  /* 9 */ 'JER\t3:4\tfigs-activepassive\tkept\t\t\tagent is the people',
  /* 10 */ 'JER\t3:5\tfigs-explicit\tthe house of the king\t\t\thouse = family',
  /* 11 */ 'JER\t3:5\twriting-pronouns\tthe king\t\t\tking = Yahweh',
];
const GATEABLE = [3, 4, 6, 7, 8, 10, 11];
const FILE_TEXT = LINES.join('\n') + '\n';

const CONFIG = {
  rulesGate: { mode: 'apply', books: 'all', allowAdd: false, effort: 'high', protectSrefs: ['figs-parallelism', 'figs-activepassive'] },
};

async function ws(fn, opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-gate-'));
  const oldDir = process.env.CSKILLBP_DIR;
  const text = opts && opts.lines ? opts.lines.join('\n') + '\n' : FILE_TEXT;
  const rules = opts && 'rules' in opts ? opts.rules : '# Gate rules\nReview each row.\n';
  try {
    fs.mkdirSync(path.join(dir, '.claude/skills/issue-identification'), { recursive: true });
    if (rules != null) fs.writeFileSync(path.join(dir, '.claude/skills/issue-identification/rules-gate.md'), rules);
    fs.mkdirSync(path.join(dir, 'data/quick-ref'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'data/quick-ref/issue_decisions.csv'), DECISIONS);
    fs.writeFileSync(path.join(dir, 'data/translation-issues.csv'), CATALOG);
    fs.writeFileSync(path.join(dir, 'ult.usfm'), ULT);
    fs.mkdirSync(path.join(dir, 'output/issues'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'output/issues/JER-03.tsv'), text);
    const mod = freshModule(dir);
    const ctx = { sources: { ultPlain: 'ult.usfm' } };
    const abs = path.join(dir, 'output/issues/JER-03.tsv');
    const run = (extra = {}) => mod.runIssueRulesGate({
      issuesPath: 'output/issues/JER-03.tsv', book: 'JER', chapter: 3, ctx, hints: null,
      config: CONFIG, env: {}, dryRun: false, model: 'test-model', status: async () => {}, ...extra,
    });
    return await fn({ dir, mod, ctx, abs, run, read: () => fs.readFileSync(abs, 'utf8') });
  } finally {
    if (oldDir === undefined) delete process.env.CSKILLBP_DIR; else process.env.CSKILLBP_DIR = oldDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Fake runClaude: verdicts for every gateable row (keep) with per-row overrides.
function fakeRunner({ overrides = {}, omit = [], extraVerdicts = [], adds = [] } = {}) {
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    const indexes = [...args.prompt.matchAll(/^#(\d+) (?!\[protected\])/gm)].map((m) => Number(m[1]));
    const verdicts = indexes.filter((i) => !omit.includes(i)).map((i) => ({
      row: i, action: 'keep', reason: 'fine', rule: null, ...(overrides[i] || {}),
    }));
    return { subtype: 'success', result: { text: JSON.stringify({ verdicts: [...verdicts, ...extraVerdicts], adds }) }, usage: { input_tokens: 10, output_tokens: 5 } };
  };
  fn.calls = calls;
  return fn;
}

const lineOf = (text, i) => text.split('\n')[i];

// --- 1 ----------------------------------------------------------------------------

test('apply changes only the targeted columns; untouched rows stay byte-identical', async () => {
  await ws(async ({ run, read }) => {
    const runner = fakeRunner({
      overrides: {
        3: { action: 'relabel', sref: 'figs-metonymy', rule: 'D3', reason: 'royal metonymy' },
        4: { action: 'rescope', quote: 'word of the LORD', reason: 'tighter' },
        7: { action: 'drop', reason: 'not an issue', rule: 'D2' },
      },
    });
    const res = await run({ runClaudeImpl: runner });
    assert.equal(res.ran, true);
    assert.equal(res.changed, true);
    assert.deepEqual(res.counts, { kept: 4, dropped: 1, relabeled: 1, rescoped: 1, added: 0 });
    assert.equal(res.rowsBefore, 9);
    assert.equal(res.rowsAfter, 8);

    const out = read();
    const before = FILE_TEXT.split('\n');
    const after = out.split('\n');
    assert.equal(after.length, before.length - 1);
    assert.equal(after[3], 'JER\t3:1\tfigs-metonymy\tthe king\t\t\tking = Yahweh');
    assert.equal(after[4], 'JER\t3:2\tfigs-idiom\tword of the LORD\t\t\tidiom here');
    // row 7 removed; everything else identical
    const expected = before.filter((_, i) => i !== 7 && i !== 3 && i !== 4);
    const actual = after.filter((_, i) => i !== 3 && i !== 4);
    assert.deepEqual(actual, expected);
    assert.match(res.prBody, /^Issue rules check: kept 4, dropped 1, relabeled 1, rescoped 1, added 0/);
    assert.match(res.prBody, /3:3 drop figs-possession "the gate" \(D2: not an issue\)/);
    assert.ok(fs.existsSync(path.join(process.env.CSKILLBP_DIR, res.reportPath)));
    assert.ok(fs.existsSync(path.join(process.env.CSKILLBP_DIR, 'output/review/JER/JER-03-pre-rules-gate.tsv')));
    assert.equal(fs.readFileSync(path.join(process.env.CSKILLBP_DIR, 'output/review/JER/JER-03-pre-rules-gate.tsv'), 'utf8'), FILE_TEXT);
  });
});

// --- 2 ----------------------------------------------------------------------------

test('incomplete verdict coverage leaves the file unchanged', async () => {
  await ws(async ({ run, read }) => {
    const runner = fakeRunner({ omit: [6], overrides: { 3: { action: 'drop', reason: 'x' } } });
    const res = await run({ runClaudeImpl: runner });
    assert.equal(res.ran, true);
    assert.equal(res.changed, false);
    assert.equal(read(), FILE_TEXT);
    assert.equal(res.counts.dropped, 0);
  });
});

// --- 3 ----------------------------------------------------------------------------

test('drop cap exceeded applies no drops but still applies relabels', async () => {
  await ws(async ({ run, read }) => {
    const runner = fakeRunner({
      overrides: {
        3: { action: 'relabel', sref: 'figs-metonymy' },
        4: { action: 'drop' }, 6: { action: 'drop' }, 7: { action: 'drop' },
      },
    });
    const res = await run({ runClaudeImpl: runner });
    assert.equal(res.counts.dropped, 0);
    assert.equal(res.counts.relabeled, 1);
    const out = read().split('\n');
    assert.equal(out.length, LINES.length + 1);
    assert.equal(out[3], 'JER\t3:1\tfigs-metonymy\tthe king\t\t\tking = Yahweh');
    assert.equal(out[4], LINES[4]);
    assert.equal(out[6], LINES[6]);
    assert.equal(out[7], LINES[7]);
  });
});

// --- 4 ----------------------------------------------------------------------------

test('relabel to an off-catalog slug is ignored', async () => {
  await ws(async ({ run, read }) => {
    const runner = fakeRunner({ overrides: { 3: { action: 'relabel', sref: 'figs-madeup' } } });
    const res = await run({ runClaudeImpl: runner });
    assert.equal(res.counts.relabeled, 0);
    assert.equal(res.changed, false);
    assert.equal(read(), FILE_TEXT);
  });
});

// --- 5 ----------------------------------------------------------------------------

test('rescope with a non-anchoring quote or an ellipsis-brace quote is ignored', async () => {
  await ws(async ({ run, read }) => {
    const runner = fakeRunner({
      overrides: {
        4: { action: 'rescope', quote: 'the queen of the LORD' },
        6: { action: 'rescope', quote: 'the {…} city' },
        7: { action: 'rescope', quote: 'the {...} gate' },
      },
    });
    const res = await run({ runClaudeImpl: runner });
    assert.equal(res.counts.rescoped, 0);
    assert.equal(read(), FILE_TEXT);
  });
});

// --- 6 ----------------------------------------------------------------------------

test('protected rows (sref list and hinted verse) never change despite verdicts', async () => {
  await ws(async ({ run, read }) => {
    // Verse 5 has an editor hint, so rows 10 and 11 are protected as well.
    const runner = fakeRunner({
      overrides: { 3: { action: 'relabel', sref: 'figs-metonymy' } },
      extraVerdicts: [5, 9, 10, 11].map((row) => ({ row, action: 'drop', reason: 'try', rule: null })),
    });
    const res = await run({ runClaudeImpl: runner, hints: [{ rowId: 'abcd', verse: 5, supportReference: 'figs-explicit' }] });
    assert.equal(res.ran, true);
    const out = read().split('\n');
    for (const i of [5, 9, 10, 11]) assert.equal(out[i], LINES[i]);
    assert.equal(out[3], 'JER\t3:1\tfigs-metonymy\tthe king\t\t\tking = Yahweh');
    assert.equal(res.counts.dropped, 0);
    // protected rows are shown as context, marked
    const prompt = runner.calls[0].prompt;
    assert.match(prompt, /^#5 \[protected\] 3:2 \| figs-parallelism/m);
    assert.match(prompt, /^#10 \[protected\] 3:5 \|/m);
  });
});

// --- 7 ----------------------------------------------------------------------------

test('accounting guard flags a row-count mismatch and accepts a consistent result', async () => {
  await ws(async ({ mod }) => {
    const before = mod.parseIssuesTsv(FILE_TEXT);
    const lost = mod.parseIssuesTsv(FILE_TEXT.split('\n').filter((_, i) => i !== 7).join('\n'));
    assert.equal(mod.accountingHolds(before, lost, { dropped: 0, added: 0 }), false);
    assert.equal(mod.accountingHolds(before, lost, { dropped: 1, added: 0 }), true);
    const noIntro = mod.parseIssuesTsv(FILE_TEXT.split('\n').filter((_, i) => i !== 1).join('\n'));
    assert.equal(mod.accountingHolds(before, noIntro, { dropped: 0, added: 0 }), false);
  });
});

// --- 8 ----------------------------------------------------------------------------

test('sidecar makes a second run return already_applied without a model call', async () => {
  await ws(async ({ run, read, dir }) => {
    const runner = fakeRunner({ overrides: { 3: { action: 'relabel', sref: 'figs-metonymy' } } });
    const first = await run({ runClaudeImpl: runner });
    assert.equal(first.changed, true);
    const afterFirst = read();
    const sidecar = JSON.parse(fs.readFileSync(path.join(dir, first.sidecarPath), 'utf8'));
    assert.equal(sidecar.version, 1);
    assert.equal(sidecar.mode, 'apply');
    assert.ok(sidecar.rulesHash && sidecar.inputHash && sidecar.outputHash);
    assert.notEqual(sidecar.inputHash, sidecar.outputHash);

    const second = await run({ runClaudeImpl: runner });
    assert.equal(second.ran, false);
    assert.equal(second.reason, 'already_applied');
    assert.equal(second.prBody, first.prBody);
    assert.equal(runner.calls.length, 1);
    assert.equal(read(), afterFirst);
  });
});

// --- 9 ----------------------------------------------------------------------------

test('dryRun never calls the model and leaves the file alone', async () => {
  await ws(async ({ run, read }) => {
    const runner = fakeRunner();
    const res = await run({ runClaudeImpl: runner, dryRun: true });
    assert.equal(res.ran, false);
    assert.equal(res.reason, 'dry_run');
    assert.equal(runner.calls.length, 0);
    assert.equal(read(), FILE_TEXT);
  });
});

// --- 10 ---------------------------------------------------------------------------

test('a usage-limit error pauses the chapter and leaves the file unchanged', async () => {
  await ws(async ({ run, read }) => {
    const res = await run({ runClaudeImpl: async () => { throw new Error('You have hit your limit; resets at 5pm'); } });
    assert.equal(res.ran, false);
    assert.equal(res.pause, true);
    assert.equal(res.reason, 'paused');
    assert.equal(read(), FILE_TEXT);
  });
});

test('a transient outage pauses; any other failure is an error, not a pause', async () => {
  await ws(async ({ run, read }) => {
    const outage = Object.assign(new Error('network down'), { name: 'ClaudeTransientOutageError' });
    const paused = await run({ runClaudeImpl: async () => { throw outage; } });
    assert.equal(paused.pause, true);
    const failed = await run({ runClaudeImpl: async () => { throw new Error('boom'); } });
    assert.equal(failed.ran, false);
    assert.equal(failed.pause, false);
    assert.equal(failed.reason, 'error');
    assert.match(failed.error, /boom/);
    const nonSuccess = await run({ runClaudeImpl: async () => ({ subtype: 'error', error: 'rate limit exceeded' }) });
    assert.equal(nonSuccess.pause, true);
    assert.equal(read(), FILE_TEXT);
  });
});

// --- 11 ---------------------------------------------------------------------------

test('adds are ignored when allowAdd is false and validated when true', async () => {
  const adds = [
    { ref: '3:1', sref: 'figs-explicit', quote: 'the people', explanation: 'people = Israel', reason: 'missed', rule: null },
    { ref: '3:1', sref: 'figs-madeup', quote: 'the people', explanation: 'x', reason: '', rule: null },
    { ref: '3:1', sref: 'figs-explicit', quote: 'the queen', explanation: 'x', reason: '', rule: null },
    { ref: '3:5', sref: 'figs-explicit', quote: 'the house', explanation: 'protected verse', reason: '', rule: null },
    { ref: '3:1', sref: 'figs-metaphor', quote: 'the king said', explanation: 'duplicate', reason: '', rule: null },
    { ref: '3:9', sref: 'figs-explicit', quote: 'the people', explanation: 'outside chunk', reason: '', rule: null },
  ];
  await ws(async ({ run, read }) => {
    const off = await run({ runClaudeImpl: fakeRunner({ adds }), hints: [{ verse: 5 }] });
    assert.equal(off.counts.added, 0);
    assert.equal(read(), FILE_TEXT);
  });
  await ws(async ({ run, read }) => {
    const on = await run({
      runClaudeImpl: fakeRunner({ adds }),
      hints: [{ verse: 5 }],
      config: { rulesGate: { ...CONFIG.rulesGate, allowAdd: true } },
    });
    assert.equal(on.counts.added, 1);
    assert.equal(on.rowsAfter, on.rowsBefore + 1);
    const out = read().split('\n');
    assert.equal(out[4], 'JER\t3:1\tfigs-explicit\tthe people\t\t\tpeople = Israel');
    assert.equal(out[3], LINES[3]);
    assert.equal(out.length, LINES.length + 2);
  });
  await ws(async ({ run, read }) => {
    const envOn = await run({ runClaudeImpl: fakeRunner({ adds: [adds[0]] }), env: { BP_RULES_GATE_ALLOW_ADD: '1' } });
    assert.equal(envOn.counts.added, 1);
    assert.ok(read().includes('JER\t3:1\tfigs-explicit\tthe people'));
  });
});

// --- 12 ---------------------------------------------------------------------------

test('header, blank and intro rows pass through untouched and are never sent', async () => {
  await ws(async ({ run, read }) => {
    const runner = fakeRunner({ overrides: { 3: { action: 'relabel', sref: 'figs-metonymy' } } });
    const res = await run({ runClaudeImpl: runner });
    assert.equal(res.changed, true);
    const out = read().split('\n');
    assert.equal(out[0], LINES[0]);
    assert.equal(out[1], LINES[1]);
    assert.equal(out[2], LINES[2]);
    const prompt = runner.calls[0].prompt;
    assert.ok(!prompt.includes('INTRO-MARKER'));
    assert.ok(!/^#[012] /m.test(prompt));
  });
});

// --- extras: settings, call options, skip reasons, helpers --------------------------

test('call options and prompt follow the spec', async () => {
  await ws(async ({ run, dir }) => {
    const runner = fakeRunner();
    await run({ runClaudeImpl: runner, env: { BP_RULES_GATE_MODEL: 'env-model', BP_RULES_GATE_EFFORT: 'max' } });
    const a = runner.calls[0];
    assert.equal(a.label, 'issue-rules-gate:JER-3');
    assert.equal(a.cwd, dir);
    assert.equal(a.model, 'env-model');
    assert.equal(a.thinking, 'max');
    assert.equal(a.maxTurns, 2);
    assert.equal(a.timeoutMs, 600000);
    assert.deepEqual(a.tools, []);
    assert.equal(a.mcpToolSet, 'none');
    assert.ok(a.disallowedTools.includes('WebSearch') && a.disallowedTools.includes('Bash'));
    assert.match(a.appendSystemPrompt, /Gate rules/);
    // decision rules for JER and ALL only, ids from the whole file
    assert.match(a.prompt, /^D1 \[figs-abstractnouns\] \(ALL; LAM\+HAB overall, drop\) Over-flagged/m);
    assert.match(a.prompt, /^D2 \[figs-metonymy\] \(JER; JER 3 keep\)/m);
    assert.ok(!a.prompt.includes('Psalms only'));
    assert.match(a.prompt, /Verse 3:1\n {2}HEB: \(none\)\n {2}ULT: And the king said/);
  });
});

test('mode off, book filter, no rules file and no gateable rows return before any model call', async () => {
  await ws(async ({ run }) => {
    const runner = fakeRunner();
    assert.equal((await run({ runClaudeImpl: runner, env: { BP_RULES_GATE_MODE: 'off' } })).reason, 'mode_off');
    assert.equal((await run({ runClaudeImpl: runner, env: { BP_RULES_GATE_BOOKS: 'ISA,PSA' } })).reason, 'book_not_enabled');
    assert.equal(runner.calls.length, 0);
  });
  const warnings = [];
  await ws(async ({ run, read }) => {
    const runner = fakeRunner();
    const res = await run({ runClaudeImpl: runner, status: async (t) => { warnings.push(t); } });
    assert.equal(res.reason, 'no_rules_file');
    assert.equal(res.ran, false);
    assert.equal(runner.calls.length, 0);
    assert.equal(read(), FILE_TEXT);
    assert.equal(warnings.length, 1);
  }, { rules: null });
  await ws(async ({ run }) => {
    const runner = fakeRunner();
    const res = await run({ runClaudeImpl: runner });
    assert.equal(res.reason, 'no_gateable_rows');
    assert.equal(runner.calls.length, 0);
  }, { lines: [LINES[1], LINES[5], LINES[9]] });
});

test('chunking splits on verse boundaries at 40 gateable rows', async () => {
  const lines = [];
  for (let v = 1; v <= 5; v++) for (let k = 0; k < 20; k++) lines.push(`JER\t3:${v}\tfigs-explicit\tthe king\t\t\tn${v}-${k}`);
  await ws(async ({ run, mod }) => {
    const runner = fakeRunner();
    await run({ runClaudeImpl: runner });
    assert.equal(runner.calls.length, 3);
    assert.equal(runner.calls[1].label, 'issue-rules-gate:JER-3#2');
    for (const c of runner.calls) {
      const n = (c.prompt.match(/^#\d+ /gm) || []).length;
      assert.ok(n <= 40);
      assert.equal(n % 20, 0, 'chunks hold whole verses');
    }
  }, { lines });
});

test('loadDecisionRules, parseVerdicts and buildPrBody helpers', async () => {
  await ws(async ({ mod }) => {
    const rules = mod.loadDecisionRules({ csvText: DECISIONS, book: 'jer' });
    assert.deepEqual(rules.map((r) => r.id), ['D1', 'D2']);
    assert.equal(rules[0].context, 'LAM+HAB overall, drop');

    const rows = mod.parseIssuesTsv(FILE_TEXT).filter((r) => !r.passthrough).slice(0, 2);
    const fenced = '```json\n{"verdicts":[{"row":3,"action":"keep"},{"row":4,"action":"drop","reason":"a\\tb\\nc"}],"adds":[]}\n```';
    const parsed = mod.parseVerdicts(fenced, rows);
    assert.equal(parsed.complete, true);
    assert.equal(parsed.verdicts.get(4).reason, 'a b c');
    assert.equal(mod.parseVerdicts('nope', rows).parseFailed, true);
    const dup = mod.parseVerdicts('{"verdicts":[{"row":3,"action":"keep"},{"row":3,"action":"keep"},{"row":4,"action":"keep"}]}', rows);
    assert.equal(dup.complete, false);

    const changes = Array.from({ length: 40 }, (_, i) => ({ ref: `3:${i}`, action: 'drop', sref: 'figs-x', before: 'q'.repeat(300), after: '', reason: 'r'.repeat(200), rule: 'D1' }));
    const body = mod.buildPrBody({ counts: { kept: 1, dropped: 40, relabeled: 0, rescoped: 0, added: 0 }, changes });
    assert.ok(body.length <= 3500);
    assert.ok(body.split('\n').filter((l) => l.startsWith('- ')).length <= 26);
  });
});

test('serializeIssuesTsv round-trips bytes, including CRLF and no trailing newline', async () => {
  await ws(async ({ mod }) => {
    for (const text of [FILE_TEXT, FILE_TEXT.replace(/\n/g, '\r\n'), FILE_TEXT.trimEnd(), '']) {
      assert.equal(mod.serializeIssuesTsv(mod.parseIssuesTsv(text)), text);
    }
  });
});

// --- review findings (PR #420): all-or-nothing, settings in the hash, write-once pre copy ----

test('an incomplete chunk in a multi-chunk chapter applies nothing, and writes no sidecar', async () => {
  const lines = ['JER\t3:intro\t\t\t\t\t# intro'];
  for (let v = 1; v <= 5; v++) for (let k = 0; k < 9; k++) lines.push(`JER\t3:${v}\tfigs-metaphor\tthe king\t\t\trow ${v}.${k}`);
  await ws(async ({ dir, run, read }) => {
    const before = read();
    let call = 0;
    const runner = async (args) => {
      call++;
      const idx = [...args.prompt.matchAll(/^#(\d+) (?!\[protected\])/gm)].map((m) => Number(m[1]));
      const verdicts = (call === 1 ? idx : idx.slice(1)).map((i, n) => ({ row: i, action: call === 1 && n === 0 ? 'drop' : 'keep', reason: 'r', rule: null }));
      return { subtype: 'success', result: JSON.stringify({ verdicts, adds: [] }) };
    };
    const res = await run({ runClaudeImpl: runner });
    assert.equal(call, 2);
    assert.equal(res.changed, false);
    assert.equal(res.reason, 'incomplete');
    assert.equal(read(), before);
    assert.equal(fs.existsSync(path.join(dir, 'output/review/JER/JER-03-rules-gate.json')), false);
  }, { lines });
});

test('changing allowAdd re-runs the gate instead of reporting already_applied', async () => {
  await ws(async ({ run }) => {
    const first = fakeRunner();
    const r1 = await run({ runClaudeImpl: first });
    assert.equal(r1.ran, true);
    const second = fakeRunner();
    const cfg = { rulesGate: { ...CONFIG.rulesGate, allowAdd: true } };
    const r2 = await run({ runClaudeImpl: second, config: cfg });
    assert.notEqual(r2.reason, 'already_applied');
    assert.ok(second.calls.length > 0);
  });
});

test('the pre-gate copy is written once and survives a later run under new rules', async () => {
  await ws(async ({ dir, run }) => {
    const original = fs.readFileSync(path.join(dir, 'output/issues/JER-03.tsv'), 'utf8');
    await run({ runClaudeImpl: fakeRunner({ overrides: { 7: { action: 'drop', reason: 'x', rule: 'D2' } } }) });
    const preAbs = path.join(dir, 'output/review/JER/JER-03-pre-rules-gate.tsv');
    assert.equal(fs.readFileSync(preAbs, 'utf8'), original);
    fs.writeFileSync(path.join(dir, '.claude/skills/issue-identification/rules-gate.md'), '# Gate rules v2\nReview each row again.\n');
    await run({ runClaudeImpl: fakeRunner({ overrides: { 6: { action: 'drop', reason: 'y', rule: 'D2' } } }) });
    assert.equal(fs.readFileSync(preAbs, 'utf8'), original);
  });
});

test('parseVerdicts accepts a row number sent as a numeric string', async () => {
  await ws(async ({ mod }) => {
    const rows = [{ index: 3, protected: false }, { index: 4, protected: false }];
    const r = mod.parseVerdicts(JSON.stringify({ verdicts: [{ row: '3', action: 'keep' }, { row: 4, action: 'drop', reason: 'x' }] }), rows);
    assert.equal(r.complete, true);
    assert.equal(r.verdicts.get(3).action, 'keep');
  });
});
