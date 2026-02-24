// providers/openai.js — OpenAI API provider
// Also used for xAI with different base URL
// POST https://api.openai.com/v1/chat/completions

const DEFAULT_MODEL = 'gpt-5.2';

const MODELS = {
  'gpt-5.2': { label: 'GPT 5.2', inputPer1M: 2.50, outputPer1M: 10.0 },
  'gpt-5.2-pro': { label: 'GPT 5.2 Pro', inputPer1M: 5.00, outputPer1M: 20.0 },
  'gpt-5.1': { label: 'GPT 5.1', inputPer1M: 2.50, outputPer1M: 10.0 },
  'o3': { label: 'o3', inputPer1M: 2.50, outputPer1M: 10.0 },
  'o4-mini': { label: 'o4 mini', inputPer1M: 0.50, outputPer1M: 2.00 },
};

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
async function sendRequest({ model, system, messages, tools, thinking, apiKey, baseUrl }) {
  const url = (baseUrl || 'https://api.openai.com') + '/v1/chat/completions';
  const modelId = model || DEFAULT_MODEL;

  const body = {
    model: modelId,
    messages: toOpenAIMessages(system, messages),
    max_completion_tokens: 65536,
  };

  if (tools && tools.length > 0) {
    body.tools = tools;
  }

  if (thinking && thinking !== 'none') {
    body.reasoning_effort = THINKING_MAP[thinking] || 'medium';
  }

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`OpenAI API error ${resp.status}: ${errText}`);
  }

  const data = await resp.json();
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
