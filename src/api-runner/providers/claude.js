// providers/claude.js — Anthropic Claude API provider
// Uses the already-installed @anthropic-ai/sdk (Messages API)

let _Anthropic = null;
const { getProviderConfig, resolveProviderModel } = require('../provider-config');

async function getAnthropicClass() {
  if (!_Anthropic) {
    const sdk = await import('@anthropic-ai/sdk');
    _Anthropic = sdk.default || sdk.Anthropic;
  }
  return _Anthropic;
}

const DEFAULT_MODEL = getProviderConfig('claude').defaultModel;
const MODELS = getProviderConfig('claude').models;

const THINKING_MAP = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  max: 'max',
};

/**
 * Convert internal messages to Claude Messages API format with Cache Control.
 */
function toClaudeMessages(messages) {
  const result = [];
  const totalMsgs = messages.length;
  
  for (let i = 0; i < totalMsgs; i++) {
    const msg = messages[i];
    const isLast = (i === totalMsgs - 1);
    const isCachePoint = (i === totalMsgs - 2 || i === totalMsgs - 4); // Cache a few points back

    if (msg.role === 'user') {
      const content = [{ type: 'text', text: msg.content }];
      if (isCachePoint) content[0].cache_control = { type: 'ephemeral' };
      result.push({ role: 'user', content });
    } else if (msg.role === 'assistant') {
      const blocks = [];
      if (msg.content) blocks.push({ type: 'text', text: msg.content });
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          blocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.arguments,
          });
        }
      }
      if (isCachePoint && blocks.length > 0) {
        blocks[blocks.length - 1].cache_control = { type: 'ephemeral' };
      }
      result.push({ role: 'assistant', content: blocks });
    } else if (msg.role === 'tool') {
      const blocks = msg.results.map((r, idx) => {
        const block = {
          type: 'tool_result',
          tool_use_id: r.toolCallId,
          content: typeof r.content === 'string' ? r.content : JSON.stringify(r.content),
          is_error: r.isError || false,
        };
        // If this is the last block of a cache point turn, add cache control
        if (isCachePoint && idx === msg.results.length - 1) {
          block.cache_control = { type: 'ephemeral' };
        }
        return block;
      });
      result.push({ role: 'user', content: blocks });
    }
  }
  return result;
}

/**
 * Send a request to the Claude Messages API.
 */
async function sendRequest({ model, system, messages, tools, thinking, apiKey, toolChoice }) {
  const Anthropic = await getAnthropicClass();
  const client = new Anthropic({ apiKey });
  const providerCfg = getProviderConfig('claude');
  const modelId = resolveProviderModel('claude', model || providerCfg.defaultModel);

  const params = {
    model: modelId,
    max_tokens: 65536,
    messages: toClaudeMessages(messages),
  };

  if (system) {
    // Always cache the system prompt (contains the Skill instructions)
    params.system = [
      {
        type: 'text',
        text: system,
        cache_control: { type: 'ephemeral' }
      }
    ];
  }

  if (tools && tools.length > 0) {
    params.tools = tools;

    // tool_choice: auto → {type:"auto"}, required → {type:"any"}, none → {type:"none"}
    if (toolChoice) {
      const typeMap = { auto: 'auto', required: 'any', none: 'none' };
      params.tool_choice = { type: typeMap[toolChoice] || 'auto' };
    }
  }

  if (thinking && thinking !== 'none') {
    params.thinking = { type: 'adaptive' };
    params.output_config = { effort: THINKING_MAP[thinking] || 'medium' };
    // Extended thinking requires higher max_tokens
    params.max_tokens = 128000;
  }

  // Override the default 10-minute timeout for large API runner workloads
  // For high max_tokens, Anthropic requires streaming. We use .stream() and wait for finalMessage()
  const stream = await client.messages.stream(params, { 
    timeout: 60 * 60 * 1000,
    headers: {
      'anthropic-beta': 'prompt-caching-2024-07-31'
    }
  });
  const resp = await stream.finalMessage();
  return parseResponse(resp);
}

function parseResponse(resp) {
  let content = '';
  const toolCalls = [];

  for (const block of resp.content || []) {
    if (block.type === 'text') {
      content += block.text;
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        name: block.name,
        arguments: block.input,
      });
    }
    // Thinking blocks are ignored (internal reasoning)
  }

  const usage = {
    inputTokens: resp.usage?.input_tokens || 0,
    outputTokens: resp.usage?.output_tokens || 0,
    cacheReadTokens: resp.usage?.cache_read_input_tokens || 0,
    cacheCreateTokens: resp.usage?.cache_creation_input_tokens || 0,
  };

  const stopReason = resp.stop_reason || 'unknown';

  return { content, toolCalls, usage, stopReason };
}

function formatToolResult(toolCallId, name, result, isError) {
  return {
    role: 'tool',
    results: [{
      toolCallId,
      name,
      content: typeof result === 'string' ? result : JSON.stringify(result),
      isError: !!isError,
    }],
  };
}

function formatAssistantMessage(content, toolCalls) {
  return { role: 'assistant', content, toolCalls };
}

function estimateCost(model, usage) {
  const providerCfg = getProviderConfig('claude');
  const resolved = resolveProviderModel('claude', model || providerCfg.defaultModel);
  const m = providerCfg.models[resolved] || providerCfg.models[providerCfg.defaultModel];
  
  const cacheReadCost = (usage.cacheReadTokens / 1_000_000) * (m.inputPer1M * 0.1); // 90% discount
  const cacheCreateCost = (usage.cacheCreateTokens / 1_000_000) * (m.inputPer1M * 1.25); // 25% premium
  const standardInputTokens = usage.inputTokens - usage.cacheReadTokens - usage.cacheCreateTokens;
  const standardInputCost = (Math.max(0, standardInputTokens) / 1_000_000) * m.inputPer1M;
  
  const outputCost = (usage.outputTokens / 1_000_000) * m.outputPer1M;
  
  return cacheReadCost + cacheCreateCost + standardInputCost + outputCost;
}

module.exports = {
  sendRequest,
  formatToolResult,
  formatAssistantMessage,
  estimateCost,
  DEFAULT_MODEL,
  MODELS,
};
