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

function createHarness({ runClaudeImpl, initialCheckpoint = null, door43PushImpl = null }) {
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
  // usfm-tools captures CSKILLBP_DIR at module load; reload it per-harness so
  // validateAlignedUsfmCompleteness/mergeAlignedUsfm read from this temp dir.
  const usfmToolsPath = require.resolve('../src/workspace-tools/usfm-tools');

  const sent = {
    stream: [],
    dm: [],
    reactions: [],
    uploads: [],
  };
  const runClaudeCalls = [];
  const checkpoints = initialCheckpoint ? [initialCheckpoint] : [];
  const clearedCheckpoints = [];
  const runSummaries = [];
  const diagnosisCalls = [];

  delete require.cache[generatePath];
  delete require.cache[pipelineUtilsPath];
  delete require.cache[adminStatusPath];
  delete require.cache[selfDiagnosisPath];
  delete require.cache[usfmToolsPath];

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
    // Mirrors the real helper so align tests can exercise permission-stall shapes.
    resultIndicatesPermissionStall: (r) => !!r && (r.subtype === 'permission_stall' || r.permissionStallDetected === true),
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
    door43Push: door43PushImpl || (async () => ({ success: true, details: 'ok', noChanges: false })),
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
    clearCheckpoint: () => {
      clearedCheckpoints.push(true);
    },
  });
  installStub(pipelineContextPath, {
    buildGenerateContext: () => ({ contextPath: 'tmp/context.json', dirPath: 'tmp/pipeline/ISA-52' }),
    buildUstContext: async () => ({ contextPath: 'tmp/ust-context.json', dirPath: 'tmp/pipeline/ISA-52', selectedUltPath: null }),
    hebrewPathForBook: (book) => `data/hebrew_bible/00-${String(book).toUpperCase()}.usfm`,
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
    clearedCheckpoints,
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
      delete require.cache[usfmToolsPath];
      if (oldBaseDir == null) delete process.env.CSKILLBP_DIR;
      else process.env.CSKILLBP_DIR = oldBaseDir;
      if (oldStatusFile == null) delete process.env.ADMIN_STATUS_FILE;
      else process.env.ADMIN_STATUS_FILE = oldStatusFile;
    },
  };
}

test('generatePipeline resumes the same initial-pipeline session after Wave 2 early exit', async () => {
  const harness = createHarness({
    runClaudeImpl: async ({ options, tempDir }) => {
      if (options.resume === 'session-isa-52') {
        assert.equal(options.skill, undefined);
        assert.match(options.prompt, /Continue the existing initial-pipeline run/);
        assert.match(options.prompt, /Wave 3/);
        fs.mkdirSync(path.join(tempDir, 'output', 'AI-UST', 'ISA'), { recursive: true });
        fs.mkdirSync(path.join(tempDir, 'output', 'issues', 'ISA'), { recursive: true });
        fs.writeFileSync(path.join(tempDir, 'output', 'AI-UST', 'ISA', 'ISA-52.usfm'), '\\id ISA\n\\c 52\n\\v 1 ust\n');
        fs.writeFileSync(path.join(tempDir, 'output', 'issues', 'ISA', 'ISA-52.tsv'), 'isa\t52:1\tfigs-activepassive\tYou were sold\n');
        return { subtype: 'success', usage: {}, total_cost_usd: 0, session_id: 'session-isa-52' };
      }
      fs.mkdirSync(path.join(tempDir, 'output', 'AI-ULT', 'ISA'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, 'tmp', 'pipeline-ISA-52'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'output', 'AI-ULT', 'ISA', 'ISA-52.usfm'), '\\id ISA\n\\c 52\n\\v 1 test\n');
      fs.writeFileSync(path.join(tempDir, 'tmp', 'pipeline-ISA-52', 'wave2_structure.tsv'), 'isa\t52:1\tfigs-activepassive\tYou were sold\n');
      fs.writeFileSync(path.join(tempDir, 'tmp', 'pipeline-ISA-52', 'wave2_rhetoric.tsv'), 'isa\t52:1\tfigs-doublet\tAwake, awake\n');
      assert.match(options.appendSystemPrompt, /Do not return success/i);
      return { subtype: 'success', usage: {}, total_cost_usd: 0, session_id: 'session-isa-52' };
    },
  });

  try {
    await harness.generatePipeline(
      { _synthetic: true, _book: 'ISA', _startChapter: 52, _endChapter: 52, skill: 'initial-pipeline', operations: 6 },
      buildMessage('generate isa 52')
    );

    assert.equal(harness.runClaudeCalls.length, 2);
    assert.equal(harness.runClaudeCalls[1].resume, 'session-isa-52');
    const statusTexts = harness.readStatusTexts();
    assert.ok(statusTexts.some((text) => text.includes('resuming the same session')));
    assert.ok(statusTexts.some((text) => text.includes('continuation completed required outputs')));
    assert.equal(harness.checkpoints.some((patch) => patch.current?.errorKind === 'initial_pipeline_early_exit'), false);
    assert.equal(harness.diagnosisCalls.length, 0);
    assert.equal(harness.sent.uploads.length, 2);
    assert.equal(harness.clearedCheckpoints.length, 1);
    assert.deepEqual(harness.runSummaries.at(-1), {
      pipeline: 'generate',
      book: 'ISA',
      startCh: 52,
      endCh: 52,
      tokensBefore: 0,
      success: true,
      userId: 42,
    });
  } finally {
    harness.cleanup();
  }
});

test('generatePipeline preserves failed checkpoint when initial-pipeline continuation remains incomplete', async () => {
  const harness = createHarness({
    runClaudeImpl: async ({ options, tempDir }) => {
      fs.mkdirSync(path.join(tempDir, 'output', 'AI-ULT', 'ISA'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, 'tmp', 'pipeline-ISA-52'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'output', 'AI-ULT', 'ISA', 'ISA-52.usfm'), '\\id ISA\n\\c 52\n\\v 1 test\n');
      fs.writeFileSync(path.join(tempDir, 'tmp', 'pipeline-ISA-52', 'wave2_structure.tsv'), 'isa\t52:1\tfigs-activepassive\tYou were sold\n');
      fs.writeFileSync(path.join(tempDir, 'tmp', 'pipeline-ISA-52', 'wave2_rhetoric.tsv'), 'isa\t52:1\tfigs-doublet\tAwake, awake\n');
      if (options.resume === 'session-isa-52') {
        return { subtype: 'success', usage: {}, total_cost_usd: 0, session_id: 'session-isa-52' };
      }
      return { subtype: 'success', usage: {}, total_cost_usd: 0, session_id: 'session-isa-52' };
    },
  });

  try {
    await harness.generatePipeline(
      { _synthetic: true, _book: 'ISA', _startChapter: 52, _endChapter: 52, skill: 'initial-pipeline', operations: 6 },
      buildMessage('generate isa 52')
    );

    assert.equal(harness.runClaudeCalls.length, 2);
    const statusTexts = harness.readStatusTexts();
    assert.ok(statusTexts.some((text) => text.includes('initial-pipeline exited before writing required outputs')));
    assert.ok(statusTexts.some((text) => text.includes('issues TSV, UST')));
    const failure = harness.checkpoints.find((patch) => patch.current?.errorKind === 'initial_pipeline_early_exit');
    assert.ok(failure);
    assert.equal(failure.resume.sessionId, 'session-isa-52');
    assert.equal(failure.resume.mode, 'continue_after_early_exit');
    assert.equal(harness.clearedCheckpoints.length, 0);
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
    assert.equal(harness.clearedCheckpoints.length, 1);
    assert.equal(harness.runSummaries.at(-1).success, true);
  } finally {
    harness.cleanup();
  }
});

test('generatePipeline resumes initial-pipeline early-exit checkpoint without deleting existing ULT', async () => {
  const initialCheckpoint = {
    state: 'failed',
    success: 0,
    fail: 1,
    completedChapters: [],
    current: {
      chapter: 52,
      skill: 'initial-pipeline',
      status: 'failed',
      errorKind: 'initial_pipeline_early_exit',
    },
    resume: {
      chapter: 52,
      skill: 'initial-pipeline',
      sessionId: 'session-resume-52',
      mode: 'continue_after_early_exit',
    },
  };
  const harness = createHarness({
    initialCheckpoint,
    runClaudeImpl: async ({ options, tempDir }) => {
      assert.equal(options.resume, 'session-resume-52');
      assert.equal(options.skill, null);
      assert.match(options.prompt, /Continue the existing initial-pipeline run/);
      assert.ok(fs.existsSync(path.join(tempDir, 'output', 'AI-ULT', 'ISA', 'ISA-52.usfm')));
      fs.mkdirSync(path.join(tempDir, 'output', 'AI-UST', 'ISA'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, 'output', 'issues', 'ISA'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'output', 'AI-UST', 'ISA', 'ISA-52.usfm'), '\\id ISA\n\\c 52\n\\v 1 ust\n');
      fs.writeFileSync(path.join(tempDir, 'output', 'issues', 'ISA', 'ISA-52.tsv'), 'isa\t52:1\tfigs-activepassive\tYou were sold\n');
      return { subtype: 'success', usage: {}, total_cost_usd: 0, session_id: 'session-resume-52' };
    },
  });

  try {
    fs.mkdirSync(path.join(harness.tempDir, 'output', 'AI-ULT', 'ISA'), { recursive: true });
    fs.mkdirSync(path.join(harness.tempDir, 'tmp', 'pipeline-ISA-52'), { recursive: true });
    fs.writeFileSync(path.join(harness.tempDir, 'output', 'AI-ULT', 'ISA', 'ISA-52.usfm'), '\\id ISA\n\\c 52\n\\v 1 existing ult\n');
    fs.writeFileSync(path.join(harness.tempDir, 'tmp', 'pipeline-ISA-52', 'wave2_structure.tsv'), 'isa\t52:1\tfigs-activepassive\tYou were sold\n');
    fs.writeFileSync(path.join(harness.tempDir, 'tmp', 'pipeline-ISA-52', 'wave2_rhetoric.tsv'), 'isa\t52:1\tfigs-doublet\tAwake, awake\n');

    await harness.generatePipeline(
      { _synthetic: true, _book: 'ISA', _startChapter: 52, _endChapter: 52, skill: 'initial-pipeline', operations: 6 },
      buildMessage('generate isa 52')
    );

    assert.equal(harness.runClaudeCalls.length, 1);
    assert.equal(harness.runClaudeCalls[0].resume, 'session-resume-52');
    assert.equal(fs.readFileSync(path.join(harness.tempDir, 'output', 'AI-ULT', 'ISA', 'ISA-52.usfm'), 'utf8'), '\\id ISA\n\\c 52\n\\v 1 existing ult\n');
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
    // Self-diagnosis now covers the alignment phase (previously Phase 1 only).
    assert.equal(harness.diagnosisCalls.length, 1);
    assert.equal(harness.diagnosisCalls[0].event.severity, 'error');
    assert.equal(harness.diagnosisCalls[0].checkpoint.current.errorKind, 'degraded_alignment');
    assert.match(harness.diagnosisCalls[0].errorText, /align-all-parallel/);
  } finally {
    harness.cleanup();
  }
});

test('generatePipeline retry prompt lists missing verses so the coordinator targets the gap (#230)', async () => {
  // ISA 52 has 15 verses in the source; every align call writes an aligned
  // file that covers only verses 1-12, leaving 13-15 missing. Attempt 1 is
  // the vanilla align call; attempt 2 is the retry. The retry prompt must
  // explicitly name the missing verses so a coordinator that consistently
  // drops the same tail verses (see EZK 16:61-63 in issue #230) gets a
  // targeted second chance instead of an identical prompt.
  let alignCalls = 0;
  const partialAligned = [
    '\\id ISA',
    '\\c 52',
    ...Array.from({ length: 12 }, (_, i) => `\\v ${i + 1} \\zaln-s |x-strong="H1" x-content="א"\\*\\w Joshua|x-occurrence="1" x-occurrences="1"\\w*\\zaln-e\\*`),
    '',
  ].join('\n');
  const fullSource = [
    '\\id ISA',
    '\\c 52',
    ...Array.from({ length: 15 }, (_, i) => `\\v ${i + 1} source verse ${i + 1}`),
    '',
  ].join('\n');
  const harness = createHarness({
    runClaudeImpl: async ({ options, tempDir }) => {
      if (options.skill === 'initial-pipeline') {
        fs.mkdirSync(path.join(tempDir, 'output', 'AI-ULT', 'ISA'), { recursive: true });
        fs.mkdirSync(path.join(tempDir, 'output', 'AI-UST', 'ISA'), { recursive: true });
        fs.mkdirSync(path.join(tempDir, 'output', 'issues', 'ISA'), { recursive: true });
        fs.writeFileSync(path.join(tempDir, 'output', 'AI-ULT', 'ISA', 'ISA-52.usfm'), fullSource);
        fs.writeFileSync(path.join(tempDir, 'output', 'AI-UST', 'ISA', 'ISA-52.usfm'), fullSource);
        fs.writeFileSync(path.join(tempDir, 'output', 'issues', 'ISA', 'ISA-52.tsv'), 'Reference\tID\nISA 52:1\ta1b2\n');
        return { subtype: 'success', usage: {}, total_cost_usd: 0 };
      }
      if (options.skill === 'align-all-parallel') {
        alignCalls++;
        fs.mkdirSync(path.join(tempDir, 'output', 'AI-ULT', 'ISA'), { recursive: true });
        fs.mkdirSync(path.join(tempDir, 'output', 'AI-UST', 'ISA'), { recursive: true });
        fs.writeFileSync(path.join(tempDir, 'output', 'AI-ULT', 'ISA', 'ISA-52-aligned.usfm'), partialAligned);
        fs.writeFileSync(path.join(tempDir, 'output', 'AI-UST', 'ISA', 'ISA-52-aligned.usfm'), partialAligned);
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
    const alignPrompts = harness.runClaudeCalls
      .filter((call) => call.skill === 'align-all-parallel')
      .map((call) => call.prompt);
    assert.equal(alignPrompts.length, 2);
    // Attempt 1 is the vanilla prompt — no retry hint.
    assert.doesNotMatch(alignPrompts[0], /previous attempt/i);
    // Attempt 2 must name the missing verses (13-15) for both ULT and UST.
    assert.match(alignPrompts[1], /previous attempt/i);
    assert.match(alignPrompts[1], /ULT verses 13-15/);
    assert.match(alignPrompts[1], /UST verses 13-15/);
    // The operator-visible status message should surface the targeted verses too.
    assert.ok(harness.readStatusTexts().some((text) => /Retrying \*\*align-all-parallel\*\*.*targeting.*ULT verses 13-15/.test(text)));
  } finally {
    harness.cleanup();
  }
});

test('generatePipeline retry prompt enumerates the full source when the previous attempt produced no aligned output (#238)', async () => {
  // ISA 52 has 15 verses in the source; every align call returns success but
  // writes no aligned USFM at all — the coverage check reports reason:'missing'
  // with missing:[] (there was no file to diff against the source). Before
  // #238 the retry hint only fired when cov.missing was non-empty, so the
  // retry prompt was identical to attempt 1 and reproduced the empty result.
  // After the fix, the retry must enumerate the source verse set (1-15) so
  // the coordinator gets a concrete target list.
  let alignCalls = 0;
  const fullSource = [
    '\\id ISA',
    '\\c 52',
    ...Array.from({ length: 15 }, (_, i) => `\\v ${i + 1} source verse ${i + 1}`),
    '',
  ].join('\n');
  const harness = createHarness({
    runClaudeImpl: async ({ options, tempDir }) => {
      if (options.skill === 'initial-pipeline') {
        fs.mkdirSync(path.join(tempDir, 'output', 'AI-ULT', 'ISA'), { recursive: true });
        fs.mkdirSync(path.join(tempDir, 'output', 'AI-UST', 'ISA'), { recursive: true });
        fs.mkdirSync(path.join(tempDir, 'output', 'issues', 'ISA'), { recursive: true });
        fs.writeFileSync(path.join(tempDir, 'output', 'AI-ULT', 'ISA', 'ISA-52.usfm'), fullSource);
        fs.writeFileSync(path.join(tempDir, 'output', 'AI-UST', 'ISA', 'ISA-52.usfm'), fullSource);
        fs.writeFileSync(path.join(tempDir, 'output', 'issues', 'ISA', 'ISA-52.tsv'), 'Reference\tID\nISA 52:1\ta1b2\n');
        return { subtype: 'success', usage: {}, total_cost_usd: 0 };
      }
      if (options.skill === 'align-all-parallel') {
        alignCalls++;
        // Return success but write nothing — mirrors the EZK 16 signature.
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
    const alignPrompts = harness.runClaudeCalls
      .filter((call) => call.skill === 'align-all-parallel')
      .map((call) => call.prompt);
    assert.equal(alignPrompts.length, 2);
    // Attempt 1 is the vanilla prompt — no retry hint.
    assert.doesNotMatch(alignPrompts[0], /previous attempt/i);
    // Attempt 2 must name the full source range (1-15) for both ULT and UST,
    // even though cov.missing was empty because no aligned file existed.
    assert.match(alignPrompts[1], /previous attempt/i);
    assert.match(alignPrompts[1], /ULT verses 1-15/);
    assert.match(alignPrompts[1], /UST verses 1-15/);
    // Operator status message should surface the enumerated targets.
    assert.ok(harness.readStatusTexts().some((text) => /Retrying \*\*align-all-parallel\*\*.*targeting.*ULT verses 1-15/.test(text)));
  } finally {
    harness.cleanup();
  }
});

test('generatePipeline fires self-diagnosis when door43-push fails', async () => {
  const harness = createHarness({
    door43PushImpl: async ({ type }) => ({ success: false, details: `Verse 1 not found in chapter 52 (${type})` }),
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
        fs.mkdirSync(path.join(tempDir, 'output', 'AI-ULT', 'ISA'), { recursive: true });
        fs.mkdirSync(path.join(tempDir, 'output', 'AI-UST', 'ISA'), { recursive: true });
        const good = '\\id ISA\n\\c 52\n\\v 1 \\zaln-s |x-strong="H1" x-content="א"\\*\\w Joshua|x-occurrence="1" x-occurrences="1"\\w*\\zaln-e\\*\n';
        fs.writeFileSync(path.join(tempDir, 'output', 'AI-ULT', 'ISA', 'ISA-52-aligned.usfm'), good);
        fs.writeFileSync(path.join(tempDir, 'output', 'AI-UST', 'ISA', 'ISA-52-aligned.usfm'), good);
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

    // door43-push failures used to only set a checkpoint; now they dispatch
    // self-diagnosis like Phase-1 failures do.
    const pushDiag = harness.diagnosisCalls.find((c) => /door43-push/.test(c.errorText || ''));
    assert.ok(pushDiag, 'expected a door43-push self-diagnosis dispatch');
    assert.equal(pushDiag.event.severity, 'error');
    assert.match(pushDiag.errorText, /Verse 1 not found/);
  } finally {
    harness.cleanup();
  }
});

test('generatePipeline fires self-diagnosis when an aligned source is missing at push time', async () => {
  // Resume at door43-push with a checkpoint that references aligned files which
  // no longer exist on disk. The pre-flight existence check must dispatch
  // diagnosis — its status text ("source file missing") infers as 'warn', so
  // this guards against the severity-gating regression caught in PR #123 review.
  const harness = createHarness({
    initialCheckpoint: {
      state: 'failed',
      success: 1,
      completedChapters: [{
        ch: 52,
        ultAligned: 'output/AI-ULT/ISA/ISA-52-aligned.usfm',
        ustAligned: 'output/AI-UST/ISA/ISA-52-aligned.usfm',
      }],
      resume: { chapter: 52, skill: 'door43-push' },
    },
    // Phase 1 is skipped on a door43-push resume, so runClaude must not be called.
    runClaudeImpl: async () => { throw new Error('runClaude should not run when resuming at door43-push'); },
  });

  try {
    await harness.generatePipeline(
      { _synthetic: true, _book: 'ISA', _startChapter: 52, _endChapter: 52, skill: 'initial-pipeline', operations: 6 },
      buildMessage('generate isa 52', { sender_id: 7 })
    );

    assert.equal(harness.runClaudeCalls.length, 0);
    const missingDiag = harness.diagnosisCalls.find((c) => /source file missing/i.test(c.errorText || ''));
    assert.ok(missingDiag, 'expected a self-diagnosis dispatch for the missing aligned source');
    assert.equal(missingDiag.event.severity, 'error');
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

test('align permission stall on a success-shaped result wins over the coverage-derived errorKind (#238)', async () => {
  // #238 regression: the stall fired after the SDK had already emitted a result
  // message, so the runner returned subtype 'success' annotated
  // permissionStallDetected. With partial aligned coverage on disk the failure
  // used to be classified incomplete_coverage; the stall classification must win.
  const harness = createHarness({
    runClaudeImpl: async ({ options, tempDir }) => {
      if (options.skill === 'initial-pipeline') {
        fs.mkdirSync(path.join(tempDir, 'output', 'AI-ULT', 'ISA'), { recursive: true });
        fs.mkdirSync(path.join(tempDir, 'output', 'AI-UST', 'ISA'), { recursive: true });
        fs.mkdirSync(path.join(tempDir, 'output', 'issues', 'ISA'), { recursive: true });
        fs.writeFileSync(path.join(tempDir, 'output', 'AI-ULT', 'ISA', 'ISA-52.usfm'), '\\id ISA\n\\c 52\n\\v 1 ult one\n\\v 2 ult two\n');
        fs.writeFileSync(path.join(tempDir, 'output', 'AI-UST', 'ISA', 'ISA-52.usfm'), '\\id ISA\n\\c 52\n\\v 1 ust one\n\\v 2 ust two\n');
        fs.writeFileSync(path.join(tempDir, 'output', 'issues', 'ISA', 'ISA-52.tsv'), 'Reference\tID\nISA 52:1\ta1b2\n');
        return { subtype: 'success', usage: {}, total_cost_usd: 0 };
      }
      if (options.skill === 'align-all-parallel') {
        // Partial output: verse 1 aligned, verse 2 missing → coverage 'incomplete'.
        fs.mkdirSync(path.join(tempDir, 'output', 'AI-ULT', 'ISA'), { recursive: true });
        fs.mkdirSync(path.join(tempDir, 'output', 'AI-UST', 'ISA'), { recursive: true });
        const partial = '\\id ISA\n\\c 52\n\\v 1 \\zaln-s |x-strong="H1" x-content="א"\\*\\w Joshua|x-occurrence="1" x-occurrences="1"\\w*\\zaln-e\\*\n';
        fs.writeFileSync(path.join(tempDir, 'output', 'AI-ULT', 'ISA', 'ISA-52-aligned.usfm'), partial);
        fs.writeFileSync(path.join(tempDir, 'output', 'AI-UST', 'ISA', 'ISA-52-aligned.usfm'), partial);
        // Success-shaped result carrying the stall annotation (see claude-runner).
        return { subtype: 'success', usage: {}, total_cost_usd: 0, permissionStallDetected: true };
      }
      return { subtype: 'success', usage: {}, total_cost_usd: 0 };
    },
  });

  try {
    await harness.generatePipeline(
      { _synthetic: true, _book: 'ISA', _startChapter: 52, _endChapter: 52, skill: 'initial-pipeline', operations: 6 },
      buildMessage('generate isa 52', { sender_id: 7 })
    );

    const failure = harness.checkpoints.find((patch) => patch.current?.status === 'failed');
    assert.ok(failure, 'align failure checkpoint expected');
    assert.equal(failure.current.errorKind, 'permission_stall', 'stall must beat the coverage-derived errorKind');
    assert.match(failure.current.validationSummary, /permission stall|auto-denied/i);
    assert.equal(harness.diagnosisCalls.length, 1);
    assert.equal(harness.diagnosisCalls[0].checkpoint.current.errorKind, 'permission_stall');
    assert.ok(harness.readStatusTexts().some((text) => text.includes('attempting salvage from any banked mapping JSON')));
  } finally {
    harness.cleanup();
  }
});

// Issue #212: a prior ULT-only run left the checkpoint at align-all-parallel with
// only ULT on disk (UST was never produced). A follow-up run in full-pipeline mode
// resumed from that checkpoint and *skipped* initial-pipeline entirely because the
// resume shortcut only looked at resumeSkill, not at what content the current run
// actually requires. The skip meant UST was still never generated, so the
// missing-output gate fired ~140ms after start and spawned a spurious diagnosis
// issue. The fix: before taking the shortcut, verify every required content type
// already has an output file on disk; otherwise fall through to initial-pipeline.
test('generatePipeline reruns initial-pipeline when align-all-parallel resume lacks a required content type', async () => {
  const initialCheckpoint = {
    state: 'failed',
    success: 0,
    fail: 1,
    completedChapters: [],
    current: {
      chapter: 52,
      skill: 'align-all-parallel',
      status: 'failed',
      errorKind: 'non_success_result',
    },
    // Prior run was ULT-only; checkpoint records align-all-parallel as the resume skill.
    resume: { chapter: 52, skill: 'align-all-parallel' },
  };
  const initialPipelineCalls = [];
  const harness = createHarness({
    initialCheckpoint,
    runClaudeImpl: async ({ options, tempDir }) => {
      if (options.skill === 'initial-pipeline') {
        initialPipelineCalls.push(options);
        fs.mkdirSync(path.join(tempDir, 'output', 'AI-ULT', 'ISA'), { recursive: true });
        fs.mkdirSync(path.join(tempDir, 'output', 'AI-UST', 'ISA'), { recursive: true });
        fs.mkdirSync(path.join(tempDir, 'output', 'issues', 'ISA'), { recursive: true });
        fs.writeFileSync(path.join(tempDir, 'output', 'AI-ULT', 'ISA', 'ISA-52.usfm'), '\\id ISA\n\\c 52\n\\v 1 ult\n');
        fs.writeFileSync(path.join(tempDir, 'output', 'AI-UST', 'ISA', 'ISA-52.usfm'), '\\id ISA\n\\c 52\n\\v 1 ust\n');
        fs.writeFileSync(path.join(tempDir, 'output', 'issues', 'ISA', 'ISA-52.tsv'), 'Reference\tID\nISA 52:1\ta1b2\n');
        return { subtype: 'success', usage: {}, total_cost_usd: 0 };
      }
      if (options.skill === 'align-all-parallel') {
        fs.mkdirSync(path.join(tempDir, 'output', 'AI-ULT', 'ISA'), { recursive: true });
        fs.mkdirSync(path.join(tempDir, 'output', 'AI-UST', 'ISA'), { recursive: true });
        const good = '\\id ISA\n\\c 52\n\\v 1 \\zaln-s |x-strong="H1" x-content="א"\\*\\w Joshua|x-occurrence="1" x-occurrences="1"\\w*\\zaln-e\\*\n';
        fs.writeFileSync(path.join(tempDir, 'output', 'AI-ULT', 'ISA', 'ISA-52-aligned.usfm'), good);
        fs.writeFileSync(path.join(tempDir, 'output', 'AI-UST', 'ISA', 'ISA-52-aligned.usfm'), good);
        return { subtype: 'success', usage: {}, total_cost_usd: 0 };
      }
      return { subtype: 'success', usage: {}, total_cost_usd: 0 };
    },
  });

  try {
    // Pre-populate the ULT-only artifact the prior run produced. UST is absent —
    // exactly the on-disk state described in issue #212.
    fs.mkdirSync(path.join(harness.tempDir, 'output', 'AI-ULT', 'ISA'), { recursive: true });
    fs.writeFileSync(
      path.join(harness.tempDir, 'output', 'AI-ULT', 'ISA', 'ISA-52.usfm'),
      '\\id ISA\n\\c 52\n\\v 1 prior ult from ULT-only run\n'
    );

    await harness.generatePipeline(
      { _synthetic: true, _book: 'ISA', _startChapter: 52, _endChapter: 52, skill: 'initial-pipeline', operations: 6 },
      buildMessage('generate isa 52')
    );

    // The regression: initial-pipeline was skipped and the missing-output gate
    // fired with errorKind='missing_output'. After the fix, initial-pipeline
    // runs, both artifacts are generated, alignment proceeds, and no
    // missing-output / resume_scope_mismatch checkpoint is written.
    assert.equal(initialPipelineCalls.length, 1, 'expected initial-pipeline to run when UST is missing on a full-pipeline resume');
    assert.ok(
      harness.readStatusTexts().some((text) => text.includes('narrower content-type set')),
      'expected a status message explaining why we fell through to initial-pipeline'
    );
    assert.equal(
      harness.checkpoints.some((patch) => patch.current?.errorKind === 'missing_output'),
      false,
      'missing-output gate must not fire when initial-pipeline was allowed to run'
    );
    assert.equal(
      harness.checkpoints.some((patch) => patch.current?.errorKind === 'resume_scope_mismatch'),
      false,
      'resume_scope_mismatch must not fire when the guard successfully re-ran initial-pipeline'
    );
    assert.equal(harness.runSummaries.at(-1).success, true);
  } finally {
    harness.cleanup();
  }
});
