// providers/openai.js — OpenAI SDK provider

const OpenAI = require('openai');
const { getProviderConfig, resolveProviderModel } = require('../provider-config');

const DEFAULT_MODEL = getProviderConfig('openai').defaultModel;
const MODELS = getProviderConfig('openai').models;

const THINKING_MAP = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  max: 'high',
};

/**
 * Convert internal messages to OpenAI chat format.
 */
function toOpenAIMessages(system, messages) {
  const result = [];
  if (system) {
    result.push({ role: 'system', content: system });
  }
  for (const msg of messages) {
    if (msg.role === 'user') {
      result.push({ role: 'user', content: msg.content });
    } else if (msg.role === 'assistant') {
      const m = { role: 'assistant' };
      if (msg.content) m.content = msg.content;
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        m.tool_calls = msg.toolCalls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments),
          },
        }));
      }
      result.push(m);
    } else if (msg.role === 'tool') {
      for (const r of msg.results) {
        result.push({
          role: 'tool',
          tool_call_id: r.toolCallId,
          content: typeof r.content === 'string' ? r.content : JSON.stringify(r.content),
        });
      }
    }
  }
  return result;
}

/**
 * Send a request to the OpenAI-compatible API.
 */
async function sendRequest({ model, system, messages, tools, thinking, apiKey, baseUrl, providerName = 'openai', toolChoice }) {
  const client = new OpenAI({ apiKey, baseURL: baseUrl });
  const providerCfg = getProviderConfig(providerName);
  const modelId = resolveProviderModel(providerName, model || providerCfg.defaultModel);

  const body = {
    model: modelId,
    messages: toOpenAIMessages(system, messages),
    max_completion_tokens: 65536,
  };

  if (tools && tools.length > 0) {
    body.tools = tools;

    // tool_choice: auto → "auto", required → "required", none → "none"
    if (toolChoice) {
      body.tool_choice = toolChoice;
    }
  }

  // GPT-5+ doesn't support reasoning_effort with tools via chat completions
  if (thinking && thinking !== 'none' && !(tools && tools.length > 0)) {
    body.reasoning_effort = THINKING_MAP[thinking] || 'medium';
  }

  let data;
  try {
    data = await client.chat.completions.create(body);
  } catch (error) {
    const status = error?.status || error?.response?.status;
    const message = error?.message || 'Unknown OpenAI SDK error';
    throw new Error(`OpenAI API error${status ? ` ${status}` : ''}: ${message}`);
  }
  return parseResponse(data);
}

function parseResponse(data) {
  const choice = data.choices?.[0];
  if (!choice) {
    throw new Error('OpenAI returned no choices');
  }

  const msg = choice.message;
  const content = msg.content || '';
  const toolCalls = (msg.tool_calls || []).map(tc => ({
    id: tc.id,
    name: tc.function.name,
    arguments: safeParseJSON(tc.function.arguments),
  }));

  const usage = {
    inputTokens: data.usage?.prompt_tokens || 0,
    outputTokens: data.usage?.completion_tokens || 0,
  };

  const stopReason = choice.finish_reason || 'unknown';

  return { content, toolCalls, usage, stopReason };
}

function safeParseJSON(str) {
  try {
    return typeof str === 'string' ? JSON.parse(str) : str;
  } catch {
    return { raw: str };
  }
}

function formatToolResult(toolCallId, name, result, isError) {
  return {
    role: 'tool',
    results: [{
      toolCallId,
      name,
      content: typeof result === 'string' ? result : JSON.stringify(result),
    }],
  };
}

function formatAssistantMessage(content, toolCalls) {
  return { role: 'assistant', content, toolCalls };
}

function estimateCost(model, usage, providerName = 'openai') {
  const providerCfg = getProviderConfig(providerName);
  const resolved = resolveProviderModel(providerName, model || providerCfg.defaultModel);
  const m = providerCfg.models[resolved] || providerCfg.models[providerCfg.defaultModel];
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
