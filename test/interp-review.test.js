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
  sliceChapter,
  stripWordMarkup,
  prepareSourceText,
  extractGuideSummary,
  loadIssueTypeGuides,
  buildReviewPrompt,
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
  assert.ok(errors.some((e) => /unknown verdict "maybe"/.test(e)));
});

test('parseVerdicts rejects a retype without sref', () => {
  const rows = [{ ...row({ ref: '1:1', sref: 'figs-metaphor', explanation: 'x' }), index: 0 }];
  const text = JSON.stringify([{ index: 0, verdict: 'retype', explanation: 'new explanation', sref: null, reason: '' }]);
  const { verdicts, errors } = parseVerdicts(text, rows);
  assert.equal(verdicts.size, 0);
  assert.ok(errors.some((e) => /"retype" requires a valid sref/.test(e)));
});

test('parseVerdicts returns one error on garbage JSON', () => {
  const rows = [{ ...row({ ref: '1:1', sref: 'figs-metaphor', explanation: 'x' }), index: 0 }];
  const { verdicts, errors, parseFailed } = parseVerdicts('not json at all {{{', rows);
  assert.equal(verdicts.size, 0);
  assert.equal(errors.length, 1);
  assert.equal(parseFailed, true);
});

test('parseVerdicts collapses tabs and newlines in explanations so a row cannot split', () => {
  const rows = [{ ...row({ ref: '1:1', sref: 'figs-metaphor', explanation: 'x' }), index: 0 }];
  const text = JSON.stringify([{ index: 0, verdict: 'tcm', explanation: 'TCM i:(1) a\n\t(2)  b', sref: null, reason: 'r\nq' }]);
  const { verdicts } = parseVerdicts(text, rows);
  assert.equal(verdicts.get(0).explanation, 'TCM i:(1) a (2) b');
  assert.equal(verdicts.get(0).reason, 'r q');
});

test('parseVerdicts rejects a retype outside the issue-type catalog and reports missing rows', () => {
  const rows = [
    { ...row({ ref: '1:1', sref: 'figs-idiom', explanation: 'x' }), index: 0 },
    { ...row({ ref: '1:2', sref: 'figs-idiom', explanation: 'y' }), index: 1 },
  ];
  const text = JSON.stringify([{ index: 0, verdict: 'retype', explanation: 'e', sref: 'figs-implication', reason: '' }]);
  const { verdicts, errors, parseFailed } = parseVerdicts(text, rows, ['figs-explicit', 'figs-idiom']);
  assert.equal(verdicts.size, 0);
  assert.equal(parseFailed, false);
  assert.ok(errors.some((e) => /not in the issue-type catalog/.test(e)));
  assert.ok(errors.some((e) => /2 row\(s\) received no verdict/.test(e)));
  const ok = parseVerdicts(JSON.stringify([{ index: 0, verdict: 'retype', explanation: 'e', sref: 'figs-explicit', reason: '' }]), rows, ['figs-explicit']);
  assert.equal(ok.verdicts.get(0).sref, 'figs-explicit');
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

// --- source text preparation ---------------------------------------------------------

test('sliceChapter cuts one chapter out of a whole-book USFM and leaves a chapter file alone', () => {
  const book = '\\id EZK\n\\c 1\n\\v 1 one\n\\c 2\n\\v 1 two\n\\c 10\n\\v 1 ten\n';
  assert.equal(sliceChapter(book, 1), '\\c 1\n\\v 1 one\n');
  assert.equal(sliceChapter(book, 2), '\\c 2\n\\v 1 two\n');
  assert.equal(sliceChapter(book, 10), '\\c 10\n\\v 1 ten\n');
  assert.equal(sliceChapter('\\c 3\n\\v 1 only\n', 3), '\\c 3\n\\v 1 only\n');
  assert.equal(sliceChapter('\\v 1 no chapter marker\n', 3), '\\v 1 no chapter marker\n');
});

test('stripWordMarkup reduces aligned ULT and UHB word markup to bare words', () => {
  const aligned = '\\v 1 \\zaln-s |x-strong="H1961" x-content="וַיְהִי"\\*\\w And|x-occurrence="1" x-occurrences="1"\\w* \\w it|x-occurrence="1" x-occurrences="1"\\w*\\zaln-e\\*';
  assert.equal(stripWordMarkup(aligned), '\\v 1 And it');
  const uhb = '\\v 1 \\w וַ⁠יְהִ֣י|lemma="הָיָה" strong="c:H1961" x-morph="He,C:Vqw3ms"\\w*';
  assert.equal(stripWordMarkup(uhb), '\\v 1 וַ⁠יְהִ֣י');
});

test('prepareSourceText prefers the plain file and slices a whole-book Hebrew source to the chapter', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'interp-src-'));
  fs.writeFileSync(path.join(ws, 'ult_aligned.usfm'), '\\c 1\n\\v 1 \\w aligned|x=1\\w*\n');
  fs.writeFileSync(path.join(ws, 'ult_plain.usfm'), '\\c 1\n\\v 1 plain\n');
  fs.writeFileSync(path.join(ws, 'heb.usfm'), '\\id EZK\n\\c 1\n\\v 1 א\n\\c 2\n\\v 1 ב\n');
  const sources = { ult: 'ult_aligned.usfm', ultPlain: 'ult_plain.usfm', hebrew: 'heb.usfm' };
  assert.equal(prepareSourceText(ws, sources, { plainKey: 'ultPlain', rawKey: 'ult', label: 'ULT', chapter: 1 }), '\\c 1\n\\v 1 plain');
  assert.equal(prepareSourceText(ws, sources, { plainKey: 'hebrewPlain', rawKey: 'hebrew', label: 'Hebrew', chapter: 2 }), '\\c 2\n\\v 1 ב');
  assert.equal(prepareSourceText(ws, sources, { plainKey: 'ustPlain', rawKey: 'ust', label: 'UST', chapter: 1 }), '');
});

// --- issue-type canon in the prompt ----------------------------------------------------

test('extractGuideSummary keeps definition/confirmed/NOT sections and drops walkthroughs', () => {
  const md = '# figs-idiom\n\n## Purpose\nfind idioms\n\n## Definition\nnon-compositional\n\n## CONFIRMED figs-idiom Classifications\n| a | b |\n\n## NOT figs-idiom (Use These Instead)\n| c | d |\n\n## Recognition Process\n1. long walkthrough\n';
  const out = extractGuideSummary(md);
  assert.match(out, /non-compositional/);
  assert.match(out, /\| a \| b \|/);
  assert.match(out, /\| c \| d \|/);
  assert.doesNotMatch(out, /walkthrough/);
  assert.doesNotMatch(out, /find idioms/);
  assert.ok(extractGuideSummary('## Definition\n' + 'x'.repeat(5000), 100).length <= 102);
});

test('loadIssueTypeGuides reads only the types present and the prompt carries them', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'interp-guides-'));
  const dir = path.join(ws, '.claude/skills/issue-identification');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'figs-idiom.md'), '## Definition\nIDIOM-CANON\n');
  fs.writeFileSync(path.join(dir, 'figs-metaphor.md'), '## Definition\nMETAPHOR-CANON\n');
  const guides = loadIssueTypeGuides(ws, ['figs-idiom', 'figs-idiom', 'figs-missing', '../etc']);
  assert.deepEqual(Object.keys(guides), ['figs-idiom']);
  const prompt = buildReviewPrompt({ book: 'EZK', chapter: 1, ultText: '', ustText: '', hebrewText: '', rows: [], issueTypes: [], guides });
  assert.match(prompt, /IDIOM-CANON/);
  assert.doesNotMatch(prompt, /METAPHOR-CANON/);
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

test('runInterpretiveReview does not write in apply mode when any chunk failed, and does not run twice on resume', async () => {
  const workspaceDir = makeWorkspace();
  const oldCskillbpDir = process.env.CSKILLBP_DIR;
  process.env.CSKILLBP_DIR = workspaceDir;
  try {
    const issuesPath = 'tmp/pipeline/ISA-01/issues.tsv';
    const abs = path.resolve(workspaceDir, issuesPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const lines = [];
    for (let v = 1; v <= 3; v++) lines.push(`ISA\t1:${v}\tfigs-metaphor\tquote-${v}\t\t\told explanation ${v}`);
    fs.writeFileSync(abs, lines.join('\n') + '\n');
    const originalText = fs.readFileSync(abs, 'utf8');
    const pipeDir = 'tmp/pipeline/ISA-01';
    writeContext(pipeDir, { sources: {} });

    // maxRows 2 → two chunks; the second fails.
    let calls = 0;
    const flaky = async () => {
      calls++;
      if (calls === 1) {
        return { subtype: 'success', result: { text: JSON.stringify([
          { index: 0, verdict: 'revise', explanation: 'new one', sref: null, reason: '' },
          { index: 1, verdict: 'agree', explanation: null, sref: null, reason: '' },
        ]) } };
      }
      return { subtype: 'success', result: { text: 'not json' } };
    };
    const settings = { mode: 'apply', model: 'x', maxRows: 2 };
    const first = await runInterpretiveReview({ issuesPath, pipeDir, book: 'ISA', chapter: 1, workspaceDir, runClaudeImpl: flaky, status: null, settings });
    assert.equal(calls, 2);
    assert.equal(first.ran, true);
    assert.equal(first.written, false);
    assert.equal(fs.readFileSync(abs, 'utf8'), originalText);
    assert.ok(first.errors.some((e) => /apply skipped/.test(e)));

    // Resume: same chapter comes back through the stage; the marker stops it.
    const second = await runInterpretiveReview({ issuesPath, pipeDir, book: 'ISA', chapter: 1, workspaceDir, runClaudeImpl: flaky, status: null, settings });
    assert.equal(calls, 2);
    assert.equal(second.ran, false);
    assert.equal(second.skipped, 'already_ran');
  } finally {
    process.env.CSKILLBP_DIR = oldCskillbpDir;
  }
});

test('runInterpretiveReview never applies a drop from a response that skipped other rows', async () => {
  const workspaceDir = makeWorkspace();
  const oldCskillbpDir = process.env.CSKILLBP_DIR;
  process.env.CSKILLBP_DIR = workspaceDir;
  try {
    const issuesPath = 'tmp/pipeline/ISA-01/issues.tsv';
    const abs = path.resolve(workspaceDir, issuesPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const lines = [];
    for (let v = 1; v <= 5; v++) lines.push(`ISA\t1:${v}\tfigs-metaphor\tquote-${v}\t\t\told explanation ${v}`);
    fs.writeFileSync(abs, lines.join('\n') + '\n');
    const originalText = fs.readFileSync(abs, 'utf8');
    const pipeDir = 'tmp/pipeline/ISA-01';
    writeContext(pipeDir, { sources: {} });

    // One valid drop, four rows unanswered: 1 of 5 < the 25% drop guard, so only
    // the completeness rule stands between this response and a deleted row.
    const partial = async () => ({ subtype: 'success', result: { text: JSON.stringify([
      { index: 2, verdict: 'drop', explanation: null, sref: null, reason: 'not an issue' },
    ]) } });
    const result = await runInterpretiveReview({ issuesPath, pipeDir, book: 'ISA', chapter: 1, workspaceDir, runClaudeImpl: partial, status: null, settings: { mode: 'apply', model: 'x', maxRows: 40 } });

    assert.equal(result.ran, true);
    assert.equal(result.written, false);
    assert.equal(fs.readFileSync(abs, 'utf8'), originalText);
    assert.ok(result.errors.some((e) => /incomplete response/.test(e)));
    assert.equal(result.changed.filter((c) => c.verdict === 'drop').length, 1); // still reported
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
