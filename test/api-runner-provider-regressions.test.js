const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  getProviderConfig,
  resolveProviderModel,
} = require('../src/api-runner/provider-config');
const { parseArgs } = require('../src/api-runner/cli');
const {
  DEFAULT_RUNTIME,
  resolveRuntime,
} = require('../src/api-runner/runtime-config');
const geminiProvider = require('../src/api-runner/providers/gemini');
const {
  getHarnessModels,
  getCleanupTargets,
  validateRequiredArtifacts,
  destDirName,
} = require('../scripts/test-providers-zec3');
const {
  resolveAgentProvider,
  resolveAgentRuntime,
} = require('../src/api-runner/team-manager');
const { getProviderSystemAppend } = require('../src/api-runner/provider-nudges');
const {
  OPENAI_TOOL_SCHEMAS,
  buildCanonicalPaths,
  verifyOutputFile,
} = require('../src/api-runner/openai-native-stage-runner');
const { readPreparedNotes } = require('../src/workspace-tools/tn-tools');

test('openai native tool catalog excludes recursive agent tools', () => {
  const names = OPENAI_TOOL_SCHEMAS.map((schema) => schema.name);
  assert.equal(names.includes('Agent'), false);
  assert.equal(names.includes('TeamCreate'), false);
  assert.equal(names.includes('SendMessage'), false);
  assert.equal(names.includes('TaskCreate'), false);
  assert.equal(names.includes('TaskGet'), false);
  assert.equal(names.includes('Read'), true);
  assert.equal(names.includes('mcp__workspace-tools__read_prepared_notes'), true);
});

test('openai native output verification rejects missing and empty files', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-native-verify-'));
  const missingPath = path.join(tempDir, 'missing.tsv');
  assert.throws(() => verifyOutputFile(missingPath, 'notes'), /missing/);

  const emptyPath = path.join(tempDir, 'empty.tsv');
  fs.writeFileSync(emptyPath, '');
  assert.throws(() => verifyOutputFile(emptyPath, 'notes'), /empty/);

  const okPath = path.join(tempDir, 'ok.tsv');
  fs.writeFileSync(okPath, 'Reference\tID\nZEC 3:1\ta1b2\n');
  assert.doesNotThrow(() => verifyOutputFile(okPath, 'notes'));
});

test('runSkill delegates openai native skills to the native stage runner', async () => {
  const runnerPath = require.resolve('../src/api-runner/runner');
  const stageRunnerPath = require.resolve('../src/api-runner/openai-native-stage-runner');
  const stageRunnerModule = require(stageRunnerPath);
  const originalRunOpenAiNativeSkill = stageRunnerModule.runOpenAiNativeSkill;

  let received = null;
  stageRunnerModule.runOpenAiNativeSkill = async (skillName, prompt, opts) => {
    received = { skillName, prompt, opts };
    return {
      turns: 1,
      inputTokens: 10,
      outputTokens: 5,
      cost: 0.01,
      durationMs: 5,
      finalText: 'ok',
    };
  };

  delete require.cache[runnerPath];

  try {
    const runner = require(runnerPath);
    const result = await runner.runSkill('tn-writer', 'ZEC 3 --context tmp/pipeline/ZEC-03/context.json', {
      provider: 'openai',
      runtime: 'openai-native',
      cwd: '/srv/bot/workspace',
      apiKeys: { openai: 'test-key' },
    });

    assert.equal(received.skillName, 'tn-writer');
    assert.equal(received.prompt, 'ZEC 3 --context tmp/pipeline/ZEC-03/context.json');
    assert.equal(received.opts.runtime, 'openai-native');
    assert.equal(result.finalText, 'ok');
  } finally {
    stageRunnerModule.runOpenAiNativeSkill = originalRunOpenAiNativeSkill;
    delete require.cache[runnerPath];
  }
});

test('openai native initial-pipeline expands into ULT, issues, and UST stages', async () => {
  const agentLoopPath = require.resolve('../src/api-runner/agent-loop');
  const stageRunnerPath = require.resolve('../src/api-runner/openai-native-stage-runner');
  const agentLoopModule = require(agentLoopPath);
  const originalRunAgentLoop = agentLoopModule.runAgentLoop;
  const tempTag = `JON-${String(9).padStart(2, '0')}`;
  const cwd = '/srv/bot/workspace';
  const outputs = buildCanonicalPaths(cwd, 'JON', 9);
  const pipelineDir = path.join(cwd, 'tmp/pipeline', tempTag);

  for (const target of [
    outputs.ult,
    outputs.ust,
    outputs.issues,
    pipelineDir,
  ]) {
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  }

  agentLoopModule.runAgentLoop = async (opts) => {
    const system = String(opts.system || '');
    if (system.includes('name: ULT-gen')) {
      fs.mkdirSync(path.dirname(outputs.ult), { recursive: true });
      fs.writeFileSync(outputs.ult, '\\id JON\n\\c 9\n\\v 1 test\n');
    } else if (system.includes('name: deep-issue-id')) {
      fs.mkdirSync(path.dirname(outputs.issues), { recursive: true });
      fs.writeFileSync(outputs.issues, 'Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote\nJON 9:1\ta1b2\tfigs-metaphor\t\tfish\t1\tTest\n');
    } else if (system.includes('name: UST-gen')) {
      fs.mkdirSync(path.dirname(outputs.ust), { recursive: true });
      fs.writeFileSync(outputs.ust, '\\id JON\n\\c 9\n\\v 1 test\n');
    }

    return {
      turns: 1,
      inputTokens: 10,
      outputTokens: 5,
      cost: 0.01,
      durationMs: 5,
      finalText: 'ok',
    };
  };

  delete require.cache[stageRunnerPath];

  try {
    const { runOpenAiNativeSkill } = require(stageRunnerPath);
    const result = await runOpenAiNativeSkill('initial-pipeline', 'jon 9', {
      provider: 'openai',
      runtime: 'openai-native',
      cwd,
      apiKey: 'test-key',
      apiKeyResolver: () => 'test-key',
    });

    assert.deepEqual(result.steps.map((step) => step.skill), ['ULT-gen', 'deep-issue-id', 'UST-gen']);
    assert.equal(fs.existsSync(outputs.ult), true);
    assert.equal(fs.existsSync(outputs.issues), true);
    assert.equal(fs.existsSync(outputs.ust), true);
  } finally {
    agentLoopModule.runAgentLoop = originalRunAgentLoop;
    if (fs.existsSync(outputs.ult)) fs.rmSync(outputs.ult, { force: true });
    if (fs.existsSync(outputs.ust)) fs.rmSync(outputs.ust, { force: true });
    if (fs.existsSync(outputs.issues)) fs.rmSync(outputs.issues, { force: true });
    if (fs.existsSync(pipelineDir)) fs.rmSync(pipelineDir, { recursive: true, force: true });
  }
});

test('openai native initial-pipeline accepts flat output layouts', async () => {
  const agentLoopPath = require.resolve('../src/api-runner/agent-loop');
  const stageRunnerPath = require.resolve('../src/api-runner/openai-native-stage-runner');
  const pipelineUtilsPath = require.resolve('../src/pipeline-utils');
  const agentLoopModule = require(agentLoopPath);
  const originalRunAgentLoop = agentLoopModule.runAgentLoop;
  const oldBaseDir = process.env.CSKILLBP_DIR;
  const cwd = '/srv/bot/workspace';
  const tag = 'JON-09';
  const outputs = buildCanonicalPaths(cwd, 'JON', 9);
  const flatUlt = path.join(cwd, 'output/AI-ULT', `${tag}.usfm`);
  const flatIssues = path.join(cwd, 'output/issues', `${tag}.tsv`);
  const flatUst = path.join(cwd, 'output/AI-UST', `${tag}.usfm`);
  const pipelineDir = path.join(cwd, 'tmp/pipeline', tag);

  for (const target of [
    outputs.ult,
    outputs.issues,
    outputs.ust,
    flatUlt,
    flatIssues,
    flatUst,
    pipelineDir,
  ]) {
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  }

  agentLoopModule.runAgentLoop = async (opts) => {
    const system = String(opts.system || '');
    if (system.includes('name: ULT-gen')) {
      fs.mkdirSync(path.dirname(flatUlt), { recursive: true });
      fs.writeFileSync(flatUlt, '\\id JON\n\\c 9\n\\v 1 test\n');
    } else if (system.includes('name: deep-issue-id')) {
      fs.mkdirSync(path.dirname(flatIssues), { recursive: true });
      fs.writeFileSync(flatIssues, 'Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote\nJON 9:1\ta1b2\tfigs-metaphor\t\tfish\t1\tTest\n');
    } else if (system.includes('name: UST-gen')) {
      fs.mkdirSync(path.dirname(flatUst), { recursive: true });
      fs.writeFileSync(flatUst, '\\id JON\n\\c 9\n\\v 1 test\n');
    }

    return {
      turns: 1,
      inputTokens: 10,
      outputTokens: 5,
      cost: 0.01,
      durationMs: 5,
      finalText: 'ok',
    };
  };

  process.env.CSKILLBP_DIR = cwd;
  delete require.cache[pipelineUtilsPath];
  delete require.cache[stageRunnerPath];

  try {
    const { runOpenAiNativeSkill } = require(stageRunnerPath);
    const result = await runOpenAiNativeSkill('initial-pipeline', 'jon 9', {
      provider: 'openai',
      runtime: 'openai-native',
      cwd,
      apiKey: 'test-key',
      apiKeyResolver: () => 'test-key',
    });

    assert.deepEqual(result.steps.map((step) => step.skill), ['ULT-gen', 'deep-issue-id', 'UST-gen']);
    assert.equal(fs.existsSync(flatUlt), true);
    assert.equal(fs.existsSync(flatIssues), true);
    assert.equal(fs.existsSync(flatUst), true);
    assert.equal(fs.existsSync(outputs.ult), false);
    assert.equal(fs.existsSync(outputs.issues), false);
    assert.equal(fs.existsSync(outputs.ust), false);
  } finally {
    agentLoopModule.runAgentLoop = originalRunAgentLoop;
    if (oldBaseDir == null) delete process.env.CSKILLBP_DIR;
    else process.env.CSKILLBP_DIR = oldBaseDir;
    delete require.cache[pipelineUtilsPath];
    delete require.cache[stageRunnerPath];
    for (const target of [flatUlt, flatIssues, flatUst]) {
      if (fs.existsSync(target)) fs.rmSync(target, { force: true });
    }
    if (fs.existsSync(pipelineDir)) fs.rmSync(pipelineDir, { recursive: true, force: true });
  }
});

test('runWithSystem forwards cwd into the openai native runtime', async () => {
  const runnerPath = require.resolve('../src/api-runner/runner');
  const nativePath = require.resolve('../src/api-runner/openai-native');
  const originalNativeModule = require.cache[nativePath];
  const nativeModule = require(nativePath);
  const originalRunOpenAiNative = nativeModule.runOpenAiNative;

  let receivedOpts = null;
  nativeModule.runOpenAiNative = async (opts) => {
    receivedOpts = opts;
    return {
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      durationMs: 0,
      finalText: 'ok',
    };
  };

  delete require.cache[runnerPath];

  try {
    const runner = require(runnerPath);
    await runner.runWithSystem('system', 'prompt', {
      provider: 'openai',
      runtime: 'openai-native',
      cwd: '/tmp/native-cwd',
      apiKeys: { openai: 'test-key' },
    });

    assert.equal(receivedOpts.cwd, '/tmp/native-cwd');
    assert.equal(receivedOpts.runtime, 'openai-native');
  } finally {
    nativeModule.runOpenAiNative = originalRunOpenAiNative;
    delete require.cache[runnerPath];
    if (originalNativeModule) require.cache[nativePath] = originalNativeModule;
  }
});

test('openai aliases resolve to current runner defaults', () => {
  assert.equal(resolveProviderModel('openai', 'opus'), 'gpt-5.4');
  assert.equal(resolveProviderModel('openai', 'sonnet'), 'gpt-5.4-mini');
  assert.equal(resolveProviderModel('openai', 'haiku'), 'gpt-5.4-nano');
  assert.equal(resolveProviderModel('xai', 'opus'), 'grok-4.20-reasoning');
  assert.equal(resolveProviderModel('xai', 'sonnet'), 'grok-4.20-reasoning');
});

test('runtime config defaults to generic api and restricts openai-native to openai', () => {
  assert.equal(resolveRuntime('openai'), DEFAULT_RUNTIME);
  assert.equal(resolveRuntime('openai', 'openai-native'), 'openai-native');
  assert.throws(
    () => resolveRuntime('gemini', 'openai-native'),
    /only supported with provider "openai"/
  );
  assert.throws(
    () => resolveRuntime('openai', 'made-up-runtime'),
    /Unknown runtime/
  );
});

test('cli parses runtime flag for api runner selection', () => {
  const args = parseArgs([
    'node',
    'src/api-runner/cli.js',
    '--provider', 'openai',
    '--runtime', 'openai-native',
    '--skill', 'ULT-gen',
    '--prompt', 'PSA 133',
  ]);

  assert.equal(args.provider, 'openai');
  assert.equal(args.runtime, 'openai-native');
  assert.equal(args.skill, 'ULT-gen');
  assert.equal(args.prompt, 'PSA 133');
});

test('gemini provider config exposes fallback models for transient overloads', () => {
  const cfg = getProviderConfig('gemini');
  assert.deepEqual(cfg.fallbackModels['gemini-3.1-pro-preview'], [
    'gemini-3-pro-preview',
    'gemini-2.5-pro',
  ]);
  assert.deepEqual(cfg.fallbackModels['gemini-3-flash-preview'], [
    'gemini-2.5-flash',
  ]);
});

test('gemini ZEC harness defaults follow provider-config aliases', () => {
  const models = getHarnessModels('gemini');
  assert.equal(models.opus, resolveProviderModel('gemini', 'opus'));
  assert.equal(models.sonnet, resolveProviderModel('gemini', 'sonnet'));
  assert.equal(models.opus, 'gemini-3.1-pro-preview');
  assert.equal(models.sonnet, 'gemini-2.5-pro');
});

test('zec harness parses runtime flag for openai native runs', () => {
  const args = require('../scripts/test-providers-zec3').parseArgs([
    'node',
    'scripts/test-providers-zec3.js',
    '--provider', 'openai',
    '--runtime', 'openai-native',
  ]);

  assert.equal(args.provider, 'openai');
  assert.equal(args.runtime, 'openai-native');
});

test('zec harness keeps generic api as the default runtime', () => {
  const args = require('../scripts/test-providers-zec3').parseArgs([
    'node',
    'scripts/test-providers-zec3.js',
    '--provider', 'openai',
  ]);

  assert.equal(args.runtime, DEFAULT_RUNTIME);
});

test('zec harness files openai native snapshots in a sibling folder', () => {
  assert.equal(destDirName('openai', DEFAULT_RUNTIME), 'openai-api');
  assert.equal(destDirName('openai', 'openai-native'), 'openai-native');
  assert.equal(destDirName('gemini', DEFAULT_RUNTIME), 'gemini-api');
});

test('zec harness cleanup includes live zec 3 output and temp artifacts', () => {
  const targets = getCleanupTargets('ZEC', 3, 'openai', 'openai-native');

  assert.ok(targets.some((target) => target.endsWith('/workspace/output/AI-ULT/ZEC/ZEC-03.usfm')));
  assert.ok(targets.some((target) => target.endsWith('/workspace/output/AI-UST/ZEC/ZEC-03-aligned.usfm')));
  assert.ok(targets.some((target) => target.endsWith('/workspace/output/issues/ZEC/ZEC-03.tsv')));
  assert.ok(targets.some((target) => target.endsWith('/workspace/output/notes/ZEC/ZEC-03.tsv')));
  assert.ok(targets.some((target) => target.endsWith('/workspace/output/quality/ZEC/ZEC-03-quality.md')));
  assert.ok(targets.some((target) => target.endsWith('/workspace/output/AI-UST/hints/ZEC/ZEC-03.json')));
  assert.ok(targets.some((target) => target.endsWith('/workspace/tmp/alignments/ZEC/ZEC-03-mapping.json')));
  assert.ok(targets.some((target) => target.endsWith('/workspace/tmp/ZEC-03-alignment-mapping.json')));
  assert.ok(targets.some((target) => target.endsWith('/workspace/tmp/pipeline/ZEC-03')));
  assert.ok(targets.some((target) => target.endsWith('/workspace/tmp/pipeline-ZEC-03')));
  assert.ok(targets.some((target) => target.endsWith('/workspace/test/zec-03/openai-native')));
  assert.equal(targets.some((target) => target.endsWith('/workspace/test/zec-03/openai-api')), false);
});

test('gemini tool results preserve upstream tool call ids', () => {
  const result = geminiProvider.formatToolResult('call-123', 'ping', { ok: true }, false);
  assert.deepEqual(result, {
    role: 'tool',
    results: [{
      toolCallId: 'call-123',
      name: 'ping',
      content: JSON.stringify({ ok: true }),
      isError: false,
    }],
  });
});

test('gemini 2.5 low thinking keeps a positive budget', () => {
  assert.equal(typeof geminiProvider.getThinkingConfig, 'function');
  assert.deepEqual(geminiProvider.getThinkingConfig('gemini-2.5-pro', 'low'), {
    thinkingConfig: { thinkingBudget: 1024 },
  });
  assert.deepEqual(geminiProvider.getThinkingConfig('gemini-3.1-pro-preview', 'low'), {
    thinkingConfig: { thinkingLevel: 'low' },
  });
});

test('gemini tool response contents include matching function response ids', () => {
  assert.equal(typeof geminiProvider.toGeminiContents, 'function');

  const contents = geminiProvider.toGeminiContents([
    geminiProvider.formatAssistantMessage('', [{
      id: 'call-123',
      name: 'ping',
      arguments: { text: 'hello' },
    }], [
      { functionCall: { id: 'call-123', name: 'ping', args: { text: 'hello' } } },
    ]),
    geminiProvider.formatToolResult('call-123', 'ping', 'OK', false),
  ]);

  assert.deepEqual(contents[1], {
    role: 'user',
    parts: [{
      functionResponse: {
        id: 'call-123',
        name: 'ping',
        response: { content: 'OK' },
      },
    }],
  });
});

test('locked provider runs keep sub-agents on the parent provider', () => {
  assert.equal(
    resolveAgentProvider({ provider: 'claude' }, { provider: 'openai', lockProvider: true }),
    'openai'
  );
  assert.equal(
    resolveAgentProvider({}, { provider: 'gemini', lockProvider: true }),
    'gemini'
  );
});

test('locked runtime runs keep sub-agents on the parent runtime', () => {
  assert.equal(
    resolveAgentRuntime({ runtime: 'generic-api' }, { runtime: 'openai-native', lockProvider: true }),
    'openai-native'
  );
  assert.equal(
    resolveAgentRuntime({}, { runtime: 'generic-api', lockProvider: false }),
    'generic-api'
  );
});

test('provider-specific runner nudges stay attached to openai and xai', () => {
  const openaiNudge = getProviderSystemAppend('openai', 'initial-pipeline', { book: 'ZEC', chapter: 3 });
  assert.match(openaiNudge, /output\/AI-ULT\/ZEC\/ZEC-03\.usfm/);
  assert.match(openaiNudge, /Verify they exist with a Glob or Read/);
  assert.match(openaiNudge, /zero-padded chapter tag "ZEC-03"/);

  const xaiNudge = getProviderSystemAppend('xai', 'initial-pipeline', { book: 'ZEC', chapter: 3 });
  assert.match(xaiNudge, /header-only file/);
  assert.match(xaiNudge, /at least one data row/);
  assert.match(xaiNudge, /Do NOT invent unpadded variants such as "ZEC-3\.usfm"/);

  const xaiAlignNudge = getProviderSystemAppend('xai', 'align-all-parallel', { book: 'ZEC', chapter: 3 });
  assert.match(xaiAlignNudge, /output\/AI-ULT\/ZEC\/ZEC-03-aligned\.usfm/);
  assert.match(xaiAlignNudge, /create_aligned_usfm/);
  assert.match(xaiAlignNudge, /Do not accept a representative sample/);

  assert.equal(getProviderSystemAppend('gemini', 'initial-pipeline'), '');
  assert.equal(getProviderSystemAppend('openai', 'align-all-parallel', { book: 'ZEC', chapter: 3 }), '');
  assert.equal(getProviderSystemAppend('xai', 'tn-writer'), '');
});

test('zec harness artifact gate rejects missing or empty required outputs', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zec3-artifacts-'));
  const paths = {
    ult: path.join(tempDir, 'ZEC-03.usfm'),
    ultAligned: path.join(tempDir, 'ZEC-03-aligned.usfm'),
    ust: path.join(tempDir, 'ZEC-03-UST.usfm'),
    ustAligned: path.join(tempDir, 'ZEC-03-UST-aligned.usfm'),
    issues: path.join(tempDir, 'ZEC-03-issues.tsv'),
    notes: path.join(tempDir, 'ZEC-03-notes.tsv'),
  };

  fs.writeFileSync(paths.ult, '\\id ZEC');
  fs.writeFileSync(paths.ultAligned, '\\id ZEC');
  fs.writeFileSync(paths.ust, '');
  fs.writeFileSync(paths.ustAligned, '\\id ZEC');
  fs.writeFileSync(paths.issues, 'Reference\tID\n3:1\ta1b2\n');

  const result = validateRequiredArtifacts(paths);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing.map((entry) => entry.key), ['notes']);
  assert.deepEqual(result.empty.map((entry) => entry.key), ['ust']);
});

test('readPreparedNotes accepts object-backed prepared_notes packets', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prepared-notes-'));
  const relRoot = path.join('tmp', path.basename(tempDir));
  const absRoot = path.join('/srv/bot/workspace', relRoot);
  fs.mkdirSync(absRoot, { recursive: true });

  const preparedRel = path.join(relRoot, 'prepared_notes.json');
  fs.writeFileSync(path.join('/srv/bot/workspace', preparedRel), JSON.stringify({
    book: 'ZEC',
    chapter: '03',
    item_count: 2,
    items: [
      { id: 'a1b2', reference: '3:1' },
      { id: 'c3d4', reference: '3:2' },
    ],
  }, null, 2));

  const summary = JSON.parse(readPreparedNotes({ preparedJson: preparedRel, summaryOnly: true }));
  assert.equal(summary.total, 2);
  assert.deepEqual(summary.ids, ['a1b2', 'c3d4']);
});
