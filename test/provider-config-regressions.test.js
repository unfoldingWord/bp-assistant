// Prototype-chain bypass regression: assertProviderModel / isConfiguredModel /
// resolveProviderModel must never resolve a model id like "toString" or
// "constructor" to an inherited Object.prototype member — that member is
// truthy-but-not-a-string, which used to slip past
// `typeof resolved !== 'string' || isConfiguredModel(...)` and pass validation
// for a model that was never configured (an executed bypass, not theoretical).
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  assertProviderModel, resolveProviderModel, resolveDifficultyModel, resolveAutoModel,
  getProviderConfig, DEFAULT_PROVIDER_CONFIGS,
} = require('../src/api-runner/provider-config');

const PROTO_KEYS = ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf'];

for (const key of PROTO_KEYS) {
  test(`assertProviderModel rejects the prototype-chain model "${key}"`, () => {
    assert.throws(
      () => assertProviderModel('claude', key),
      /Unknown claude model/,
    );
  });

  test(`resolveProviderModel does not resolve alias "${key}" to an inherited member`, () => {
    const resolved = resolveProviderModel('claude', key);
    // Falls through to the candidate itself (a string), never to a function
    // or object pulled off Object.prototype.
    assert.strictEqual(resolved, key);
  });
}

test('assertProviderModel still resolves a real alias and a real model id', () => {
  assert.strictEqual(assertProviderModel('claude', 'opus'), 'claude-opus-5-5');
  assert.strictEqual(assertProviderModel('claude', 'claude-sonnet-4-6'), 'claude-sonnet-4-6');
});

// Opus split: raw Messages API paths (providers/claude.js, translate-llm) need a
// concrete id, so 'opus' and the default resolve to claude-opus-5-5. Agent SDK
// paths (claude-runner tiers, BP_AUTO_MODEL) send the bare 'opus' alias so the
// SDK's alias table decides which Opus runs.
test('raw-API claude paths resolve opus and the default to claude-opus-5-5', () => {
  assert.strictEqual(resolveProviderModel('claude'), 'claude-opus-5-5');
  assert.strictEqual(resolveProviderModel('claude', 'opus'), 'claude-opus-5-5');
  assert.strictEqual(assertProviderModel('claude', 'claude-opus-5-5'), 'claude-opus-5-5');
  // Pinning Opus 5 explicitly still works.
  assert.strictEqual(assertProviderModel('claude', 'claude-opus-5'), 'claude-opus-5');
  const m = getProviderConfig('claude').models['claude-opus-5-5'];
  assert.deepStrictEqual(m, { label: 'Claude Opus 5.5', inputPer1M: 4.0, outputPer1M: 20.0 });
});

test('Agent SDK claude paths send the bare opus alias', () => {
  for (const tier of ['low', 'medium', 'high']) {
    assert.strictEqual(resolveDifficultyModel('claude', tier), 'opus');
  }
  assert.strictEqual(resolveDifficultyModel('claude', 'opus'), 'opus');
  for (const level of ['high', 'xhigh', 'max']) {
    assert.strictEqual(resolveAutoModel('claude', undefined, level), 'opus');
  }
  // Explicit alias still resolves through modelAliases (sonnet/haiku unchanged).
  assert.strictEqual(resolveAutoModel('claude', undefined, 'medium'), 'claude-sonnet-4-6');
});

test('BP_FORCE_MODEL / BP_MODEL_<TIER> = opus keep the bare SDK alias', () => {
  process.env.BP_FORCE_MODEL = 'opus';
  try {
    assert.strictEqual(resolveDifficultyModel('claude', 'high'), 'opus');
    assert.strictEqual(resolveDifficultyModel('claude', 'sonnet'), 'opus');
  } finally {
    delete process.env.BP_FORCE_MODEL;
  }
  process.env.BP_MODEL_HIGH = 'opus';
  try {
    assert.strictEqual(resolveDifficultyModel('claude', 'high'), 'opus');
  } finally {
    delete process.env.BP_MODEL_HIGH;
  }
  // Other providers keep mapping 'opus' to their own concrete top model.
  process.env.BP_FORCE_MODEL = 'opus';
  try {
    assert.strictEqual(resolveDifficultyModel('openai', 'high'), 'gpt-5.4');
  } finally {
    delete process.env.BP_FORCE_MODEL;
  }
});

test('model-provider-config.json and the JS defaults agree on the claude Opus fields', () => {
  const json = require('../model-provider-config.json').providers.claude;
  const js = DEFAULT_PROVIDER_CONFIGS.claude;
  assert.strictEqual(json.defaultModel, js.defaultModel);
  assert.strictEqual(json.difficultyModel, js.difficultyModel);
  assert.strictEqual(json.modelAliases.opus, js.modelAliases.opus);
  for (const level of ['high', 'xhigh', 'max']) {
    assert.strictEqual(json.autoModelByThinking[level], js.autoModelByThinking[level]);
  }
  assert.deepStrictEqual(json.models['claude-opus-5-5'], js.models['claude-opus-5-5']);
});
