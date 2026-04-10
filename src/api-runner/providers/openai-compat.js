// providers/openai-compat.js — OpenAI-compatible provider presets

const openaiProvider = require('./openai');
const { getProviderConfig } = require('../provider-config');

function wrap(config) {
  return {
    ...openaiProvider,
    baseUrl: config.baseUrl,
    DEFAULT_MODEL: config.defaultModel,
    MODELS: config.models,
    async sendRequest(args) {
      return openaiProvider.sendRequest({
        ...args,
        providerName: config.providerName,
        baseUrl: args.baseUrl || config.baseUrl,
        model: args.model || config.defaultModel,
      });
    },
    estimateCost(model, usage) {
      return openaiProvider.estimateCost(model, usage, config.providerName);
    },
  };
}

function forGroq() {
  return wrap({ ...getProviderConfig('groq'), providerName: 'groq' });
}

function forDeepSeek() {
  return wrap({ ...getProviderConfig('deepseek'), providerName: 'deepseek' });
}

function forMistral() {
  return wrap({ ...getProviderConfig('mistral'), providerName: 'mistral' });
}

module.exports = {
  forGroq,
  forDeepSeek,
  forMistral,
};
