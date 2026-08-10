// The direct multi-provider seam in translate-pipeline.js: params resolution,
// key containment, the two LLM branch points, cache-key separation, and the
// failure patch the status endpoint renders.
//
// No network and no Claude Agent SDK: translate-llm is driven through its
// transport test hook, and claude-runner is replaced in the require cache
// BEFORE translate-pipeline loads (it destructures runClaude at load time), so
// "the provider path does not call runClaude" is asserted, not assumed.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');

// --- claude-runner stand-in (installed before translate-pipeline loads) -----
const runClaudeCalls = [];
const claudeRunnerPath = require.resolve('../src/claude-runner');
require.cache[claudeRunnerPath] = {
  id: claudeRunnerPath,
  filename: claudeRunnerPath,
  loaded: true,
  exports: {
    runClaude: async (opts) => {
      runClaudeCalls.push(opts);
      // Behave like the skill: read the task JSON, write the output file.
      const task = JSON.parse(fs.readFileSync(String(opts.prompt).split('\n')[0], 'utf8'));
      fs.writeFileSync(task.outputFile, fs.readFileSync(task._testOutputFrom, 'utf8'), 'utf8');
      return { subtype: 'success' };
    },
  },
};

const core = require('../src/lib/translate-core');
const { getResourceType } = require('../src/lib/resource-types');
const { makeTsvCodec } = require('../src/lib/tsv-resource');
const translateLlm = require('../src/lib/translate-llm');
const {
  resolveParams, runTsvBatch, runArticleFile, buildRunHash, buildFailurePatch,
} = require('../src/translate-pipeline');
const { buildApiSyntheticRoute } = require('../src/router');
const { serializeCheckpoint } = require('../src/api/pipeline');

const KEY = 'sk-provider-key-0123456789abcdef';

// --- fixtures --------------------------------------------------------------

function tsvResource(resourceType) {
  const rt = getResourceType(resourceType);
  const codec = makeTsvCodec(rt.columns);
  return {
    resourceType,
    passThroughColumns: rt.passThroughColumns,
    translateColumns: rt.translateColumns,
    file: rt.file,
    _codec: codec,
    checkOpts: { passThroughColumns: rt.passThroughColumns, translateColumns: rt.translateColumns },
    sizeOf: (r) => rt.translateColumns.reduce((s, c) => s + (r[c] || '').length, 0),
  };
}

const BATCH_ROWS = [
  { Reference: '1:1', ID: 'ab11', Tags: '', SupportReference: 'rc://*/ta/man/translate/figs-metaphor', Quote: 'the vision', Occurrence: '1', Note: 'This is a note.' },
  { Reference: '1:2', ID: 'ab12', Tags: '', SupportReference: '', Quote: '', Occurrence: '1', Note: 'Another note.' },
];
const TARGET_ROWS = BATCH_ROWS.map((r, i) => ({ ...r, Note: i === 0 ? 'هذه ملاحظة.' : 'ملاحظة أخرى.' }));

/** A skills checkout with just the SKILL.md bodies translate-llm inlines. */
function makeSkillsRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tlskills-'));
  for (const skill of ['translate-tn', 'translate-article']) {
    const dir = path.join(root, '.claude', 'skills', skill);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${skill}\n---\n\nTranslate faithfully.\n`, 'utf8');
  }
  return root;
}

function providerParams(extra = {}) {
  const params = {
    resourceType: 'tn',
    family: 'tsv',
    skill: 'translate-tn',
    translateColumns: ['Note'],
    passThroughColumns: getResourceType('tn').passThroughColumns,
    targetLang: 'ar',
    targetLangName: 'Arabic',
    sourceLangName: 'English',
    direction: 'rtl',
    provider: 'claude',
    model: 'claude-opus-5',
    thinking: 'medium',
    ...extra,
  };
  Object.defineProperty(params, 'apiKey', { value: KEY, enumerable: false });
  return params;
}

/** Stub transport returning the given output between the sentinel markers. */
function stubTransport(output, usage = { inputTokens: 1200, outputTokens: 340 }) {
  const seen = [];
  translateLlm._setTestHooks({
    transport: async (args) => {
      seen.push(args);
      return {
        text: `${translateLlm.BEGIN_OUTPUT}\n${output}\n${translateLlm.END_OUTPUT}`,
        usage,
        stopReason: 'end_turn',
      };
    },
  });
  return seen;
}

// --- resolveParams ---------------------------------------------------------

test('resolveParams: provider run carries provider + resolved model, key non-enumerable', () => {
  const route = {
    _synthetic: true, _book: 'OBA', _startChapter: 1, _endChapter: 1, _verseStart: null, _verseEnd: null,
    _translate: { targetLang: 'ar', provider: 'openai', model: 'gpt-5.4-mini' },
  };
  Object.defineProperty(route, '_apiKey', { value: KEY, enumerable: false });

  const p = resolveParams(route, {});
  assert.strictEqual(p.provider, 'openai');
  assert.strictEqual(p.model, 'gpt-5.4-mini');   // NOT the sonnet|opus alias path
  assert.strictEqual(p.apiKey, KEY);
  assert.strictEqual(Object.keys(p).includes('apiKey'), false);
  assert.ok(!JSON.stringify(p).includes(KEY), 'JSON.stringify(params) leaked the key');
  assert.ok(!util.inspect(p, { depth: 5 }).includes(KEY), 'util.inspect(params) leaked the key');
  assert.ok(!util.inspect({ ...p }).includes(KEY), 'spread of params leaked the key');
});

test('resolveParams: a provider without a key throws rather than falling back', () => {
  assert.throws(() => resolveParams({
    _synthetic: true, _book: 'OBA', _startChapter: 1, _endChapter: 1, _verseStart: null, _verseEnd: null,
    _translate: { targetLang: 'ar', provider: 'openai', model: 'gpt-5.4-mini' },
  }, {}), /without an API key/);
});

test('resolveParams: no provider → unchanged model default, no provider, no key', () => {
  const route = {
    _synthetic: true, _book: 'OBA', _startChapter: 1, _endChapter: 1, _verseStart: null, _verseEnd: null,
    _translate: { targetLang: 'ar' },
  };
  const p = resolveParams(route, {});
  assert.strictEqual(p.provider, null);
  assert.strictEqual(p.model, 'opus');
  assert.strictEqual(p.apiKey, undefined);
});

// --- router threading ------------------------------------------------------

test('buildApiSyntheticRoute: provider + resolved model on _translate, key hidden on the route', () => {
  const scope = { book: 'OBA', startChapter: 1, endChapter: 1, verseStart: null, verseEnd: null };
  const route = buildApiSyntheticRoute('translate', scope, { targetLang: 'ar', model: 'sonnet' },
    { provider: 'xai', model: 'grok-4', apiKey: KEY });

  assert.strictEqual(route._translate.provider, 'xai');
  // The provider's resolved model wins over the agentic options.model alias.
  assert.strictEqual(route._translate.model, 'grok-4');
  assert.strictEqual(route._apiKey, KEY);
  assert.strictEqual(Object.keys(route).includes('_apiKey'), false);
  assert.ok(!JSON.stringify(route).includes(KEY), 'JSON.stringify(route) leaked the key');
  assert.ok(!util.inspect(route, { depth: 5 }).includes(KEY), 'util.inspect(route) leaked the key');
});

test('buildApiSyntheticRoute: no ai → no provider, no key, options.model preserved', () => {
  const scope = { book: 'OBA', startChapter: 1, endChapter: 1, verseStart: null, verseEnd: null };
  const route = buildApiSyntheticRoute('translate', scope, { targetLang: 'ar', model: 'sonnet' });
  assert.strictEqual(route._translate.provider, undefined);
  assert.strictEqual(route._translate.model, 'sonnet');
  assert.strictEqual(route._apiKey, undefined);
});

// --- runHash ---------------------------------------------------------------

test('buildRunHash: unchanged without a provider, distinct per provider', () => {
  const p = {
    resourceType: 'tn',
    sourceRef: 'unfoldingWord/en_tn@master',
    contextRef: 'BSOJ/translation-context@master',
    model: 'opus',
    direction: 'rtl',
  };
  // Pinned from the pre-multi-provider formula
  // (sha1 of "tn|unfoldingWord/en_tn@master|BSOJ/translation-context@master|opus|rtl|").
  // A change here orphans every cached batch of every in-flight subscription run.
  assert.strictEqual(buildRunHash(p, ''), 'dd81e34f');

  const claude = buildRunHash({ ...p, provider: 'claude' }, '');
  const openai = buildRunHash({ ...p, provider: 'openai' }, '');
  assert.notStrictEqual(claude, 'dd81e34f');
  assert.notStrictEqual(claude, openai);
});

// --- the two LLM call sites ------------------------------------------------

test('TSV batch: provider params call translate-llm and skip runClaude', async () => {
  const skillsRoot = makeSkillsRoot();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlwork-'));
  const prevSkills = process.env.CSKILLBP_DIR;
  process.env.CSKILLBP_DIR = skillsRoot;
  runClaudeCalls.length = 0;
  try {
    const resource = tsvResource('tn');
    const params = providerParams();
    const files = core.writeBatchFiles(workDir, 0, {
      batchRows: BATCH_ROWS,
      packMarkdown: '# Translation context\n',
      targetLang: 'ar', targetLangName: 'Arabic', sourceLangName: 'English', direction: 'rtl',
      book: 'OBA', resource,
    });
    const seen = stubTransport(resource._codec.serialize(TARGET_ROWS).trimEnd());

    const res = await runTsvBatch({ files, batchRows: BATCH_ROWS, params, resource });

    assert.strictEqual(res.checks.ok, true, JSON.stringify(res.checks.errors));
    assert.strictEqual(res.attempts, 1);
    assert.strictEqual(res.rows.length, 2);
    assert.strictEqual(res.rows[0].Note, 'هذه ملاحظة.');
    assert.strictEqual(runClaudeCalls.length, 0, 'provider path called runClaude');

    // One provider call, carrying the injected key and the resolved model.
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].provider, 'claude');
    assert.strictEqual(seen[0].model, 'claude-opus-5');
    assert.strictEqual(seen[0].apiKey, KEY);
    assert.strictEqual(seen[0].thinking, 'medium');

    // Usage/cost is reported per call for the run report.
    assert.strictEqual(res.llmCalls.length, 1);
    assert.deepStrictEqual(res.llmCalls[0].usage, { inputTokens: 1200, outputTokens: 340 });
    assert.ok(res.llmCalls[0].costUsd > 0, 'costUsd not priced from the catalog');
    assert.strictEqual(res.llmCalls[0].model, 'claude-opus-5');
  } finally {
    translateLlm._resetTestHooks();
    if (prevSkills === undefined) delete process.env.CSKILLBP_DIR; else process.env.CSKILLBP_DIR = prevSkills;
    fs.rmSync(skillsRoot, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test('TSV batch: without a provider the agentic runClaude path is used unchanged', async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlwork-'));
  runClaudeCalls.length = 0;
  try {
    const resource = tsvResource('tn');
    const params = {
      resourceType: 'tn', family: 'tsv', skill: 'translate-tn',
      translateColumns: ['Note'], passThroughColumns: getResourceType('tn').passThroughColumns,
      targetLang: 'ar', targetLangName: 'Arabic', sourceLangName: 'English', direction: 'rtl',
      provider: null, model: 'opus', thinking: 'medium',
    };
    const files = core.writeBatchFiles(workDir, 0, {
      batchRows: BATCH_ROWS,
      packMarkdown: '# Translation context\n',
      targetLang: 'ar', targetLangName: 'Arabic', sourceLangName: 'English', direction: 'rtl',
      book: 'OBA', resource,
    });
    // Point the stand-in runner at the "translated" file it should copy.
    const outSource = path.join(workDir, 'expected-out.tsv');
    fs.writeFileSync(outSource, resource._codec.serialize(TARGET_ROWS), 'utf8');
    const task = JSON.parse(fs.readFileSync(files.taskFile, 'utf8'));
    task._testOutputFrom = outSource;
    fs.writeFileSync(files.taskFile, JSON.stringify(task, null, 2), 'utf8');

    const res = await runTsvBatch({ files, batchRows: BATCH_ROWS, params, resource });

    assert.strictEqual(res.checks.ok, true, JSON.stringify(res.checks.errors));
    assert.strictEqual(runClaudeCalls.length, 1, 'default path did not call runClaude');
    assert.strictEqual(runClaudeCalls[0].model, 'opus');
    assert.strictEqual(runClaudeCalls[0].thinking, 'medium');
    assert.deepStrictEqual(runClaudeCalls[0].tools, ['Read', 'Write']);
    assert.deepStrictEqual(res.llmCalls, []);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test('TSV batch: a provider without an apiKey fails closed and never calls runClaude', async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlwork-'));
  runClaudeCalls.length = 0;
  try {
    const resource = tsvResource('tn');
    const params = {
      resourceType: 'tn', family: 'tsv', skill: 'translate-tn',
      translateColumns: ['Note'], passThroughColumns: getResourceType('tn').passThroughColumns,
      targetLang: 'ar', targetLangName: 'Arabic', sourceLangName: 'English', direction: 'rtl',
      provider: 'claude', model: 'claude-opus-5', thinking: 'medium',
      // apiKey deliberately absent — the call site must not silently fall
      // through to the agentic runClaude path (which would bill on the
      // bot's own subscription) nor to translate-llm's env-key fallback.
    };
    const files = core.writeBatchFiles(workDir, 0, {
      batchRows: BATCH_ROWS,
      packMarkdown: '# Translation context\n',
      targetLang: 'ar', targetLangName: 'Arabic', sourceLangName: 'English', direction: 'rtl',
      book: 'OBA', resource,
    });

    await assert.rejects(
      runTsvBatch({ files, batchRows: BATCH_ROWS, params, resource }),
      (err) => err.errorKind === 'invalid_key',
    );
    assert.strictEqual(runClaudeCalls.length, 0, 'fell through to runClaude without an api key');
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test('article file: provider params call translate-llm and skip runClaude', async () => {
  const skillsRoot = makeSkillsRoot();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlart-'));
  const prevSkills = process.env.CSKILLBP_DIR;
  process.env.CSKILLBP_DIR = skillsRoot;
  runClaudeCalls.length = 0;
  try {
    const sourceMarkdown = '# Aside\n\nAn aside is a figure of speech.\n';
    const params = providerParams({
      resourceType: 'ta', family: 'article', skill: 'translate-article', articleId: 'translate/figs-aside',
    });
    const files = core.writeArticleFiles(workDir, 0, {
      sourceMarkdown,
      packMarkdown: '# Translation context\n',
      articleId: 'translate/figs-aside',
      filePath: 'translate/figs-aside/01.md',
      targetLang: 'ar', targetLangName: 'Arabic', sourceLangName: 'English', direction: 'rtl',
    });
    files.path = 'translate/figs-aside/01.md';
    const seen = stubTransport('# جانب\n\nالجانب هو صورة بلاغية.');

    const res = await runArticleFile({ files, sourceMarkdown, params });

    assert.strictEqual(res.checks.ok, true, JSON.stringify(res.checks.errors));
    assert.match(res.markdown, /جانب/);
    assert.strictEqual(runClaudeCalls.length, 0, 'provider path called runClaude');
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].apiKey, KEY);
    assert.strictEqual(res.llmCalls.length, 1);
    assert.ok(res.llmCalls[0].costUsd > 0);
  } finally {
    translateLlm._resetTestHooks();
    if (prevSkills === undefined) delete process.env.CSKILLBP_DIR; else process.env.CSKILLBP_DIR = prevSkills;
    fs.rmSync(skillsRoot, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test('TSV batch: a failed check drives the shared repair loop on the provider path too', async () => {
  const skillsRoot = makeSkillsRoot();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlrepair-'));
  const prevSkills = process.env.CSKILLBP_DIR;
  process.env.CSKILLBP_DIR = skillsRoot;
  try {
    const resource = tsvResource('tn');
    const params = providerParams();
    const files = core.writeBatchFiles(workDir, 0, {
      batchRows: BATCH_ROWS,
      packMarkdown: '# Translation context\n',
      targetLang: 'ar', targetLangName: 'Arabic', sourceLangName: 'English', direction: 'rtl',
      book: 'OBA', resource,
    });

    // Attempt 1 drops a row (missing-row error); attempt 2 is complete.
    const bad = resource._codec.serialize([TARGET_ROWS[0]]).trimEnd();
    const good = resource._codec.serialize(TARGET_ROWS).trimEnd();
    const seen = [];
    let call = 0;
    translateLlm._setTestHooks({
      transport: async (args) => {
        seen.push(args);
        call += 1;
        const body = call === 1 ? bad : good;
        return {
          text: `${translateLlm.BEGIN_OUTPUT}\n${body}\n${translateLlm.END_OUTPUT}`,
          usage: { inputTokens: 100, outputTokens: 50 },
          stopReason: 'end_turn',
        };
      },
    });

    const res = await runTsvBatch({ files, batchRows: BATCH_ROWS, params, resource });
    assert.strictEqual(res.attempts, 2);
    assert.strictEqual(res.checks.ok, true);
    assert.strictEqual(res.llmCalls.length, 2);
    // The repair prompt carries the violations and the previous output.
    assert.match(seen[1].user, /FAILED deterministic validation/);
    assert.match(seen[1].user, /Previous output/);
  } finally {
    translateLlm._resetTestHooks();
    if (prevSkills === undefined) delete process.env.CSKILLBP_DIR; else process.env.CSKILLBP_DIR = prevSkills;
    fs.rmSync(skillsRoot, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

// --- usage aggregation into the run report ---------------------------------

/** A context-pack directory is enough to run translateArticles fully offline. */
function makeContextDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlctx-'));
  fs.writeFileSync(path.join(dir, 'instructions.md'), 'translate faithfully', 'utf8');
  return dir;
}

const RESOLVE_TWO_FILES = async () => ({
  articleId: 'translate/figs-aside',
  files: [
    { path: 'translate/figs-aside/01.md', sourceMarkdown: '# Aside\n\nbody' },
    { path: 'translate/figs-aside/sub.md', sourceMarkdown: '# Sub\n\nbody' },
  ],
});
const OK_CHECKS = { ok: true, errors: [], warnings: [], violations: [] };

test('report.llm sums usage and cost across calls on a provider run', async () => {
  const ctxDir = makeContextDir();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlagg-'));
  try {
    const { translateArticles } = require('../src/translate-pipeline');
    const params = providerParams({
      resourceType: 'ta', family: 'article', skill: 'translate-article',
      articleId: 'translate/figs-aside', articleUrl: null,
      sourceLang: 'en', sourceRef: 'unfoldingWord/en_ta@master',
      contextRef: ctxDir, contextRefExplicit: true,
      targetOrg: 'BSOJ', repoName: 'ar_ta',
    });
    let n = 0;
    const runFileImpl = async () => {
      n += 1;
      return {
        markdown: '# جانب\n\nنص',
        checks: OK_CHECKS,
        attempts: 1,
        llmCalls: [{ usage: { inputTokens: 1000 * n, outputTokens: 100 * n }, costUsd: 0.25 * n, model: 'claude-opus-5' }],
      };
    };
    const res = await translateArticles(params, { workDir, resolveImpl: RESOLVE_TWO_FILES, runFileImpl });
    assert.deepStrictEqual(res.report.llm, {
      provider: 'claude',
      model: 'claude-opus-5',
      inputTokens: 3000,
      outputTokens: 300,
      estimatedCostUsd: 0.75,
      calls: 2,
    });
  } finally {
    fs.rmSync(ctxDir, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test('report has no llm field at all on a subscription run', async () => {
  const ctxDir = makeContextDir();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlagg2-'));
  try {
    const { translateArticles } = require('../src/translate-pipeline');
    const params = {
      resourceType: 'ta', family: 'article', skill: 'translate-article',
      articleId: 'translate/figs-aside', articleUrl: null,
      targetLang: 'ar', targetLangName: 'Arabic', sourceLang: 'en', sourceLangName: 'English',
      direction: 'rtl', sourceRef: 'unfoldingWord/en_ta@master',
      contextRef: ctxDir, contextRefExplicit: true, model: 'opus', provider: null,
      targetOrg: 'BSOJ', repoName: 'ar_ta',
    };
    const runFileImpl = async () => ({ markdown: '# جانب\n\nنص', checks: OK_CHECKS, attempts: 1 });
    const res = await translateArticles(params, { workDir, resolveImpl: RESOLVE_TWO_FILES, runFileImpl });
    assert.strictEqual('llm' in res.report, false, 'subscription report grew an llm field');
  } finally {
    fs.rmSync(ctxDir, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

// --- failure reporting -----------------------------------------------------

test('buildFailurePatch: provider errorKind rides the checkpoint and reaches GET status', () => {
  const err = new translateLlm.TranslateProviderError('invalid_key', 'openai', 'openai invalid_key: bad key');
  const { message, patch } = buildFailurePatch(err, { chapter: 1, skill: 'translate-tn', apiKey: KEY });
  assert.strictEqual(patch.state, 'failed');
  assert.strictEqual(patch.current.errorKind, 'invalid_key');
  assert.strictEqual(message, 'openai invalid_key: bad key');

  const out = serializeCheckpoint('job-1', {
    pipelineType: 'translate',
    scope: { book: 'OBA', startChapter: 1, endChapter: 1, verseStart: null, verseEnd: null },
    state: patch.state,
    current: patch.current,
    updatedAt: '2026-08-07T00:00:00.000Z',
    createdAt: '2026-08-07T00:00:00.000Z',
  });
  assert.strictEqual(out.current.errorKind, 'invalid_key');
  assert.strictEqual(out.current.error, 'openai invalid_key: bad key');
});

test('buildFailurePatch: the API key is scrubbed out of the reported message', () => {
  const err = new Error(`request failed for key ${KEY} at provider`);
  const { message, patch } = buildFailurePatch(err, { chapter: 1, skill: 'translate-tn', apiKey: KEY });
  assert.ok(!message.includes(KEY), `message leaked the key: ${message}`);
  assert.ok(!patch.current.error.includes(KEY));
  assert.match(message, /\[redacted\]/);
});

test('buildFailurePatch: without an errorKind the patch shape is unchanged', () => {
  const { patch } = buildFailurePatch(new Error('boom'), { chapter: 3, skill: 'translate-tq', apiKey: null });
  assert.deepStrictEqual(patch, {
    state: 'failed',
    current: { chapter: 3, skill: 'translate-tq', status: 'failed', error: 'boom' },
  });
});
