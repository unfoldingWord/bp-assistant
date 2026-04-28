const test = require('node:test');
const assert = require('node:assert/strict');

const { ANTHROPIC_API_KEY_ALIAS, getAnthropicApiKey, prioritizeClaudeOauth } = require('../src/anthropic-env');
const { readSecret } = require('../src/secrets');

function snapshotEnv(keys) {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
}

test('prioritizeClaudeOauth removes ambient Anthropic API key when OAuth token is present', () => {
  const keys = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', ANTHROPIC_API_KEY_ALIAS];
  const before = snapshotEnv(keys);

  try {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-token';
    process.env.ANTHROPIC_API_KEY = 'anthropic-key';
    delete process.env[ANTHROPIC_API_KEY_ALIAS];

    prioritizeClaudeOauth();

    assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(process.env[ANTHROPIC_API_KEY_ALIAS], 'anthropic-key');
    assert.equal(getAnthropicApiKey(), 'anthropic-key');
  } finally {
    restoreEnv(before);
  }
});

test('readSecret falls back to quarantined Anthropic API key alias for explicit API paths', () => {
  const keys = ['ANTHROPIC_API_KEY', ANTHROPIC_API_KEY_ALIAS];
  const before = snapshotEnv(keys);

  try {
    delete process.env.ANTHROPIC_API_KEY;
    process.env[ANTHROPIC_API_KEY_ALIAS] = 'anthropic-key';

    assert.equal(readSecret('anthropic_api_key', 'ANTHROPIC_API_KEY'), 'anthropic-key');
  } finally {
    restoreEnv(before);
  }
});
