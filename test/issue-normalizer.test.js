const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeIssueRows, PARALLELISM_REPEAT_HINT } = require('../src/issue-normalizer');

function row({
  book = 'PSA',
  ref,
  sref = 'figs-parallelism',
  quote = 'a and b',
  explanation = 'synonymous parallelism',
}) {
  return [book, ref, sref, quote, '', '', explanation].join('\t');
}

function parallelismCols(lines) {
  return lines
    .map((line) => line.split('\t'))
    .filter((cols) => String(cols[2] || '').toLowerCase().trim() === 'figs-parallelism');
}

const isRepeat = (cols) => /\bt:\s*parallelism-repeat\s*$/.test(cols[6] || '');

function keptRefs(lines) {
  return lines
    .map((line) => line.split('\t'))
    .filter((cols) => String(cols[2] || '').toLowerCase().trim() === 'figs-parallelism')
    .map((cols) => cols[1]);
}

test('normalizeIssueRows keeps every synonymous parallelism and marks repeats for the simple template (#423)', () => {
  const input = [
    row({ ref: '35:1', quote: 'A; B', explanation: 'synonymous parallelism t: first instance' }),
    row({ ref: '35:4', quote: 'C; D', explanation: 'synonymous parallelism' }),
    row({ ref: '35:7', quote: 'E; F', explanation: 'synonymous parallelism' }),
    row({ ref: '35:9', quote: 'G; H', explanation: 'synonymous parallelism - same idea twice' }),
    row({ ref: '35:11', quote: 'I; J', explanation: 'synonymous parallelism' }),
    row({ ref: '35:14', quote: 'K; L', explanation: 'synonymous parallelism' }),
  ];
  const result = normalizeIssueRows(input);
  const cols = parallelismCols(result.lines);
  assert.equal(PARALLELISM_REPEAT_HINT, 'parallelism-repeat');
  assert.deepEqual(cols.map((c) => c[1]), ['35:1', '35:4', '35:7', '35:9', '35:11', '35:14']);
  assert.equal(cols[0][6], 'synonymous parallelism t: first instance');
  assert.equal(isRepeat(cols[0]), false);
  for (const c of cols.slice(1)) assert.equal(isRepeat(c), true, c[1]);
  assert.equal(cols[3][6], 'synonymous parallelism - same idea twice t: parallelism-repeat');
  assert.equal(result.summary.kept_parallelism_rows, 6);
  assert.equal(result.summary.kept_parallelism_repeats, 5);
  assert.equal(result.summary.dropped_parallelism_rows, 0);
});

test('normalizeIssueRows replaces other template hints on repeat rows', () => {
  const input = [
    row({ ref: '35:1', quote: 'A; B', explanation: 'synonymous parallelism t: first instance' }),
    row({ ref: '35:4', quote: 'C; D', explanation: 'synonymous parallelism t: combine i: keep both verbs' }),
    row({ ref: '35:7', quote: 'E; F', explanation: 'synonymous parallelism t: first instance' }),
  ];
  const result = normalizeIssueRows(input);
  const cols = parallelismCols(result.lines);
  assert.equal(cols[1][6], 'synonymous parallelism i: keep both verbs t: parallelism-repeat');
  assert.equal(cols[2][6], 'synonymous parallelism t: parallelism-repeat');
  assert.equal(cols.filter((c) => /first instance/i.test(c[6])).length, 1);
});

test('normalizeIssueRows allows one qualified unique parallelism with valid reason', () => {
  const input = [
    row({ ref: '35:1', quote: 'A; B', explanation: 'synonymous parallelism t: first instance' }),
    row({
      ref: '35:9',
      quote: 'X; Y; Z',
      explanation: 'synonymous parallelism q: unique-parallelism reason: tricola',
    }),
  ];
  const result = normalizeIssueRows(input);
  assert.deepEqual(keptRefs(result.lines), ['35:1', '35:9']);
  assert.equal(result.summary.kept_parallelism_exceptions, 1);
});

test('normalizeIssueRows routes unique parallelism with invalid reason or over the cap to the simple template', () => {
  const input = [
    row({ ref: '35:1', quote: 'A; B', explanation: 'synonymous parallelism t: first instance' }),
    row({ ref: '35:9', quote: 'X; Y; Z', explanation: 'synonymous parallelism q: unique-parallelism reason: vague' }),
    row({ ref: '35:10', quote: 'P; Q; R', explanation: 'synonymous parallelism q: unique-parallelism reason: tricola' }),
    row({ ref: '35:12', quote: 'S; T; U', explanation: 'synonymous parallelism q: unique-parallelism reason: pivot' }),
  ];
  const result = normalizeIssueRows(input);
  const cols = parallelismCols(result.lines);
  assert.deepEqual(cols.map((c) => c[1]), ['35:1', '35:9', '35:10', '35:12']);
  assert.deepEqual(cols.map(isRepeat), [false, true, false, true]);
  assert.equal(result.summary.kept_parallelism_exceptions, 1);
  assert.equal(result.summary.kept_parallelism_repeats, 2);
});

test('normalizeIssueRows drops synthetic and antithetical parallelism rows', () => {
  const input = [
    row({ ref: '35:1', quote: 'A; B', explanation: 'synonymous parallelism t: first instance' }),
    row({ ref: '35:2', quote: 'C; D', explanation: 'synthetic parallelism' }),
    row({ ref: '35:3', quote: 'E; F', explanation: 'antithetical parallelism' }),
  ];
  const result = normalizeIssueRows(input);
  assert.deepEqual(keptRefs(result.lines), ['35:1']);
  assert.equal(result.summary.dropped_nonsynonymous_parallelism_rows, 2);
});

test('normalizeIssueRows drops near-duplicate qualified unique parallelism', () => {
  const sharedQuote = 'May they be ashamed and confounded and turned back and disappointed without cause';
  const input = [
    row({ ref: '35:1', quote: sharedQuote, explanation: 'synonymous parallelism t: first instance' }),
    row({
      ref: '35:2',
      quote: sharedQuote,
      explanation: 'synonymous parallelism q: unique-parallelism reason: pivot',
    }),
  ];
  const result = normalizeIssueRows(input, { duplicateSimilarityThreshold: 0.6 });
  assert.deepEqual(keptRefs(result.lines), ['35:1']);
  assert.equal(result.summary.dropped_duplicate_parallelism_rows, 1);
});

test('normalizeIssueRows ensures only one first-instance marker remains', () => {
  const input = [
    row({ ref: '35:1', quote: 'A; B', explanation: 'synonymous parallelism t: first instance' }),
    row({
      ref: '35:9',
      quote: 'X; Y; Z',
      explanation: 'synonymous parallelism q: unique-parallelism reason: tricola t: first instance',
    }),
  ];
  const result = normalizeIssueRows(input);
  const parallelRows = result.lines.map((line) => line.split('\t')).filter((cols) => cols[2] === 'figs-parallelism');
  const firstTags = parallelRows.filter((cols) => /\bfirst instance\b/i.test(cols[6] || ''));
  assert.equal(firstTags.length, 1);
});

test('normalizeIssueRows emits high intro signal when raw synonymous count reaches threshold', () => {
  const input = [
    row({ ref: '35:1', explanation: 'synonymous parallelism t: first instance' }),
    row({ ref: '35:4', explanation: 'synonymous parallelism' }),
    row({ ref: '35:7', explanation: 'synonymous parallelism' }),
    row({ ref: '35:9', explanation: 'synonymous parallelism' }),
    row({ ref: '35:10', explanation: 'synonymous parallelism' }),
  ];
  const result = normalizeIssueRows(input, { highParallelismThreshold: 5 });
  assert.equal(result.introSignal.parallelism_signal, 'high');
  assert.equal(result.introSignal.parallelism_synonymous_count, 5);
});

test('normalizeIssueRows drops ellipsis rows that only restate ULT brace supplies', () => {
  const input = [
    row({ ref: '37:16', sref: 'figs-ellipsis', quote: 'Better {is} the little of the righteous', explanation: 'implied verb supplied in braces' }),
    row({ ref: '37:16', sref: 'figs-possession', quote: 'the little of the righteous', explanation: 'what belongs to the righteous' }),
  ];

  const result = normalizeIssueRows(input);
  const srefs = result.lines.map((line) => line.split('\t')[2]);

  assert.equal(srefs.includes('figs-ellipsis'), false);
  assert.equal(result.summary.dropped_braced_ellipsis_rows, 1);
});

test('normalizeIssueRows drops doublet rows subsumed by kept parallelism in same verse', () => {
  const input = [
    row({ ref: '37:1', sref: 'figs-doublet', quote: 'evildoers & doers of unrighteousness', explanation: 'doublet - two terms for wicked people' }),
    row({ ref: '37:1', sref: 'figs-parallelism', quote: 'Do not be upset about evildoers; do not be envious of the doers of unrighteousness', explanation: 'synonymous parallelism t: first instance' }),
  ];

  const result = normalizeIssueRows(input);
  const keptSrefs = result.lines.map((line) => line.split('\t')[2]);

  assert.deepEqual(keptSrefs, ['figs-parallelism']);
  assert.equal(result.summary.dropped_parallelism_overlap_doublets, 1);
});

test('normalizeIssueRows normalizes discontinuous quote ellipsis to ampersand syntax', () => {
  const input = [
    row({ ref: '37:33', sref: 'writing-pronouns', quote: 'him ... his hand', explanation: 'first him = righteous; his = wicked' }),
  ];

  const result = normalizeIssueRows(input);
  const cols = result.lines[0].split('\t');

  assert.equal(cols[3], 'him & his hand');
  assert.equal(result.summary.normalized_discontinuous_quotes, 1);
});
