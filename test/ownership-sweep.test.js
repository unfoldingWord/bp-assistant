const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { sweepWorkspaceOwnership, sweepStaleTmp, partitionBlocked } = require('../src/ownership-sweep');

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

test('sweepWorkspaceOwnership walks custom subdirs (e.g. door43-repos) when provided', () => {
  // Regression for issue #207: door43-repos/<repo>/.git/objects/** must be
  // reachable by the sweep so a root-owned git object shard from a prior
  // privileged run doesn't EACCES the next unprivileged push.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-door43-'));
  const shardDir = path.join(base, 'door43-repos', 'en_tn', '.git', 'objects', '6d');
  fs.mkdirSync(shardDir, { recursive: true });
  const objFile = path.join(shardDir, '125395a5993b8cca36e4218751d6a00fc574b8');
  fs.writeFileSync(objFile, 'x');

  const res = sweepWorkspaceOwnership({
    baseDir: base,
    subdirs: ['output', 'tmp', 'door43-repos'],
    log: silent,
  });
  // All files here match the workspace owner (the test process), so foreign
  // should be empty — but the walk must have reached objFile, i.e. it must
  // not throw and must return a normal result object.
  assert.ok(res && Array.isArray(res.foreign));
  assert.deepEqual(res.foreign, []);
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

test('sweepStaleTmp never touches tmp/translate-* (editor-delivery outputs)', () => {
  // Editor-delivery files must remain fetchable via GET /api/pipeline/{jobId}/output
  // after 'done' — the checkpoint outlives the scratch TTL, so the run dir must too.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-tmp-tr-'));
  const trDir = path.join(base, 'tmp', 'translate-ar-OBA-1-1-cafe1234', 'out');
  fs.mkdirSync(trDir, { recursive: true });
  const tsv = path.join(trDir, 'tq_OBA.tsv');
  fs.writeFileSync(tsv, 'x');
  const other = path.join(base, 'tmp', 'other-scratch.txt');
  fs.writeFileSync(other, 'y');
  const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  for (const p of [tsv, trDir, path.join(base, 'tmp', 'translate-ar-OBA-1-1-cafe1234'), other]) {
    fs.utimesSync(p, old, old);
  }

  const res = sweepStaleTmp({ baseDir: base, ttlDays: 7, log: silent });
  assert.equal(res.removed, 1);
  assert.equal(fs.existsSync(tsv), true);
  assert.equal(fs.existsSync(other), false);
});

// --- issue #349: foreign-owned-but-unwritable detection -------------------
// The bot normally runs unprivileged, so chownSync is not permitted and
// detection is the only mitigation. Foreign ownership on its own is not the
// failure predictor — unwritability is. `expectedUid` lets these tests force
// the foreign branch without needing root.

test('sweepWorkspaceOwnership does not flag foreign paths that are still writable', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-writable-'));
  const shardDir = path.join(base, 'door43-repos', 'en_tn', '.git', 'objects', '6d');
  fs.mkdirSync(shardDir, { recursive: true });

  const res = sweepWorkspaceOwnership({
    baseDir: base,
    subdirs: ['door43-repos'],
    expectedUid: process.getuid() + 1, // force every path to look foreign
    log: silent,
  });

  assert.ok(res.foreign.length > 0, 'paths should be seen as foreign-owned');
  assert.deepEqual(res.blocked, [], 'writable paths are not an EACCES risk');
});

test('sweepWorkspaceOwnership flags a foreign, unwritable git object shard as blocked', () => {
  // Reproduces issue #349: a root-owned .git/objects/<shard> dir that the
  // unprivileged bot cannot create new loose objects in. The sweep must report
  // it up front rather than letting door43-push discover it ~55 min into a run.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-blocked-'));
  const shardDir = path.join(base, 'door43-repos', 'en_tn', '.git', 'objects', '6d');
  fs.mkdirSync(shardDir, { recursive: true });
  fs.chmodSync(shardDir, 0o555); // readable + traversable, not writable

  try {
    const res = sweepWorkspaceOwnership({
      baseDir: base,
      subdirs: ['door43-repos'],
      expectedUid: process.getuid() + 1,
      log: silent,
    });

    assert.ok(res.blocked.includes(shardDir), 'unwritable shard dir must be blocked');
    const { fatal, advisory } = partitionBlocked(res.blocked);
    assert.ok(fatal.includes(shardDir), 'a door43 .git path must be fatal, not advisory');
    assert.deepEqual(advisory, []);
  } finally {
    fs.chmodSync(shardDir, 0o755);
  }
});

test('sweepWorkspaceOwnership reports blocked: [] when ownership is clean', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-clean-'));
  fs.mkdirSync(path.join(base, 'output'), { recursive: true });
  fs.writeFileSync(path.join(base, 'output', 'a.tsv'), 'x');

  const res = sweepWorkspaceOwnership({ baseDir: base, log: silent });
  assert.deepEqual(res.foreign, []);
  assert.deepEqual(res.blocked, []);
});

test('partitionBlocked separates door43 git trees from everything else', () => {
  const { fatal, advisory } = partitionBlocked([
    '/data/workspace/door43-repos/en_tn/.git/objects/6d',
    '/data/workspace/door43-repos/en_ult/.git',
    '/data/workspace/output/JER/4/notes.tsv',
    '/data/workspace/door43-repos/en_tn/README.md',
  ]);

  assert.deepEqual(fatal, [
    '/data/workspace/door43-repos/en_tn/.git/objects/6d',
    '/data/workspace/door43-repos/en_ult/.git',
  ]);
  assert.deepEqual(advisory, [
    '/data/workspace/output/JER/4/notes.tsv',
    '/data/workspace/door43-repos/en_tn/README.md',
  ]);
});
