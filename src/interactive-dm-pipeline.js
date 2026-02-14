// interactive-dm-pipeline.js — multi-turn Claude in DMs for admin only
// Invoked when no route matches and the DM is from config.adminUserId.

const path = require('path');
const os = require('os');
const config = require('../config.json');
const { getSession, setSession, setModel, clearSession } = require('./session-store');
const {
  getOrCreateSession,
  clearLiveSession,
  sendSessionMessage,
} = require('./claude-runner');
const { sendDM, addReaction, removeReaction } = require('./zulip-client');

function resolveCwd(cwd) {
  if (!cwd) return process.cwd();
  const expanded = cwd.startsWith('~') ? path.join(os.homedir(), cwd.slice(1).replace(/^\//, '')) : cwd;
  return path.resolve(expanded);
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_TURNS = 200;
const DEFAULT_MODEL = 'haiku';
const ZULIP_MAX_MESSAGE_LENGTH = 10000;

let inFlight = false;

function isResetCommand(content) {
  const t = content.trim().toLowerCase();
  return t === '/reset' || t === 'reset conversation';
}

const SWITCH_RE = /^\s*switch\s+(?:to\s+)?(haiku|sonnet|opus)\s*$/i;
const SWITCH_PREFIX_RE = /^\s*switch\s+(?:to\s+)?(haiku|sonnet|opus)\s*[.:]?\s*/i;

/** If the message mentions "opus" or "sonnet" (as a word), use that model; otherwise default to haiku. */
function modelForMessage(content) {
  const lower = content.toLowerCase();
  if (/\bopus\b/.test(lower)) return 'opus';
  if (/\bsonnet\b/.test(lower)) return 'sonnet';
  return DEFAULT_MODEL;
}

/**
 * Detect "switch (to)? haiku|sonnet|opus" at start or as whole message.
 * Returns { model, prompt, isOnlySwitch }. If isOnlySwitch, prompt is ''.
 */
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

async function interactiveDmPipeline(route, message) {
  const adminId = message.sender_id;

  if (isResetCommand(message.content)) {
    clearSession();
    clearLiveSession();
    await sendDM(adminId, 'Conversation reset. Send a message to start a new session.');
    return;
  }

  const { model: switchModel, prompt: switchPrompt, isOnlySwitch } = parseSwitchAndPrompt(message.content);
  if (switchModel && (isOnlySwitch || !switchPrompt.trim())) {
    setModel(switchModel);
    const label = switchModel.charAt(0).toUpperCase() + switchModel.slice(1);
    await sendDM(adminId, `Switched to ${label}. Next messages will use ${label} until you change.`);
    return;
  }

  if (inFlight) {
    await sendDM(adminId, 'Please wait for my previous reply to finish.');
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
  const stored = getSession();
  const model = route.model ?? switchModel ?? stored?.model ?? modelForMessage(message.content);
  const promptToSend = switchModel != null && switchPrompt !== '' ? switchPrompt : message.content;
  if (switchModel) setModel(switchModel);

  try {
    const { session } = await getOrCreateSession({
      cwd,
      model,
      maxTurns: route.maxTurns || DEFAULT_MAX_TURNS,
      storedSessionId: stored ? stored.sessionId : undefined,
    });

    const { replyText: finalReply, result } = await sendSessionMessage(session, promptToSend, {
      timeoutMs,
      setSession: (sessionId) => setSession(sessionId, model),
    });
    if (finalReply) {
      const prefix = modelToPrefix(model);
      const withPrefix = prefix + finalReply;
      const toSend = withPrefix.length > ZULIP_MAX_MESSAGE_LENGTH
        ? withPrefix.slice(0, ZULIP_MAX_MESSAGE_LENGTH - 50) + '\n\n… (truncated)'
        : withPrefix;
      await sendDM(adminId, toSend);
    }
    if (result?.total_cost_usd != null) {
      console.log(`[interactive-dm] Cost: $${result.total_cost_usd.toFixed(4)}, turns: ${result.num_turns ?? '?'}`);
    }
  } catch (err) {
    console.error(`[interactive-dm] Error: ${err.message}`);
    clearSession();
    if (err.name === 'AbortError') {
      await sendDM(adminId, 'Request timed out. You can send another message to continue.');
    } else {
      await sendDM(adminId, `Something went wrong: ${err.message}. Send another message to try again or /reset to start fresh.`);
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
