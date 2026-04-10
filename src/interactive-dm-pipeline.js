// interactive-dm-pipeline.js — multi-turn Claude for authorized users
// Uses query() API with resume for multi-turn (loads skills, CLAUDE.md, project settings).

const path = require('path');
const os = require('os');
const config = require('./config');
const { getSession, setSession, setModel, clearSession, incrementExchanges } = require('./session-store');
const { buildOptions, DEFAULT_RESTRICTED_TOOLS, createFreshWorkspaceToolsServer } = require('./claude-runner');
const { ensureFreshToken } = require('./auth-refresh');
const { sendDM, sendMessage, addReaction, removeReaction } = require('./zulip-client');
const { recordMetrics } = require('./usage-tracker');

let _query = null;
async function getQuery() {
  if (!_query) {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    _query = sdk.query;
  }
  return _query;
}

function resolveCwd(cwd) {
  if (!cwd) return process.cwd();
  const expanded = cwd.startsWith('~') ? path.join(os.homedir(), cwd.slice(1).replace(/^\//, '')) : cwd;
  return path.resolve(expanded);
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_TURNS = 200;
const DEFAULT_MODEL = 'opus';
const ZULIP_MAX_MESSAGE_LENGTH = 10000;
const TRANSIENT_RETRY_WINDOW_MS = 10 * 60 * 1000;
const RETRY_BASE_DELAY_MS = 5000;
const RETRY_MAX_DELAY_MS = 60000;

// Global lock to prevent overlapping Claude processes
let inFlight = false;

function isResetCommand(content) {
  const t = content.trim().toLowerCase().replace(/^@\*\*[^*]+\*\*\s*/, '');
  return t === '/reset' || t === 'reset conversation';
}

const SWITCH_RE = /^\s*(?:@\*\*[^*]+\*\*\s*)?switch\s+(?:to\s+)?(haiku|sonnet|opus)\s*$/i;
const SWITCH_PREFIX_RE = /^\s*(?:@\*\*[^*]+\*\*\s*)?switch\s+(?:to\s+)?(haiku|sonnet|opus)\s*[.:]?\s*/i;

function modelForMessage(content) {
  const lower = content.toLowerCase();
  if (/\bopus\b/.test(lower)) return 'opus';
  if (/\bsonnet\b/.test(lower)) return 'sonnet';
  return DEFAULT_MODEL;
}

function parseSwitchAndPrompt(content) {
  const trimmed = content.trim();
  const onlySwitch = SWITCH_RE.exec(trimmed);
  if (onlySwitch) {
    return { model: onlySwitch[1].toLowerCase(), prompt: '', isOnlySwitch: true };
  }
  const prefixMatch = trimmed.match(SWITCH_PREFIX_RE);
  if (prefixMatch) {
    const model = prefixMatch[1].toLowerCase();
    const prompt = trimmed.replace(SWITCH_PREFIX_RE, '').trim();
    return { model, prompt, isOnlySwitch: false };
  }
  return { model: null, prompt: content, isOnlySwitch: false };
}

function modelToPrefix(model) {
  const m = (model || '').toLowerCase();
  if (m === 'opus') return 'O: ';
  if (m === 'sonnet') return 'S: ';
  return 'H: ';
}

function isUsageLimitError(text) {
  return /hit your limit|usage limit|rate limit|too many requests|429/i.test(String(text || ''));
}

function isTransientDowntimeError(text) {
  const t = String(text || '').toLowerCase();
  if (!t || isUsageLimitError(t)) return false;
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

function backoffDelayMs(attempt) {
  const exp = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * Math.pow(2, Math.max(0, attempt - 1)));
  const jitter = Math.floor(Math.random() * 2000);
  return exp + jitter;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chicagoIsoFromUtcDate(date) {
  const wall = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const byType = Object.fromEntries(wall.map((p) => [p.type, p.value]));
  const tzName = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    timeZoneName: 'shortOffset',
  }).formatToParts(date).find((p) => p.type === 'timeZoneName')?.value || 'GMT-6';
  const offsetMatch = tzName.match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/);
  let offset = '-06:00';
  if (offsetMatch) {
    const sign = offsetMatch[1];
    const hh = String(offsetMatch[2]).padStart(2, '0');
    const mm = String(offsetMatch[3] || '00').padStart(2, '0');
    offset = `${sign}${hh}:${mm}`;
  }
  return `${byType.year}-${byType.month}-${byType.day}T${byType.hour}:${byType.minute}:${byType.second}${offset}`;
}

function buildUsageLimitResetTag(errorText) {
  const m = String(errorText || '').match(/resets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(UTC\)/i);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = parseInt(m[2] || '0', 10);
  const ampm = m[3].toLowerCase();
  if (ampm === 'pm' && hour !== 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;
  const now = new Date();
  const resetUtc = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    hour,
    minute,
    0,
  ));
  if (resetUtc.getTime() <= now.getTime()) resetUtc.setUTCDate(resetUtc.getUTCDate() + 1);
  return `<time:${chicagoIsoFromUtcDate(resetUtc)}>`;
}

/**
 * Run one query() call, collecting reply text and session ID.
 */
async function runInteractiveQuery({ prompt, cwd, resume, model, maxTurns, timeoutMs, appendSystemPrompt }) {
  const startedAt = Date.now();
  let attempt = 0;

  while (true) {
    attempt++;
    await ensureFreshToken();
    const queryFn = await getQuery();
    const wsTools = await createFreshWorkspaceToolsServer();
    const abortController = new AbortController();
    const timeout = timeoutMs || DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => {
      console.warn(`[interactive] Timeout (${timeout / 1000}s) — aborting`);
      abortController.abort();
    }, timeout);

    const options = buildOptions({
      cwd,
      resume,
      model,
      maxTurns,
      abortController,
      appendSystemPrompt,
      tools: DEFAULT_RESTRICTED_TOOLS,
      disallowedTools: ['Bash'],
      disableLocalSettings: true,
      forceNoAutoBashSandbox: true,
      mcpServers: { 'workspace-tools': wsTools },
    });

    console.log(`[interactive] query() cwd=${cwd} model=${model}${resume ? ` resume=${resume.slice(0, 8)}…` : ''}`);
    const conversation = queryFn({ prompt, options });

    let replyText = '';
    let result = null;
    let sessionId = null;

    try {
      for await (const event of conversation) {
        if (abortController.signal.aborted) break;
        if (event.session_id && !sessionId) {
          sessionId = event.session_id;
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
      if (!result || result.subtype !== 'success') {
        const errText = result?.error || result?.result || `Claude returned subtype "${result?.subtype || 'unknown'}"`;
        const e = new Error(errText);
        e.name = 'ClaudeRunError';
        throw e;
      }
      return { replyText: replyText.trim(), result, sessionId };
    } catch (err) {
      const errText = err?.message || String(err);
      const elapsed = Date.now() - startedAt;
      if (isTransientDowntimeError(errText) && elapsed < TRANSIENT_RETRY_WINDOW_MS) {
        const delay = backoffDelayMs(attempt);
        console.warn(`[interactive] Transient SDK error, retrying in ${Math.round(delay / 1000)}s (attempt ${attempt}): ${errText.slice(0, 200)}`);
        await sleep(delay);
        continue;
      }
      if (isTransientDowntimeError(errText) && elapsed >= TRANSIENT_RETRY_WINDOW_MS) {
        const outageErr = new Error('Claude is temporarily down after retry attempts');
        outageErr.name = 'ClaudeTransientOutageError';
        throw outageErr;
      }
      throw err;
    } finally {
      clearTimeout(timer);
      try { conversation.close(); } catch (_) {}
    }
  }
}

async function interactiveDmPipeline(route, message) {
  const isStream = message.type === 'stream';
  const sessionKey = isStream 
    ? `stream-${message.display_recipient}-${message.subject}`
    : `dm-${message.sender_id}`;

  const reply = async (text) => {
    try {
      if (isStream) {
        await sendMessage(message.display_recipient, message.subject, text);
      } else {
        await sendDM(message.sender_id, text);
      }
    } catch (err) {
      console.error(`[interactive] Failed to send reply: ${err.message}`);
    }
  };

  if (isResetCommand(message.content)) {
    clearSession(sessionKey);
    await reply('Conversation reset. Send a message to start a new session.');
    return;
  }

  const { model: switchModel, prompt: switchPrompt, isOnlySwitch } = parseSwitchAndPrompt(message.content);
  if (switchModel && (isOnlySwitch || !switchPrompt.trim())) {
    setModel(sessionKey, switchModel);
    const label = switchModel.charAt(0).toUpperCase() + switchModel.slice(1);
    await reply(`Switched to ${label}. Next messages will use ${label} until you change.`);
    return;
  }

  if (inFlight) {
    await reply('Please wait for my previous reply to finish.');
    return;
  }

  inFlight = true;
  const msgId = message.id;
  let reactionAdded = false;

  try {
    await addReaction(msgId, 'working_on_it');
    reactionAdded = true;
  } catch (_) {}

  const cwd = resolveCwd(route.cwd);
  const timeoutMs = route.timeoutMs || DEFAULT_TIMEOUT_MS;
  const stored = getSession(sessionKey);
  const model = route.model ?? switchModel ?? stored?.model ?? modelForMessage(message.content);
  
  // Strip @mention for the prompt
  const cleanMessage = message.content.replace(/^@\*\*[^*]+\*\*\s*/, '').trim();
  
  // If this is the start of an editor review, we can prefix the prompt with a command if needed
  let promptToSend = switchModel != null && switchPrompt !== '' ? switchPrompt : cleanMessage;

  // Inject sender name context so Claude addresses the right person and skips @-mentions
  if (isStream && message.sender_full_name) {
    const senderContext = `[Replying to: ${message.sender_full_name}. Do not generate @-mentions.]\n\n`;
    promptToSend = senderContext + promptToSend;
  }

  if (switchModel) setModel(sessionKey, switchModel);

  try {
    const { replyText: finalReply, result, sessionId } = await runInteractiveQuery({
      prompt: promptToSend,
      cwd,
      resume: stored?.sessionId,
      model,
      maxTurns: route.maxTurns || DEFAULT_MAX_TURNS,
      timeoutMs,
      appendSystemPrompt: route.systemPrompt,
    });

    // Record metrics for interactive queries
    if (result) {
      recordMetrics({
        pipeline: 'interactive', skill: route.name || 'interactive-dm',
        book: null, chapter: null, result, success: result?.subtype === 'success',
        userId: message.sender_id,
      });
    }

    if (sessionId) {
      setSession(sessionKey, sessionId, model, {
        startedBy: message.sender_id,
        maxExchanges: route.maxExchanges,
      });
    }

    if (finalReply) {
      // Strip any @-mentions Claude may have generated (wrong name problem)
      const cleanReply = finalReply.replace(/^@\*\*[^*]+\*\*\s*/, '');
      const prefix = modelToPrefix(model);
      const withPrefix = prefix + cleanReply;
      let toSend = withPrefix.length > ZULIP_MAX_MESSAGE_LENGTH
        ? withPrefix.slice(0, ZULIP_MAX_MESSAGE_LENGTH - 50) + '\n\n... (truncated)'
        : withPrefix;

      // For stream sessions, track exchanges and auto-clear at limit
      if (isStream) {
        const count = incrementExchanges(sessionKey);
        const currentSession = getSession(sessionKey);
        const MAX_STREAM_EXCHANGES = currentSession?.maxExchanges || 3;
        if (count >= MAX_STREAM_EXCHANGES) {
          clearSession(sessionKey);
          toSend += '\n\n*(Session limit reached — start a new request to continue.)*';
          console.log(`[interactive] Stream session ${sessionKey} cleared after ${count} exchanges`);
        }
      }

      // When replying to a stream, mention the original sender
      const finalMsg = isStream ? `@**${message.sender_full_name}** ${toSend}` : toSend;
      await reply(finalMsg);
    } else {
      console.warn(`[interactive] Empty reply (model: ${model}, turns: ${result?.num_turns ?? '?'})`);
      await reply(`${modelToPrefix(model)}(No response — Claude returned empty. Try /reset to start a fresh session.)`);
    }
  } catch (err) {
    console.error(`[interactive] Error: ${err.message}`);
    clearSession(sessionKey);
    if (err.name === 'AbortError') {
      await reply('Request timed out. You can send another message to continue.');
    } else if (err.name === 'ClaudeTransientOutageError') {
      await reply('Claude is temporarily down, you\'ll need to re-trigger.');
    } else if (isUsageLimitError(err.message || '')) {
      const resetTag = buildUsageLimitResetTag(err.message || '');
      const when = resetTag ? ` around ${resetTag}` : ' after the limit resets';
      await reply(`I hit our Claude usage limit for this request. Please try again${when}.`);
    } else {
      await reply(`Something went wrong: ${err.message}. Send another message to try again or /reset to start fresh.`);
    }
  } finally {
    if (reactionAdded) {
      try {
        await removeReaction(msgId, 'working_on_it');
      } catch (_) {}
    }
    inFlight = false;
  }
}

module.exports = { interactiveDmPipeline };
