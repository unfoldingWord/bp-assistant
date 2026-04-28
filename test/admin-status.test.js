const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('publishAdminStatus persists events and readAdminStatus returns newest first', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-status-'));
  const oldFile = process.env.ADMIN_STATUS_FILE;
  process.env.ADMIN_STATUS_FILE = path.join(tempDir, 'admin-status.jsonl');

  delete require.cache[require.resolve('../src/admin-status')];
  const { publishAdminStatus, readAdminStatus } = require('../src/admin-status');

  try {
    await publishAdminStatus({
      source: 'generate-pipeline',
      pipelineType: 'generate',
      message: 'Running **align-all-parallel** for NUM 17...',
    });
    await publishAdminStatus({
      source: 'generate-pipeline',
      pipelineType: 'generate',
      message: 'Repo verify OK for NUM 17: ULT and UST merged to master',
    });

    const events = readAdminStatus({ limit: 10 });
    assert.equal(events.length, 2);
    assert.equal(events[0].message, 'Repo verify OK for NUM 17: ULT and UST merged to master');
    assert.equal(events[0].scope, 'NUM 17');
    assert.equal(events[0].phase, 'verify');
    assert.equal(events[0].severity, 'success');
    assert.equal(events[1].phase, 'align');
    assert.equal(events[1].severity, 'active');
    assert.equal(typeof events[0].timestamp, 'string');
    assert.match(fs.readFileSync(process.env.ADMIN_STATUS_FILE, 'utf8'), /Running \*\*align-all-parallel\*\* for NUM 17/);
  } finally {
    if (oldFile == null) delete process.env.ADMIN_STATUS_FILE;
    else process.env.ADMIN_STATUS_FILE = oldFile;
    delete require.cache[require.resolve('../src/admin-status')];
  }
});

test('inferSeverity treats "succeeded with 0 failed" terminal summaries as success', () => {
  const { inferSeverity } = require('../src/admin-status');
  const severity = inferSeverity('Generation complete for **ZEC 4-4**: 1 succeeded, 0 failed.');
  assert.equal(severity, 'success');
});

test('inferSeverity treats terminal failures as error', () => {
  const { inferSeverity } = require('../src/admin-status');
  assert.equal(inferSeverity('Notes pipeline for PSA 39 failed — all 1 chapter(s) had errors.'), 'error');
  assert.equal(inferSeverity('Generation complete for **ZEC 4-4**: 0 succeeded, 1 failed.'), 'error');
});
