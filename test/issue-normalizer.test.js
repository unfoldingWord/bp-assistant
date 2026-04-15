const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeIssueRows } = require('../src/issue-normalizer');

function row({
  book = 'PSA',
  ref,
  sref = 'figs-parallelism',
  quote = 'a and b',
  explanation = 'synonymous parallelism',
}) {
  return [book, ref, sref, quote, '', '', explanation].join('\t');
}

function keptRefs(lines) {
  return lines
    .map((line) => line.split('\t'))
    .filter((cols) => String(cols[2] || '').toLowerCase().trim() === 'figs-parallelism')
    .map((cols) => cols[1]);
}

test('normalizeIssueRows keeps only first synonymous parallelism by default', () => {
  const input = [
    row({ ref: '35:1', quote: 'A; B', explanation: 'synonymous parallelism t: first instance' }),
    row({ ref: '35:4', quote: 'C; D', explanation: 'synonymous parallelism' }),
    row({ ref: '35:7', quote: 'E; F', explanation: 'synonymous parallelism' }),
  ];
  const result = normalizeIssueRows(input);
  assert.deepEqual(keptRefs(result.lines), ['35:1']);
  assert.equal(result.summary.kept_parallelism_rows, 1);
  assert.equal(result.summary.dropped_unqualified_parallelism_rows, 2);
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

test('normalizeIssueRows drops qualified unique parallelism with invalid reason', () => {
  const input = [
    row({ ref: '35:1', quote: 'A; B', explanation: 'synonymous parallelism t: first instance' }),
    row({
      ref: '35:9',
      quote: 'X; Y; Z',
      explanation: 'synonymous parallelism q: unique-parallelism reason: vague',
    }),
  ];
  const result = normalizeIssueRows(input);
  assert.deepEqual(keptRefs(result.lines), ['35:1']);
  assert.equal(result.summary.dropped_invalid_reason_parallelism_rows, 1);
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
