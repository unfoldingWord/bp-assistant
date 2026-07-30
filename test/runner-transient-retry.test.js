'use strict';

// Unit tests for the transient-outage retry decision in claude-runner.
//
// DAN 7 notes (2026-07-29) died this way:
//   [claude-runner] Retry window exhausted after 686s and 1 attempts. Giving up for now.
//   Last error: ... API Error: 500 Internal server error
//
// One attempt, zero retries — from logic whose entire purpose is retrying. `startedAt`
// is stamped before the first attempt but `elapsed` is only checked after it returns,
// so an attempt that itself outlasts the 10-minute window has already blown the budget
// before the loop can try again. Any call hanging past the window was GUARANTEED no
// retry, which is exactly the case the window exists to cover. The chapter then parked
// in `paused_for_outage` — a state nothing auto-resumes — holding the single bot slot
// and blocking three queued jobs behind it.
//
// The fix is an attempt floor, itself bounded by a wall-clock ceiling: per-attempt
// timeouts run up to 150min, so an unbounded floor would trade a zero-retry bug for a
// hold-the-slot-for-7.5-hours bug.

const test = require('node:test');
const assert = require('node:assert');

const {
  shouldRetryTransient,
  isTransientSdkMessage,
  TRANSIENT_RETRY_WINDOW_MS,
  MIN_TRANSIENT_ATTEMPTS,
  TRANSIENT_RETRY_CEILING_MS,
} = require('../src/claude-runner');

const MIN = 60 * 1000;

test('the DAN 7 regression: a 686s first attempt still gets retried', () => {
  // attempt is 1-based at the decision point, so this is the state the real run was
  // in when it gave up: one attempt, 686s elapsed, already past the 10min window.
  assert.strictEqual(shouldRetryTransient(1, 686 * 1000), true);
});

test('the DAN 7 error text is classified transient', () => {
  // If this stops matching, the retry logic above is never even consulted.
  const real = 'Claude Code returned an error result: API Error: 500 Internal server error';
  assert.strictEqual(isTransientSdkMessage(real), true);
});

test('inside the window, retries proceed regardless of attempt count', () => {
  assert.strictEqual(shouldRetryTransient(1, 1 * MIN), true);
  assert.strictEqual(shouldRetryTransient(9, TRANSIENT_RETRY_WINDOW_MS - 1), true);
});

test('past the window, the attempt floor guarantees exactly MIN attempts', () => {
  const past = TRANSIENT_RETRY_WINDOW_MS + 1;
  // Attempts 1 and 2 retry; attempt 3 is the floor and stops. Total: 3 attempts.
  assert.strictEqual(shouldRetryTransient(1, past), true);
  assert.strictEqual(shouldRetryTransient(2, past), true);
  assert.strictEqual(shouldRetryTransient(MIN_TRANSIENT_ATTEMPTS, past), false);
});

test('the ceiling bounds the floor so a long hang cannot hold a slot for hours', () => {
  // An attempt near the 150min per-attempt timeout must NOT earn two more of the same.
  assert.strictEqual(shouldRetryTransient(1, TRANSIENT_RETRY_CEILING_MS + 1), false);
  assert.strictEqual(shouldRetryTransient(1, TRANSIENT_RETRY_CEILING_MS - 1), true);
});

test('the decision is total: every state either retries or stops, never both', () => {
  for (const attempt of [1, 2, 3, 4, 50]) {
    for (const mins of [0, 5, 9, 10, 11, 44, 45, 46, 150]) {
      const decision = shouldRetryTransient(attempt, mins * MIN);
      assert.strictEqual(typeof decision, 'boolean', `attempt=${attempt} mins=${mins}`);
    }
  }
});

test('the loop terminates: retrying always ends once both bounds are crossed', () => {
  const beyondBoth = Math.max(TRANSIENT_RETRY_WINDOW_MS, TRANSIENT_RETRY_CEILING_MS) + 1;
  assert.strictEqual(shouldRetryTransient(MIN_TRANSIENT_ATTEMPTS, beyondBoth), false);
  assert.strictEqual(shouldRetryTransient(1000, beyondBoth), false);
});
