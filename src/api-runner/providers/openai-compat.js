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
        baseUrl: args.baseUrl || config.baseUrl,
        model: args.model || config.defaultModel,
      });
    },
  };
}

function forGroq() {
  return wrap(getProviderConfig('groq'));
}

function forDeepSeek() {
  return wrap(getProviderConfig('deepseek'));
}

function forMistral() {
  return wrap(getProviderConfig('mistral'));
}

module.exports = {
  forGroq,
  forDeepSeek,
  forMistral,
};
