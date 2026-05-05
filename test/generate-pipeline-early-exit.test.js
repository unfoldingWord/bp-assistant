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
    id: 77,
    type: 'stream',
    display_recipient: 'Bot Testing',
    subject: 'ISA 52',
    sender_id: 42,
    sender_full_name: 'Test User',
    sender_email: 'tester@example.com',
    content,
    ...overrides,
  };
}

function createHarness({ runClaudeImpl }) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'generate-pipeline-'));
  const oldBaseDir = process.env.CSKILLBP_DIR;
  const oldStatusFile = process.env.ADMIN_STATUS_FILE;
  process.env.CSKILLBP_DIR = tempDir;
  process.env.ADMIN_STATUS_FILE = path.join(tempDir, 'admin-status.jsonl');
  const requiredSkillFiles = [
    '.claude/skills/initial-pipeline/SKILL.md',
    '.claude/skills/issue-identification/orchestration-conventions.md',
    '.claude/skills/issue-identification/analyst-domains.md',
    '.claude/skills/issue-identification/challenger-protocol.md',
    '.claude/skills/issue-identification/merge-procedure.md',
    '.claude/skills/issue-identification/gemini-review-wave.md',
  ];
  for (const relPath of requiredSkillFiles) {
    const absPath = path.join(tempDir, relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, '# stub\n');
  }

  const generatePath = require.resolve('../src/generate-pipeline');
  const configPath = require.resolve('../src/config');
  const zulipPath = require.resolve('../src/zulip-client');
  const claudeRunnerPath = require.resolve('../src/claude-runner');
  const routerPath = require.resolve('../src/router');
  const authRefreshPath = require.resolve('../src/auth-refresh');
  const usageTrackerPath = require.resolve('../src/usage-tracker');
  const door43PushPath = require.resolve('../src/door43-push');
  const repoVerifyPath = require.resolve('../src/repo-verify');
  const pendingMergesPath = require.resolve('../src/pending-merges');
  const checkpointsPath = require.resolve('../src/pipeline-checkpoints');
  const pipelineContextPath = require.resolve('../src/pipeline-context');
  const pipelineUtilsPath = require.resolve('../src/pipeline-utils');
  const adminStatusPath = require.resolve('../src/admin-status');
  const selfDiagnosisPath = require.resolve('../src/self-diagnosis');

  const sent = {
    stream: [],
    dm: [],
    reactions: [],
    uploads: [],
  };
  const runClaudeCalls = [];
  const checkpoints = [];
  const runSummaries = [];
  const diagnosisCalls = [];

  delete require.cache[generatePath];
  delete require.cache[pipelineUtilsPath];
  delete require.cache[adminStatusPath];
  delete require.cache[selfDiagnosisPath];

  installStub(configPath, {
    adminUserId: 1,
    chrisUserId: 42,
    fileResponseUserIds: [42],
  });
  installStub(zulipPath, {
    sendMessage: async (stream, topic, text) => sent.stream.push({ stream, topic, text }),
    sendDM: async (userId, text) => sent.dm.push({ userId, text }),
    addReaction: async (messageId, emoji) => sent.reactions.push({ op: 'add', messageId, emoji }),
    removeReaction: async (messageId, emoji) => sent.reactions.push({ op: 'remove', messageId, emoji }),
    uploadFile: async (filePath, fileName) => {
      sent.uploads.push({ filePath, fileName });
      return `https://uploads.example/${encodeURIComponent(fileName)}`;
    },
  });
  installStub(claudeRunnerPath, {
    DEFAULT_RESTRICTED_TOOLS: [],
    isTransientOutageError: () => false,
    runClaude: async (options) => {
      runClaudeCalls.push(options);
      return runClaudeImpl({ options, tempDir });
    },
  });
  installStub(routerPath, {
    extractContentTypes: (content) => {
      const text = String(content || '');
      const hasUlt = /\bULT\b/i.test(text);
      const hasUst = /\bUST\b/i.test(text);
      if (hasUlt && !hasUst) return ['ult'];
      if (hasUst && !hasUlt) return ['ust'];
      return ['ult', 'ust'];
    },
  });
  installStub(authRefreshPath, {
    ensureFreshToken: async () => true,
    isAuthError: () => false,
  });
  installStub(usageTrackerPath, {
    getCumulativeTokens: () => 0,
    recordMetrics: () => {},
    recordRunSummary: (summary) => runSummaries.push(summary),
  });
  installStub(door43PushPath, {
    REPO_MAP: {},
    checkConflictingBranches: async () => [],
    door43Push: async () => ({ success: true, details: 'ok', noChanges: false }),
    getRepoFilename: () => 'dummy.usfm',
  });
  installStub(repoVerifyPath, {
    verifyDcsToken: async () => ({ valid: true, details: 'ok' }),
    verifyRepoPush: async () => ({ success: true, details: 'ok' }),
  });
  installStub(pendingMergesPath, {
    setPendingMerge: () => {},
  });
  installStub(checkpointsPath, {
    getCheckpoint: () => checkpoints.at(-1) || null,
    setCheckpoint: (_ref, patch) => {
      checkpoints.push(patch);
      return patch;
    },
    clearCheckpoint: () => {},
  });
  installStub(pipelineContextPath, {
    buildGenerateContext: () => ({ contextPath: 'tmp/context.json', dirPath: 'tmp/pipeline/ISA-52' }),
    buildUstContext: async () => ({ contextPath: 'tmp/ust-context.json', dirPath: 'tmp/pipeline/ISA-52', selectedUltPath: null }),
  });
  installStub(selfDiagnosisPath, {
    dispatchSelfDiagnosis: async (payload) => {
      diagnosisCalls.push(payload);
      return { ok: true, action: 'created' };
    },
  });

  const { generatePipeline } = require('../src/generate-pipeline');

  return {
    tempDir,
    sent,
    runClaudeCalls,
    checkpoints,
    runSummaries,
    diagnosisCalls,
    readStatusTexts() {
      if (!fs.existsSync(process.env.ADMIN_STATUS_FILE)) return [];
      return fs.readFileSync(process.env.ADMIN_STATUS_FILE, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line).message);
    },
    generatePipeline,
    cleanup() {
      delete require.cache[generatePath];
      delete require.cache[pipelineUtilsPath];
      delete require.cache[configPath];
      delete require.cache[zulipPath];
      delete require.cache[claudeRunnerPath];
      delete require.cache[routerPath];
      delete require.cache[authRefreshPath];
      delete require.cache[usageTrackerPath];
      delete require.cache[door43PushPath];
      delete require.cache[repoVerifyPath];
      delete require.cache[pendingMergesPath];
      delete require.cache[checkpointsPath];
      delete require.cache[pipelineContextPath];
      delete require.cache[adminStatusPath];
      delete require.cache[selfDiagnosisPath];
      if (oldBaseDir == null) delete process.env.CSKILLBP_DIR;
      else process.env.CSKILLBP_DIR = oldBaseDir;
      if (oldStatusFile == null) delete process.env.ADMIN_STATUS_FILE;
      else process.env.ADMIN_STATUS_FILE = oldStatusFile;
    },
  };
}

test('generatePipeline classifies initial-pipeline early exit when only Wave 2 artifacts exist', async () => {
  const harness = createHarness({
    runClaudeImpl: async ({ options, tempDir }) => {
      fs.mkdirSync(path.join(tempDir, 'output', 'AI-ULT', 'ISA'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, 'tmp', 'pipeline-ISA-52'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'output', 'AI-ULT', 'ISA', 'ISA-52.usfm'), '\\id ISA\n\\c 52\n\\v 1 test\n');
      fs.writeFileSync(path.join(tempDir, 'tmp', 'pipeline-ISA-52', 'wave2_structure.tsv'), 'isa\t52:1\tfigs-activepassive\tYou were sold\n');
      fs.writeFileSync(path.join(tempDir, 'tmp', 'pipeline-ISA-52', 'wave2_rhetoric.tsv'), 'isa\t52:1\tfigs-doublet\tAwake, awake\n');
      assert.match(options.appendSystemPrompt, /Do not return success/i);
      return { subtype: 'success', usage: {}, total_cost_usd: 0 };
    },
  });

  try {
    await harness.generatePipeline(
      { _synthetic: true, _book: 'ISA', _startChapter: 52, _endChapter: 52, skill: 'initial-pipeline', operations: 6 },
      buildMessage('generate isa 52')
    );

    assert.equal(harness.runClaudeCalls.length, 1);
    const statusTexts = harness.readStatusTexts();
    assert.ok(statusTexts.some((text) => text.includes('initial-pipeline exited before writing required outputs')));
    assert.ok(statusTexts.some((text) => text.includes('issues TSV, UST')));
    assert.ok(harness.checkpoints.some((patch) => patch.current?.errorKind === 'initial_pipeline_early_exit'));
    assert.equal(harness.diagnosisCalls.length, 1);
    assert.equal(harness.diagnosisCalls[0].event.severity, 'error');
    assert.equal(harness.diagnosisCalls[0].checkpoint.current.errorKind, 'initial_pipeline_early_exit');
    assert.match(harness.diagnosisCalls[0].errorText, /issues TSV, UST/);
    assert.match(harness.diagnosisCalls[0].errorText, /wave2_structure\.tsv/);
    assert.match(harness.diagnosisCalls[0].errorText, /Claude returned subtype=success/);
    assert.deepEqual(harness.runSummaries.at(-1), {
      pipeline: 'generate',
      book: 'ISA',
      startCh: 52,
      endCh: 52,
      tokensBefore: 0,
      success: false,
      userId: 42,
    });
  } finally {
    harness.cleanup();
  }
});

test('generatePipeline accepts initial-pipeline success when final ULT, issues, and UST outputs exist', async () => {
  const harness = createHarness({
    runClaudeImpl: async ({ options, tempDir }) => {
      fs.mkdirSync(path.join(tempDir, 'output', 'AI-ULT', 'ISA'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, 'output', 'AI-UST', 'ISA'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, 'output', 'issues', 'ISA'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'output', 'AI-ULT', 'ISA', 'ISA-52.usfm'), '\\id ISA\n\\c 52\n\\v 1 ult\n');
      fs.writeFileSync(path.join(tempDir, 'output', 'AI-UST', 'ISA', 'ISA-52.usfm'), '\\id ISA\n\\c 52\n\\v 1 ust\n');
      fs.writeFileSync(path.join(tempDir, 'output', 'issues', 'ISA', 'ISA-52.tsv'), 'isa\t52:1\tfigs-activepassive\tYou were sold\n');
      assert.match(options.appendSystemPrompt, /required outputs exist/i);
      return { subtype: 'success', usage: {}, total_cost_usd: 0 };
    },
  });

  try {
    await harness.generatePipeline(
      { _synthetic: true, _book: 'ISA', _startChapter: 52, _endChapter: 52, skill: 'initial-pipeline', operations: 6 },
      buildMessage('generate isa 52')
    );

    assert.equal(harness.runClaudeCalls.length, 1);
    assert.equal(harness.checkpoints.some((patch) => patch.current?.errorKind === 'initial_pipeline_early_exit'), false);
    assert.equal(harness.sent.uploads.length, 2);
    assert.ok(harness.sent.stream.some(({ text }) => text.includes('ISA 52 ULT.usfm')));
    assert.ok(harness.sent.stream.some(({ text }) => text.includes('ISA 52 UST.usfm')));
    assert.equal(harness.diagnosisCalls.length, 0);
    assert.equal(harness.runSummaries.at(-1).success, true);
  } finally {
    harness.cleanup();
  }
});

test('generatePipeline does not apply initial-pipeline guardrails to direct ULT-only runs', async () => {
  const harness = createHarness({
    runClaudeImpl: async ({ options, tempDir }) => {
      fs.mkdirSync(path.join(tempDir, 'output', 'AI-ULT', 'ISA'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'output', 'AI-ULT', 'ISA', 'ISA-52.usfm'), '\\id ISA\n\\c 52\n\\v 1 ult\n');
      assert.equal(options.skill, 'ULT-gen');
      assert.equal(options.appendSystemPrompt, undefined);
      return { subtype: 'success', usage: {}, total_cost_usd: 0 };
    },
  });

  try {
    await harness.generatePipeline(
      { _synthetic: true, _book: 'ISA', _startChapter: 52, _endChapter: 52, skill: 'initial-pipeline', operations: 6 },
      buildMessage('generate ULT isa 52')
    );

    assert.equal(harness.runClaudeCalls.length, 1);
    assert.equal(harness.sent.uploads.length, 1);
    assert.ok(harness.sent.stream.some(({ text }) => text.includes('ISA 52 ULT.usfm')));
    assert.equal(harness.checkpoints.some((patch) => patch.current?.errorKind === 'initial_pipeline_early_exit'), false);
    assert.equal(harness.runSummaries.at(-1).success, true);
  } finally {
    harness.cleanup();
  }
});

test('generatePipeline retries alignment once and fails with degraded_alignment when quality stays low', async () => {
  let alignCalls = 0;
  const harness = createHarness({
    runClaudeImpl: async ({ options, tempDir }) => {
      if (options.skill === 'initial-pipeline') {
        fs.mkdirSync(path.join(tempDir, 'output', 'AI-ULT', 'ISA'), { recursive: true });
        fs.mkdirSync(path.join(tempDir, 'output', 'AI-UST', 'ISA'), { recursive: true });
        fs.mkdirSync(path.join(tempDir, 'output', 'issues', 'ISA'), { recursive: true });
        fs.writeFileSync(path.join(tempDir, 'output', 'AI-ULT', 'ISA', 'ISA-52.usfm'), '\\id ISA\n\\c 52\n\\v 1 ult\n');
        fs.writeFileSync(path.join(tempDir, 'output', 'AI-UST', 'ISA', 'ISA-52.usfm'), '\\id ISA\n\\c 52\n\\v 1 ust\n');
        fs.writeFileSync(path.join(tempDir, 'output', 'issues', 'ISA', 'ISA-52.tsv'), 'Reference\tID\nISA 52:1\ta1b2\n');
        return { subtype: 'success', usage: {}, total_cost_usd: 0 };
      }
      if (options.skill === 'align-all-parallel') {
        alignCalls++;
        fs.mkdirSync(path.join(tempDir, 'output', 'AI-ULT', 'ISA'), { recursive: true });
        fs.mkdirSync(path.join(tempDir, 'output', 'AI-UST', 'ISA'), { recursive: true });
        const degraded = '\\id ISA\n\\c 52\n\\v 1 \\w one|x\\w* \\w two|x\\w* \\w three|x\\w* \\w four|x\\w* \\w five|x\\w* \\w six|x\\w* \\w seven|x\\w* \\w eight|x\\w* \\w nine|x\\w* \\w ten|x\\w*\n';
        fs.writeFileSync(path.join(tempDir, 'output', 'AI-ULT', 'ISA', 'ISA-52-aligned.usfm'), degraded);
        fs.writeFileSync(path.join(tempDir, 'output', 'AI-UST', 'ISA', 'ISA-52-aligned.usfm'), degraded);
        return { subtype: 'success', usage: {}, total_cost_usd: 0 };
      }
      return { subtype: 'success', usage: {}, total_cost_usd: 0 };
    },
  });

  try {
    await harness.generatePipeline(
      { _synthetic: true, _book: 'ISA', _startChapter: 52, _endChapter: 52, skill: 'initial-pipeline', operations: 6 },
      buildMessage('generate isa 52', { sender_id: 7 })
    );

    assert.equal(alignCalls, 2);
    assert.ok(harness.checkpoints.some((patch) => patch.current?.errorKind === 'degraded_alignment'));
    assert.ok(harness.readStatusTexts().some((text) => text.includes('Retrying **align-all-parallel**')));
  } finally {
    harness.cleanup();
  }
});

test('generatePipeline reruns align-all-parallel when first post-align validation fails', async () => {
  let alignCalls = 0;
  const harness = createHarness({
    runClaudeImpl: async ({ options, tempDir }) => {
      if (options.skill === 'initial-pipeline') {
        fs.mkdirSync(path.join(tempDir, 'output', 'AI-ULT', 'ISA'), { recursive: true });
        fs.mkdirSync(path.join(tempDir, 'output', 'AI-UST', 'ISA'), { recursive: true });
        fs.mkdirSync(path.join(tempDir, 'output', 'issues', 'ISA'), { recursive: true });
        fs.writeFileSync(path.join(tempDir, 'output', 'AI-ULT', 'ISA', 'ISA-52.usfm'), '\\id ISA\n\\c 52\n\\v 1 ult\n');
        fs.writeFileSync(path.join(tempDir, 'output', 'AI-UST', 'ISA', 'ISA-52.usfm'), '\\id ISA\n\\c 52\n\\v 1 ust\n');
        fs.writeFileSync(path.join(tempDir, 'output', 'issues', 'ISA', 'ISA-52.tsv'), 'Reference\tID\nISA 52:1\ta1b2\n');
        return { subtype: 'success', usage: {}, total_cost_usd: 0 };
      }
      if (options.skill === 'align-all-parallel') {
        alignCalls++;
        fs.mkdirSync(path.join(tempDir, 'output', 'AI-ULT', 'ISA'), { recursive: true });
        fs.mkdirSync(path.join(tempDir, 'output', 'AI-UST', 'ISA'), { recursive: true });
        const degraded = '\\id ISA\n\\c 52\n\\v 1 plain text no milestones\n';
        const good = '\\id ISA\n\\c 52\n\\v 1 \\zaln-s |x-strong="H1" x-content="א"\\*\\w Joshua|x-occurrence="1" x-occurrences="1"\\w*\\zaln-e\\*\n';
        const out = alignCalls === 1 ? degraded : good;
        fs.writeFileSync(path.join(tempDir, 'output', 'AI-ULT', 'ISA', 'ISA-52-aligned.usfm'), out);
        fs.writeFileSync(path.join(tempDir, 'output', 'AI-UST', 'ISA', 'ISA-52-aligned.usfm'), out);
        return { subtype: 'success', usage: {}, total_cost_usd: 0 };
      }
      return { subtype: 'success', usage: {}, total_cost_usd: 0 };
    },
  });

  try {
    await harness.generatePipeline(
      { _synthetic: true, _book: 'ISA', _startChapter: 52, _endChapter: 52, skill: 'initial-pipeline', operations: 6 },
      buildMessage('generate isa 52', { sender_id: 7 })
    );

    assert.equal(alignCalls, 2);
    assert.ok(harness.readStatusTexts().some((text) => text.includes('Alignment validation failed for ISA 52 (attempt 1/2)')));
    assert.ok(harness.readStatusTexts().some((text) => text.includes('Retrying **align-all-parallel** for ISA 52')));
  } finally {
    harness.cleanup();
  }
});
