// Direct multi-provider LLM path for the translate pipeline. No network: every
// SDK call goes through the module's transport test hook.
'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'translate-llm-'));

// Fixture skills checkout. The module resolves CSKILLBP_DIR at call time, so an
// env override here is enough — no need to preload before require.
const SKILL_DIR = path.join(TMP, 'skills', '.claude', 'skills', 'translate-tn');
fs.mkdirSync(SKILL_DIR, { recursive: true });
fs.writeFileSync(path.join(SKILL_DIR, 'SKILL.md'), [
  '---',
  'name: translate-tn',
  'description: Fixture skill. Should never reach the prompt.',
  '---',
  '',
  '# translate-tn — fixture body',
  '',
  'IRON RULE: the Quote column is copied byte-for-byte.',
  '',
  '## Input',
  '',
  'Read the task JSON and Write the outputFile.',
  '',
].join('\n'), 'utf8');
process.env.CSKILLBP_DIR = path.join(TMP, 'skills');

// Pinned pricing so the cost assertions do not drift with the live catalog.
// Overrides merge into the defaults, so every other provider/model still works.
const CONFIG_FIXTURE = path.join(TMP, 'model-provider-config.json');
fs.writeFileSync(CONFIG_FIXTURE, JSON.stringify({
  providers: {
    claude: { models: { 'llm-test-priced': { label: 'Test', inputPer1M: 2.0, outputPer1M: 10.0 } } },
  },
}), 'utf8');
process.env.MODEL_PROVIDER_CONFIG_FILE = CONFIG_FIXTURE;

const llm = require('../src/lib/translate-llm');

after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });

const HEADER = 'Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote';
const ROW = '1:1\tab12\t\trc://*/ta/man/translate/figs-metaphor\tדְּבַר\t1\tترجمة';

/** Materialize the working files runTsvBatch expects, mirroring writeBatchFiles. */
function makeBatchFiles(name = 'batch-01') {
  const dir = fs.mkdtempSync(path.join(TMP, 'work-'));
  const files = {
    nn: '01',
    batchFile: path.join(dir, `${name}.tsv`),
    packFile: path.join(dir, `${name}-pack.md`),
    taskFile: path.join(dir, `${name}-task.json`),
    outputFile: path.join(dir, `${name}-out.tsv`),
  };
  fs.writeFileSync(files.batchFile, `${HEADER}\n${ROW}\n`, 'utf8');
  fs.writeFileSync(files.packFile, '# Context pack fixture\n\nPreferred: عهد\n', 'utf8');
  fs.writeFileSync(files.taskFile, JSON.stringify({
    task: 'translate-tsv-batch',
    resourceType: 'tn',
    translateColumns: ['Note'],
    passThroughColumns: ['Reference', 'ID', 'Tags', 'SupportReference', 'Quote', 'Occurrence'],
    batchFile: files.batchFile,
    packFile: files.packFile,
    outputFile: files.outputFile,
  }, null, 2), 'utf8');
  return files;
}

function withKey(params, apiKey) {
  Object.defineProperty(params, 'apiKey', { value: apiKey, enumerable: false });
  return params;
}

function wrapped(body) {
  return `Here you go.\n\n${llm.BEGIN_OUTPUT}\n${body}\n${llm.END_OUTPUT}\n`;
}

function stubTransport(impl) {
  const calls = [];
  const sleeps = [];
  llm._setTestHooks({
    transport: async (args) => { calls.push(args); return impl(args, calls.length); },
    sleep: async (s) => { sleeps.push(s); },
  });
  return { calls, sleeps };
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

test('buildTranslatePrompt strips frontmatter and appends the API mode override', () => {
  const { system } = llm.buildTranslatePrompt({
    skill: 'translate-tn', taskJson: '{}', packMarkdown: 'pack', sourceText: 'src',
  });
  assert.ok(!system.includes('description: Fixture skill'), 'YAML frontmatter must not reach the model');
  assert.ok(!/^---/.test(system), 'system must not start with a frontmatter fence');
  assert.ok(system.startsWith('# translate-tn — fixture body'), system.slice(0, 80));
  assert.ok(system.includes('IRON RULE'), 'skill body must be preserved');
  assert.ok(system.includes('## API mode override (supersedes the Input/Output mechanics above)'));
  assert.ok(system.includes('There are no tools'));
  assert.ok(system.includes(llm.BEGIN_OUTPUT) && system.includes(llm.END_OUTPUT));
});

test('buildTranslatePrompt inlines the task JSON, the pack and the source rows', () => {
  const { user } = llm.buildTranslatePrompt({
    skill: 'translate-tn',
    taskJson: '{"task":"translate-tsv-batch","rowCount":1}',
    packMarkdown: '# Pack\n\nPreferred: عهد',
    sourceText: `${HEADER}\n${ROW}`,
  });
  assert.ok(user.includes('"task":"translate-tsv-batch"'));
  assert.ok(user.includes('Preferred: عهد'));
  assert.ok(user.includes(ROW), 'the TSV rows must be inlined verbatim');
  assert.ok(user.includes('# Task JSON') && user.includes('# Context pack') && user.includes('# Source content'));
  assert.ok(!user.includes('# Previous output'));
  assert.ok(!user.includes('# Repair note'));
});

test('buildTranslatePrompt repair mode inlines the previous output and the violations', () => {
  const { user } = llm.buildTranslatePrompt({
    skill: 'translate-tn', taskJson: '{}', packMarkdown: 'pack', sourceText: 'src',
    previousOutput: `${HEADER}\nBROKEN ROW`,
    repairNote: '- [passthrough] row ab12: Quote column was translated',
  });
  assert.ok(user.includes('# Previous output'));
  assert.ok(user.includes('BROKEN ROW'));
  assert.ok(user.includes('# Repair note'));
  assert.ok(user.includes('Quote column was translated'));
});

test('a missing SKILL.md throws an error naming the path', () => {
  assert.throws(
    () => llm.buildTranslatePrompt({ skill: 'no-such-skill', taskJson: '{}', packMarkdown: '', sourceText: '' }),
    (err) => err.message.includes(path.join('no-such-skill', 'SKILL.md')),
  );
});

// ---------------------------------------------------------------------------
// Output extraction
// ---------------------------------------------------------------------------

test('extractOutput returns the text between the sentinels', () => {
  const body = `${HEADER}\n${ROW}`;
  assert.strictEqual(llm.extractOutput(wrapped(body)), body);
});

test('extractOutput takes the LAST sentinel pair', () => {
  const text = `${llm.BEGIN_OUTPUT}\nfirst draft\n${llm.END_OUTPUT}\n`
    + `oops, corrected:\n${llm.BEGIN_OUTPUT}\nsecond draft\n${llm.END_OUTPUT}\n`;
  assert.strictEqual(llm.extractOutput(text), 'second draft');
});

test('extractOutput preserves fenced code blocks inside the sentinels (tA articles)', () => {
  const article = '# Title\n\nSee this:\n\n```json\n{"a": 1}\n```\n\nAnd more prose.';
  assert.strictEqual(llm.extractOutput(wrapped(article)), article);
});

test('extractOutput falls back to stripping a single outer fence', () => {
  assert.strictEqual(llm.extractOutput('```tsv\nA\tB\n1\t2\n```'), 'A\tB\n1\t2');
  assert.strictEqual(llm.extractOutput('```\nplain\n```'), 'plain');
});

test('extractOutput falls back to the raw trimmed text', () => {
  assert.strictEqual(llm.extractOutput('\n  A\tB\n1\t2\n  '), 'A\tB\n1\t2');
});

test('extractOutput returns empty string for empty sentinel bodies', () => {
  assert.strictEqual(llm.extractOutput(`${llm.BEGIN_OUTPUT}\n\n${llm.END_OUTPUT}`), '');
  assert.strictEqual(llm.extractOutput(''), '');
});

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

const CASES = [
  ['anthropic 401 authentication_error', { status: 401, error: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } }, 'invalid_key'],
  ['openai 401 invalid_api_key', { status: 401, error: { message: 'Incorrect API key provided', code: 'invalid_api_key' } }, 'invalid_key'],
  ['gemini PERMISSION_DENIED', { status: 403, message: '{"error":{"code":403,"status":"PERMISSION_DENIED","message":"API key not valid"}}' }, 'invalid_key'],
  ['anthropic 404 model', { status: 404, error: { error: { type: 'not_found_error', message: 'model: bogus' } } }, 'model_not_found'],
  ['openai 404 model_not_found', { status: 404, error: { message: 'The model `bogus` does not exist', code: 'model_not_found' } }, 'model_not_found'],
  ['gemini NOT_FOUND', { message: '{"error":{"status":"NOT_FOUND","message":"models/bogus is not found"}}' }, 'model_not_found'],
  ['anthropic 429', { status: 429, error: { error: { type: 'rate_limit_error', message: 'rate limit' } } }, 'rate_limited'],
  ['gemini RESOURCE_EXHAUSTED', { status: 429, message: '{"error":{"status":"RESOURCE_EXHAUSTED"}}' }, 'rate_limited'],
  ['anthropic 529 overloaded', { status: 529, error: { error: { type: 'overloaded_error', message: 'Overloaded' } } }, 'provider_overloaded'],
  ['xai 503', { status: 503, error: { message: 'service unavailable' } }, 'provider_overloaded'],
  ['gemini UNAVAILABLE', { status: 503, message: '{"error":{"status":"UNAVAILABLE","message":"The model is overloaded"}}' }, 'provider_overloaded'],
  ['openai 400 context length', { status: 400, error: { message: "This model's maximum context length is 200000 tokens" } }, 'context_too_long'],
  ['abort', { name: 'AbortError', message: 'The operation was aborted' }, 'timeout'],
  ['socket timeout', { message: 'Request timed out.' }, 'timeout'],
  ['unclassified 400', { status: 400, error: { message: 'messages: unexpected role' } }, 'provider_error'],
];

for (const [label, err, expected] of CASES) {
  test(`classifyProviderError maps ${label} → ${expected}`, () => {
    assert.strictEqual(llm.classifyProviderError(err).code, expected);
  });
}

test('classifyProviderError reads Retry-After from a header object and a Headers-like', () => {
  assert.strictEqual(llm.classifyProviderError({ status: 429, headers: { 'Retry-After': '42' } }).retryAfterSeconds, 42);
  const headers = new Map([['retry-after', '7']]);
  assert.strictEqual(llm.classifyProviderError({ status: 429, headers }).retryAfterSeconds, 7);
});

test('classifyProviderError reads a Gemini retryDelay out of the body', () => {
  const err = { status: 429, message: '{"error":{"status":"RESOURCE_EXHAUSTED","details":[{"retryDelay":"17s"}]}}' };
  assert.strictEqual(llm.classifyProviderError(err).retryAfterSeconds, 17);
});

const NETWORK_CASES = [
  ['ECONNRESET via err.cause.code', { message: 'Connection error.', cause: { code: 'ECONNRESET' } }],
  ['ECONNREFUSED via err.cause.code', { message: 'fetch failed', cause: { code: 'ECONNREFUSED' } }],
  ['EAI_AGAIN via err.code', { message: 'getaddrinfo failed', code: 'EAI_AGAIN' }],
  ['EPIPE via err.code', { message: 'write EPIPE', code: 'EPIPE' }],
  ['UND_ERR_SOCKET via err.cause.code', { message: 'fetch failed', cause: { code: 'UND_ERR_SOCKET' } }],
];

for (const [label, err] of NETWORK_CASES) {
  test(`classifyProviderError maps ${label} → network_error`, () => {
    assert.strictEqual(llm.classifyProviderError(err).code, 'network_error');
  });
}

// ---------------------------------------------------------------------------
// Retry policy
// ---------------------------------------------------------------------------

test('rate_limited retries twice then succeeds, honoring Retry-After', async () => {
  const files = makeBatchFiles();
  const stub = stubTransport((_args, n) => {
    if (n <= 2) {
      const err = new Error('rate limit');
      err.status = 429;
      err.headers = { 'retry-after': '40' };
      throw err;
    }
    return { text: wrapped(`${HEADER}\n${ROW}`), usage: { inputTokens: 10, outputTokens: 5 }, stopReason: 'end_turn' };
  });

  const res = await llm.runTsvBatch({
    files,
    params: withKey({ provider: 'claude', model: 'claude-sonnet-4-6', skill: 'translate-tn', thinking: 'medium' }, 'k'),
  });
  assert.strictEqual(stub.calls.length, 3);
  // Retry-After (40s) exceeds the 15s * attempt floor, so it wins both times.
  assert.deepStrictEqual(stub.sleeps, [40, 40]);
  assert.strictEqual(res.model, 'claude-sonnet-4-6');
  llm._resetTestHooks();
});

test('rate_limited gives up after 3 attempts', async () => {
  const files = makeBatchFiles();
  const stub = stubTransport(() => { const e = new Error('slow down'); e.status = 429; throw e; });
  await assert.rejects(
    llm.runTsvBatch({ files, params: withKey({ provider: 'claude', model: 'claude-sonnet-4-6', skill: 'translate-tn' }, 'k') }),
    (err) => err instanceof llm.TranslateProviderError && err.code === 'rate_limited' && err.errorKind === 'rate_limited',
  );
  assert.strictEqual(stub.calls.length, 3);
  assert.deepStrictEqual(stub.sleeps, [15, 30]);
  llm._resetTestHooks();
});

test('invalid_key is not retried', async () => {
  const files = makeBatchFiles();
  const stub = stubTransport(() => { const e = new Error('invalid x-api-key'); e.status = 401; throw e; });
  await assert.rejects(
    llm.runTsvBatch({ files, params: withKey({ provider: 'claude', model: 'claude-sonnet-4-6', skill: 'translate-tn' }, 'k') }),
    (err) => err.code === 'invalid_key' && err.provider === 'claude',
  );
  assert.strictEqual(stub.calls.length, 1);
  assert.deepStrictEqual(stub.sleeps, []);
  llm._resetTestHooks();
});

test('timeout is retried once', async () => {
  const files = makeBatchFiles();
  const stub = stubTransport((_a, n) => {
    if (n === 1) { const e = new Error('Request timed out.'); e.name = 'TimeoutError'; throw e; }
    return { text: wrapped('X'), usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end_turn' };
  });
  await llm.runTsvBatch({ files, params: withKey({ provider: 'claude', model: 'claude-sonnet-4-6', skill: 'translate-tn' }, 'k') });
  assert.strictEqual(stub.calls.length, 2);
  llm._resetTestHooks();
});

test('network_error (connection reset) retries twice, same policy as provider_overloaded', async () => {
  const files = makeBatchFiles();
  const stub = stubTransport((_args, n) => {
    if (n <= 2) {
      const err = new Error('fetch failed');
      err.cause = { code: 'ECONNRESET' };
      throw err;
    }
    return { text: wrapped(`${HEADER}\n${ROW}`), usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end_turn' };
  });
  await llm.runTsvBatch({ files, params: withKey({ provider: 'claude', model: 'claude-sonnet-4-6', skill: 'translate-tn' }, 'k') });
  assert.strictEqual(stub.calls.length, 3);
  assert.deepStrictEqual(stub.sleeps, [15, 30]);
  llm._resetTestHooks();
});

test('network_error gives up after 3 attempts, reporting network_error not provider_error', async () => {
  const files = makeBatchFiles();
  const stub = stubTransport(() => { const e = new Error('fetch failed'); e.cause = { code: 'ECONNRESET' }; throw e; });
  await assert.rejects(
    llm.runTsvBatch({ files, params: withKey({ provider: 'claude', model: 'claude-sonnet-4-6', skill: 'translate-tn' }, 'k') }),
    (err) => err.code === 'network_error' && err.errorKind === 'network_error',
  );
  assert.strictEqual(stub.calls.length, 3);
  llm._resetTestHooks();
});

test('backoff is capped at 120s even when Retry-After is huge', async () => {
  const files = makeBatchFiles();
  const stub = stubTransport((_args, n) => {
    if (n <= 2) {
      const err = new Error('rate limit');
      err.status = 429;
      err.headers = { 'retry-after': '9999' };
      throw err;
    }
    return { text: wrapped(`${HEADER}\n${ROW}`), usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end_turn' };
  });
  await llm.runTsvBatch({ files, params: withKey({ provider: 'claude', model: 'claude-sonnet-4-6', skill: 'translate-tn' }, 'k') });
  assert.deepStrictEqual(stub.sleeps, [120, 120]);
  llm._resetTestHooks();
});

test('an unknown model fails as model_not_found without calling the provider', async () => {
  const files = makeBatchFiles();
  const stub = stubTransport(() => { throw new Error('must not be reached'); });
  await assert.rejects(
    llm.runTsvBatch({ files, params: withKey({ provider: 'openai', model: 'gpt-not-real', skill: 'translate-tn' }, 'k') }),
    (err) => err.code === 'model_not_found' && err.provider === 'openai',
  );
  assert.strictEqual(stub.calls.length, 0);
  llm._resetTestHooks();
});

test('a truncating stop reason becomes output_too_long, per provider', async () => {
  const perProvider = [
    ['claude', 'claude-sonnet-4-6', 'max_tokens'],
    ['openai', 'gpt-5.4', 'max_output_tokens'],
    ['xai', 'grok-4.20-reasoning', 'length'],
    ['gemini', 'gemini-2.5-pro', 'MAX_TOKENS'],
  ];
  for (const [provider, model, stopReason] of perProvider) {
    const files = makeBatchFiles();
    stubTransport(() => ({ text: wrapped('partial'), usage: { inputTokens: 1, outputTokens: 1 }, stopReason }));
    await assert.rejects(
      llm.runTsvBatch({ files, params: withKey({ provider, model, skill: 'translate-tn' }, 'k') }),
      (err) => err.code === 'output_too_long' && err.provider === provider,
      `${provider}/${stopReason}`,
    );
    llm._resetTestHooks();
  }
});

test('output_too_long with reasoning enabled retries once with reasoning/thinking dropped', async () => {
  const files = makeBatchFiles();
  const stub = stubTransport((args, n) => {
    if (n === 1) {
      assert.strictEqual(args.thinking, 'medium');
      return { text: wrapped('partial'), usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'max_tokens' };
    }
    return { text: wrapped(`${HEADER}\n${ROW}`), usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end_turn' };
  });
  const res = await llm.runTsvBatch({
    files,
    params: withKey({ provider: 'claude', model: 'claude-sonnet-4-6', skill: 'translate-tn', thinking: 'medium' }, 'k'),
  });
  assert.strictEqual(stub.calls.length, 2);
  // The retry drops thinking/reasoning entirely rather than repeating it.
  assert.strictEqual(stub.calls[1].thinking, 'none');
  assert.strictEqual(res.model, 'claude-sonnet-4-6');
  llm._resetTestHooks();
});

test('output_too_long with no reasoning enabled still fails after one truncation (no fallback to try)', async () => {
  const files = makeBatchFiles();
  const stub = stubTransport(() => ({ text: wrapped('partial'), usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'max_tokens' }));
  await assert.rejects(
    llm.runTsvBatch({ files, params: withKey({ provider: 'claude', model: 'claude-sonnet-4-6', skill: 'translate-tn' }, 'k') }),
    (err) => err.code === 'output_too_long',
  );
  assert.strictEqual(stub.calls.length, 1);
  llm._resetTestHooks();
});

test('a reply with no extractable output becomes empty_output', async () => {
  const files = makeBatchFiles();
  stubTransport(() => ({ text: `${llm.BEGIN_OUTPUT}\n   \n${llm.END_OUTPUT}`, usage: {}, stopReason: 'end_turn' }));
  await assert.rejects(
    llm.runTsvBatch({ files, params: withKey({ provider: 'claude', model: 'claude-sonnet-4-6', skill: 'translate-tn' }, 'k') }),
    (err) => err.code === 'empty_output',
  );
  assert.ok(!fs.existsSync(files.outputFile), 'no output file on empty output');
  llm._resetTestHooks();
});

// ---------------------------------------------------------------------------
// Secret hygiene
// ---------------------------------------------------------------------------

test('the API key never reaches a thrown message, even unpatterned', async () => {
  const key = 'zzz-unpatterned-key-0123456789abcdef';
  const files = makeBatchFiles();
  stubTransport(() => { const e = new Error(`Bad request for key ${key} on tenant`); e.status = 400; throw e; });
  await assert.rejects(
    llm.runTsvBatch({ files, params: withKey({ provider: 'claude', model: 'claude-sonnet-4-6', skill: 'translate-tn' }, key) }),
    (err) => {
      assert.ok(!err.message.includes(key), `key leaked: ${err.message}`);
      assert.ok(err.message.startsWith('claude provider_error: '), err.message);
      return true;
    },
  );
  llm._resetTestHooks();
});

test('scrubSecrets redacts known key patterns', () => {
  const out = llm.scrubSecrets('key=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA and xai-BBBBBBBBBBBBBBBBBB');
  assert.ok(!out.includes('sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA'));
  assert.ok(!out.includes('xai-BBBBBBBBBBBBBBBBBB'));
});

test('scrubSecrets redacts hyphenated modern key shapes (sk-proj-…, xai- hyphenated)', () => {
  const out = llm.scrubSecrets('key=sk-proj-AbC-123_456789012345678901 and xai-AbC-1234567890123456');
  assert.ok(!out.includes('sk-proj-AbC-123_456789012345678901'));
  assert.ok(!out.includes('xai-AbC-1234567890123456'));
});

// ---------------------------------------------------------------------------
// Key presence
// ---------------------------------------------------------------------------

test('a provider call with no apiKey throws invalid_key without touching the transport', async () => {
  const files = makeBatchFiles();
  const stub = stubTransport(() => { throw new Error('must not be reached — no key means no client'); });
  await assert.rejects(
    llm.runTsvBatch({ files, params: { provider: 'claude', model: 'claude-sonnet-4-6', skill: 'translate-tn' } }),
    (err) => err.code === 'invalid_key' && err.provider === 'claude',
  );
  assert.strictEqual(stub.calls.length, 0);
  llm._resetTestHooks();
});

// ---------------------------------------------------------------------------
// Test-hook gating
// ---------------------------------------------------------------------------

test('_setTestHooks refuses to run outside a test context', () => {
  const prev = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try {
    assert.throws(() => llm._setTestHooks({ transport: async () => ({}) }), /test-only/);
  } finally {
    if (prev === undefined) delete process.env.NODE_TEST_CONTEXT; else process.env.NODE_TEST_CONTEXT = prev;
  }
});

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

test('estimateCost prices a call off the catalog', () => {
  // Fixture: $2.00 / 1M in, $10.00 / 1M out.
  const cost = llm.estimateCost('claude', 'llm-test-priced', { inputTokens: 500_000, outputTokens: 100_000 });
  assert.ok(Math.abs(cost - 2.0) < 1e-9, String(cost));
});

test('estimateCost returns null for an unpriced model or unknown provider', () => {
  assert.strictEqual(llm.estimateCost('claude', 'not-in-the-catalog', { inputTokens: 1000, outputTokens: 1000 }), null);
  assert.strictEqual(llm.estimateCost('nope', 'whatever', { inputTokens: 1, outputTokens: 1 }), null);
});

// ---------------------------------------------------------------------------
// End to end
// ---------------------------------------------------------------------------

test('runTsvBatch writes the extracted output and returns usage + cost', async () => {
  const files = makeBatchFiles();
  const body = `${HEADER}\n${ROW}`;
  const stub = stubTransport(() => ({
    text: `Thinking out loud first.\n\n${wrapped(body)}`,
    usage: { inputTokens: 250_000, outputTokens: 50_000 },
    stopReason: 'end_turn',
  }));

  const res = await llm.runTsvBatch({
    files,
    params: withKey({ provider: 'claude', model: 'llm-test-priced', skill: 'translate-tn', thinking: 'medium' }, 'secret-key-value'),
  });

  assert.strictEqual(fs.readFileSync(files.outputFile, 'utf8'), `${body}\n`);
  assert.deepStrictEqual(res.usage, { inputTokens: 250_000, outputTokens: 50_000 });
  assert.strictEqual(res.model, 'llm-test-priced');
  assert.ok(Math.abs(res.costUsd - 1.0) < 1e-9, String(res.costUsd));

  // The transport saw the assembled prompt and the (non-enumerable) key.
  assert.strictEqual(stub.calls.length, 1);
  assert.strictEqual(stub.calls[0].apiKey, 'secret-key-value');
  assert.ok(stub.calls[0].system.includes('API mode override'));
  assert.ok(stub.calls[0].user.includes(ROW));
  llm._resetTestHooks();
});

test('runTsvBatch in repair mode inlines the previous output file', async () => {
  const files = makeBatchFiles();
  fs.writeFileSync(files.outputFile, `${HEADER}\nPREVIOUS BAD ROW\n`, 'utf8');
  const stub = stubTransport(() => ({ text: wrapped(`${HEADER}\n${ROW}`), usage: {}, stopReason: 'end_turn' }));

  await llm.runTsvBatch({
    files,
    params: withKey({ provider: 'claude', model: 'claude-sonnet-4-6', skill: 'translate-tn' }, 'k'),
    repairNote: '- [passthrough] row ab12: Quote was altered',
  });
  assert.ok(stub.calls[0].user.includes('PREVIOUS BAD ROW'));
  assert.ok(stub.calls[0].user.includes('Quote was altered'));
  assert.strictEqual(fs.readFileSync(files.outputFile, 'utf8'), `${HEADER}\n${ROW}\n`);
  llm._resetTestHooks();
});

// ---------------------------------------------------------------------------
// Adapters (real adapter code, fake SDK clients)
// ---------------------------------------------------------------------------

/** Drive a real adapter by substituting the SDK client it would construct. */
async function runWithClient(provider, model, client, extraParams = {}) {
  const files = makeBatchFiles();
  llm._setTestHooks({ transport: null, clients: { [provider]: client }, sleep: async () => {} });
  const res = await llm.runTsvBatch({
    files,
    params: withKey({ provider, model, skill: 'translate-tn', ...extraParams }, 'k'),
  });
  llm._resetTestHooks();
  return { res, output: fs.readFileSync(files.outputFile, 'utf8') };
}

test('claude adapter streams, maps effort and reads usage', async () => {
  let seen = null;
  const client = {
    messages: {
      stream(params) {
        seen = params;
        return {
          finalMessage: async () => ({
            content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: wrapped('OUT') }],
            usage: { input_tokens: 11, output_tokens: 22 },
            stop_reason: 'end_turn',
          }),
        };
      },
    },
  };
  const { res, output } = await runWithClient('claude', 'claude-sonnet-4-6', client, { thinking: 'high' });
  assert.strictEqual(output, 'OUT\n');
  assert.deepStrictEqual(res.usage, { inputTokens: 11, outputTokens: 22 });
  assert.strictEqual(seen.model, 'claude-sonnet-4-6');
  assert.strictEqual(seen.max_tokens, 32000);
  assert.ok(seen.system.includes('API mode override'));
  assert.deepStrictEqual(seen.thinking, { type: 'adaptive' });
  assert.deepStrictEqual(seen.output_config, { effort: 'high' });
  assert.strictEqual(seen.messages.length, 1);
});

test('openai adapter uses the Responses API and drops a rejected reasoning param', async () => {
  const bodies = [];
  const client = {
    responses: {
      async create(body) {
        bodies.push(JSON.parse(JSON.stringify(body)));
        if (body.reasoning) {
          const err = new Error("Unsupported parameter: 'reasoning' is not supported with this model.");
          err.status = 400;
          throw err;
        }
        return { status: 'completed', output_text: wrapped('OUT'), usage: { input_tokens: 3, output_tokens: 4 } };
      },
    },
  };
  const { res, output } = await runWithClient('openai', 'gpt-4.1', client, { thinking: 'medium' });
  assert.strictEqual(output, 'OUT\n');
  assert.deepStrictEqual(res.usage, { inputTokens: 3, outputTokens: 4 });
  assert.strictEqual(bodies.length, 2);
  assert.deepStrictEqual(bodies[0].reasoning, { effort: 'medium' });
  assert.strictEqual(bodies[1].reasoning, undefined);
  assert.strictEqual(bodies[0].max_output_tokens, 32000);
  assert.ok(bodies[0].instructions.includes('API mode override'));
});

test('openai adapter walks output items when output_text is absent', async () => {
  const client = {
    responses: {
      async create() {
        return {
          status: 'completed',
          output: [
            { type: 'reasoning', content: [] },
            { type: 'message', content: [{ type: 'output_text', text: wrapped('OUT') }] },
          ],
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    },
  };
  const { output } = await runWithClient('openai', 'gpt-5.4', client);
  assert.strictEqual(output, 'OUT\n');
});

test('openai adapter surfaces an incomplete max_output_tokens response as output_too_long', async () => {
  const files = makeBatchFiles();
  llm._setTestHooks({
    clients: {
      openai: {
        responses: {
          async create() {
            return { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output_text: wrapped('half'), usage: {} };
          },
        },
      },
    },
  });
  await assert.rejects(
    llm.runTsvBatch({ files, params: withKey({ provider: 'openai', model: 'gpt-5.4', skill: 'translate-tn' }, 'k') }),
    (err) => err.code === 'output_too_long',
  );
  llm._resetTestHooks();
});

test('xai adapter sets reasoning_effort only for effort-capable models', async () => {
  const bodies = [];
  const client = {
    chat: {
      completions: {
        async create(body) {
          bodies.push(body);
          return {
            choices: [{ message: { content: wrapped('OUT') }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 6 },
          };
        },
      },
    },
  };
  await runWithClient('xai', 'grok-3-mini', client, { thinking: 'high' });
  await runWithClient('xai', 'grok-4.20-reasoning', client, { thinking: 'high' });
  assert.strictEqual(bodies[0].reasoning_effort, 'high');
  assert.strictEqual(bodies[1].reasoning_effort, undefined);
  assert.strictEqual(bodies[0].max_completion_tokens, 32000);
  assert.deepStrictEqual(bodies[0].messages.map((m) => m.role), ['system', 'user']);
});

test('gemini adapter picks thinkingLevel for 3.x and a token budget for 2.5', async () => {
  const configs = [];
  const client = {
    models: {
      async generateContent({ config }) {
        configs.push(config);
        return {
          candidates: [{ content: { parts: [{ text: wrapped('OUT') }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 8 },
        };
      },
    },
  };
  const { res, output } = await runWithClient('gemini', 'gemini-3-flash-preview', client, { thinking: 'high' });
  await runWithClient('gemini', 'gemini-2.5-pro', client, { thinking: 'high' });
  assert.strictEqual(output, 'OUT\n');
  assert.deepStrictEqual(res.usage, { inputTokens: 7, outputTokens: 8 });
  assert.deepStrictEqual(configs[0].thinkingConfig, { thinkingLevel: 'high' });
  assert.deepStrictEqual(configs[1].thinkingConfig, { thinkingBudget: 8192 });
  assert.strictEqual(configs[0].maxOutputTokens, 32000);
  assert.ok(configs[0].systemInstruction.parts[0].text.includes('API mode override'));
  assert.ok(configs[0].abortSignal, 'the per-request abort signal must be forwarded');
});

test('runArticleFile reads srcFile and writes the translated markdown', async () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'article-'));
  const files = {
    nn: '01',
    srcFile: path.join(dir, 'article-01.md'),
    packFile: path.join(dir, 'article-01-pack.md'),
    taskFile: path.join(dir, 'article-01-task.json'),
    outputFile: path.join(dir, 'article-01-out.md'),
  };
  const source = '# God\n\nSee [[rc://en/ta/man/translate/translate-names]].\n\n```\nliteral\n```';
  fs.writeFileSync(files.srcFile, `${source}\n`, 'utf8');
  fs.writeFileSync(files.packFile, '# Pack\n', 'utf8');
  fs.writeFileSync(files.taskFile, JSON.stringify({ task: 'translate-article', sourceFile: files.srcFile, outputFile: files.outputFile }), 'utf8');

  const translated = '# الله\n\nانظر [[rc://en/ta/man/translate/translate-names]].\n\n```\nliteral\n```';
  const stub = stubTransport(() => ({ text: wrapped(translated), usage: { inputTokens: 1, outputTokens: 2 }, stopReason: 'end_turn' }));

  const res = await llm.runArticleFile({
    files,
    params: withKey({ provider: 'gemini', model: 'gemini-2.5-pro', skill: 'translate-tn' }, 'k'),
  });
  assert.strictEqual(fs.readFileSync(files.outputFile, 'utf8'), `${translated}\n`);
  assert.ok(stub.calls[0].user.includes('literal'), 'source markdown must be inlined');
  assert.strictEqual(res.model, 'gemini-2.5-pro');
  llm._resetTestHooks();
});
