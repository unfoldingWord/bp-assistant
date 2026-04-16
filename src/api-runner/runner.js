// runner.js — High-level API: runSkill() and runCustom()
// Wraps agent-loop with prompt building and options handling

const { buildSkillPrompt, buildCustomPrompt } = require('./prompt-builder');
const { runAgentLoop } = require('./agent-loop');
const { runOpenAiNative } = require('./openai-native');
const { DEFAULT_RUNTIME, resolveRuntime } = require('./runtime-config');
const { readSecret } = require('../secrets');
const { getProviderConfig } = require('./provider-config');

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
 * @param {string} opts.toolChoice - Tool choice: auto, required, none
 * @param {Object} opts.apiKeys - { gemini, openai, xai, anthropic }
 * @returns {Promise<{turns: number, inputTokens: number, outputTokens: number, cost: number, durationMs: number, finalText: string}>}
 */
async function runSkill(name, prompt, opts = {}) {
  const cwd = opts.cwd || '/srv/bot/workspace';
  const system = buildSkillPrompt(name, { cwd }) + (opts.systemAppend ? '\n\n' + opts.systemAppend : '');

  if (opts.dryRun) {
    return dryRun(system, prompt, opts);
  }

  const provider = opts.provider || 'gemini';
  return runWithSystem(system, prompt, {
    ...opts,
    provider,
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

  const provider = opts.provider || 'gemini';
  return runWithSystem(system, prompt, {
    ...opts,
    provider,
  });
}

async function runWithSystem(system, prompt, opts = {}) {
  const provider = opts.provider || 'gemini';
  const runtime = resolveRuntime(provider, opts.runtime);
  const runner = runtime === 'openai-native' ? runOpenAiNative : runAgentLoop;

  return runner({
    provider,
    runtime,
    model: opts.model,
    system,
    userMessage: prompt,
    maxTurns: opts.maxTurns || 100,
    timeoutMs: (opts.timeout || 30) * 60 * 1000,
    cwd,
    verbose: opts.verbose || false,
    thinking: opts.thinking || 'medium',
    apiKey: resolveApiKey(provider, opts.apiKeys || {}),
    toolChoice: opts.toolChoice,
    apiKeyResolver: (p) => resolveApiKey(p, opts.apiKeys || {}),
    lockProvider: !!opts.lockProvider,
    session: opts.session,
  });
}

function resolveApiKey(provider, apiKeys) {
  const cfg = getProviderConfig(provider);
  const aliasMap = {
    claude: 'anthropic',
    openai: 'openai',
    gemini: 'gemini',
    xai: 'xai',
    groq: 'openai',
    deepseek: 'openai',
    mistral: 'openai',
  };
  const alias = aliasMap[provider];
  const provided = alias ? apiKeys[alias] : undefined;
  if (provided) return provided;
  return readSecret(cfg.secretName, cfg.envName);
}

function listProviders() {
  const { getProviderNames } = require('./provider-config');
  return getProviderNames();
}

module.exports = { runSkill, runCustom, resolveApiKey, listProviders, runWithSystem };

function dryRun(system, prompt, opts) {
  console.log('=== DRY RUN ===\n');
  console.log('--- System Prompt ---');
  console.log(system);
  console.log('\n--- User Message ---');
  console.log(prompt);
  console.log('\n--- Options ---');
  console.log(`Provider: ${opts.provider || 'gemini'}`);
  console.log(`Runtime: ${opts.runtime || DEFAULT_RUNTIME}`);
  console.log(`Model: ${opts.model || '(default)'}`);
  console.log(`Thinking: ${opts.thinking || 'medium'}`);
  console.log(`Tool Choice: ${opts.toolChoice || '(default)'}`);
  console.log(`Max turns: ${opts.maxTurns || 100}`);
  console.log(`Timeout: ${opts.timeout || 30} min`);
  console.log(`CWD: ${opts.cwd || '/srv/bot/workspace'}`);
  console.log('\n=== END DRY RUN ===');
  return { turns: 0, inputTokens: 0, outputTokens: 0, cost: 0, durationMs: 0, finalText: '(dry run)' };
}
