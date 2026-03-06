const config = require('./config');
const { getClient, sendMessage } = require('./zulip-client');
const { routeMessage, hasPendingAction, hasActiveSession } = require('./router');
const { ensureFreshToken, setReauthNotifier, attemptReauth } = require('./auth-refresh');
const { getAllPendingMerges } = require('./pending-merges');
const { verifyDcsToken } = require('./repo-verify');

let myUserId = null;

async function registerQueue(client) {
  const res = await client.queues.register({
    event_types: ['message'],
  });
  return { queueId: res.queue_id, lastEventId: res.last_event_id };
}

async function pollEvents(client, queueId, lastEventId) {
  const res = await client.events.retrieve({
    queue_id: queueId,
    last_event_id: lastEventId,
    dont_block: false,
  });
  return res.events || [];
}

async function handleEvents(events) {
  for (const event of events) {
    console.log(`[bot] EVENT: ${event.type}`);
    if (event.type !== 'message') continue;

    const msg = event.message;

    // Skip messages sent by ourselves to avoid echo loops
    if (msg.sender_id === myUserId) continue;

    const flags = event.flags || [];

    if (msg.type === 'stream') {
      // Filter to watched channel (respond to all topics within it)
      if (msg.display_recipient !== config.channel) continue;
      // Require @-mention unless we're waiting for a yes/no confirmation or have an active session
      if (!flags.includes('mentioned')
        && !hasPendingAction(msg.display_recipient, msg.subject)
        && !hasActiveSession(msg.display_recipient, msg.subject, msg.sender_id)) continue;
      console.log(`[bot] Stream message in "${msg.display_recipient}" > "${msg.subject}" from ${msg.sender_full_name}: ${msg.content}`);
    } else if (msg.type === 'private') {
      if (!config.watchDMs) continue;
      console.log(`[bot] DM from ${msg.sender_full_name}`);

      // Handle "reauth" DM command from admin
      if (msg.sender_id === config.adminUserId) {
        const trimmed = msg.content.replace(/^@\*\*[^*]+\*\*\s*/, '').trim().toLowerCase();
        if (trimmed === 'reauth' || trimmed === 'retry auth') {
          console.log('[bot] Admin requested reauth via DM');
          await sendMessage(null, null, 'Starting re-authentication...');
          sendDM(msg.sender_id, 'Starting re-authentication...').catch(() => {});
          attemptReauth().then(ok => {
            sendDM(msg.sender_id, ok
              ? 'Re-authentication successful. Token refreshed.'
              : 'Re-authentication failed. Try `claude auth login` inside the container.'
            ).catch(() => {});
          });
          continue;
        }
      }
    }

    await routeMessage(msg);
  }
}

async function pollLoop(client, queueId, lastEventId) {
  let currentLastId = lastEventId;

  while (true) {
    try {
      const events = await pollEvents(client, queueId, currentLastId);
      if (events.length > 0) {
        currentLastId = events[events.length - 1].id;
        await handleEvents(events);
      }
    } catch (err) {
      if (err.message && err.message.includes('BAD_EVENT_QUEUE_ID')) {
        console.log('[bot] Event queue expired, re-registering...');
        return null; // Signal to re-register
      }
      console.error(`[bot] Poll error: ${err.message}`);
      // Brief pause before retrying on transient errors
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

async function main() {
  const client = await getClient();

  // Get our own user ID to filter self-messages
  const profile = await client.users.me.getProfile();
  myUserId = profile.user_id;
  console.log(`[bot] Authenticated as ${profile.email} (id: ${myUserId})`);

  // Register a single unfiltered event queue
  // (Zulip bot accounts don't support narrow filters on event queues)
  const queue = await registerQueue(client);
  console.log(`[bot] Registered event queue`);

  console.log(`[bot] Watching channel: "${config.channel}" (all topics)`);
  if (config.watchDMs) console.log('[bot] Watching DMs');

  // Register reauth notifier — sends OAuth URL to admin via Zulip DM
  if (config.adminUserId) {
    setReauthNotifier(async (url) => {
      console.log(`[bot] Sending reauth URL to admin via DM`);
      await sendDM(config.adminUserId,
        `Claude auth expired. Please approve in browser:\n${url}\n\nThe bot will resume automatically once approved.`
      );
    });
  }

  // Proactive token refresh every 6 hours (tokens last 8h, refresh at 30min margin)
  const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
  ensureFreshToken().then(ok => {
    console.log(`[bot] Initial token check: ${ok ? 'OK' : 'FAILED — run claude login in container'}`);
  });
  verifyDcsToken().then(res => {
    console.log(`[bot] DCS token check: ${res.details}`);
  });
  setInterval(() => {
    ensureFreshToken().then(ok => {
      if (!ok) console.error('[bot] Scheduled token refresh FAILED');
    }).catch(err => {
      console.error(`[bot] Scheduled token refresh error: ${err.message}`);
    });
  }, REFRESH_INTERVAL_MS);

  console.log('[bot] Listening for messages...');

  // Send reminders for any pending merges that survived a restart
  try {
    const pendingMerges = getAllPendingMerges();
    if (pendingMerges.length > 0) {
      console.log(`[bot] Found ${pendingMerges.length} pending merge(s) from previous session`);
      for (const pm of pendingMerges) {
        const msg = pm.originalMessage;
        if (msg && msg.type === 'stream' && msg.display_recipient && msg.subject) {
          const rangeLabel = pm.startChapter === pm.endChapter
            ? `${pm.book} ${pm.startChapter}`
            : `${pm.book} ${pm.startChapter}\u2013${pm.endChapter}`;
          const typeLabel = pm.pipelineType === 'generate' ? 'ULT/UST content' : 'translation notes';
          await sendMessage(msg.display_recipient, msg.subject,
            `Reminder: I have ${typeLabel} for **${rangeLabel}** ready to push, ` +
            `but your branches need merging first. Say **merged** when done, or **cancel** to discard.`
          );
        }
      }
    }
  } catch (err) {
    console.error(`[bot] Failed to send pending merge reminders: ${err.message}`);
  }

  // If the loop exits (queue expired), restart everything
  while (true) {
    const result = await pollLoop(client, queue.queueId, queue.lastEventId);
    if (result === null) {
      console.log('[bot] Restarting event loop...');
      return main(); // Re-register queue
    }
  }
}

process.on('unhandledRejection', (reason) => {
  console.error('[bot] Unhandled promise rejection:', reason);
});

main().catch((err) => {
  console.error(`[bot] Fatal error: ${err.message}`);
  process.exit(1);
});
