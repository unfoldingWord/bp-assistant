// Regression tests for the scheduled Door43 refresh (#335).
//
// Two defects let the Fly volume's source data sit 1-6 months stale:
//
//   1. The weekly cron ran only `fetch-google`, so hbo_uhb/en_ult/en_ust/en_tn
//      and the three cache indexes were never refreshed on a schedule.
//   2. fetchDoor43Data's cache check skipped any file that merely carried a
//      "# Fetched:" header, so staleness was sticky -- a file fetched once was
//      never revisited without an explicit forced run.
//
// These tests pin both fixes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'weekly-refresh-'));
process.env.CSKILLBP_DIR = WS;

const { runWeeklyRefresh } = require('../src/cron-weekly-refresh');
const { shouldRefreshWeekly, CURATE_STEPS } = require('../src/curate-data');

// Silence the module's console output for the duration of a call.
async function quietly(fn) {
  const log = console.log, error = console.error;
  console.log = () => {}; console.error = () => {};
  try { return await fn(); } finally { console.log = log; console.error = error; }
}

test('weekly refresh requests a full forced run, not a Google-only one', async () => {
  const calls = [];
  await quietly(() => runWeeklyRefresh(async (opts) => {
    calls.push(opts);
    return { success: true, messages: ['ok'] };
  }));

  assert.equal(calls.length, 1);
  // No `step` means curatePublishedData runs every step in CURATE_STEPS --
  // crucially fetch-door43 (the four coordinated repos) and build-indexes.
  assert.equal(calls[0].step, undefined,
    'a `step` would narrow the run and re-open the gap this issue is about');
  assert.equal(calls[0].force, true, 'force is required to bypass the per-file cache');
});

test('the full run covers both the Door43 fetch and the index rebuild', () => {
  // Guards the assumption the test above relies on: a step-less run is only
  // sufficient because these two steps are in the pipeline.
  assert.ok(CURATE_STEPS.includes('fetch-door43'));
  assert.ok(CURATE_STEPS.includes('build-indexes'));
});

test('fetch errors are reported without throwing', async () => {
  const result = await quietly(() => runWeeklyRefresh(async () => ({
    success: true,
    messages: ['partial'],
    fetchErrors: [{ file: 'glossary.csv', message: '403' }],
  })));
  assert.equal(result.fetchErrors.length, 1);
});

test('a thrown curation error is swallowed so the cron keeps running', async () => {
  const result = await quietly(() => runWeeklyRefresh(async () => {
    throw new Error('Door43 unreachable');
  }));
  assert.equal(result, null);
});

test('shouldRefreshWeekly makes staleness self-healing, not sticky', () => {
  // The bug: a file fetched months ago was skipped forever because it had a
  // header at all. The age check must say "refresh" for it.
  assert.equal(shouldRefreshWeekly('2026-04-13'), true, 'an April file must refresh');

  // No header / unparseable date -> refetch, matching the old behaviour.
  assert.equal(shouldRefreshWeekly(null), true);
  assert.equal(shouldRefreshWeekly('not-a-date'), true);

  // A file fetched today is fresh and must NOT be refetched -- otherwise every
  // pipeline run would re-download the whole corpus.
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(shouldRefreshWeekly(today), false, 'a same-day file must be skipped');
});
