// Guards the single liveness predicate shared by /health/pipelines
// (mcp-server.js), the resume gate (router.js), and the job-status endpoint
// bible-editor polls (api/pipeline.js). Before this was shared, job-status used
// a 12h window while the other two used the restart test, so a run killed by a
// fly.io restart reported healthy to bible-editor for hours.

const test = require('node:test');
const assert = require('node:assert/strict');

const PROCESS_START = Date.UTC(2026, 7, 3, 19, 22, 11);

function withProcessStart(fn) {
  const original = process.env.PROCESS_STARTED_AT_MS;
  process.env.PROCESS_STARTED_AT_MS = String(PROCESS_START);
  try {
    fn(require('../src/pipeline-liveness'));
  } finally {
    if (original == null) delete process.env.PROCESS_STARTED_AT_MS;
    else process.env.PROCESS_STARTED_AT_MS = original;
  }
}

const running = (updatedAt) => ({ state: 'running', updatedAt });

test('checkpoint written before process start is interrupted', () => {
  withProcessStart(({ isInterruptedRunningCheckpoint }) => {
    // The real NUM 27 case: checkpoint 19:21:12Z, process start 19:22:11Z.
    const cp = running(new Date(PROCESS_START - 59_000).toISOString());
    assert.equal(isInterruptedRunningCheckpoint(cp, PROCESS_START + 60_000), true);
  });
});

test('checkpoint written after process start is not interrupted', () => {
  withProcessStart(({ isInterruptedRunningCheckpoint }) => {
    const cp = running(new Date(PROCESS_START + 1000).toISOString());
    assert.equal(isInterruptedRunningCheckpoint(cp, PROCESS_START + 60_000), false);
  });
});

test('a long but progressing run is not interrupted', () => {
  withProcessStart(({ isInterruptedRunningCheckpoint, WEDGE_STALENESS_MS }) => {
    // A legitimate skill invocation can go 150 min without a checkpoint write,
    // and a full `generate` can run ~4h. Neither may be reported dead.
    const now = PROCESS_START + (4 * 60 * 60 * 1000);
    const cp = running(new Date(now - (150 * 60 * 1000)).toISOString());
    assert.ok(WEDGE_STALENESS_MS > 150 * 60 * 1000, 'window must clear the skill timeout');
    assert.equal(isInterruptedRunningCheckpoint(cp, now), false);
  });
});

test('a run wedged past the staleness window is interrupted even without a restart', () => {
  withProcessStart(({ isInterruptedRunningCheckpoint, WEDGE_STALENESS_MS }) => {
    const stampedAt = PROCESS_START + 1000;
    const now = stampedAt + WEDGE_STALENESS_MS + 1000;
    assert.equal(isInterruptedRunningCheckpoint(running(new Date(stampedAt).toISOString()), now), true);
  });
});

test('non-running and unparseable checkpoints are never interrupted', () => {
  withProcessStart(({ isInterruptedRunningCheckpoint }) => {
    const stale = new Date(PROCESS_START - 60_000).toISOString();
    const now = PROCESS_START + 60_000;
    for (const state of ['failed', 'complete', 'paused_for_outage']) {
      assert.equal(isInterruptedRunningCheckpoint({ state, updatedAt: stale }, now), false, state);
    }
    assert.equal(isInterruptedRunningCheckpoint(running('not-a-date'), now), false);
    assert.equal(isInterruptedRunningCheckpoint(running(undefined), now), false);
    assert.equal(isInterruptedRunningCheckpoint(null, now), false);
  });
});
