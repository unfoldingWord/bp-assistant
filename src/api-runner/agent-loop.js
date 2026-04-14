// agent-loop.js — Core agentic loop: send → tool calls → execute → repeat
// Provider-agnostic: works with any provider module (gemini, openai, claude)

const { executeTool, TOOL_SCHEMAS, toGeminiTools, toOpenAITools, toClaudeTools } = require('./tools');
const { getProviderConfig, resolveXaiModel } = require('./provider-config');
const { isAgentTool } = require('./agent-tools');
const { MAX_DEPTH } = require('./team-manager');

const PROVIDERS = {
  gemini: () => require('./providers/gemini'),
  openai: () => require('./providers/openai'),
  groq: () => require('./providers/openai-compat').forGroq(),
  deepseek: () => require('./providers/openai-compat').forDeepSeek(),
  mistral: () => require('./providers/openai-compat').forMistral(),
  xai: () => require('./providers/openai'),   // xAI uses OpenAI-compatible API
  claude: () => require('./providers/claude'),
};

function getToolsForProvider(providerName, schemas) {
  switch (providerName) {
    case 'gemini': return toGeminiTools(schemas);
    case 'openai': return toOpenAITools(schemas);
    case 'groq': return toOpenAITools(schemas);
    case 'deepseek': return toOpenAITools(schemas);
    case 'mistral': return toOpenAITools(schemas);
    case 'xai': return toOpenAITools(schemas);
    case 'claude': return toClaudeTools(schemas);
    default: throw new Error(`Unknown provider: ${providerName}`);
  }
}

/**
 * Run the agentic loop.
 *
 * @param {Object} opts
 * @param {string} opts.provider - Provider name: gemini, openai, groq, deepseek, mistral, xai, claude
 * @param {string} opts.model - Model ID (provider-specific)
 * @param {string} opts.system - System prompt
 * @param {string} opts.userMessage - User message
 * @param {Array} [opts.existingMessages] - Resume from existing conversation
 * @param {number} opts.maxTurns - Max loop iterations
 * @param {number} opts.timeoutMs - Timeout in ms
 * @param {string} opts.cwd - Working directory for tool execution
 * @param {boolean} opts.verbose - Show full tool call/result details
 * @param {string} opts.thinking - Thinking level: low, medium, high, max
 * @param {string} opts.apiKey - API key for the provider
 * @param {string} [opts.toolChoice] - Tool choice: auto, required, none
 * @param {number} [opts.depth=0] - Agent nesting depth (for recursive spawning)
 * @param {Function} [opts.apiKeyResolver] - Function to resolve API keys by provider
 * @returns {Promise<{turns: number, inputTokens: number, outputTokens: number, cost: number, durationMs: number, finalText: string, _messages: Array}>}
 */
async function runAgentLoop({
  provider: providerName,
  model,
  system,
  userMessage,
  existingMessages,
  maxTurns = 100,
  timeoutMs = 30 * 60 * 1000,
  cwd = '/srv/bot/workspace',
  verbose = false,
  thinking = 'medium',
  apiKey,
  toolChoice,
  depth = 0,
  apiKeyResolver,
}) {
  const providerMod = PROVIDERS[providerName]();

  // Determine which tools are available at this depth
  // Sub-agents at max depth don't get agent tools (prevents infinite recursion)
  let schemas = TOOL_SCHEMAS;
  if (depth >= MAX_DEPTH) {
    schemas = TOOL_SCHEMAS.filter(s => !isAgentTool(s.name));
  }
  const tools = getToolsForProvider(providerName, schemas);

  // Resolve model for xAI (auto-select reasoning variant)
  let resolvedModel = model;
  let baseUrl;
  let resolvedThinking = thinking;
  if (providerName === 'xai') {
    const xaiConfig = getProviderConfig('xai');
    resolvedModel = resolveXaiModel(model, thinking);
    baseUrl = xaiConfig.baseUrl;
    // Only grok-3-mini supports reasoning_effort
    if (!xaiConfig.reasoningEffortModels.includes(resolvedModel)) {
      resolvedThinking = undefined;
    }
  } else if (providerName === 'groq' || providerName === 'deepseek' || providerName === 'mistral') {
    baseUrl = providerMod.baseUrl;
  }

  // Initialize messages — either resume or start fresh
  const messages = existingMessages
    ? [...existingMessages, { role: 'user', content: userMessage }]
    : [{ role: 'user', content: userMessage }];

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let turns = 0;
  let finalText = '';
  let consecutiveToolOnlyTurns = 0;
  let activeToolChoice = toolChoice;
  const startTime = Date.now();
  const deadline = startTime + timeoutMs;

  // Build agent context for agent tools (allows sub-agent spawning)
  const agentContext = {
    parentOpts: {
      provider: providerName,
      model: resolvedModel,
      thinking: resolvedThinking,
      cwd,
      verbose,
      apiKey,
      apiKeyResolver,
      depth,
    },
    runAgentLoopFn: runAgentLoop,
  };

  const depthPrefix = depth > 0 ? `[depth ${depth}] ` : '';
  console.log(`[agent-loop] ${depthPrefix}Starting — provider: ${providerName}, model: ${resolvedModel || providerMod.DEFAULT_MODEL}, thinking: ${resolvedThinking || 'default'}${activeToolChoice ? `, toolChoice: ${activeToolChoice}` : ''}`);
  console.log(`[agent-loop] ${depthPrefix}Max turns: ${maxTurns}, timeout: ${timeoutMs / 1000}s`);

  while (turns < maxTurns) {
    if (Date.now() > deadline) {
      console.warn(`[agent-loop] ${depthPrefix}Timeout reached after ${turns} turns`);
      break;
    }

    turns++;
    console.log(`[agent-loop] ${depthPrefix}Turn ${turns}...`);

    let response;
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        response = await providerMod.sendRequest({
          model: resolvedModel,
          system,
          messages,
          tools,
          thinking: resolvedThinking,
          apiKey,
          baseUrl,
          toolChoice: activeToolChoice,
        });
        break; // success
      } catch (err) {
        const isTransient = /503|502|500|529|overloaded|unavailable|service\s+temporarily|fetch\s+failed|network|ECONNRESET|ETIMEDOUT|ENOTFOUND/i.test(err.message);
        const isRateLimit = /429|rate.?limit|too.many.requests/i.test(err.message);
        const shouldRetry = (isTransient || isRateLimit) && attempt < maxRetries;
        if (shouldRetry) {
          const delayMs = isRateLimit ? 60000 : 15000 * attempt;
          console.warn(`[agent-loop] ${depthPrefix}Turn ${turns} attempt ${attempt} failed (${err.message.slice(0, 80)}...) — retrying in ${delayMs / 1000}s`);
          await new Promise(r => setTimeout(r, delayMs));
        } else {
          console.error(`[agent-loop] ${depthPrefix}API error on turn ${turns}: ${err.message}`);
          throw err;
        }
      }
    }

    totalInputTokens += response.usage.inputTokens;
    totalOutputTokens += response.usage.outputTokens;

    if (response.content) {
      finalText = response.content;
      if (verbose) {
        console.log(`[agent-loop] ${depthPrefix}Assistant: ${response.content.slice(0, 500)}`);
      } else {
        console.log(`[agent-loop] ${depthPrefix}Assistant: ${response.content.slice(0, 150)}${response.content.length > 150 ? '...' : ''}`);
      }
    }

    console.log(`[agent-loop] ${depthPrefix}Stop reason: ${response.stopReason}, Tool calls: ${response.toolCalls?.length || 0}`);

    // No tool calls — model is done
    if (!response.toolCalls || response.toolCalls.length === 0) {
      console.log(`[agent-loop] ${depthPrefix}No tool calls — done after ${turns} turns`);
      break;
    }

    // Loop detection: track consecutive turns with tool calls but no text
    if (!response.content || response.content.trim() === '') {
      consecutiveToolOnlyTurns++;
    } else {
      consecutiveToolOnlyTurns = 0;
    }

    // Safety: if 10+ consecutive tool-only turns, force toolChoice back to auto
    if (consecutiveToolOnlyTurns >= 10 && activeToolChoice === 'required') {
      console.warn(`[agent-loop] ${depthPrefix}Loop detected: ${consecutiveToolOnlyTurns} consecutive tool-only turns. Switching toolChoice to "auto".`);
      activeToolChoice = 'auto';
      consecutiveToolOnlyTurns = 0;
    }

    // Record assistant message with tool calls
    messages.push(providerMod.formatAssistantMessage(response.content, response.toolCalls, response._rawParts));

    // Execute tool calls
    const results = [];
    for (const tc of response.toolCalls) {
      console.log(`[agent-loop] ${depthPrefix}  Tool: ${tc.name}(${summarizeArgs(tc.arguments)})`);
      const startTool = Date.now();
      const result = await executeTool(tc.name, tc.arguments, cwd, agentContext);
      const elapsed = Date.now() - startTool;

      if (verbose) {
        console.log(`[agent-loop] ${depthPrefix}  Result (${elapsed}ms): ${result.slice(0, 500)}`);
      } else {
        console.log(`[agent-loop] ${depthPrefix}  Result (${elapsed}ms): ${result.slice(0, 120)}${result.length > 120 ? '...' : ''}`);
      }

      const isError = result.startsWith('Error:');
      results.push(providerMod.formatToolResult(tc.id, tc.name, result, isError));
    }

    // Merge tool results into a single message for Gemini, or individual messages for OpenAI/Claude
    if (providerName === 'gemini') {
      // Gemini: all function responses in one user turn
      const allResults = [];
      for (const r of results) {
        allResults.push(...r.results);
      }
      messages.push({ role: 'tool', results: allResults });
    } else {
      // OpenAI/xAI/Claude: each tool result is separate
      for (const r of results) {
        messages.push(r);
      }
    }
  }

  const durationMs = Date.now() - startTime;
  const modelForCost = resolvedModel || providerMod.DEFAULT_MODEL;
  let cost;
  if (providerName === 'xai') {
    const xaiConfig = getProviderConfig('xai');
    const fallback = xaiConfig.models[xaiConfig.defaultModel];
    const m = xaiConfig.models[modelForCost] || fallback;
    cost = (totalInputTokens / 1_000_000) * m.inputPer1M + (totalOutputTokens / 1_000_000) * m.outputPer1M;
  } else {
    cost = providerMod.estimateCost(
      modelForCost,
      { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
      providerName
    );
  }

  console.log(`[agent-loop] ${depthPrefix}Finished — turns: ${turns}, input: ${totalInputTokens}, output: ${totalOutputTokens}, cost: $${cost.toFixed(4)}, duration: ${(durationMs / 1000).toFixed(1)}s`);

  return { turns, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, cost, durationMs, finalText, _messages: messages };
}

function summarizeArgs(args) {
  if (!args) return '';
  const entries = Object.entries(args);
  if (entries.length === 0) return '';
  return entries.map(([k, v]) => {
    const str = typeof v === 'string' ? v : JSON.stringify(v);
    return `${k}: ${str.length > 60 ? str.slice(0, 60) + '...' : str}`;
  }).join(', ');
}

module.exports = { runAgentLoop };
