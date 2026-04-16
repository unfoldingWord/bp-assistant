const DEFAULT_RUNTIME = 'generic-api';

const VALID_RUNTIMES = new Set([
  DEFAULT_RUNTIME,
  'openai-native',
]);

function normalizeRuntime(runtime) {
  if (!runtime) return DEFAULT_RUNTIME;
  return String(runtime).trim().toLowerCase();
}

function resolveRuntime(provider, runtime) {
  const resolvedProvider = String(provider || 'gemini').trim().toLowerCase();
  const resolvedRuntime = normalizeRuntime(runtime);

  if (!VALID_RUNTIMES.has(resolvedRuntime)) {
    throw new Error(`Unknown runtime "${runtime}". Valid: ${Array.from(VALID_RUNTIMES).join(', ')}`);
  }

  if (resolvedRuntime === 'openai-native' && resolvedProvider !== 'openai') {
    throw new Error(`Runtime "${resolvedRuntime}" is only supported with provider "openai"`);
  }

  return resolvedRuntime;
}

module.exports = {
  DEFAULT_RUNTIME,
  VALID_RUNTIMES,
  normalizeRuntime,
  resolveRuntime,
};
