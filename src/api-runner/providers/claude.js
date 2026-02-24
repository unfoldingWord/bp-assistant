// providers/claude.js — Anthropic Claude API provider
// Uses the already-installed @anthropic-ai/sdk (Messages API)

let _Anthropic = null;

async function getAnthropicClass() {
  if (!_Anthropic) {
    const sdk = await import('@anthropic-ai/sdk');
    _Anthropic = sdk.default || sdk.Anthropic;
  }
  return _Anthropic;
}

const DEFAULT_MODEL = 'claude-opus-4-6';

const MODELS = {
  'claude-opus-4-6': { label: 'Claude Opus 4.6', inputPer1M: 15.0, outputPer1M: 75.0 },
  'claude-sonnet-4-6': { label: 'Claude Sonnet 4.6', inputPer1M: 3.0, outputPer1M: 15.0 },
  'claude-haiku-4-5-20251001': { label: 'Claude Haiku 4.5', inputPer1M: 0.80, outputPer1M: 4.0 },
};

const THINKING_MAP = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  max: 'max',
};

/**
 * Convert internal messages to Claude Messages API format.
 */
function toClaudeMessages(messages) {
  const result = [];
  for (const msg of messages) {
    if (msg.role === 'user') {
      result.push({ role: 'user', content: msg.content });
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
      result.push({ role: 'assistant', content: blocks });
    } else if (msg.role === 'tool') {
      const blocks = msg.results.map(r => ({
        type: 'tool_result',
        tool_use_id: r.toolCallId,
        content: typeof r.content === 'string' ? r.content : JSON.stringify(r.content),
        is_error: r.isError || false,
      }));
      result.push({ role: 'user', content: blocks });
    }
  }
  return result;
}

/**
 * Send a request to the Claude Messages API.
 */
async function sendRequest({ model, system, messages, tools, thinking, apiKey }) {
  const Anthropic = await getAnthropicClass();
  const client = new Anthropic({ apiKey });
  const modelId = model || DEFAULT_MODEL;

  const params = {
    model: modelId,
    max_tokens: 65536,
    messages: toClaudeMessages(messages),
  };

  if (system) {
    params.system = system;
  }

  if (tools && tools.length > 0) {
    params.tools = tools;
  }

  if (thinking && thinking !== 'none') {
    params.thinking = { type: 'adaptive' };
    params.output_config = { effort: THINKING_MAP[thinking] || 'medium' };
    // Extended thinking requires higher max_tokens
    params.max_tokens = 128000;
  }

  const resp = await client.messages.create(params);
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
  const m = MODELS[model] || MODELS[DEFAULT_MODEL];
  const inputCost = (usage.inputTokens / 1_000_000) * m.inputPer1M;
  const outputCost = (usage.outputTokens / 1_000_000) * m.outputPer1M;
  return inputCost + outputCost;
}

module.exports = {
  sendRequest,
  formatToolResult,
  formatAssistantMessage,
  estimateCost,
  DEFAULT_MODEL,
  MODELS,
};
