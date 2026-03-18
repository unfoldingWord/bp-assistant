// provider-config.js — single source of truth for API provider settings

const fs = require('fs');

const DEFAULT_PROVIDER_CONFIGS = {
  claude: {
    defaultModel: 'claude-opus-4-6',
    secretName: 'anthropic_api_key',
    envName: 'ANTHROPIC_API_KEY',
    models: {
      'claude-opus-4-6': { label: 'Claude Opus 4.6', inputPer1M: 15.0, outputPer1M: 75.0 },
      'claude-sonnet-4-6': { label: 'Claude Sonnet 4.6', inputPer1M: 3.0, outputPer1M: 15.0 },
      'claude-haiku-4-5-20251001': { label: 'Claude Haiku 4.5', inputPer1M: 0.8, outputPer1M: 4.0 },
    },
  },
  openai: {
    defaultModel: 'gpt-4.1',
    secretName: 'openai_api_key',
    envName: 'OPENAI_API_KEY',
    models: {
      'gpt-4.1': { label: 'GPT 4.1', inputPer1M: 2.0, outputPer1M: 8.0 },
      'gpt-5.3': { label: 'GPT 5.3', inputPer1M: 4.0, outputPer1M: 16.0 },
      'gpt-5.4': { label: 'GPT 5.4', inputPer1M: 5.0, outputPer1M: 20.0 },
      'o3': { label: 'o3', inputPer1M: 2.5, outputPer1M: 10.0 },
      'o4-mini': { label: 'o4 mini', inputPer1M: 0.5, outputPer1M: 2.0 },
    },
  },
  gemini: {
    defaultModel: 'gemini-3.1-pro-preview',
    secretName: 'google_api_key',
    envName: 'GOOGLE_API_KEY',
    models: {
      'gemini-3.1-pro-preview': { label: 'Gemini 3.1 Pro (preview)', inputPer1M: 1.25, outputPer1M: 10.0 },
      'gemini-3-pro-preview': { label: 'Gemini 3 Pro (preview)', inputPer1M: 1.25, outputPer1M: 10.0 },
      'gemini-3-flash-preview': { label: 'Gemini 3 Flash (preview)', inputPer1M: 0.15, outputPer1M: 0.6 },
      'gemini-2.5-pro': { label: 'Gemini 2.5 Pro', inputPer1M: 1.25, outputPer1M: 10.0 },
      'gemini-2.5-flash': { label: 'Gemini 2.5 Flash', inputPer1M: 0.15, outputPer1M: 0.6 },
    },
  },
  xai: {
    defaultModel: 'grok-4-0709',
    secretName: 'xai_api_key',
    envName: 'XAI_API_KEY',
    baseUrl: 'https://api.x.ai',
    models: {
      'grok-4-0709': { label: 'Grok 4', inputPer1M: 3.0, outputPer1M: 9.0 },
      'grok-4-1-fast-reasoning': { label: 'Grok 4.1 Fast (reasoning)', inputPer1M: 3.0, outputPer1M: 9.0 },
      'grok-4-1-fast-non-reasoning': { label: 'Grok 4.1 Fast (no CoT)', inputPer1M: 3.0, outputPer1M: 9.0 },
      'grok-3': { label: 'Grok 3', inputPer1M: 3.0, outputPer1M: 15.0 },
      'grok-3-mini': { label: 'Grok 3 Mini', inputPer1M: 0.3, outputPer1M: 0.5 },
    },
    autoModelByThinking: {
      low: 'grok-4-1-fast-non-reasoning',
      medium: 'grok-4-1-fast-reasoning',
      high: 'grok-4-1-fast-reasoning',
      max: 'grok-4-1-fast-reasoning',
      none: 'grok-4-1-fast-non-reasoning',
    },
    reasoningEffortModels: ['grok-3-mini'],
  },
  groq: {
    defaultModel: 'meta-llama/llama-4-scout-17b-16e-instruct',
    secretName: 'openai_api_key',
    envName: 'OPENAI_API_KEY',
    baseUrl: 'https://api.groq.com/openai/v1',
    models: {
      'meta-llama/llama-4-scout-17b-16e-instruct': { label: 'Llama 4 Scout', inputPer1M: 0.2, outputPer1M: 0.2 },
      'qwen/qwen3-32b': { label: 'Qwen3 32B', inputPer1M: 0.29, outputPer1M: 0.39 },
    },
  },
  deepseek: {
    defaultModel: 'deepseek-chat',
    secretName: 'openai_api_key',
    envName: 'OPENAI_API_KEY',
    baseUrl: 'https://api.deepseek.com',
    models: {
      'deepseek-chat': { label: 'DeepSeek Chat', inputPer1M: 0.27, outputPer1M: 1.1 },
      'deepseek-reasoner': { label: 'DeepSeek Reasoner', inputPer1M: 0.55, outputPer1M: 2.19 },
    },
  },
  mistral: {
    defaultModel: 'mistral-large-latest',
    secretName: 'openai_api_key',
    envName: 'OPENAI_API_KEY',
    baseUrl: 'https://api.mistral.ai/v1',
    models: {
      'mistral-large-latest': { label: 'Mistral Large', inputPer1M: 2.0, outputPer1M: 6.0 },
      'mistral-medium-latest': { label: 'Mistral Medium', inputPer1M: 0.6, outputPer1M: 1.8 },
    },
  },
};

const CONFIG_PATH_CANDIDATES = [
  '/config/model-provider-config.json',
  '/srv/bot/config/model-provider-config.json',
];

const overrideCache = {
  path: null,
  mtimeMs: null,
  merged: DEFAULT_PROVIDER_CONFIGS,
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function getConfigPath() {
  const envPath = process.env.MODEL_PROVIDER_CONFIG_FILE;
  if (envPath && fs.existsSync(envPath)) return envPath;
  for (const candidate of CONFIG_PATH_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function readJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function normalizeOverrides(parsed) {
  if (!parsed || typeof parsed !== 'object') return {};
  if (parsed.providers && typeof parsed.providers === 'object') return parsed.providers;
  return parsed;
}

function mergeProvider(baseCfg, overrideCfg) {
  const merged = { ...baseCfg, ...overrideCfg };
  if (baseCfg?.models || overrideCfg?.models) {
    merged.models = { ...(baseCfg?.models || {}), ...(overrideCfg?.models || {}) };
  }
  if (baseCfg?.autoModelByThinking || overrideCfg?.autoModelByThinking) {
    merged.autoModelByThinking = {
      ...(baseCfg?.autoModelByThinking || {}),
      ...(overrideCfg?.autoModelByThinking || {}),
    };
  }
  if (Array.isArray(overrideCfg?.reasoningEffortModels)) {
    merged.reasoningEffortModels = [...overrideCfg.reasoningEffortModels];
  } else if (Array.isArray(baseCfg?.reasoningEffortModels)) {
    merged.reasoningEffortModels = [...baseCfg.reasoningEffortModels];
  }
  return merged;
}

function mergeProviderConfigs(baseConfigs, overrideConfigs) {
  const merged = clone(baseConfigs);
  for (const [provider, overrideCfg] of Object.entries(overrideConfigs)) {
    const baseCfg = merged[provider] || {};
    merged[provider] = mergeProvider(baseCfg, overrideCfg || {});
  }
  return merged;
}

function getResolvedProviderConfigs() {
  const configPath = getConfigPath();
  if (!configPath) return DEFAULT_PROVIDER_CONFIGS;

  try {
    const stat = fs.statSync(configPath);
    if (
      overrideCache.path === configPath &&
      overrideCache.mtimeMs === stat.mtimeMs &&
      overrideCache.merged
    ) {
      return overrideCache.merged;
    }

    const parsed = readJsonFile(configPath);
    const overrides = normalizeOverrides(parsed);
    const merged = mergeProviderConfigs(DEFAULT_PROVIDER_CONFIGS, overrides);

    overrideCache.path = configPath;
    overrideCache.mtimeMs = stat.mtimeMs;
    overrideCache.merged = merged;
    return merged;
  } catch (error) {
    console.warn(`[provider-config] Failed to load ${configPath}: ${error.message}`);
    return DEFAULT_PROVIDER_CONFIGS;
  }
}

function getProviderConfig(provider) {
  const cfg = getResolvedProviderConfigs()[provider];
  if (!cfg) throw new Error(`Unknown provider: ${provider}`);
  return cfg;
}

function getProviderNames() {
  return Object.keys(getResolvedProviderConfigs());
}

function resolveXaiModel(model, thinking) {
  const cfg = getProviderConfig('xai');
  if (model) return model;
  return cfg.autoModelByThinking[thinking || 'medium'] || cfg.defaultModel;
}

module.exports = {
  DEFAULT_PROVIDER_CONFIGS,
  getResolvedProviderConfigs,
  getProviderConfig,
  getProviderNames,
  resolveXaiModel,
};
