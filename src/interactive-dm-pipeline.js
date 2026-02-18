// interactive-dm-pipeline.js — multi-turn Claude for authorized users
// Uses query() API with resume for multi-turn (loads skills, CLAUDE.md, project settings).

const path = require('path');
const os = require('os');
const config = require('./config');
const { getSession, setSession, setModel, clearSession, incrementExchanges } = require('./session-store');
const { buildOptions } = require('./claude-runner');
const { ensureFreshToken } = require('./auth-refresh');
const { sendDM, sendMessage, addReaction, removeReaction } = require('./zulip-client');

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

/**
 * Run one query() call, collecting reply text and session ID.
 */
async function runInteractiveQuery({ prompt, cwd, resume, model, maxTurns, timeoutMs, appendSystemPrompt }) {
  await ensureFreshToken();
  const queryFn = await getQuery();
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
  } finally {
    clearTimeout(timer);
    try { conversation.close(); } catch (_) {}
  }

  return { replyText: replyText.trim(), result, sessionId };
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

    if (sessionId) {
      if (route.singleShot) {
        clearSession(sessionKey);
        console.log(`[interactive] Single-shot route "${route.name}" — session cleared after completion`);
      } else {
        setSession(sessionKey, sessionId, model);
      }
    }

    if (finalReply) {
      const prefix = modelToPrefix(model);
      const withPrefix = prefix + finalReply;
      let toSend = withPrefix.length > ZULIP_MAX_MESSAGE_LENGTH
        ? withPrefix.slice(0, ZULIP_MAX_MESSAGE_LENGTH - 50) + '\n\n… (truncated)'
        : withPrefix;

      // For stream sessions, track exchanges and auto-clear at limit
      if (isStream) {
        const count = incrementExchanges(sessionKey);
        const MAX_STREAM_EXCHANGES = 3;
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
