// providers/gemini.js — Google Gemini API provider
// POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent

const DEFAULT_MODEL = 'gemini-3.1-pro-preview';

const MODELS = {
  'gemini-3.1-pro-preview': { label: 'Gemini 3.1 Pro (preview)', inputPer1M: 1.25, outputPer1M: 10.0 },
  'gemini-3-pro-preview': { label: 'Gemini 3 Pro (preview)', inputPer1M: 1.25, outputPer1M: 10.0 },
  'gemini-3-flash-preview': { label: 'Gemini 3 Flash (preview)', inputPer1M: 0.15, outputPer1M: 0.60 },
  'gemini-2.5-pro': { label: 'Gemini 2.5 Pro', inputPer1M: 1.25, outputPer1M: 10.0 },
  'gemini-2.5-flash': { label: 'Gemini 2.5 Flash', inputPer1M: 0.15, outputPer1M: 0.60 },
};

const THINKING_MAP_3X = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  max: 'high',
};

const THINKING_MAP_25 = {
  low: 0,
  medium: 4096,
  high: 8192,
  max: 32768,
};

function getThinkingConfig(model, thinking) {
  if (!thinking || thinking === 'none') return undefined;
  const is3x = model.startsWith('gemini-3');
  if (is3x) {
    return { thinkingConfig: { thinkingLevel: THINKING_MAP_3X[thinking] || 'medium' } };
  }
  return { thinkingConfig: { thinkingBudget: THINKING_MAP_25[thinking] ?? 4096 } };
}

/**
 * Convert internal messages to Gemini contents format.
 * Internal format: [{ role: 'user'|'assistant'|'tool', ... }]
 */
function toGeminiContents(messages) {
  const contents = [];
  for (const msg of messages) {
    if (msg.role === 'user') {
      contents.push({ role: 'user', parts: [{ text: msg.content }] });
    } else if (msg.role === 'assistant') {
      // Replay raw parts if available (preserves thoughtSignature on functionCall parts)
      if (msg._rawParts) {
        contents.push({ role: 'model', parts: msg._rawParts });
      } else {
        const parts = [];
        if (msg.content) parts.push({ text: msg.content });
        if (msg.toolCalls) {
          for (const tc of msg.toolCalls) {
            parts.push({ functionCall: { name: tc.name, args: tc.arguments } });
          }
        }
        contents.push({ role: 'model', parts });
      }
    } else if (msg.role === 'tool') {
      contents.push({
        role: 'user',
        parts: msg.results.map(r => ({
          functionResponse: {
            name: r.name,
            response: { content: r.content },
          },
        })),
      });
    }
  }
  return contents;
}

/**
 * Send a request to the Gemini API.
 */
async function sendRequest({ model, system, messages, tools, thinking, apiKey }) {
  const modelId = model || DEFAULT_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`;

  const body = {
    contents: toGeminiContents(messages),
  };

  if (system) {
    body.systemInstruction = { parts: [{ text: system }] };
  }

  if (tools && tools.length > 0) {
    body.tools = tools;
  }

  body.generationConfig = {
    maxOutputTokens: 65536,
  };

  const thinkingCfg = getThinkingConfig(modelId, thinking);
  if (thinkingCfg) {
    Object.assign(body.generationConfig, thinkingCfg);
  }

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Gemini API error ${resp.status}: ${errText}`);
  }

  const data = await resp.json();

  if (data.error) {
    throw new Error(`Gemini API error: ${data.error.message || JSON.stringify(data.error)}`);
  }

  return parseResponse(data);
}

function parseResponse(data) {
  const candidate = data.candidates?.[0];
  if (!candidate) {
    throw new Error('Gemini returned no candidates');
  }

  let content = '';
  const toolCalls = [];
  const rawParts = candidate.content?.parts || [];

  for (const part of rawParts) {
    if (part.text) {
      content += part.text;
    } else if (part.functionCall) {
      toolCalls.push({
        id: `gemini-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: part.functionCall.name,
        arguments: part.functionCall.args || {},
      });
    }
    // thought parts and thoughtSignature fields are preserved in rawParts
  }

  const usage = {
    inputTokens: data.usageMetadata?.promptTokenCount || 0,
    outputTokens: data.usageMetadata?.candidatesTokenCount || 0,
  };

  const stopReason = candidate.finishReason || 'unknown';

  // rawParts carries thoughtSignature — needed for 3.x thinking models
  return { content, toolCalls, usage, stopReason, _rawParts: rawParts };
}

function formatToolResult(toolCallId, name, result, isError) {
  return {
    role: 'tool',
    results: [{ name, content: typeof result === 'string' ? result : JSON.stringify(result) }],
  };
}

function formatAssistantMessage(content, toolCalls, _rawParts) {
  return { role: 'assistant', content, toolCalls, _rawParts };
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
