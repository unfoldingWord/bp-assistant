// interactive-dm-pipeline.js — multi-turn Claude in DMs for admin only
// Invoked when no route matches and the DM is from config.adminUserId.

const config = require('../config.json');
const { getSession, setSession, clearSession } = require('./session-store');
const { runClaudeStream } = require('./claude-runner');
const { sendDM, addReaction, removeReaction } = require('./zulip-client');

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_TURNS = 200;
const ZULIP_MAX_MESSAGE_LENGTH = 10000;

let inFlight = false;

function isResetCommand(content) {
  const t = content.trim().toLowerCase();
  return t === '/reset' || t === 'reset conversation';
}

async function interactiveDmPipeline(route, message) {
  const adminId = message.sender_id;

  if (isResetCommand(message.content)) {
    clearSession();
    await sendDM(adminId, 'Conversation reset. Send a message to start a new session.');
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

  const cwd = route.cwd || process.cwd();
  const timeoutMs = route.timeoutMs || DEFAULT_TIMEOUT_MS;
  const maxTurns = route.maxTurns || DEFAULT_MAX_TURNS;
  const stored = getSession();
  const resume = stored ? stored.sessionId : undefined;

  let replyText = '';
  let result = null;
  let streamedSessionId = null;

  try {
    const { conversation, abortController, cleanup } = await runClaudeStream({
      prompt: message.content,
      cwd,
      resume,
      maxTurns,
      timeoutMs,
      appendSystemPrompt: route.appendSystemPrompt,
    });

    try {
      for await (const event of conversation) {
        if (event.session_id && !streamedSessionId) {
          streamedSessionId = event.session_id;
          setSession(event.session_id);
        }
        if (event.type === 'assistant' && event.message?.content) {
          for (const block of event.message.content) {
            if (block && typeof block.text === 'string') {
              replyText += block.text;
            }
          }
        }
        if (event.type === 'result') {
          result = event;
        }
      }
    } catch (err) {
      if (err.name === 'AbortError' || abortController.signal.aborted) {
        replyText = replyText.trim() || 'Request timed out. You can send another message to continue.';
      } else {
        throw err;
      }
    } finally {
      cleanup();
    }

    const finalReply = replyText.trim();
    if (finalReply) {
      const toSend = finalReply.length > ZULIP_MAX_MESSAGE_LENGTH
        ? finalReply.slice(0, ZULIP_MAX_MESSAGE_LENGTH - 50) + '\n\n… (truncated)'
        : finalReply;
      await sendDM(adminId, toSend);
    }
    if (result?.total_cost_usd != null) {
      console.log(`[interactive-dm] Cost: $${result.total_cost_usd.toFixed(4)}, turns: ${result.num_turns ?? '?'}`);
    }
  } catch (err) {
    console.error(`[interactive-dm] Error: ${err.message}`);
    await sendDM(adminId, `Something went wrong: ${err.message}. You can try again or send /reset to start fresh.`);
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
