// Tests for scripts/log-tee.js — the rotating tee that copies the bot's stdout
// (piped in via process substitution in entrypoint.sh, see issue #290) to both
// the container's stdout (so `fly logs` keeps working) and a file on the Fly
// volume (which survives past Fly's short live-tail retention).
//
// Runs log-tee.js as a real child process (spawnSync) writing to a temp dir —
// this exercises the actual stdin/stdout/file-write path, not just in-process
// logic.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.resolve(__dirname, '../scripts/log-tee.js');

function runTee(logFile, input, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, logFile], {
    encoding: 'utf8',
    input,
    env: { ...process.env, ...env },
  });
}

function tmpLogPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-log-tee-'));
  return path.join(dir, 'app.log');
}

test('copies stdin to stdout unchanged', () => {
  const logFile = tmpLogPath();
  const result = runTee(logFile, 'hello\nworld\n');
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'hello\nworld\n');
});

test('writes the same content to the log file', () => {
  const logFile = tmpLogPath();
  const result = runTee(logFile, 'line one\nline two\n');
  assert.equal(result.status, 0);
  assert.equal(fs.readFileSync(logFile, 'utf8'), 'line one\nline two\n');
});

test('appends across separate runs rather than truncating', () => {
  const logFile = tmpLogPath();
  runTee(logFile, 'first run\n');
  runTee(logFile, 'second run\n');
  assert.equal(fs.readFileSync(logFile, 'utf8'), 'first run\nsecond run\n');
});

test('creates the log directory if missing', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-log-tee-'));
  const logFile = path.join(base, 'nested', 'dir', 'app.log');
  const result = runTee(logFile, 'created\n');
  assert.equal(result.status, 0);
  assert.equal(fs.readFileSync(logFile, 'utf8'), 'created\n');
});

test('rotates when the size cap is exceeded and prunes to the keep limit', () => {
  const logFile = tmpLogPath();
  // Small cap so a handful of short writes force multiple rotations.
  const env = { LOG_TEE_MAX_BYTES: '10', LOG_TEE_KEEP: '2' };
  // Each run appends one line and rotates independently to make rotation
  // boundaries deterministic (rotate() only fires between/at the end of writes
  // within a single process's stdin stream in this test, one run == one write).
  runTee(logFile, '0123456789\n', env); // 11 bytes >= cap -> rotate after write
  runTee(logFile, 'aaaaaaaaaa\n', env); // rotate again
  runTee(logFile, 'bbbbbbbbbb\n', env); // rotate again; keep=2 should prune oldest

  assert.ok(fs.existsSync(logFile), 'current log file should exist');
  assert.ok(fs.existsSync(`${logFile}.1`), 'most recent rotated file should exist');
  assert.ok(fs.existsSync(`${logFile}.2`), 'second rotated file should exist');
  assert.ok(!fs.existsSync(`${logFile}.3`), 'rotation must not keep more than LOG_TEE_KEEP files');
});

test('rotated file contents are preserved, not corrupted, across rotation', () => {
  const logFile = tmpLogPath();
  const env = { LOG_TEE_MAX_BYTES: '5', LOG_TEE_KEEP: '3' };
  // Each write (7 bytes) exceeds the 5-byte cap on its own, so each run rotates
  // immediately after its single write and leaves the new current file empty.
  runTee(logFile, 'AAAAAA\n', env);
  runTee(logFile, 'BBBBBB\n', env);

  const contents = ['', `.1`, `.2`, `.3`]
    .map((suffix) => `${logFile}${suffix}`)
    .filter(fs.existsSync)
    .map((f) => fs.readFileSync(f, 'utf8'));
  // Whatever landed across the rotated files must be exactly the two writes,
  // verbatim (no truncation, no interleaving of the two runs' bytes).
  assert.ok(contents.includes('AAAAAA\n'), `expected AAAAAA\\n among: ${JSON.stringify(contents)}`);
  assert.ok(contents.includes('BBBBBB\n'), `expected BBBBBB\\n among: ${JSON.stringify(contents)}`);
});

test('still copies stdin to stdout even when the log path cannot be created', () => {
  // Point the log file inside a path component that is actually a file, so
  // mkdirSync(recursive) / openSync fail — this must degrade to pass-through,
  // never crash or swallow stdout.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-log-tee-'));
  const blocker = path.join(base, 'not-a-dir');
  fs.writeFileSync(blocker, 'x');
  const logFile = path.join(blocker, 'app.log');

  const result = runTee(logFile, 'still visible\n');
  assert.equal(result.stdout, 'still visible\n');
  assert.match(result.stderr, /\[log-tee\] disabling file logging/);
});

test('passes stdin through stdout for large multi-chunk input', () => {
  const logFile = tmpLogPath();
  const big = 'x'.repeat(200_000) + '\n';
  const result = runTee(logFile, big);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, big);
  assert.equal(fs.readFileSync(logFile, 'utf8'), big);
});

test('exits 2 with usage message when no log path is given', () => {
  const result = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', input: '' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage: log-tee\.js/);
});

test('age pruning: removes old rotated siblings but never the active file', () => {
  const logFile = tmpLogPath();
  fs.writeFileSync(logFile, 'active\n');
  fs.writeFileSync(`${logFile}.1`, 'old rotated\n');
  fs.writeFileSync(`${logFile}.2`, 'recent rotated\n');

  const oldTime = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000); // 40 days ago
  const recentTime = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000); // 2 days ago
  fs.utimesSync(logFile, oldTime, oldTime); // active file: deliberately old mtime too
  fs.utimesSync(`${logFile}.1`, oldTime, oldTime);
  fs.utimesSync(`${logFile}.2`, recentTime, recentTime);

  const result = runTee(logFile, 'new line\n', { LOG_TEE_MAX_AGE_DAYS: '30' });

  assert.equal(result.status, 0);
  assert.ok(fs.existsSync(logFile), 'active file must never be age-pruned, regardless of its own mtime');
  assert.ok(!fs.existsSync(`${logFile}.1`), 'rotated sibling older than the max age should be pruned');
  assert.ok(fs.existsSync(`${logFile}.2`), 'rotated sibling within the max age should be kept');
});

test('age pruning: default of 30 days does not touch fresh rotated siblings', () => {
  const logFile = tmpLogPath();
  fs.writeFileSync(`${logFile}.1`, 'fresh\n');
  // No LOG_TEE_MAX_AGE_DAYS override — exercise the documented default.
  const result = runTee(logFile, 'x\n');
  assert.equal(result.status, 0);
  assert.ok(fs.existsSync(`${logFile}.1`), 'freshly-written rotated sibling must survive the default 30-day prune');
});

test('stdout backpressure: pausing/resuming stdin loses no data and does not hang', async () => {
  const logFile = tmpLogPath();
  const child = spawn(process.execPath, [SCRIPT, logFile]);

  // One chunk comfortably larger than a typical OS pipe buffer, repeated
  // enough times that log-tee's process.stdout.write() is very likely to
  // return false at least once, forcing the pause/resume path.
  const chunk = 'y'.repeat(65536) + '\n';
  const chunkCount = 20;
  const totalExpected = chunk.length * chunkCount;

  // Deliberately do NOT read child.stdout yet, so the OS pipe backs up and
  // log-tee is forced to pause its own stdin — this is what proves the
  // pause/resume wiring engages, not just that data eventually arrives.
  for (let i = 0; i < chunkCount; i++) {
    child.stdin.write(chunk);
  }
  child.stdin.end();

  await new Promise((resolve) => setTimeout(resolve, 250));

  let stdoutData = '';
  child.stdout.on('data', (d) => {
    stdoutData += d;
  });

  const [code] = await new Promise((resolve) => {
    child.on('close', (c) => resolve([c]));
  });

  assert.equal(code, 0);
  assert.equal(stdoutData.length, totalExpected, 'no bytes lost or duplicated across the pause/resume cycle');
  assert.equal(fs.readFileSync(logFile, 'utf8').length, totalExpected);
});

test('stdout error tolerance: a downstream reader going away exits quietly instead of crashing', async () => {
  const logFile = tmpLogPath();
  const child = spawn(process.execPath, [SCRIPT, logFile]);

  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d.toString();
  });

  // Destroy our read end immediately so the child's stdout write hits a
  // broken pipe (EPIPE) instead of a live reader.
  child.stdout.destroy();

  child.stdin.write('x'.repeat(1000) + '\n');

  const [code, signal] = await new Promise((resolve) => {
    child.on('close', (c, s) => resolve([c, s]));
  });

  assert.equal(signal, null, 'must not die from an unhandled error / uncaught exception');
  assert.equal(code, 0, 'a dead stdout reader must exit quietly (0), not crash');
  assert.doesNotMatch(stderr, /Unhandled|Uncaught|EPIPE/, 'the EPIPE must be swallowed, not rethrown to stderr');
});
