const {
  Agent,
  MemorySession,
  OpenAIProvider,
  Runner,
  tool,
} = require('@openai/agents');

const { executeTool, TOOL_SCHEMAS, strictifySchema } = require('./tools');
const { getProviderConfig, resolveProviderModel } = require('./provider-config');
const { resolveRuntime } = require('./runtime-config');

const DEFAULT_MODEL = getProviderConfig('openai').defaultModel;

const THINKING_MAP = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  max: 'xhigh',
};

async function runOpenAiNative({
  provider: providerName,
  model,
  system,
  userMessage,
  maxTurns = 100,
  timeoutMs = 30 * 60 * 1000,
  cwd = '/srv/bot/workspace',
  thinking = 'medium',
  apiKey,
  toolChoice,
  depth = 0,
  apiKeyResolver,
  lockProvider = false,
  runtime = 'openai-native',
  session,
  toolSchemas = TOOL_SCHEMAS,
}) {
  if (providerName !== 'openai') {
    throw new Error(`OpenAI native runtime only supports provider "openai" (received "${providerName}")`);
  }

  const modelId = resolveProviderModel('openai', model || DEFAULT_MODEL);
  const provider = new OpenAIProvider({ apiKey, useResponses: true });
  const runner = new Runner({
    modelProvider: provider,
    tracingDisabled: true,
    traceIncludeSensitiveData: false,
    workflowName: 'bp-assistant-openai-native',
  });
  const activeSession = session || new MemorySession();
  const startTime = Date.now();
  const depthPrefix = depth > 0 ? `[depth ${depth}] ` : '';

  console.log(
    `[openai-native] ${depthPrefix}Starting — model: ${modelId}, thinking: ${thinking || 'default'}${toolChoice ? `, toolChoice: ${toolChoice}` : ''}`
  );
  console.log(`[openai-native] ${depthPrefix}Max turns: ${maxTurns}, timeout: ${timeoutMs / 1000}s`);

  const abortController = new AbortController();
  const timer = setTimeout(() => {
    console.warn(`[openai-native] ${depthPrefix}Timeout reached after ${(Date.now() - startTime) / 1000}s`);
    abortController.abort();
  }, timeoutMs);

  try {
    const agent = new Agent({
      name: depth > 0 ? `WorkspaceAgentDepth${depth}` : 'WorkspaceAgent',
      instructions: system,
      model: modelId,
      tools: buildOpenAiNativeTools({
        cwd,
        depth,
        thinking,
        apiKey,
        apiKeyResolver,
        lockProvider,
        runtime,
        toolSchemas,
      }),
      modelSettings: buildModelSettings({ model: modelId, thinking, toolChoice }),
    });

    const result = await runner.run(agent, userMessage, {
      maxTurns,
      signal: abortController.signal,
      session: activeSession,
    });

    const usage = result.state?.usage || result.runContext?.usage;
    const inputTokens = usage?.inputTokens || 0;
    const outputTokens = usage?.outputTokens || 0;
    const durationMs = Date.now() - startTime;
    const providerCfg = getProviderConfig('openai');
    const modelCfg = providerCfg.models[modelId] || providerCfg.models[providerCfg.defaultModel];
    const cost = ((inputTokens / 1_000_000) * modelCfg.inputPer1M) + ((outputTokens / 1_000_000) * modelCfg.outputPer1M);
    const finalText = typeof result.finalOutput === 'string'
      ? result.finalOutput
      : JSON.stringify(result.finalOutput ?? '');

    console.log(
      `[openai-native] ${depthPrefix}Finished — turns: ${usage?.requests || 0}, input: ${inputTokens}, output: ${outputTokens}, cost: $${cost.toFixed(4)}, duration: ${(durationMs / 1000).toFixed(1)}s`
    );

    return {
      turns: usage?.requests || 0,
      inputTokens,
      outputTokens,
      cost,
      durationMs,
      finalText,
      _messages: [],
      _session: activeSession,
    };
  } finally {
    clearTimeout(timer);
    await provider.close().catch(() => {});
  }
}

function buildOpenAiNativeTools(parentOpts) {
  const toolSchemas = parentOpts.toolSchemas || TOOL_SCHEMAS;
  return toolSchemas.map((schema) => tool({
    name: schema.name,
    description: schema.description,
    parameters: strictifySchema(schema.parameters),
    strict: true,
    execute: async (args) => {
      const result = await executeTool(
        schema.name,
        args || {},
        parentOpts.cwd,
        {
          parentOpts,
          runAgentLoopFn: runNestedAgent,
        }
      );
      return typeof result === 'string' ? result : JSON.stringify(result);
    },
  }));
}

async function runNestedAgent(opts) {
  const runtime = resolveRuntime(opts.provider, opts.runtime);
  if (runtime === 'openai-native') {
    return runOpenAiNative(opts);
  }

  const { runAgentLoop } = require('./agent-loop');
  return runAgentLoop({
    ...opts,
    runtime,
  });
}

function buildModelSettings({ model, thinking, toolChoice }) {
  const settings = {
    toolChoice: toolChoice || 'auto',
    parallelToolCalls: false,
    maxTokens: 65536,
    store: true,
    text: { verbosity: 'medium' },
  };

  if (supportsReasoning(model) && thinking && thinking !== 'none') {
    settings.reasoning = {
      effort: THINKING_MAP[thinking] || 'medium',
      summary: 'concise',
    };
  }

  return settings;
}

function supportsReasoning(model) {
  return /^(gpt-5|o3|o4)/.test(String(model || ''));
}

module.exports = {
  runOpenAiNative,
  buildModelSettings,
  supportsReasoning,
};
