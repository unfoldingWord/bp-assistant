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

function buildMessage(content, overrides = {}) {
  return {
    id: 91,
    type: 'stream',
    display_recipient: 'Bot Testing',
    subject: 'TQ Testing',
    sender_id: 42,
    sender_full_name: 'Test User',
    sender_email: 'tester@example.com',
    content,
    ...overrides,
  };
}

function createHarness({ runClaudeImpl, verifyTqImpl, conflictChapters = new Set() } = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tqs-pipeline-'));
  const oldBaseDir = process.env.CSKILLBP_DIR;
  const oldStatusFile = process.env.ADMIN_STATUS_FILE;
  process.env.CSKILLBP_DIR = tempDir;
  process.env.ADMIN_STATUS_FILE = path.join(tempDir, 'admin-status.jsonl');

  const pipelinePath = require.resolve('../src/tqs-pipeline');
  const configPath = require.resolve('../src/config');
  const zulipPath = require.resolve('../src/zulip-client');
  const claudeRunnerPath = require.resolve('../src/claude-runner');
  const pipelineUtilsPath = require.resolve('../src/pipeline-utils');
  const door43PushPath = require.resolve('../src/door43-push');
  const repoVerifyPath = require.resolve('../src/repo-verify');
  const checkpointsPath = require.resolve('../src/pipeline-checkpoints');
  const usageTrackerPath = require.resolve('../src/usage-tracker');
  const miscToolsPath = require.resolve('../src/workspace-tools/misc-tools');
  const adminStatusPath = require.resolve('../src/admin-status');

  const sent = { stream: [], dm: [], reactions: [] };
  const runClaudeCalls = [];
  const pushCalls = [];
  const verifyCalls = [];
  const checkpoints = [];
  const summaries = [];

  delete require.cache[pipelinePath];
  delete require.cache[adminStatusPath];

  installStub(configPath, { adminUserId: 1 });
  installStub(zulipPath, {
    sendMessage: async (stream, topic, text) => sent.stream.push({ stream, topic, text }),
    sendDM: async (userId, text) => sent.dm.push({ userId, text }),
    addReaction: async (messageId, emoji) => sent.reactions.push({ op: 'add', messageId, emoji }),
    removeReaction: async (messageId, emoji) => sent.reactions.push({ op: 'remove', messageId, emoji }),
  });
  installStub(claudeRunnerPath, {
    DEFAULT_RESTRICTED_TOOLS: ['Read'],
    isTransientOutageError: () => false,
    runClaude: async (options) => {
      runClaudeCalls.push(options);
      if (runClaudeImpl) return runClaudeImpl({ options, tempDir });
      return { subtype: 'success', usage: {}, total_cost_usd: 0 };
    },
  });
  installStub(pipelineUtilsPath, {
    getDoor43Username: () => 'tester',
    emailToFallbackUsername: () => 'tester',
    buildBranchName: (book, chapter) => `AI-${book}-${String(chapter).padStart(book === 'PSA' ? 3 : 2, '0')}`,
    calcSkillTimeout: () => 1000,
    normalizeBookName: (name) => String(name || '').toUpperCase(),
    CSKILLBP_DIR: tempDir,
  });
  installStub(door43PushPath, {
    REPO_MAP: { tq: 'en_tq' },
    getRepoFilename: (type, book) => `${type}_${book}.tsv`.replace(/^tq_/, 'tq_'),
    checkConflictingBranches: async (_repo, _file, chapter) => (
      conflictChapters.has(chapter) ? [{ branch: `editor-${chapter}` }] : []
    ),
    door43Push: async (args) => {
      pushCalls.push(args);
      return { success: true, details: `push ok ${args.chapter}` };
    },
  });
  installStub(repoVerifyPath, {
    verifyDcsToken: async () => ({ valid: true, details: 'ok' }),
    verifyRepoPush: async (args) => {
      verifyCalls.push(args);
      return { success: true, details: 'verified' };
    },
  });
  installStub(checkpointsPath, {
    getCheckpoint: () => null,
    setCheckpoint: (_ref, patch) => {
      checkpoints.push(patch);
      return patch;
    },
    clearCheckpoint: () => {
      checkpoints.push({ cleared: true });
    },
  });
  installStub(usageTrackerPath, {
    getCumulativeTokens: () => 0,
    recordMetrics: () => {},
    recordRunSummary: (summary) => summaries.push(summary),
  });
  installStub(miscToolsPath, {
    verifyTq: (args) => (verifyTqImpl ? verifyTqImpl(args) : `Verified 1 rows in ${path.basename(args.tsvFile)}\nAll checks passed`),
  });

  const { tqsPipeline } = require('../src/tqs-pipeline');

  return {
    tempDir,
    sent,
    runClaudeCalls,
    pushCalls,
    verifyCalls,
    checkpoints,
    summaries,
    readStatusTexts() {
      if (!fs.existsSync(process.env.ADMIN_STATUS_FILE)) return [];
      return fs.readFileSync(process.env.ADMIN_STATUS_FILE, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line).message);
    },
    tqsPipeline,
    cleanup() {
      delete require.cache[pipelinePath];
      delete require.cache[configPath];
      delete require.cache[zulipPath];
      delete require.cache[claudeRunnerPath];
      delete require.cache[pipelineUtilsPath];
      delete require.cache[door43PushPath];
      delete require.cache[repoVerifyPath];
      delete require.cache[checkpointsPath];
      delete require.cache[usageTrackerPath];
      delete require.cache[miscToolsPath];
      delete require.cache[adminStatusPath];
      if (oldBaseDir == null) delete process.env.CSKILLBP_DIR;
      else process.env.CSKILLBP_DIR = oldBaseDir;
      if (oldStatusFile == null) delete process.env.ADMIN_STATUS_FILE;
      else process.env.ADMIN_STATUS_FILE = oldStatusFile;
    },
  };
}

test('tqsPipeline expands whole-book requests into a chapter loop', async () => {
  const harness = createHarness({
    runClaudeImpl: async ({ options, tempDir }) => {
      const chapterMatch = options.prompt.match(/chapter (\d+)/i);
      const chapter = Number(chapterMatch[1]);
      const outDir = path.join(tempDir, 'output', 'tq', 'HAB');
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, `HAB-${String(chapter).padStart(3, '0')}.tsv`), 'Reference\tID\tTags\tQuote\tOccurrence\tQuestion\tResponse\n1:1\taaaa\t\t\t\tQ\tA\n');
      return { subtype: 'success', usage: {}, total_cost_usd: 0 };
    },
  });

  try {
    await harness.tqsPipeline(
      { _synthetic: true, _book: 'HAB', _startChapter: 1, _endChapter: 3, _wholeBook: true },
      buildMessage('write tqs for hab')
    );

    assert.equal(harness.runClaudeCalls.length, 3);
    assert.deepEqual(harness.pushCalls.map((call) => call.chapter), [1, 2, 3]);
    assert.deepEqual(harness.verifyCalls.map((call) => call.repo), ['en_tq', 'en_tq', 'en_tq']);
    assert.equal(harness.summaries.at(-1).success, true);
  } finally {
    harness.cleanup();
  }
});

test('tqsPipeline loops requested chapter ranges only', async () => {
  const harness = createHarness({
    runClaudeImpl: async ({ options, tempDir }) => {
      const chapter = Number(options.prompt.match(/chapter (\d+)/i)[1]);
      const outDir = path.join(tempDir, 'output', 'tq', 'PSA');
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, `PSA-${String(chapter).padStart(3, '0')}.tsv`), 'Reference\tID\tTags\tQuote\tOccurrence\tQuestion\tResponse\n1:1\taaaa\t\t\t\tQ\tA\n');
      return { subtype: 'success', usage: {}, total_cost_usd: 0 };
    },
  });

  try {
    await harness.tqsPipeline(
      { _synthetic: true, _book: 'PSA', _startChapter: 1, _endChapter: 2, _wholeBook: false },
      buildMessage('write tqs for psa 1-2')
    );

    assert.deepEqual(harness.pushCalls.map((call) => call.chapter), [1, 2]);
  } finally {
    harness.cleanup();
  }
});

test('tqsPipeline blocks push when expected output file is missing', async () => {
  const harness = createHarness({
    runClaudeImpl: async () => ({ subtype: 'success', usage: {}, total_cost_usd: 0 }),
  });

  try {
    await harness.tqsPipeline(
      { _synthetic: true, _book: 'PSA', _startChapter: 23, _endChapter: 23, _wholeBook: false },
      buildMessage('write tqs for psa 23')
    );

    assert.equal(harness.pushCalls.length, 0);
    assert.equal(harness.summaries.at(-1).success, false);
    assert.ok(harness.readStatusTexts().some((text) => text.includes('expected output file missing')));
  } finally {
    harness.cleanup();
  }
});

test('tqsPipeline blocks push when verifyTq reports errors', async () => {
  const harness = createHarness({
    runClaudeImpl: async ({ tempDir }) => {
      const outDir = path.join(tempDir, 'output', 'tq', 'PSA');
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, 'PSA-023.tsv'), 'Reference\tID\tTags\tQuote\tOccurrence\tQuestion\tResponse\n1:1\taaaa\t\t\t\tQ\tA\n');
      return { subtype: 'success', usage: {}, total_cost_usd: 0 };
    },
    verifyTqImpl: () => 'Verified 1 rows in PSA-023.tsv\n1 error(s):\nLine 2: Invalid reference',
  });

  try {
    await harness.tqsPipeline(
      { _synthetic: true, _book: 'PSA', _startChapter: 23, _endChapter: 23, _wholeBook: false },
      buildMessage('write tqs for psa 23')
    );

    assert.equal(harness.pushCalls.length, 0);
    assert.equal(harness.summaries.at(-1).success, false);
  } finally {
    harness.cleanup();
  }
});

test('tqsPipeline blocks push for chapters with conflicting branches', async () => {
  const harness = createHarness({
    runClaudeImpl: async ({ tempDir }) => {
      const outDir = path.join(tempDir, 'output', 'tq', 'PSA');
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, 'PSA-023.tsv'), 'Reference\tID\tTags\tQuote\tOccurrence\tQuestion\tResponse\n1:1\taaaa\t\t\t\tQ\tA\n');
      return { subtype: 'success', usage: {}, total_cost_usd: 0 };
    },
    conflictChapters: new Set([23]),
  });

  try {
    await harness.tqsPipeline(
      { _synthetic: true, _book: 'PSA', _startChapter: 23, _endChapter: 23, _wholeBook: false },
      buildMessage('write tqs for psa 23')
    );

    assert.equal(harness.pushCalls.length, 0);
    assert.equal(harness.summaries.at(-1).success, false);
    assert.ok(harness.readStatusTexts().some((text) => text.includes('conflicting branches')));
  } finally {
    harness.cleanup();
  }
});
