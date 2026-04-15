// providers/gemini.js — Google Gemini SDK provider

const { GoogleGenAI } = require('@google/genai');
const { assertProviderModel, getProviderConfig, resolveProviderModel } = require('../provider-config');

const DEFAULT_MODEL = getProviderConfig('gemini').defaultModel;
const MODELS = getProviderConfig('gemini').models;

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
            ...(r.toolCallId ? { id: r.toolCallId } : {}),
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
async function sendRequest({ model, system, messages, tools, thinking, apiKey, providerName = 'gemini', toolChoice }) {
  const ai = new GoogleGenAI({ apiKey });
  const providerCfg = getProviderConfig(providerName);
  const modelId = assertProviderModel(providerName, model || providerCfg.defaultModel);

  const config = { maxOutputTokens: 65536 };
  const thinkingCfg = getThinkingConfig(modelId, thinking);
  if (thinkingCfg) {
    Object.assign(config, thinkingCfg);
  }

  if (system) {
    config.systemInstruction = { parts: [{ text: system }] };
  }
  if (tools && tools.length > 0) {
    config.tools = tools;

    // toolConfig: auto → AUTO, required → ANY, none → NONE
    if (toolChoice) {
      const modeMap = { auto: 'AUTO', required: 'ANY', none: 'NONE' };
      config.toolConfig = {
        functionCallingConfig: { mode: modeMap[toolChoice] || 'AUTO' },
      };
    }
  }

  let response;
  try {
    response = await ai.models.generateContent({
      model: modelId,
      contents: toGeminiContents(messages),
      config,
    });
  } catch (error) {
    const status = error?.status || error?.response?.status;
    const message = extractGeminiErrorMessage(error);
    throw new Error(`Gemini API error${status ? ` ${status}` : ''}: ${message}`);
  }

  return parseResponse(response);
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
        id: part.functionCall.id || `gemini-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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
    results: [{
      toolCallId,
      name,
      content: typeof result === 'string' ? result : JSON.stringify(result),
      isError: !!isError,
    }],
  };
}

function formatAssistantMessage(content, toolCalls, _rawParts) {
  return { role: 'assistant', content, toolCalls, _rawParts };
}

function estimateCost(model, usage, providerName = 'gemini') {
  const providerCfg = getProviderConfig(providerName);
  const resolved = resolveProviderModel(providerName, model || providerCfg.defaultModel);
  const m = providerCfg.models[resolved] || providerCfg.models[providerCfg.defaultModel];
  const inputCost = (usage.inputTokens / 1_000_000) * m.inputPer1M;
  const outputCost = (usage.outputTokens / 1_000_000) * m.outputPer1M;
  return inputCost + outputCost;
}

function extractGeminiErrorMessage(error) {
  if (!error) return 'Unknown Gemini SDK error';
  const raw = error?.message || 'Unknown Gemini SDK error';
  try {
    const parsed = JSON.parse(raw);
    return parsed?.error?.message || raw;
  } catch {
    return raw;
  }
}

module.exports = {
  sendRequest,
  formatToolResult,
  formatAssistantMessage,
  estimateCost,
  toGeminiContents,
  DEFAULT_MODEL,
  MODELS,
};
