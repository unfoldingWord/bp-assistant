const ANTHROPIC_API_KEY_ALIAS = 'BP_ANTHROPIC_API_KEY';

function getAnthropicApiKey() {
  const direct = String(process.env.ANTHROPIC_API_KEY || '').trim();
  if (direct) return direct;

  const aliased = String(process.env[ANTHROPIC_API_KEY_ALIAS] || '').trim();
  return aliased || null;
}

function prioritizeClaudeOauth() {
  const oauthToken = String(process.env.CLAUDE_CODE_OAUTH_TOKEN || '').trim();
  const apiKey = String(process.env.ANTHROPIC_API_KEY || '').trim();

  if (apiKey && !process.env[ANTHROPIC_API_KEY_ALIAS]) {
    process.env[ANTHROPIC_API_KEY_ALIAS] = apiKey;
  }

  if (oauthToken && apiKey) {
    delete process.env.ANTHROPIC_API_KEY;
    console.log('[auth] Removed ambient ANTHROPIC_API_KEY so Claude SDK uses OAuth token');
  }
}

module.exports = {
  ANTHROPIC_API_KEY_ALIAS,
  getAnthropicApiKey,
  prioritizeClaudeOauth,
};
