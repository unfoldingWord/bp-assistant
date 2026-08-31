// Tests for the optional-ccusage fallback in src/usage-tracker.js (issue #355).
//
// ccusage is an optional dependency. The bot's Docker image installs it, but the
// automation host runs scripts straight from a bare checkout with no node_modules,
// so the import fails there. That is an expected, non-fatal fallback — getHeadroom()
// degrades to bot-log-only and reports ccusageOk: false.
//
// The bug: the failed import was not memoized, so every getHeadroom() call retried
// the dynamic import and re-emitted `console.warn('[usage-tracker] ccusage library
// not available: ...')`, spamming every cron run's log.
//
// These run usage-tracker in a real child process so the module-level memo starts
// cold and console output is captured exactly as a cron run would see it.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Call getHeadroom() N times in a fresh process and report what it logged.
function runHeadroom({ calls = 3, env = {} } = {}) {
  const script = `
    const tracker = require(${JSON.stringify(path.join(ROOT, 'src/usage-tracker.js'))});
    (async () => {
      let room;
      for (let i = 0; i < ${calls}; i++) room = await tracker.getHeadroom();
      console.log('__RESULT__' + JSON.stringify({ ccusageOk: room.ccusageOk, used: room.used }));
    })().catch(e => { console.log('__THREW__' + e.message); process.exit(1); });
  `;
  const res = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    cwd: ROOT,
    env: { ...process.env, ...env },
  });
  const all = `${res.stdout}${res.stderr}`;
  const marker = res.stdout.match(/__RESULT__(.*)/);
  return {
    status: res.status,
    output: all,
    threw: all.includes('__THREW__'),
    result: marker ? JSON.parse(marker[1]) : null,
    // Every line that mentions ccusage, regardless of console level.
    ccusageLines: all.split('\n').filter(l => /ccusage/i.test(l) && !l.includes('__RESULT__')),
  };
}

test('repeated getHeadroom() calls emit no ccusage warning when the package is absent', () => {
  const run = runHeadroom({ calls: 5 });

  assert.equal(run.threw, false, `getHeadroom() threw:\n${run.output}`);
  assert.equal(run.status, 0, `exited non-zero:\n${run.output}`);

  // The regression: the old code logged once per call, at warn level.
  assert.deepEqual(
    run.ccusageLines,
    [],
    `expected a silent fallback, got:\n${run.ccusageLines.join('\n')}`
  );
  assert.ok(
    !/ccusage library not available/.test(run.output),
    'the old unconditional warn string must not appear'
  );
});

test('getHeadroom() still returns a usable result via the bot-log-only path', () => {
  const run = runHeadroom({ calls: 1 });

  assert.ok(run.result, `no result parsed from:\n${run.output}`);
  // ccusage absent -> the ccusage source contributes nothing and says so.
  assert.equal(run.result.ccusageOk, false);
  assert.equal(typeof run.result.used, 'number');
  assert.ok(Number.isFinite(run.result.used));
});

test('BP_DEBUG surfaces the fallback exactly once, not once per call', () => {
  const run = runHeadroom({ calls: 5, env: { BP_DEBUG: '1' } });

  assert.equal(run.threw, false, `getHeadroom() threw:\n${run.output}`);
  assert.equal(
    run.ccusageLines.length,
    1,
    `expected exactly 1 debug line across 5 calls, got ${run.ccusageLines.length}:\n${run.ccusageLines.join('\n')}`
  );
  assert.match(run.ccusageLines[0], /ccusage unavailable, using bot-log only/);
});
