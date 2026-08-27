// Regression tests for issue #349: an unfixable, unwritable path under a
// door43 repo's .git tree must abort the run at preflight and land on
// admin-status, instead of surfacing ~55 minutes later as an EACCES at
// door43-push.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function installStub(modulePath, exportsValue) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports: exportsValue,
  };
}

const runnerPath = require.resolve('../src/pipeline-runner');
const sweepPath = require.resolve('../src/ownership-sweep');
const notesPipelinePath = require.resolve('../src/notes-pipeline');

// partitionBlocked is pure, so the stub reuses the real implementation.
const { partitionBlocked } = require('../src/ownership-sweep');

function setup({ blocked }) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-ownership-'));
  process.env.ADMIN_STATUS_FILE = path.join(tempDir, 'admin-status.jsonl');

  delete require.cache[runnerPath];
  delete require.cache[require.resolve('../src/admin-status')];

  installStub(sweepPath, {
    sweepWorkspaceOwnership: () => ({
      foreign: blocked.slice(),
      blocked: blocked.slice(),
      chowned: 0,
      canChown: false,
      targetUid: 1001,
      targetGid: 1001,
    }),
    sweepStaleTmp: () => null,
    partitionBlocked,
  });

  let notesRan = false;
  installStub(notesPipelinePath, {
    notesPipeline: async () => {
      notesRan = true;
    },
  });

  const { runPipeline } = require(runnerPath);
  const { readAdminStatus } = require('../src/admin-status');
  return { runPipeline, readAdminStatus, notesRan: () => notesRan };
}

function teardown() {
  delete require.cache[sweepPath];
  delete require.cache[notesPipelinePath];
  delete require.cache[runnerPath];
  delete require.cache[require.resolve('../src/admin-status')];
  delete process.env.ADMIN_STATUS_FILE;
}

test('runPipeline aborts before work starts when a door43 .git path is blocked', async () => {
  const blockedPath = '/data/workspace/door43-repos/en_tn/.git/objects/6d';
  const { runPipeline, readAdminStatus, notesRan } = setup({ blocked: [blockedPath] });

  try {
    await assert.rejects(
      () => runPipeline({ type: 'notes', name: 'write-notes' }, { content: '/write notes JER 4' }),
      (err) => {
        assert.equal(err.errorKind, 'workspace_ownership_blocked');
        assert.match(err.message, /door43-repos/);
        return true;
      },
    );

    assert.equal(notesRan(), false, 'the notes pipeline must not start');

    const events = readAdminStatus({});
    const errors = events.filter((e) => e.severity === 'error');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].phase, 'preflight');
    assert.equal(errors[0].pipelineType, 'notes');
    assert.match(errors[0].message, /would fail at door43-push/);
    assert.match(errors[0].message, /6d/);
  } finally {
    teardown();
  }
});

test('runPipeline warns but proceeds when blocked paths are outside door43 git trees', async () => {
  const { runPipeline, readAdminStatus, notesRan } = setup({
    blocked: ['/data/workspace/output/JER/4/stale.tsv'],
  });

  try {
    await runPipeline({ type: 'notes', name: 'write-notes' }, { content: '/write notes JER 4' });

    assert.equal(notesRan(), true, 'a non-fatal ownership problem must not block the run');

    const events = readAdminStatus({});
    const warns = events.filter((e) => e.severity === 'warn');
    assert.equal(warns.length, 1);
    assert.equal(warns[0].phase, 'preflight');
    assert.match(warns[0].message, /may cause EACCES/);
    assert.equal(events.filter((e) => e.severity === 'error').length, 0);
  } finally {
    teardown();
  }
});

test('runPipeline is unaffected when the sweep reports nothing blocked', async () => {
  const { runPipeline, readAdminStatus, notesRan } = setup({ blocked: [] });

  try {
    await runPipeline({ type: 'notes', name: 'write-notes' }, { content: '/write notes JER 4' });
    assert.equal(notesRan(), true);
    assert.deepEqual(readAdminStatus({}), [], 'a clean sweep must stay silent');
  } finally {
    teardown();
  }
});
