const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { sweepWorkspaceOwnership, sweepStaleTmp } = require('../src/ownership-sweep');

const silent = { warn() {} };

test('sweepWorkspaceOwnership reports nothing when all files match the workspace owner', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-own-'));
  fs.mkdirSync(path.join(base, 'output', 'sub'), { recursive: true });
  fs.mkdirSync(path.join(base, 'tmp'), { recursive: true });
  fs.writeFileSync(path.join(base, 'output', 'sub', 'a.tsv'), 'x');
  fs.writeFileSync(path.join(base, 'tmp', 'b.json'), 'y');

  const res = sweepWorkspaceOwnership({ baseDir: base, log: silent });
  assert.deepEqual(res.foreign, []);
  assert.equal(res.chowned, 0);
});

test('sweepWorkspaceOwnership returns null when the workspace root is absent', () => {
  const res = sweepWorkspaceOwnership({ baseDir: path.join(os.tmpdir(), 'sweep-missing-' + Date.now()), log: silent });
  assert.equal(res, null);
});

test('sweepStaleTmp removes tmp entries older than the TTL and keeps fresh ones', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-tmp-'));
  const tmpDir = path.join(base, 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const oldFile = path.join(tmpDir, 'old.txt');
  const freshFile = path.join(tmpDir, 'fresh.txt');
  fs.writeFileSync(oldFile, 'old');
  fs.writeFileSync(freshFile, 'fresh');
  const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
  fs.utimesSync(oldFile, tenDaysAgo, tenDaysAgo);

  const res = sweepStaleTmp({ baseDir: base, ttlDays: 7, log: silent });
  assert.equal(res.removed, 1);
  assert.equal(fs.existsSync(oldFile), false);
  assert.equal(fs.existsSync(freshFile), true);
});

test('sweepStaleTmp is a no-op when ttlDays <= 0', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-tmp-off-'));
  fs.mkdirSync(path.join(base, 'tmp'), { recursive: true });
  const f = path.join(base, 'tmp', 'x.txt');
  fs.writeFileSync(f, 'x');
  const past = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
  fs.utimesSync(f, past, past);

  const res = sweepStaleTmp({ baseDir: base, ttlDays: 0, log: silent });
  assert.equal(res, null);
  assert.equal(fs.existsSync(f), true);
});

test('sweepStaleTmp never touches tmp/pipeline (resumable run state)', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-tmp-pipe-'));
  const pipeDir = path.join(base, 'tmp', 'pipeline', 'HAB-01');
  fs.mkdirSync(pipeDir, { recursive: true });
  const ctx = path.join(pipeDir, 'context.json');
  fs.writeFileSync(ctx, '{}');
  const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  fs.utimesSync(ctx, old, old);
  fs.utimesSync(pipeDir, old, old);
  fs.utimesSync(path.join(base, 'tmp', 'pipeline'), old, old);

  const res = sweepStaleTmp({ baseDir: base, ttlDays: 7, log: silent });
  assert.equal(res.removed, 0);
  assert.equal(fs.existsSync(ctx), true);
});
