// claude-runner.js — SDK wrapper for Claude Agent SDK query()
// Replaces `claude -p` subprocess calls with programmatic SDK usage

const { ensureFreshToken } = require('./auth-refresh');
const { recordRateLimit, getHeadroom } = require('./usage-tracker');
const { createWorkspaceTools } = require('./workspace-tools');
const config = require('./config');
const { sendDM } = require('./zulip-client');

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

const TRANSIENT_RETRY_WINDOW_MS = 10 * 60 * 1000;
const RETRY_BASE_DELAY_MS = 5000;
const RETRY_MAX_DELAY_MS = 60000;

class ClaudeTransientOutageError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ClaudeTransientOutageError';
    this.details = details;
  }
}

function buildOptions({
  cwd,
  resume,
  model,
  betas,
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
    permissionMode: 'auto',
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
  if (betas) {
    options.betas = betas;
  }
  if (appendSystemPrompt) {
    options.systemPrompt = appendSystemPrompt;
  }
  return options;
}

async function runClaudeOnce({
  prompt,
  cwd,
  model,
  betas,
  allowedTools,
  tools,
  disallowedTools,
  disableLocalSettings,
  forceNoAutoBashSandbox,
  skill,
  maxTurns,
  timeoutMs,
  appendSystemPrompt,
  onProgress,
  guardrails,
}) {
  await ensureFreshToken();
  const query = await getQuery();
  const wsTools = await getWorkspaceToolsServer();

  const fullPrompt = skill ? `/${skill} ${prompt}` : prompt;

  const abortController = new AbortController();
  const timeout = timeoutMs || DEFAULT_TIMEOUT_MS;
  let turnCount = 0;
  let lastTool = null;
  const queryStart = Date.now();
  const toolErrorSigs = new Map();
  let consecutiveToolErrors = 0;

  const timer = setTimeout(() => {
    const elapsed = Math.round((Date.now() - queryStart) / 1000);
    console.warn(`[claude-runner] Timeout reached after ${elapsed}s — ${turnCount} tool calls, last tool: ${lastTool || 'none'} — aborting query`);
    if (onProgress) {
      try {
        const p = onProgress({ turnCount, lastTool, elapsedMs: Date.now() - queryStart, timedOut: true });
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch (_) {}
    }
    abortController.abort();
  }, timeout);

  const HEARTBEAT_MS = 10 * 60 * 1000;
  const heartbeatTimer = onProgress ? setInterval(() => {
    try {
      const p = onProgress({ turnCount, lastTool, elapsedMs: Date.now() - queryStart, timedOut: false });
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (_) {}
  }, HEARTBEAT_MS) : null;

  const options = buildOptions({
    cwd,
    model,
    betas,
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
            turnCount++;
            lastTool = block.name;
            console.log(`[claude] Tool: ${block.name}(${JSON.stringify(block.input || {}).slice(0, 150)})`);
          }
        }
      } else if (message.type === 'result') {
        result = message;
      } else if (message.type === 'user') {
        const text = typeof message.message?.content === 'string'
          ? message.message.content
          : JSON.stringify(message.message?.content || '');
        const lower = text.toLowerCase();
        const isToolError = lower.includes('tool_use_error');
        if (isToolError) {
          const sig = lower.includes('string to replace not found')
            ? 'string_not_found'
            : lower.includes('no changes to make')
              ? 'no_op_edit'
              : lower.includes('file has been modified since read')
                ? 'stale_edit'
                : 'other_tool_error';
          consecutiveToolErrors += 1;
          toolErrorSigs.set(sig, (toolErrorSigs.get(sig) || 0) + 1);
          if (guardrails) {
            const maxConsecutive = Number(guardrails.maxConsecutiveToolErrors || 0);
            const maxSigRepeats = Number(guardrails.maxRepeatedToolErrorSignature || 0);
            const sigRepeats = Number(toolErrorSigs.get(sig) || 0);
            const stopForConsecutive = maxConsecutive > 0 && consecutiveToolErrors >= maxConsecutive;
            const stopForRepeats = maxSigRepeats > 0 && sigRepeats >= maxSigRepeats && sig !== 'other_tool_error';
            if (stopForConsecutive || stopForRepeats) {
              throw new Error(
                `Guardrail stop: repeated tool errors (${sig}, consecutive=${consecutiveToolErrors}, repeats=${sigRepeats})`
              );
            }
          }
        } else if (lower.includes('tool_result')) {
          // Only reset on non-error tool results to avoid false positives during
          // legitimate read/validation sequences.
          consecutiveToolErrors = 0;
        }
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
      if (guardrails && Number(guardrails.maxToolCalls || 0) > 0 && turnCount >= Number(guardrails.maxToolCalls)) {
        throw new Error(`Guardrail stop: max tool calls exceeded (${turnCount}/${guardrails.maxToolCalls})`);
      }
    }
  } catch (err) {
    if (err.name === 'AbortError' || abortController.signal.aborted) {
      const elapsed = Math.round((Date.now() - queryStart) / 1000);
      console.warn(`[claude-runner] Query aborted after ${elapsed}s — ${turnCount} tool calls, last tool: ${lastTool || 'none'}`);
    } else {
      // Detect rate limit errors and calibrate the window budget
      const msg = (err.message || '').toLowerCase();
      const isRateLimit = msg.includes('rate limit') || msg.includes('429') || msg.includes('too many requests');
      if (isRateLimit) {
        console.warn(`[claude-runner] Rate limit detected -- calibrating window budget`);
        try {
          const room = await getHeadroom();
          recordRateLimit({ windowUsed: room.used, source: 'claude-runner-error' });
        } catch { /* non-fatal */ }
      }
      throw err;
    }
  } finally {
    clearTimeout(timer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
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
        const room = await getHeadroom();
        recordRateLimit({ windowUsed: room.used, source: 'claude-runner-result' });
      } catch { /* non-fatal */ }
    }
  } else {
    console.warn(`[claude-runner] Query ended without a result message (timeout or abort)`);
  }

  return result;
}

function isUsageCapMessage(text) {
  return /hit your limit|resets?\s+\d{1,2}(?::\d{2})?\s*(am|pm)\s*\(utc\)/i.test(String(text || ''));
}

function isTransientSdkMessage(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return false;
  if (isUsageCapMessage(t)) return false;
  return (
    t.includes('internal server error') ||
    t.includes('api error: 500') ||
    t.includes('api_error') ||
    t.includes('http 500') ||
    t.includes('http 502') ||
    t.includes('http 503') ||
    t.includes('http 504') ||
    t.includes('service unavailable') ||
    t.includes('temporarily unavailable') ||
    t.includes('gateway timeout') ||
    t.includes('bad gateway') ||
    t.includes('overloaded') ||
    t.includes('connection reset') ||
    t.includes('socket hang up') ||
    t.includes('econnreset') ||
    t.includes('etimedout')
  );
}

function isTransientOutageError(err) {
  if (!err) return false;
  if (err.name === 'ClaudeTransientOutageError') return true;
  return false;
}

function backoffDelayMs(attempt) {
  const exp = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * Math.pow(2, Math.max(0, attempt - 1)));
  const jitter = Math.floor(Math.random() * 2000);
  return exp + jitter;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function notifyAdminDowntime(text) {
  try {
    if (!config.adminUserId) return;
    await sendDM(config.adminUserId, text);
  } catch (err) {
    console.warn(`[claude-runner] Failed to send downtime DM: ${err.message}`);
  }
}

async function runClaude(args) {
  const startedAt = Date.now();
  let attempt = 0;
  let lastTransientMessage = '';
  let firstDowntimeNoticeSent = false;

  while (true) {
    attempt++;
    try {
      const result = await runClaudeOnce({ ...args });
      if (args?.guardrails?.tokenBudget && result?.usage) {
        const u = result.usage || {};
        const total = (u.input_tokens ?? u.inputTokens ?? 0)
          + (u.output_tokens ?? u.outputTokens ?? 0)
          + (u.cache_read_input_tokens ?? u.cacheReadInputTokens ?? 0)
          + (u.cache_creation_input_tokens ?? u.cacheCreationInputTokens ?? 0);
        if (total > Number(args.guardrails.tokenBudget)) {
          return {
            ...result,
            subtype: 'error',
            error: `Guardrail stop: token budget exceeded (${total}/${args.guardrails.tokenBudget})`,
          };
        }
      }
      if (result?.subtype === 'success') return result;

      const resultMsg = `${result?.subtype || ''} ${result?.error || ''} ${result?.result || ''}`.trim();
      const elapsed = Date.now() - startedAt;
      if (isTransientSdkMessage(resultMsg) && elapsed < TRANSIENT_RETRY_WINDOW_MS) {
        lastTransientMessage = resultMsg;
        if (!firstDowntimeNoticeSent) {
          firstDowntimeNoticeSent = true;
          await notifyAdminDowntime(
            `[claude-runner] First transient Claude outage signal detected (attempt ${attempt}). ` +
            `Starting retry/backoff window up to 10 minutes. Last error: ${resultMsg.slice(0, 300)}`
          );
        }
        const delay = backoffDelayMs(attempt);
        console.warn(`[claude-runner] Transient non-success result, retrying in ${Math.round(delay / 1000)}s (attempt ${attempt})`);
        await sleep(delay);
        continue;
      }
      if (isTransientSdkMessage(resultMsg) && elapsed >= TRANSIENT_RETRY_WINDOW_MS) {
        await notifyAdminDowntime(
          `[claude-runner] Retry window exhausted after ${Math.round(elapsed / 1000)}s and ${attempt} attempts. ` +
          `Giving up for now. Last error: ${resultMsg.slice(0, 300)}`
        );
        throw new ClaudeTransientOutageError(
          'Claude is temporarily down after retry attempts',
          { elapsedMs: elapsed, attempts: attempt, lastMessage: resultMsg.slice(0, 500) || lastTransientMessage.slice(0, 500) }
        );
      }

      return result;
    } catch (err) {
      const msg = err?.message || String(err);
      const elapsed = Date.now() - startedAt;
      if (isTransientSdkMessage(msg) && elapsed < TRANSIENT_RETRY_WINDOW_MS) {
        lastTransientMessage = msg;
        if (!firstDowntimeNoticeSent) {
          firstDowntimeNoticeSent = true;
          await notifyAdminDowntime(
            `[claude-runner] First transient Claude outage signal detected (attempt ${attempt}). ` +
            `Starting retry/backoff window up to 10 minutes. Last error: ${msg.slice(0, 300)}`
          );
        }
        const delay = backoffDelayMs(attempt);
        console.warn(`[claude-runner] Transient SDK error, retrying in ${Math.round(delay / 1000)}s (attempt ${attempt}): ${msg.slice(0, 200)}`);
        await sleep(delay);
        continue;
      }
      if (isTransientSdkMessage(msg) && elapsed >= TRANSIENT_RETRY_WINDOW_MS) {
        await notifyAdminDowntime(
          `[claude-runner] Retry window exhausted after ${Math.round(elapsed / 1000)}s and ${attempt} attempts. ` +
          `Giving up for now. Last error: ${msg.slice(0, 300)}`
        );
        throw new ClaudeTransientOutageError(
          'Claude is temporarily down after retry attempts',
          { elapsedMs: elapsed, attempts: attempt, lastMessage: msg.slice(0, 500) || lastTransientMessage.slice(0, 500) }
        );
      }
      throw err;
    }
  }
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
  betas,
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
    betas,
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
  getWorkspaceToolsServer,
  DEFAULT_RESTRICTED_TOOLS,
  ClaudeTransientOutageError,
  isTransientOutageError,
};
