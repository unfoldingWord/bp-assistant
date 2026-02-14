// claude-runner.js — SDK wrapper for Claude Agent SDK query()
// Replaces `claude -p` subprocess calls with programmatic SDK usage

let _query = null;

async function getQuery() {
  if (!_query) {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    _query = sdk.query;
  }
  return _query;
}

// Default: 10 minutes per invocation, 200 turns max
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_TURNS = 200;

const DEFAULT_ALLOWED_TOOLS = [
  'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash',
  'Task', 'Skill', 'SendMessage',
];

function buildOptions({
  cwd,
  resume,
  model,
  allowedTools,
  maxTurns,
  timeoutMs,
  appendSystemPrompt,
  abortController,
}) {
  const options = {
    cwd: cwd || process.cwd(),
    abortController: abortController || new AbortController(),
    maxTurns: maxTurns || DEFAULT_MAX_TURNS,
    allowedTools: allowedTools || DEFAULT_ALLOWED_TOOLS,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    settingSources: ['user', 'project', 'local'],
    persistSession: true,
  };
  if (resume) {
    options.resume = resume;
  }
  options.model = model || 'haiku';
  if (appendSystemPrompt) {
    options.systemPrompt = appendSystemPrompt;
  }
  return options;
}

async function runClaude({ prompt, cwd, model, allowedTools, skill, maxTurns, timeoutMs, appendSystemPrompt }) {
  const query = await getQuery();

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
    maxTurns,
    appendSystemPrompt,
    abortController,
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
            console.log(`[claude] Tool: ${block.name}`);
          }
        }
      } else if (message.type === 'result') {
        result = message;
      }
    }
  } catch (err) {
    if (err.name === 'AbortError' || abortController.signal.aborted) {
      console.warn(`[claude-runner] Query aborted (timeout or manual abort)`);
    } else {
      throw err;
    }
  } finally {
    clearTimeout(timer);
    try { conversation.close(); } catch (_) {}
  }

  if (result) {
    console.log(`[claude-runner] Finished — subtype: ${result.subtype}, turns: ${result.num_turns}, cost: $${result.total_cost_usd?.toFixed(4) || '?'}, duration: ${(result.duration_ms / 1000).toFixed(1)}s`);
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
async function runClaudeStream({ prompt, cwd, resume, model, maxTurns, timeoutMs, appendSystemPrompt }) {
  const query = await getQuery();
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
    maxTurns,
    appendSystemPrompt,
    abortController,
  });

  console.log(`[claude-runner] Starting stream in ${cwd}${resume ? ` (resume: ${resume.slice(0, 8)}…)` : ''}`);
  const conversation = query({ prompt, options });

  function cleanup() {
    clearTimeout(timer);
    try { conversation.close(); } catch (_) {}
  }

  return { conversation, abortController, cleanup };
}

// --- V2 session (long-lived process): one session, send/stream per message ---
let _v2Create = null;
let _v2Resume = null;

async function getV2SessionAPI() {
  if (!_v2Create) {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    _v2Create = sdk.unstable_v2_createSession;
    _v2Resume = sdk.unstable_v2_resumeSession;
  }
  return { createSession: _v2Create, resumeSession: _v2Resume };
}

/**
 * Long-lived session for interactive DM: one Claude process, send() + stream() per message.
 * Call getOrCreateSession() then sendSessionMessage(); on process exit we clear and next message creates fresh.
 */
let _liveSession = null;
let _liveSessionModel = null;

async function getOrCreateSession({ cwd, model, maxTurns, storedSessionId }) {
  const { createSession, resumeSession } = await getV2SessionAPI();
  const effectiveModel = model || 'haiku';
  const opts = {
    model: effectiveModel,
    cwd: cwd || process.cwd(),
    allowedTools: DEFAULT_ALLOWED_TOOLS,
    permissionMode: 'acceptEdits',
  };

  if (_liveSession && _liveSessionModel === effectiveModel) {
    return { session: _liveSession, isNew: false };
  }

  if (_liveSession) {
    try { _liveSession.close(); } catch (_) {}
    _liveSession = null;
    _liveSessionModel = null;
  }

  if (storedSessionId) {
    try {
      const session = resumeSession(storedSessionId, opts);
      _liveSession = session;
      _liveSessionModel = effectiveModel;
      console.log(`[claude-runner] Resumed v2 session ${storedSessionId.slice(0, 8)}… (${effectiveModel})`);
      return { session, isNew: false };
    } catch (err) {
      console.warn(`[claude-runner] v2 resume failed: ${err.message}, creating new session`);
      _liveSession = null;
      _liveSessionModel = null;
    }
  }

  const session = createSession(opts);
  _liveSession = session;
  _liveSessionModel = effectiveModel;
  console.log(`[claude-runner] Created new v2 session (${effectiveModel})`);
  return { session, isNew: true };
}

function clearLiveSession() {
  if (_liveSession) {
    try { _liveSession.close(); } catch (_) {}
    _liveSession = null;
    _liveSessionModel = null;
  }
}

/**
 * Send one message to the long-lived session and collect reply. Uses AbortController for timeout.
 * On failure (e.g. process died), clears live session so next call creates/resumes fresh.
 */
async function sendSessionMessage(session, prompt, { timeoutMs, setSession }) {
  const abortController = new AbortController();
  const timeout = timeoutMs || DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => {
    abortController.abort();
  }, timeout);

  let replyText = '';
  let result = null;
  let streamedSessionId = null;

  try {
    await session.send(prompt);
    for await (const event of session.stream()) {
      if (abortController.signal.aborted) break;
      if (event.session_id && !streamedSessionId) {
        streamedSessionId = event.session_id;
        if (setSession) setSession(event.session_id);
      }
      if (event.type === 'assistant' && event.message?.content) {
        for (const block of event.message.content) {
          if (block && typeof block.text === 'string') replyText += block.text;
        }
      }
      if (event.type === 'result') result = event;
    }
    if (abortController.signal.aborted) {
      const e = new Error('Request timed out');
      e.name = 'AbortError';
      throw e;
    }
  } catch (err) {
    clearLiveSession();
    throw err;
  } finally {
    clearTimeout(timer);
  }

  return { replyText: replyText.trim(), result };
}

module.exports = {
  runClaude,
  runClaudeStream,
  buildOptions,
  getOrCreateSession,
  clearLiveSession,
  sendSessionMessage,
};
