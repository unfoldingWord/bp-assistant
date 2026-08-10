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
  assertProviderModel, resolveProviderModel,
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
  assert.strictEqual(assertProviderModel('claude', 'opus'), 'claude-opus-5');
  assert.strictEqual(assertProviderModel('claude', 'claude-sonnet-4-6'), 'claude-sonnet-4-6');
});
