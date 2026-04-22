const test = require('node:test');
const assert = require('node:assert/strict');

const {
  _classifyRunClaudeEmpty: classify,
  _AT_TIMEOUTS: atTimeouts,
  _DEFAULT_AT_CONCURRENCY: defaultAtConcurrency,
} = require('../src/notes-pipeline');

test('classifyRunClaudeEmpty: local timeout outcome → timeout_<phase>', () => {
  const timeoutResult = {
    subtype: 'timeout',
    timedOut: true,
    reason: 'timeout_local_abort',
    queryId: 'abc123',
    elapsedMs: 60123,
    configuredTimeoutMs: 60000,
    driftMs: 123,
  };
  assert.equal(classify(timeoutResult, 'generate'), 'timeout_generate');
  assert.equal(classify(timeoutResult, 'validate'), 'timeout_validate');
  assert.equal(classify(timeoutResult, 'retry'), 'timeout_retry');
});

test('classifyRunClaudeEmpty: SDK success with blank text → empty_text_after_success_<phase>', () => {
  const successBlank = { subtype: 'success', result: '' };
  assert.equal(classify(successBlank, 'generate'), 'empty_text_after_success_generate');
});

test('classifyRunClaudeEmpty: no_result subtype → no_result_<phase>', () => {
  const noResult = { subtype: 'no_result', reason: 'no_result_message' };
  assert.equal(classify(noResult, 'generate'), 'no_result_generate');
});

test('classifyRunClaudeEmpty: null/undefined result falls back to no_result', () => {
  assert.equal(classify(null, 'generate'), 'no_result_generate');
  assert.equal(classify(undefined, 'validate'), 'no_result_validate');
});

test('classifyRunClaudeEmpty: other non-success subtypes are tagged with the subtype', () => {
  const errored = { subtype: 'error_max_turns' };
  assert.equal(classify(errored, 'generate'), 'non_success_generate:error_max_turns');
  const unknown = {};
  assert.equal(classify(unknown, 'generate'), 'non_success_generate:unknown');
});

test('classifyRunClaudeEmpty: timedOut=true on non-timeout subtype still classifies as timeout', () => {
  // Defensive: if a caller sets timedOut without the canonical subtype.
  const weirdTimeout = { subtype: 'success', timedOut: true };
  assert.equal(classify(weirdTimeout, 'generate'), 'timeout_generate');
});

test('AT stage timeouts are extended to five minutes for generate, validate, and retry', () => {
  assert.deepEqual(atTimeouts, {
    generationMs: 5 * 60 * 1000,
    validationMs: 5 * 60 * 1000,
    retryMs: 5 * 60 * 1000,
  });
});

test('AT generation defaults to lower concurrency to reduce rate-limit pressure', () => {
  assert.equal(defaultAtConcurrency, 2);
});
