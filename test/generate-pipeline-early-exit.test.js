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
    // Ditto for the external-permission-wall shape (#271). This stub replaces the
    // whole module, so a helper missing here is `undefined` at the call site and
    // throws inside the align try/catch — which reads as an unrelated align failure.
    resultIndicatesPermissionWall: (r) => !!r && r.subtype === 'permission_wall',
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
    // No-progress continuation: exactly one attempt recorded, with per-attempt diagnostics.
    assert.match(harness.diagnosisCalls[0].errorText, /Continuation attempt 1:/);
    assert.equal(failure.current.continuationAttempts.length, 1);
    assert.equal(failure.current.continuationAttempts[0].progressed, false);
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

test('generatePipeline retries the continuation when an attempt progresses but stays incomplete (#260)', async () => {
  let continuationCalls = 0;
  const harness = createHarness({
    runClaudeImpl: async ({ options, tempDir }) => {
      if (options.resume === 'session-isa-52') {
        continuationCalls++;
        assert.match(options.prompt, /Continue the existing initial-pipeline run/);
        assert.match(options.prompt, /test -s|MISS/);
        if (continuationCalls === 1) {
          // Attempt 1: progresses (writes issues TSV) but early-exits before UST.
          fs.mkdirSync(path.join(tempDir, 'output', 'issues', 'ISA'), { recursive: true });
          fs.writeFileSync(path.join(tempDir, 'output', 'issues', 'ISA', 'ISA-52.tsv'), 'isa\t52:1\tfigs-activepassive\tYou were sold\n');
        } else {
          // Attempt 2: finishes the UST.
          fs.mkdirSync(path.join(tempDir, 'output', 'AI-UST', 'ISA'), { recursive: true });
          fs.writeFileSync(path.join(tempDir, 'output', 'AI-UST', 'ISA', 'ISA-52.usfm'), '\\id ISA\n\\c 52\n\\v 1 ust\n');
        }
        return { subtype: 'success', usage: {}, total_cost_usd: 0, session_id: 'session-isa-52', num_turns: 5, duration_ms: 9000 };
      }
      fs.mkdirSync(path.join(tempDir, 'output', 'AI-ULT', 'ISA'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'output', 'AI-ULT', 'ISA', 'ISA-52.usfm'), '\\id ISA\n\\c 52\n\\v 1 test\n');
      return { subtype: 'success', usage: {}, total_cost_usd: 0, session_id: 'session-isa-52' };
    },
  });

  try {
    await harness.generatePipeline(
      { _synthetic: true, _book: 'ISA', _startChapter: 52, _endChapter: 52, skill: 'initial-pipeline', operations: 6 },
      buildMessage('generate isa 52')
    );

    assert.equal(harness.runClaudeCalls.length, 3);
    assert.equal(continuationCalls, 2);
    const statusTexts = harness.readStatusTexts();
    assert.ok(statusTexts.some((text) => text.includes('attempt 2/3')));
    assert.ok(statusTexts.some((text) => text.includes('continuation completed required outputs')));
    assert.equal(harness.checkpoints.some((patch) => patch.current?.errorKind === 'initial_pipeline_early_exit'), false);
    assert.equal(harness.diagnosisCalls.length, 0);
    assert.equal(harness.runSummaries.at(-1).success, true);
  } finally {
    harness.cleanup();
  }
});

// #251: initial-pipeline returned success having written nothing at all --
// not even a Wave-2 temp file. Resuming that session asks the agent to
// "continue from the artifacts already on disk" when there are none, so it
// returns success again in seconds and the chapter hard-fails. The first
// attempt must restart the skill from scratch instead of resuming.
test('generatePipeline restarts initial-pipeline from scratch when the run produced zero artifacts (#251)', async () => {
  const calls = [];
  const harness = createHarness({
    runClaudeImpl: async ({ options, tempDir }) => {
      calls.push({ skill: options.skill, resume: options.resume, prompt: options.prompt });
      // First call: claim success, write absolutely nothing.
      if (calls.length === 1) {
        return { subtype: 'success', usage: {}, total_cost_usd: 0, session_id: 'session-isa-52', num_turns: 2, duration_ms: 9000 };
      }
      // Second call must be a fresh skill invocation, not a resume.
      fs.mkdirSync(path.join(tempDir, 'output', 'AI-ULT', 'ISA'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, 'output', 'AI-UST', 'ISA'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, 'output', 'issues', 'ISA'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'output', 'AI-ULT', 'ISA', 'ISA-52.usfm'), '\\id ISA\n\\c 52\n\\v 1 ult\n');
      fs.writeFileSync(path.join(tempDir, 'output', 'AI-UST', 'ISA', 'ISA-52.usfm'), '\\id ISA\n\\c 52\n\\v 1 ust\n');
      fs.writeFileSync(path.join(tempDir, 'output', 'issues', 'ISA', 'ISA-52.tsv'), 'isa\t52:1\tfigs-activepassive\tYou were sold\n');
      return { subtype: 'success', usage: {}, total_cost_usd: 0, session_id: 'session-isa-52-restart' };
    },
  });

  try {
    await harness.generatePipeline(
      { _synthetic: true, _book: 'ISA', _startChapter: 52, _endChapter: 52, skill: 'initial-pipeline', operations: 6 },
      buildMessage('generate isa 52')
    );

    assert.equal(calls.length, 2, 'one initial call plus one restart');
    // The restart is the whole point: fresh skill, no resume, plain chapter ref
    // rather than the "continue from what is on disk" prompt.
    assert.equal(calls[1].skill, 'initial-pipeline');
    assert.equal(calls[1].resume, null);
    assert.equal(calls[1].prompt, 'ISA 52');
    assert.doesNotMatch(calls[1].prompt, /Continue the existing initial-pipeline run/);

    const statusTexts = harness.readStatusTexts();
    assert.ok(statusTexts.some((t) => t.includes('wrote no output at all')), 'operator is told why it restarted');
    assert.ok(statusTexts.some((t) => t.includes('restarting the skill from scratch')));
    assert.equal(harness.runSummaries.at(-1).success, true);
  } finally {
    harness.cleanup();
  }
});

// The counterpart: when SOMETHING exists, resuming is still correct and the
// restart branch must not fire.
test('generatePipeline still resumes rather than restarting when partial artifacts exist (#251)', async () => {
  const calls = [];
  const harness = createHarness({
    runClaudeImpl: async ({ options, tempDir }) => {
      calls.push({ skill: options.skill, resume: options.resume });
      if (calls.length === 1) {
        // Partial progress: a ULT exists, so there IS something to resume from.
        fs.mkdirSync(path.join(tempDir, 'output', 'AI-ULT', 'ISA'), { recursive: true });
        fs.writeFileSync(path.join(tempDir, 'output', 'AI-ULT', 'ISA', 'ISA-52.usfm'), '\\id ISA\n\\c 52\n\\v 1 ult\n');
        return { subtype: 'success', usage: {}, total_cost_usd: 0, session_id: 'session-isa-52' };
      }
      fs.mkdirSync(path.join(tempDir, 'output', 'AI-UST', 'ISA'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, 'output', 'issues', 'ISA'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'output', 'AI-UST', 'ISA', 'ISA-52.usfm'), '\\id ISA\n\\c 52\n\\v 1 ust\n');
      fs.writeFileSync(path.join(tempDir, 'output', 'issues', 'ISA', 'ISA-52.tsv'), 'isa\t52:1\tfigs-activepassive\tYou were sold\n');
      return { subtype: 'success', usage: {}, total_cost_usd: 0, session_id: 'session-isa-52' };
    },
  });

  try {
    await harness.generatePipeline(
      { _synthetic: true, _book: 'ISA', _startChapter: 52, _endChapter: 52, skill: 'initial-pipeline', operations: 6 },
      buildMessage('generate isa 52')
    );

    assert.equal(calls[1].resume, 'session-isa-52', 'resumed, not restarted');
    assert.equal(calls[1].skill, undefined);
    const statusTexts = harness.readStatusTexts();
    assert.ok(statusTexts.some((t) => t.includes('resuming the same session')));
    assert.equal(statusTexts.some((t) => t.includes('restarting the skill from scratch')), false);
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

test('generatePipeline restarts from scratch when an early-exit checkpoint has no artifacts on disk', async () => {
  // #251: resuming a zero-progress early exit told the agent to "resume from
  // the artifacts already on disk" when nothing was on disk, so it returned
  // success in seconds having done nothing. With no artifacts, the checkpoint
  // resume must re-invoke the skill fresh rather than resume the dead session.
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
      observedArtifacts: [],
    },
    resume: {
      chapter: 52,
      skill: 'initial-pipeline',
      sessionId: 'session-dead-52',
      mode: 'continue_after_early_exit',
    },
  };
  const harness = createHarness({
    initialCheckpoint,
    runClaudeImpl: async ({ options, tempDir }) => {
      // The dead session must NOT be resumed, and the skill must be re-invoked.
      assert.equal(options.resume, null);
      assert.equal(options.skill, 'initial-pipeline');
      assert.equal(options.prompt, 'ISA 52');
      assert.doesNotMatch(options.prompt, /Continue the existing initial-pipeline run/);
      for (const dir of ['AI-ULT', 'AI-UST', 'issues']) {
        fs.mkdirSync(path.join(tempDir, 'output', dir, 'ISA'), { recursive: true });
      }
      fs.writeFileSync(path.join(tempDir, 'output', 'AI-ULT', 'ISA', 'ISA-52.usfm'), '\\id ISA\n\\c 52\n\\v 1 ult\n');
      fs.writeFileSync(path.join(tempDir, 'output', 'AI-UST', 'ISA', 'ISA-52.usfm'), '\\id ISA\n\\c 52\n\\v 1 ust\n');
      fs.writeFileSync(path.join(tempDir, 'output', 'issues', 'ISA', 'ISA-52.tsv'), 'isa\t52:1\tfigs-activepassive\tYou were sold\n');
      return { subtype: 'success', usage: {}, total_cost_usd: 0, session_id: 'session-fresh-52' };
    },
  });

  try {
    await harness.generatePipeline(
      { _synthetic: true, _book: 'ISA', _startChapter: 52, _endChapter: 52, skill: 'initial-pipeline', operations: 6 },
      buildMessage('generate isa 52')
    );

    // One fresh invocation was enough — no continuation loop, no hard fail.
    assert.equal(harness.runClaudeCalls.length, 1);
    assert.equal(harness.runClaudeCalls[0].resume, null);
    assert.ok(harness.readStatusTexts().some((t) => t.includes('no artifacts on disk')));
    // slice(1): index 0 is the seeded failure checkpoint this run resumes FROM,
    // which carries errorKind by construction. Only patches written during the
    // run indicate a fresh early exit.
    assert.equal(
      harness.checkpoints.slice(1).some((patch) => patch.current?.errorKind === 'initial_pipeline_early_exit'),
      false
    );
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
    // No chapter ever reached completedChapters, so the run gets an explicit
    // Zulip failure reply instead of only a silent :warning: reaction.
    assert.ok(harness.sent.stream.some(({ text }) => text.includes('Generation failed for **ISA 52** — no chapters completed (1 chapter(s) had errors).')));
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
    // Generation succeeded (completedChapters is non-empty) but push failed for
    // every chapter — this must NOT be reported as a generation failure, and the
    // count must be attributed to push/verify, not blended with generation fails.
    assert.ok(harness.sent.stream.some(({ text }) => text.includes('1 chapter(s) generated content but all failed to push to Door43') && !text.includes('failed generation entirely')));
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

// Issue #271 (EZK 19, 2026-07-24). An EXTERNAL permission wall denied every tool call
// in the align session tree — plain Read/Glob/TaskOutput/Agent, the workspace-tools
// CLI wrapper and the MCP alternate — despite bypassPermissions:true, so the refusal
// came from above this process and nothing local could clear it. Two behaviours must
// hold once the runner has exhausted its own backoff window and reports the wall:
//   1. the align retry is SKIPPED. EZK 19 spent attempt 2 re-running straight into the
//      same wall (19:37:16 -> 19:38:44, 88s, 16 more denials) and banked nothing;
//   2. the failure is labelled `permission_wall`, NOT the coverage-derived
//      `missing_output` that #271 actually shipped — that label sent the operator to
//      "investigate the coordinator prompt / model or simply re-run", advice no prompt
//      change and no re-run could act on.
test('align permission wall skips the retry and outranks the coverage-derived errorKind (#271)', async () => {
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
        // The wall denies everything, so the run banks NOTHING — no aligned USFM and
        // no mapping JSON for salvage to work from. Coverage therefore reads 'missing',
        // which is exactly the reading that must lose to the wall classification.
        return { subtype: 'permission_wall', wallDenials: 2, totalPermissionDenials: 16, usage: {}, total_cost_usd: 0 };
      }
      return { subtype: 'success', usage: {}, total_cost_usd: 0 };
    },
  });

  try {
    await harness.generatePipeline(
      { _synthetic: true, _book: 'ISA', _startChapter: 52, _endChapter: 52, skill: 'initial-pipeline', operations: 6 },
      buildMessage('generate isa 52', { sender_id: 7 })
    );

    const alignCalls = harness.runClaudeCalls.filter((c) => c.skill === 'align-all-parallel');
    assert.equal(alignCalls.length, 1, 'the retry must be skipped while the wall is still up');

    const failure = harness.checkpoints.find((patch) => patch.current?.status === 'failed');
    assert.ok(failure, 'align failure checkpoint expected');
    assert.equal(failure.current.errorKind, 'permission_wall', 'wall must beat the coverage-derived errorKind');
    assert.match(failure.current.validationSummary, /permission wall/i);
    assert.equal(harness.diagnosisCalls[0].checkpoint.current.errorKind, 'permission_wall');

    const texts = harness.readStatusTexts();
    assert.ok(texts.some((t) => /external permission wall/i.test(t)), 'operator must be told it is external');
    assert.ok(texts.some((t) => /Skipping the align retry/i.test(t)), 'the skipped retry must be explained');
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

// Issue #258: JER 35 continuation session had every sub-agent tool call
// auto-denied by the permission classifier and returned end_turn with zero
// artifacts. The wrapper's early-exit check correctly failed the chapter but
// folded the failure into a generic initial_pipeline_early_exit with no signal
// that permission denials were the real cause. After the fix, the continuation
// call passes bypassPermissions to prevent the denial in the first place, and
// when the runner still surfaces a permission stall the checkpoint records a
// distinct errorKind ('initial_pipeline_permission_denied') so admin
// diagnosis names the real cause.
test('generatePipeline passes bypassPermissions to the initial-pipeline continuation call (#258)', async () => {
  const harness = createHarness({
    runClaudeImpl: async ({ options, tempDir }) => {
      // Initial call produces partial output (ULT only), triggering the
      // continuation attempt to finish Wave 2/3.
      if (options.resume === 'session-jer-35') {
        // The regression guard: the continuation MUST be invoked with
        // bypassPermissions so a resumed session can't fall back to the
        // classifier and auto-deny sub-agent tool calls (JER 35, #258).
        assert.equal(options.bypassPermissions, true, 'continuation must pass bypassPermissions to avoid classifier-based auto-denies');
        fs.mkdirSync(path.join(tempDir, 'output', 'AI-UST', 'JER'), { recursive: true });
        fs.mkdirSync(path.join(tempDir, 'output', 'issues', 'JER'), { recursive: true });
        fs.writeFileSync(path.join(tempDir, 'output', 'AI-UST', 'JER', 'JER-35.usfm'), '\\id JER\n\\c 35\n\\v 1 ust\n');
        fs.writeFileSync(path.join(tempDir, 'output', 'issues', 'JER', 'JER-35.tsv'), 'jer\t35:1\tfigs-x\tsample\n');
        return { subtype: 'success', usage: {}, total_cost_usd: 0, session_id: 'session-jer-35' };
      }
      fs.mkdirSync(path.join(tempDir, 'output', 'AI-ULT', 'JER'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, 'tmp', 'pipeline-JER-35'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'output', 'AI-ULT', 'JER', 'JER-35.usfm'), '\\id JER\n\\c 35\n\\v 1 test\n');
      fs.writeFileSync(path.join(tempDir, 'tmp', 'pipeline-JER-35', 'wave2_structure.tsv'), 'jer\t35:1\tfigs-x\tsample\n');
      return { subtype: 'success', usage: {}, total_cost_usd: 0, session_id: 'session-jer-35' };
    },
  });

  try {
    await harness.generatePipeline(
      { _synthetic: true, _book: 'JER', _startChapter: 35, _endChapter: 35, skill: 'initial-pipeline', operations: 6 },
      buildMessage('generate jer 35', { subject: 'JER 35' })
    );
    assert.equal(harness.runClaudeCalls.length, 2);
    assert.equal(harness.runClaudeCalls[1].resume, 'session-jer-35');
    assert.equal(harness.runClaudeCalls[1].bypassPermissions, true);
  } finally {
    harness.cleanup();
  }
});

test('generatePipeline classifies permission-stalled continuation as initial_pipeline_permission_denied (#258)', async () => {
  const harness = createHarness({
    runClaudeImpl: async ({ options, tempDir }) => {
      if (options.resume === 'session-jer-35') {
        // Continuation returns success-shaped result BUT annotated
        // permissionStallDetected — mirroring the shape claude-runner
        // emits when the stall watchdog fires after the SDK has already
        // returned a result message (issue #238). No artifacts are
        // produced because every tool call was auto-denied.
        return {
          subtype: 'success',
          usage: {},
          total_cost_usd: 0,
          session_id: 'session-jer-35',
          permissionStallDetected: true,
        };
      }
      fs.mkdirSync(path.join(tempDir, 'output', 'AI-ULT', 'JER'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, 'tmp', 'pipeline-JER-35'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'output', 'AI-ULT', 'JER', 'JER-35.usfm'), '\\id JER\n\\c 35\n\\v 1 test\n');
      fs.writeFileSync(path.join(tempDir, 'tmp', 'pipeline-JER-35', 'wave2_structure.tsv'), 'jer\t35:1\tfigs-x\tsample\n');
      return { subtype: 'success', usage: {}, total_cost_usd: 0, session_id: 'session-jer-35' };
    },
  });

  try {
    await harness.generatePipeline(
      { _synthetic: true, _book: 'JER', _startChapter: 35, _endChapter: 35, skill: 'initial-pipeline', operations: 6 },
      buildMessage('generate jer 35', { subject: 'JER 35' })
    );
    // The continuation ran, artifacts are still missing, and the
    // checkpoint uses the distinct permission-denied errorKind so
    // diagnosis names the real cause instead of the generic early exit.
    const failure = harness.checkpoints.find((patch) => patch.current?.errorKind === 'initial_pipeline_permission_denied');
    assert.ok(failure, 'expected initial_pipeline_permission_denied checkpoint');
    assert.equal(failure.current.continuationPermissionStall, true);
    assert.deepEqual(failure.current.missingOutputs.sort(), ['UST', 'issues TSV']);
    // Generic early-exit kind must NOT be used when the stall is detected.
    assert.equal(
      harness.checkpoints.some((patch) => patch.current?.errorKind === 'initial_pipeline_early_exit'),
      false,
      'permission-stall classification must beat the generic early-exit fallback'
    );
    // Status text names the real cause.
    assert.ok(
      harness.readStatusTexts().some((text) => /blocked by auto-denied tool calls/i.test(text)),
      'expected status text to name the permission-denial cause'
    );
    // Self-diagnosis payload carries the distinct errorKind.
    assert.equal(harness.diagnosisCalls.length, 1);
    assert.equal(harness.diagnosisCalls[0].checkpoint.current.errorKind, 'initial_pipeline_permission_denied');
    assert.match(harness.diagnosisCalls[0].errorText, /permission-stalled|auto-denied/i);
  } finally {
    harness.cleanup();
  }
});

// Issue #364: EZK 23 was regenerated a month after a successful run. The
// persistent workspace still held July's raw output/AI-ULT|AI-UST files, which
// `align-all-parallel` consumes as input but never deletes. The pre-run cleanup
// did not remove them, so the existence-only gate in
// getInitialPipelineOutputStatus saw ULT/UST/issues-TSV all "present" the
// instant the (no-op, 66-second) initial-pipeline call returned. That skipped
// the early-exit/continuation retry loop entirely and dropped the run into the
// freshness-gated hasUlt/hasUst check, which failed with a generic and
// misleading `missing_output` — the files were on disk, just stale.
test('stale leftovers from a prior run trigger the continuation retry loop, not a bogus missing_output (#364)', async () => {
  const attempts = [];
  const harness = createHarness({
    runClaudeImpl: async ({ options }) => {
      // Every attempt is a no-op: returns "success" almost immediately and
      // writes nothing, mirroring the 66-second August 31 run.
      attempts.push(options);
      return { subtype: 'success', usage: {}, total_cost_usd: 0, session_id: 'session-ezk-23' };
    },
  });

  try {
    // Recreate July's leftovers, including the naming-variant twins that let a
    // copy survive cleanup: resolveOutputFile returns the flat path first, so the
    // old single-shot unlink deleted only that one and left the BOOK/ subdirectory
    // copy on disk to satisfy the existence-only gate.
    const stalePaths = [
      ['output', 'AI-ULT', 'EZK-23.usfm'],
      ['output', 'AI-ULT', 'EZK', 'EZK-23.usfm'],
      ['output', 'AI-UST', 'EZK-23.usfm'],
      ['output', 'AI-UST', 'EZK', 'EZK-23.usfm'],
      ['output', 'issues', 'EZK', 'EZK-23.tsv'],
    ].map((parts) => path.join(harness.tempDir, ...parts));
    const monthAgoSec = Date.now() / 1000 - 32 * 24 * 60 * 60;
    for (const abs of stalePaths) {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, '\\id EZK\n\\c 23\n\\v 1 stale july output\n');
      fs.utimesSync(abs, monthAgoSec, monthAgoSec);
    }

    await harness.generatePipeline(
      { _synthetic: true, _book: 'EZK', _startChapter: 23, _endChapter: 23, skill: 'initial-pipeline', operations: 6 },
      buildMessage('generate ezk 23', { subject: 'EZK 23' })
    );

    // The pre-run cleanup must remove *every* naming variant, not just the first
    // one resolveOutputFile happens to return.
    for (const abs of stalePaths.slice(0, 4)) {
      assert.equal(
        fs.existsSync(abs),
        false,
        `stale leftover ${path.relative(harness.tempDir, abs)} must be deleted before initial-pipeline runs`
      );
    }

    // The core regression: the stale issues TSV (which cleanup never touches)
    // must not make the gate believe initial-pipeline produced valid output.
    // Before the fix the run made exactly one no-op call and fell straight
    // through to the failure branch; now the retry loop fires and re-attempts.
    assert.ok(attempts.length > 1, 'stale leftovers must not short-circuit the initial-pipeline retry loop');

    // And if it still ends up failing, it must not be labelled missing_output
    // when the files are sitting right there on disk.
    const failed = harness.checkpoints.filter((patch) => patch.current?.status === 'failed');
    for (const patch of failed) {
      assert.notEqual(
        patch.current.errorKind,
        'missing_output',
        'a stale-leftover failure must not be classified as missing_output'
      );
    }
  } finally {
    harness.cleanup();
  }
});

// Issue #364, part 3: the `stale_output` branch further down only fires *after*
// hasRequiredGeneratedOutputs succeeds, so a run whose only outputs are stale
// leftovers could never reach it and was labelled `missing_output` instead —
// pointing the operator at generation when the real problem was workspace
// hygiene. For a non-initial-pipeline skill (which never enters the
// continuation retry loop) the classification at that gate is the only signal,
// so it must distinguish "no file at all" from "file present but stale".
test('a failure whose outputs exist but are stale is classified stale_output, not missing_output (#364)', async () => {
  const harness = createHarness({
    // Returns success without writing anything: the leftovers on disk are all
    // that will ever be there.
    runClaudeImpl: async () => ({ subtype: 'success', usage: {}, total_cost_usd: 0 }),
  });

  try {
    // Model hypothesis (a) from the issue: the leftovers survive the pre-run
    // cleanup because the unlink itself fails. A read-only parent directory
    // makes unlink raise EACCES, which the old code swallowed silently.
    const monthAgoSec = Date.now() / 1000 - 32 * 24 * 60 * 60;
    const lockedDirs = [];
    for (const parts of [['output', 'AI-ULT', 'EZK', 'EZK-23.usfm'], ['output', 'AI-UST', 'EZK', 'EZK-23.usfm']]) {
      const abs = path.join(harness.tempDir, ...parts);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, '\\id EZK\n\\c 23\n\\v 1 stale july output\n');
      fs.utimesSync(abs, monthAgoSec, monthAgoSec);
      lockedDirs.push(path.dirname(abs));
    }
    for (const dir of lockedDirs) fs.chmodSync(dir, 0o555);

    await harness.generatePipeline(
      { _synthetic: true, _book: 'EZK', _startChapter: 23, _endChapter: 23, skill: 'ult-generation', operations: 6 },
      buildMessage('generate ezk 23', { subject: 'EZK 23' })
    );

    const failed = harness.checkpoints.filter((patch) => patch.current?.status === 'failed');
    assert.ok(failed.length > 0, 'the run should have failed');
    const kinds = failed.map((patch) => patch.current.errorKind);
    assert.ok(
      kinds.includes('stale_output'),
      `expected a stale_output classification, got ${JSON.stringify(kinds)}`
    );
    assert.equal(failed.at(-1).current.outputStatus, 'stale');
    assert.ok(
      failed.at(-1).current.staleOutputs?.length > 0,
      'the checkpoint should name the stale files so the operator can inspect their mtimes'
    );
    assert.ok(
      harness.readStatusTexts().some((text) => text.includes('stale from an earlier run')),
      'the operator-facing message should say stale, not "missing expected output"'
    );
  } finally {
    for (const parts of [['output', 'AI-ULT', 'EZK'], ['output', 'AI-UST', 'EZK']]) {
      try { fs.chmodSync(path.join(harness.tempDir, ...parts), 0o755); } catch (_) { /* best effort */ }
    }
    harness.cleanup();
  }
});
