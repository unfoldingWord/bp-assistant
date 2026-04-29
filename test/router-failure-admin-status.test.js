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

test('router publishes admin-status event when pipeline dispatch throws', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-failure-status-'));
  const oldStatusFile = process.env.ADMIN_STATUS_FILE;
  process.env.ADMIN_STATUS_FILE = path.join(tempDir, 'admin-status.jsonl');

  const routerPath = require.resolve('../src/router');
  const configPath = require.resolve('../src/config');
  const pipelineRunnerPath = require.resolve('../src/pipeline-runner');
  const zulipPath = require.resolve('../src/zulip-client');
  const sessionStorePath = require.resolve('../src/session-store');
  const verseCountsPath = require.resolve('../src/verse-counts');
  const intentClassifierPath = require.resolve('../src/intent-classifier');
  const usageTrackerPath = require.resolve('../src/usage-tracker');
  const pendingMergesPath = require.resolve('../src/pending-merges');
  const checkpointsPath = require.resolve('../src/pipeline-checkpoints');
  const insertionResumePath = require.resolve('../src/insertion-resume');
  const pipelineUtilsPath = require.resolve('../src/pipeline-utils');
  const claudeRunnerPath = require.resolve('../src/claude-runner');

  delete require.cache[routerPath];

  installStub(configPath, {
    adminUserId: 100,
    authorizedUserIds: [100],
    unauthorizedReply: 'nope',
    dmDefaultPipeline: null,
    routes: [
      {
        name: 'write-notes',
        match: '/write notes(?:\\s+for)?\\s+(\\w+)\\s+(\\d+)/i',
        type: 'notes',
        reply: false,
      },
    ],
  });
  installStub(pipelineRunnerPath, {
    runPipeline: async () => {
      throw new Error('ctx is not defined');
    },
  });
  installStub(zulipPath, {
    sendMessage: async () => {},
    sendDM: async () => {},
    addReaction: async () => {},
    removeReaction: async () => {},
  });
  installStub(sessionStorePath, {
    getSession: () => null,
    clearSession: () => {},
    hasActiveStreamSession: () => false,
  });
  installStub(verseCountsPath, {
    getTotalVerses: () => 1,
    getChapterCount: () => 1,
  });
  installStub(intentClassifierPath, {
    classifyIntent: async () => ({ intent: 'unknown' }),
  });
  installStub(usageTrackerPath, {
    preflightCheck: async () => ({ decision: 'allow', estimate: {} }),
    estimateTokens: () => 0,
  });
  installStub(pendingMergesPath, {
    getPendingMerge: () => null,
    clearPendingMerge: () => {},
    getAllPendingMerges: () => [],
  });
  installStub(checkpointsPath, {
    getCheckpoint: () => null,
    setCheckpoint: () => {},
    clearCheckpoint: () => {},
    listCheckpoints: () => [],
  });
  installStub(insertionResumePath, {
    resumeInsertion: async () => {},
  });
  installStub(pipelineUtilsPath, {
    normalizeBookName: (value) => String(value || '').trim().toUpperCase().slice(0, 3),
    isValidBook: () => true,
  });
  installStub(claudeRunnerPath, {
    isTransientOutageError: () => false,
  });

  try {
    const { routeMessage } = require('../src/router');
    await routeMessage({
      id: 9001,
      type: 'private',
      sender_id: 100,
      sender_full_name: 'Admin User',
      content: 'write notes for zech 5',
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(fs.existsSync(process.env.ADMIN_STATUS_FILE), true);
    const events = fs.readFileSync(process.env.ADMIN_STATUS_FILE, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const latest = events[events.length - 1];
    assert.equal(latest.pipelineType, 'notes');
    assert.equal(latest.phase, 'router-dispatch');
    assert.equal(latest.severity, 'error');
    assert.equal(latest.scope, 'ZEC 5');
    assert.match(latest.message, /ctx is not defined/i);
  } finally {
    delete require.cache[routerPath];
    delete require.cache[configPath];
    delete require.cache[pipelineRunnerPath];
    delete require.cache[zulipPath];
    delete require.cache[sessionStorePath];
    delete require.cache[verseCountsPath];
    delete require.cache[intentClassifierPath];
    delete require.cache[usageTrackerPath];
    delete require.cache[pendingMergesPath];
    delete require.cache[checkpointsPath];
    delete require.cache[insertionResumePath];
    delete require.cache[pipelineUtilsPath];
    delete require.cache[claudeRunnerPath];
    if (oldStatusFile == null) delete process.env.ADMIN_STATUS_FILE;
    else process.env.ADMIN_STATUS_FILE = oldStatusFile;
  }
});
