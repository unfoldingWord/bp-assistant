// claude-runner.js — SDK wrapper for Claude Agent SDK query()
// Replaces `claude -p` subprocess calls with programmatic SDK usage

const { ensureFreshToken } = require('./auth-refresh');
const { recordRateLimit, getHeadroom } = require('./usage-tracker');
const { createWorkspaceTools } = require('./workspace-tools');

let _query = null;
let _workspaceToolsServer = null;

async function getQuery() {
  if (!_query) {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    _query = sdk.query;
  }
  return _query;
}

async function getWorkspaceToolsServer() {
  if (!_workspaceToolsServer) {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    const { z } = require('zod');
    _workspaceToolsServer = createWorkspaceTools(sdk.createSdkMcpServer, sdk.tool, z);
  }
  return _workspaceToolsServer;
}

// Default: 10 minutes per invocation, 200 turns max
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_TURNS = 200;

const DEFAULT_ALLOWED_TOOLS = [
  'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'Task', 'Skill', 'SendMessage',
  'Agent', 'TeamCreate', 'TeamDelete',
  'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet',
  'NotebookEdit', 'WebFetch', 'WebSearch',
];

// Restricted profile for shell-less runs (distroless-compatible).
const DEFAULT_RESTRICTED_TOOLS = [
  'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'Task', 'TaskOutput', 'Skill', 'SendMessage',
  'Agent', 'TeamCreate', 'TeamDelete',
  'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet',
  'NotebookEdit', 'WebFetch', 'WebSearch',
];

function buildOptions({
  cwd,
  resume,
  model,
  allowedTools,
  tools,
  disallowedTools,
  disableLocalSettings,
  forceNoAutoBashSandbox,
  maxTurns,
  timeoutMs,
  appendSystemPrompt,
  abortController,
  mcpServers,
}) {
  const options = {
    cwd: cwd || process.cwd(),
    abortController: abortController || new AbortController(),
    maxTurns: maxTurns || DEFAULT_MAX_TURNS,
    allowedTools: allowedTools || DEFAULT_ALLOWED_TOOLS,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    settingSources: disableLocalSettings ? ['user', 'project'] : ['user', 'project', 'local'],
    persistSession: true,
  };
  if (tools) {
    options.tools = tools;
  }
  if (disallowedTools) {
    options.disallowedTools = disallowedTools;
  }
  if (forceNoAutoBashSandbox) {
    options.settings = {
      sandbox: {
        enabled: true,
        autoAllowBashIfSandboxed: false,
      },
    };
  }
  if (mcpServers) {
    options.mcpServers = mcpServers;
  }
  if (resume) {
    options.resume = resume;
  }
  options.model = model || 'opus';
  if (appendSystemPrompt) {
    options.systemPrompt = appendSystemPrompt;
  }
  return options;
}

async function runClaude({
  prompt,
  cwd,
  model,
  allowedTools,
  tools,
  disallowedTools,
  disableLocalSettings,
  forceNoAutoBashSandbox,
  skill,
  maxTurns,
  timeoutMs,
  appendSystemPrompt,
}) {
  await ensureFreshToken();
  const query = await getQuery();
  const wsTools = await getWorkspaceToolsServer();

  const fullPrompt = skill ? `/${skill} ${prompt}` : prompt;

  const abortController = new AbortController();
  const timeout = timeoutMs || DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => {
    console.warn(`[claude-runner] Timeout reached (${timeout / 1000}s) — aborting query`);
    abortController.abort();
  }, timeout);

  const options = buildOptions({
    cwd,
    model,
    allowedTools,
    tools,
    disallowedTools,
    disableLocalSettings,
    forceNoAutoBashSandbox,
    maxTurns,
    appendSystemPrompt,
    abortController,
    mcpServers: { 'workspace-tools': wsTools },
  });

  console.log(`[claude-runner] Starting query in ${cwd}`);
  console.log(`[claude-runner] Prompt: ${fullPrompt.slice(0, 200)}`);
  console.log(`[claude-runner] maxTurns: ${options.maxTurns}, timeout: ${timeout / 1000}s`);

  const conversation = query({ prompt: fullPrompt, options });

  let result = null;

  try {
    for await (const message of conversation) {
      if (message.type === 'assistant' && message.message?.content) {
        for (const block of message.message.content) {
          if ('text' in block) {
            console.log(`[claude] ${block.text.slice(0, 200)}`);
          } else if ('name' in block) {
            console.log(`[claude] Tool: ${block.name}(${JSON.stringify(block.input || {}).slice(0, 150)})`);
          }
        }
      } else if (message.type === 'result') {
        result = message;
      } else if (message.type === 'user') {
        const text = typeof message.message?.content === 'string'
          ? message.message.content
          : JSON.stringify(message.message?.content || '');
        if (text.includes('command-stderr') || text.includes('Error')) {
          console.error(`[claude-runner] SDK user message (error): ${text.slice(0, 500)}`);
        } else {
          console.log(`[claude-runner] SDK user message: ${text.slice(0, 300)}`);
        }
      } else if (message.type === 'system') {
        console.log(`[claude-runner] SDK system: ${message.subtype || 'unknown'} ${JSON.stringify(message).slice(0, 200)}`);
        if (message.subtype === 'init' && Array.isArray(message.tools)) {
          console.log(`[claude-runner] SDK init tools: ${message.tools.join(', ')}`);
        }
      } else {
        console.log(`[claude-runner] SDK event: ${message.type}${message.subtype ? '/' + message.subtype : ''}`);
      }
    }
  } catch (err) {
    if (err.name === 'AbortError' || abortController.signal.aborted) {
      console.warn(`[claude-runner] Query aborted (timeout or manual abort)`);
    } else {
      // Detect rate limit errors and calibrate the window budget
      const msg = (err.message || '').toLowerCase();
      const isRateLimit = msg.includes('rate limit') || msg.includes('429') || msg.includes('too many requests');
      if (isRateLimit) {
        console.warn(`[claude-runner] Rate limit detected -- calibrating window budget`);
        try {
          const room = getHeadroom();
          recordRateLimit({ windowUsed: room.used, source: 'claude-runner-error' });
        } catch { /* non-fatal */ }
      }
      throw err;
    }
  } finally {
    clearTimeout(timer);
    try { conversation.close(); } catch (_) {}
  }

  if (result) {
    console.log(`[claude-runner] Finished — subtype: ${result.subtype}, turns: ${result.num_turns}, cost: $${result.total_cost_usd?.toFixed(4) || '?'}, duration: ${(result.duration_ms / 1000).toFixed(1)}s`);
    if (result.subtype !== 'success' && result.result) {
      console.error(`[claude-runner] Result text: ${result.result.slice(0, 500)}`);
    }
    // Detect rate limit in result subtype or error message
    const resultMsg = (result.subtype || '') + ' ' + (result.error || '');
    const isRateLimit = /rate.?limit|429|too.many.requests/i.test(resultMsg);
    if (isRateLimit) {
      console.warn(`[claude-runner] Rate limit in result subtype -- calibrating window budget`);
      try {
        const room = getHeadroom();
        recordRateLimit({ windowUsed: room.used, source: 'claude-runner-result' });
      } catch { /* non-fatal */ }
    }
  } else {
    console.warn(`[claude-runner] Query ended without a result message (timeout or abort)`);
  }

  return result;
}

/**
 * Start a resumable query and return the async generator so the caller can consume
 * events, capture session_id from the first message that has it, and collect assistant text.
 * Caller must call cleanup() in a finally block.
 *
 * @param {{ prompt: string, cwd?: string, resume?: string, model?: string, maxTurns?: number, timeoutMs?: number, appendSystemPrompt?: string }}
 * @returns {{ conversation: AsyncGenerator, abortController: AbortController, cleanup: () => void }}
 */
async function runClaudeStream({
  prompt,
  cwd,
  resume,
  model,
  allowedTools,
  tools,
  disallowedTools,
  disableLocalSettings,
  forceNoAutoBashSandbox,
  maxTurns,
  timeoutMs,
  appendSystemPrompt,
}) {
  await ensureFreshToken();
  const query = await getQuery();
  const wsTools = await getWorkspaceToolsServer();
  const abortController = new AbortController();
  const timeout = timeoutMs || DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => {
    console.warn(`[claude-runner] Timeout reached (${timeout / 1000}s) — aborting stream`);
    abortController.abort();
  }, timeout);

  const options = buildOptions({
    cwd,
    resume,
    model,
    allowedTools,
    tools,
    disallowedTools,
    disableLocalSettings,
    forceNoAutoBashSandbox,
    maxTurns,
    appendSystemPrompt,
    abortController,
    mcpServers: { 'workspace-tools': wsTools },
  });

  console.log(`[claude-runner] Starting stream in ${cwd}${resume ? ` (resume: ${resume.slice(0, 8)}…)` : ''}`);
  const conversation = query({ prompt, options });

  function cleanup() {
    clearTimeout(timer);
    try { conversation.close(); } catch (_) {}
  }

  return { conversation, abortController, cleanup };
}

module.exports = {
  runClaude,
  runClaudeStream,
  buildOptions,
  DEFAULT_RESTRICTED_TOOLS,
};
