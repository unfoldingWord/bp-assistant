// runner.js — High-level API: runSkill() and runCustom()
// Wraps agent-loop with prompt building and options handling

const { buildSkillPrompt, buildCustomPrompt } = require('./prompt-builder');
const { runAgentLoop } = require('./agent-loop');

/**
 * Run a named skill from the workspace.
 *
 * @param {string} name - Skill name (e.g. 'ULT-gen')
 * @param {string} prompt - User message (e.g. 'PSA 133')
 * @param {Object} opts
 * @param {string} opts.provider - Provider name
 * @param {string} opts.model - Model ID
 * @param {string} opts.thinking - Thinking level
 * @param {number} opts.maxTurns - Max agentic loop iterations
 * @param {number} opts.timeout - Timeout in minutes
 * @param {string} opts.cwd - Working directory
 * @param {boolean} opts.verbose - Verbose output
 * @param {boolean} opts.dryRun - Print system prompt, don't call API
 * @param {string} opts.systemAppend - Extra text to append to system prompt
 * @param {Object} opts.apiKeys - { gemini, openai, xai, anthropic }
 * @returns {Promise<{turns: number, inputTokens: number, outputTokens: number, cost: number, durationMs: number, finalText: string}>}
 */
async function runSkill(name, prompt, opts = {}) {
  const cwd = opts.cwd || '/srv/bot/workspace';
  const system = buildSkillPrompt(name, { cwd }) + (opts.systemAppend ? '\n\n' + opts.systemAppend : '');

  if (opts.dryRun) {
    return dryRun(system, prompt, opts);
  }

  return runAgentLoop({
    provider: opts.provider || 'gemini',
    model: opts.model,
    system,
    userMessage: prompt,
    maxTurns: opts.maxTurns || 100,
    timeoutMs: (opts.timeout || 30) * 60 * 1000,
    cwd,
    verbose: opts.verbose || false,
    thinking: opts.thinking || 'medium',
    apiKey: resolveApiKey(opts.provider || 'gemini', opts.apiKeys || {}),
  });
}

/**
 * Run with a custom inline system prompt.
 * Used for challenger, merge steps, defense prompts, etc.
 *
 * @param {string} systemText - Custom system prompt
 * @param {string} prompt - User message
 * @param {Object} opts - Same as runSkill
 */
async function runCustom(systemText, prompt, opts = {}) {
  const cwd = opts.cwd || '/srv/bot/workspace';
  const system = buildCustomPrompt(systemText, { cwd }) + (opts.systemAppend ? '\n\n' + opts.systemAppend : '');

  if (opts.dryRun) {
    return dryRun(system, prompt, opts);
  }

  return runAgentLoop({
    provider: opts.provider || 'gemini',
    model: opts.model,
    system,
    userMessage: prompt,
    maxTurns: opts.maxTurns || 100,
    timeoutMs: (opts.timeout || 30) * 60 * 1000,
    cwd,
    verbose: opts.verbose || false,
    thinking: opts.thinking || 'medium',
    apiKey: resolveApiKey(opts.provider || 'gemini', opts.apiKeys || {}),
  });
}

function resolveApiKey(provider, apiKeys) {
  switch (provider) {
    case 'gemini': return apiKeys.gemini || process.env.GEMINI_API_KEY;
    case 'openai': return apiKeys.openai || process.env.OPENAI_API_KEY;
    case 'xai': return apiKeys.xai || process.env.XAI_API_KEY;
    case 'claude': return apiKeys.anthropic || process.env.ANTHROPIC_API_KEY;
    default: throw new Error(`Unknown provider: ${provider}`);
  }
}

function dryRun(system, prompt, opts) {
  console.log('=== DRY RUN ===\n');
  console.log('--- System Prompt ---');
  console.log(system);
  console.log('\n--- User Message ---');
  console.log(prompt);
  console.log('\n--- Options ---');
  console.log(`Provider: ${opts.provider || 'gemini'}`);
  console.log(`Model: ${opts.model || '(default)'}`);
  console.log(`Thinking: ${opts.thinking || 'medium'}`);
  console.log(`Max turns: ${opts.maxTurns || 100}`);
  console.log(`Timeout: ${opts.timeout || 30} min`);
  console.log(`CWD: ${opts.cwd || '/srv/bot/workspace'}`);
  console.log('\n=== END DRY RUN ===');
  return { turns: 0, inputTokens: 0, outputTokens: 0, cost: 0, durationMs: 0, finalText: '(dry run)' };
}

module.exports = { runSkill, runCustom };
