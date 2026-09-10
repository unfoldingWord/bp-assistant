const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  parseIssuesTsv,
  serializeIssuesTsv,
  selectInterpretiveRows,
  parseVerdicts,
  applyVerdicts,
  resolveInterpReviewSettings,
  runInterpretiveReview,
} = require('../src/interp-review');
const { writeContext } = require('../src/pipeline-context');

// --- (a) parse/serialize round trip ------------------------------------------------

test('parseIssuesTsv/serializeIssuesTsv round-trip is byte-identical', () => {
  const text = [
    'ISA\t1:intro\t\t\t\t\t# Some intro markdown',
    '',
    'ISA\t1:9\tfigs-metaphor\tקֶֶַ֫דֶם\t\t\tTCM i:(1) foo (2) bar',
    'ISA\t1:10\tfigs-idiom\thear the word\t\t\tan idiom meaning listen carefully',
  ].join('\n') + '\n';

  const rows = parseIssuesTsv(text);
  const out = serializeIssuesTsv(rows);
  assert.equal(out, text);
});

test('short 4-column rows round-trip byte-identical and rebuild with 7 columns only when changed', () => {
  const text = 'ISA\t1:1\tfigs-metaphor\tquote-one\nISA\t1:2\tfigs-idiom\tquote-two\n';
  const rows = parseIssuesTsv(text);
  assert.equal(serializeIssuesTsv(rows), text);
  const { rows: newRows } = applyVerdicts(rows, new Map([
    [1, { index: 1, verdict: 'revise', explanation: 'new two', sref: null, reason: '' }],
  ]));
  assert.equal(serializeIssuesTsv(newRows), 'ISA\t1:1\tfigs-metaphor\tquote-one\nISA\t1:2\tfigs-idiom\tquote-two\t\t\tnew two\n');
});

test('selectInterpretiveRows ignores the analysts\' stock "could be verb" wording', () => {
  const rows = [
    row({ ref: '1:1', sref: 'figs-abstractnouns', explanation: 'abstract noun - could be verb' }),
    row({ ref: '1:2', sref: 'figs-activepassive', explanation: 'passive - agent is God or the king' }),
    row({ ref: '1:3', sref: 'figs-activepassive', explanation: 'referent is either the city or the people' }),
  ];
  assert.deepEqual(selectInterpretiveRows(rows).map((r) => r.ref), ['1:3']);
});

test('parseIssuesTsv marks a passthrough row for :intro refs and short lines', () => {
  const text = 'ISA\t1:intro\t\t\t\t\tintro text\nISA\t1:1\n';
  const rows = parseIssuesTsv(text);
  assert.equal(rows[0].passthrough, true);
  assert.equal(rows[1].passthrough, true); // fewer than 4 columns
});

// --- (b) selectInterpretiveRows ------------------------------------------------------

function row({ book = 'ISA', ref, sref, quote = 'q', explanation }) {
  return { index: 0, book, ref, sref, quote, col5: '', col6: '', explanation, raw: '' };
}

test('selectInterpretiveRows picks sref-set, TCM, and hedge rows; skips plain figs-activepassive', () => {
  const rows = [
    row({ ref: '1:1', sref: 'figs-metaphor', explanation: 'a plain metaphor note' }),
    row({ ref: '1:2', sref: 'figs-activepassive', explanation: 'TCM i:(1) a (2) b' }),
    row({ ref: '1:3', sref: 'figs-activepassive', explanation: 'this could mean several things' }),
    row({ ref: '1:4', sref: 'figs-activepassive', explanation: 'a plain, unhedged, non-TCM note' }),
  ];
  const selected = selectInterpretiveRows(rows).map((r) => r.ref);
  assert.deepEqual(selected, ['1:1', '1:2', '1:3']);
});

// --- (c) parseVerdicts ---------------------------------------------------------------

test('parseVerdicts handles a fenced JSON block', () => {
  const rows = [row({ index: 0, ref: '1:1', sref: 'figs-metaphor', explanation: 'x' })];
  rows[0].index = 0;
  const text = '```json\n[{"index":0,"verdict":"agree","explanation":null,"sref":null,"reason":"fine"}]\n```';
  const { verdicts, errors } = parseVerdicts(text, rows);
  assert.equal(errors.length, 0);
  assert.equal(verdicts.get(0).verdict, 'agree');
});

test('parseVerdicts rejects an unknown verdict', () => {
  const rows = [{ ...row({ ref: '1:1', sref: 'figs-metaphor', explanation: 'x' }), index: 0 }];
  const text = JSON.stringify([{ index: 0, verdict: 'maybe', explanation: null, sref: null, reason: '' }]);
  const { verdicts, errors } = parseVerdicts(text, rows);
  assert.equal(verdicts.size, 0);
  assert.equal(errors.length, 1);
});

test('parseVerdicts rejects a retype without sref', () => {
  const rows = [{ ...row({ ref: '1:1', sref: 'figs-metaphor', explanation: 'x' }), index: 0 }];
  const text = JSON.stringify([{ index: 0, verdict: 'retype', explanation: 'new explanation', sref: null, reason: '' }]);
  const { verdicts, errors } = parseVerdicts(text, rows);
  assert.equal(verdicts.size, 0);
  assert.equal(errors.length, 1);
});

test('parseVerdicts returns one error on garbage JSON', () => {
  const rows = [{ ...row({ ref: '1:1', sref: 'figs-metaphor', explanation: 'x' }), index: 0 }];
  const { verdicts, errors } = parseVerdicts('not json at all {{{', rows);
  assert.equal(verdicts.size, 0);
  assert.equal(errors.length, 1);
});

// --- (d) applyVerdicts ---------------------------------------------------------------

test('applyVerdicts changes only explanation/sref and removes dropped rows; quotes never change', () => {
  const rows = parseIssuesTsv([
    'ISA\t1:1\tfigs-metaphor\tquote-one\t\t\told explanation one',
    'ISA\t1:2\tfigs-idiom\tquote-two\t\t\told explanation two',
    'ISA\t1:3\tfigs-metonymy\tquote-three\t\t\told explanation three',
    'ISA\t1:4\tfigs-metaphor\tquote-four\t\t\told explanation four',
  ].join('\n') + '\n');

  const verdicts = new Map([
    [0, { index: 0, verdict: 'agree', explanation: null, sref: null, reason: '' }],
    [1, { index: 1, verdict: 'revise', explanation: 'revised explanation two', sref: null, reason: 'r' }],
    [2, { index: 2, verdict: 'retype', explanation: 'retyped explanation three', sref: 'figs-explicit', reason: 'r' }],
    [3, { index: 3, verdict: 'drop', explanation: null, sref: null, reason: 'r' }],
  ]);

  const before = rows.map((r) => r.quote);
  const { rows: newRows, changed } = applyVerdicts(rows, verdicts);

  // quote never touched on surviving rows
  for (const r of newRows) {
    const original = rows.find((o) => o.index === r.index);
    assert.equal(r.quote, original.quote);
  }
  assert.equal(before[1], newRows.find((r) => r.index === 1).quote);

  assert.equal(newRows.length, 3); // row 3 dropped
  assert.equal(newRows.find((r) => r.index === 1).explanation, 'revised explanation two');
  assert.equal(newRows.find((r) => r.index === 2).sref, 'figs-explicit');
  assert.equal(newRows.find((r) => r.index === 2).explanation, 'retyped explanation three');
  assert.ok(!newRows.find((r) => r.index === 3));

  assert.equal(changed.length, 3);
  const dropEntry = changed.find((c) => c.verdict === 'drop');
  assert.equal(dropEntry.index, 3);
});

// --- (e) resolveInterpReviewSettings --------------------------------------------------

test('resolveInterpReviewSettings defaults to off', () => {
  const settings = resolveInterpReviewSettings({ config: {}, env: {}, book: 'ISA' });
  assert.equal(settings.mode, 'off');
  assert.equal(settings.enabledForBook, false);
});

test('resolveInterpReviewSettings honors env mode override', () => {
  const config = { interpReview: { mode: 'off', books: ['ISA'], model: 'claude-fable-5-1', maxRowsPerCall: 40 } };
  const settings = resolveInterpReviewSettings({ config, env: { BP_INTERP_REVIEW_MODE: 'report' }, book: 'ISA' });
  assert.equal(settings.mode, 'report');
  assert.equal(settings.enabledForBook, true);
});

test('resolveInterpReviewSettings "all" books env enables every book', () => {
  const config = { interpReview: { mode: 'report', books: ['ISA'], model: 'claude-fable-5-1', maxRowsPerCall: 40 } };
  const settings = resolveInterpReviewSettings({ config, env: { BP_INTERP_REVIEW_BOOKS: 'all' }, book: 'GEN' });
  assert.equal(settings.enabledForBook, true);
});

test('resolveInterpReviewSettings matches books case-insensitively', () => {
  const config = { interpReview: { mode: 'report', books: ['isa', 'jer'], model: 'claude-fable-5-1', maxRowsPerCall: 40 } };
  const settings = resolveInterpReviewSettings({ config, env: {}, book: 'ISA' });
  assert.equal(settings.enabledForBook, true);
});

test('resolveInterpReviewSettings falls back to off on an invalid mode', () => {
  const config = { interpReview: { mode: 'bogus', books: ['ISA'], model: 'claude-fable-5-1', maxRowsPerCall: 40 } };
  const settings = resolveInterpReviewSettings({ config, env: {}, book: 'ISA' });
  assert.equal(settings.mode, 'off');
  assert.equal(settings.enabledForBook, false);
});

// --- (f) runInterpretiveReview end-to-end ---------------------------------------------

function makeWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'interp-review-'));
}

function writeIssuesFixture(workspaceDir, relPath) {
  const abs = path.resolve(workspaceDir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const text = [
    'ISA\t1:1\tfigs-metaphor\tquote-one\t\t\told explanation one',
    'ISA\t1:2\tfigs-idiom\tquote-two\t\t\told explanation two',
  ].join('\n') + '\n';
  fs.writeFileSync(abs, text);
  return abs;
}

test('runInterpretiveReview in report mode leaves the TSV untouched and writes markdown', async () => {
  const workspaceDir = makeWorkspace();
  const oldCskillbpDir = process.env.CSKILLBP_DIR;
  process.env.CSKILLBP_DIR = workspaceDir;
  try {
    const issuesPath = 'tmp/pipeline/ISA-01/issues.tsv';
    const absIssuesPath = writeIssuesFixture(workspaceDir, issuesPath);
    const originalText = fs.readFileSync(absIssuesPath, 'utf8');

    const pipeDir = 'tmp/pipeline/ISA-01';
    writeContext(pipeDir, { sources: { ult: `${pipeDir}/ult.usfm`, ust: `${pipeDir}/ust.usfm`, hebrew: `${pipeDir}/hebrew.usfm` } });
    fs.writeFileSync(path.resolve(workspaceDir, pipeDir, 'ult.usfm'), 'ULT text');
    fs.writeFileSync(path.resolve(workspaceDir, pipeDir, 'ust.usfm'), 'UST text');
    fs.writeFileSync(path.resolve(workspaceDir, pipeDir, 'hebrew.usfm'), 'Hebrew text');

    const fakeRunClaudeImpl = async () => ({
      subtype: 'success',
      result: { text: JSON.stringify([
        { index: 0, verdict: 'revise', explanation: 'new explanation one', sref: null, reason: 'clarify' },
        { index: 1, verdict: 'agree', explanation: null, sref: null, reason: '' },
      ]) },
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    const settings = { mode: 'report', model: 'claude-fable-5-1', maxRows: 40 };
    const result = await runInterpretiveReview({
      issuesPath, pipeDir, book: 'ISA', chapter: 1, workspaceDir,
      runClaudeImpl: fakeRunClaudeImpl, status: null, settings,
    });

    assert.equal(result.ran, true);
    assert.equal(fs.readFileSync(absIssuesPath, 'utf8'), originalText); // unchanged in report mode
    assert.ok(fs.existsSync(path.resolve(workspaceDir, result.reviewPath)));
    assert.equal(result.changed.length, 1);
  } finally {
    process.env.CSKILLBP_DIR = oldCskillbpDir;
  }
});

test('runInterpretiveReview in apply mode writes the changed explanation but never the quote', async () => {
  const workspaceDir = makeWorkspace();
  const oldCskillbpDir = process.env.CSKILLBP_DIR;
  process.env.CSKILLBP_DIR = workspaceDir;
  try {
    const issuesPath = 'tmp/pipeline/ISA-01/issues.tsv';
    const absIssuesPath = writeIssuesFixture(workspaceDir, issuesPath);

    const pipeDir = 'tmp/pipeline/ISA-01';
    writeContext(pipeDir, { sources: { ult: `${pipeDir}/ult.usfm`, ust: `${pipeDir}/ust.usfm`, hebrew: `${pipeDir}/hebrew.usfm` } });
    fs.writeFileSync(path.resolve(workspaceDir, pipeDir, 'ult.usfm'), 'ULT text');
    fs.writeFileSync(path.resolve(workspaceDir, pipeDir, 'ust.usfm'), 'UST text');
    fs.writeFileSync(path.resolve(workspaceDir, pipeDir, 'hebrew.usfm'), 'Hebrew text');

    const fakeRunClaudeImpl = async () => ({
      subtype: 'success',
      result: { text: JSON.stringify([
        { index: 0, verdict: 'revise', explanation: 'new explanation one', sref: null, reason: 'clarify' },
        { index: 1, verdict: 'agree', explanation: null, sref: null, reason: '' },
      ]) },
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    const settings = { mode: 'apply', model: 'claude-fable-5-1', maxRows: 40 };
    const result = await runInterpretiveReview({
      issuesPath, pipeDir, book: 'ISA', chapter: 1, workspaceDir,
      runClaudeImpl: fakeRunClaudeImpl, status: null, settings,
    });

    assert.equal(result.ran, true);
    const updatedText = fs.readFileSync(absIssuesPath, 'utf8');
    assert.match(updatedText, /new explanation one/);
    assert.match(updatedText, /quote-one/); // quote column untouched
    assert.match(updatedText, /quote-two/);
  } finally {
    process.env.CSKILLBP_DIR = oldCskillbpDir;
  }
});

test('runInterpretiveReview ignores drops above the drop-share guard but keeps revisions', async () => {
  const workspaceDir = makeWorkspace();
  const oldCskillbpDir = process.env.CSKILLBP_DIR;
  process.env.CSKILLBP_DIR = workspaceDir;
  try {
    const issuesPath = 'tmp/pipeline/ISA-01/issues.tsv';
    const absIssuesPath = writeIssuesFixture(workspaceDir, issuesPath);
    const pipeDir = 'tmp/pipeline/ISA-01';
    writeContext(pipeDir, { sources: {} });

    // 2 rows, one drop = 50% > 25% guard
    const fakeRunClaudeImpl = async () => ({
      subtype: 'success',
      result: { text: JSON.stringify([
        { index: 0, verdict: 'revise', explanation: 'new explanation one', sref: null, reason: 'clarify' },
        { index: 1, verdict: 'drop', explanation: null, sref: null, reason: 'not an issue' },
      ]) },
    });

    const result = await runInterpretiveReview({
      issuesPath, pipeDir, book: 'ISA', chapter: 1, workspaceDir,
      runClaudeImpl: fakeRunClaudeImpl, status: null, settings: { mode: 'apply', model: 'x', maxRows: 40 },
    });

    const updatedText = fs.readFileSync(absIssuesPath, 'utf8');
    assert.match(updatedText, /new explanation one/);
    assert.match(updatedText, /quote-two/); // drop was ignored
    assert.ok(result.errors.some((e) => /drop guard/.test(e)));
    assert.equal(result.changed.filter((c) => c.verdict === 'drop').length, 0);
  } finally {
    process.env.CSKILLBP_DIR = oldCskillbpDir;
  }
});

test('runInterpretiveReview leaves the TSV untouched and reports errors on a Claude failure, without throwing', async () => {
  const workspaceDir = makeWorkspace();
  const oldCskillbpDir = process.env.CSKILLBP_DIR;
  process.env.CSKILLBP_DIR = workspaceDir;
  try {
    const issuesPath = 'tmp/pipeline/ISA-01/issues.tsv';
    const absIssuesPath = writeIssuesFixture(workspaceDir, issuesPath);
    const originalText = fs.readFileSync(absIssuesPath, 'utf8');

    const pipeDir = 'tmp/pipeline/ISA-01';
    writeContext(pipeDir, { sources: { ult: `${pipeDir}/ult.usfm`, ust: `${pipeDir}/ust.usfm`, hebrew: `${pipeDir}/hebrew.usfm` } });
    fs.writeFileSync(path.resolve(workspaceDir, pipeDir, 'ult.usfm'), 'ULT text');
    fs.writeFileSync(path.resolve(workspaceDir, pipeDir, 'ust.usfm'), 'UST text');
    fs.writeFileSync(path.resolve(workspaceDir, pipeDir, 'hebrew.usfm'), 'Hebrew text');

    const fakeRunClaudeImpl = async () => ({ subtype: 'error' });

    const settings = { mode: 'apply', model: 'claude-fable-5-1', maxRows: 40 };
    const result = await runInterpretiveReview({
      issuesPath, pipeDir, book: 'ISA', chapter: 1, workspaceDir,
      runClaudeImpl: fakeRunClaudeImpl, status: null, settings,
    });

    assert.equal(fs.readFileSync(absIssuesPath, 'utf8'), originalText);
    assert.ok(result.errors.length > 0);
  } finally {
    process.env.CSKILLBP_DIR = oldCskillbpDir;
  }
});
