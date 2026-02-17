const config = require('../config.json');
const { getClient } = require('./zulip-client');
const { routeMessage } = require('./router');
const { ensureFreshToken } = require('./auth-refresh');

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
      // Filter to watched channel and topics, require @-mention
      if (msg.display_recipient !== config.channel) continue;
      if (!config.topics.includes(msg.subject)) continue;
      if (!flags.includes('mentioned')) continue;
      console.log(`[bot] Stream message in "${msg.display_recipient}" > "${msg.subject}" from ${msg.sender_full_name}: ${msg.content}`);
    } else if (msg.type === 'private') {
      if (!config.watchDMs) continue;
      console.log(`[bot] DM from ${msg.sender_full_name}`);
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

  console.log(`[bot] Watching channel: "${config.channel}"`);
  console.log(`[bot] Watching topics: ${config.topics.join(', ')}`);
  if (config.watchDMs) console.log('[bot] Watching DMs');

  // Proactive token refresh every 6 hours (tokens last 8h, refresh at 30min margin)
  const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
  ensureFreshToken().then(ok => {
    console.log(`[bot] Initial token check: ${ok ? 'OK' : 'FAILED — run claude login in container'}`);
  });
  setInterval(() => {
    ensureFreshToken().then(ok => {
      if (!ok) console.error('[bot] Scheduled token refresh FAILED');
    }).catch(err => {
      console.error(`[bot] Scheduled token refresh error: ${err.message}`);
    });
  }, REFRESH_INTERVAL_MS);

  console.log('[bot] Listening for messages...');

  // If the loop exits (queue expired), restart everything
  while (true) {
    const result = await pollLoop(client, queue.queueId, queue.lastEventId);
    if (result === null) {
      console.log('[bot] Restarting event loop...');
      return main(); // Re-register queue
    }
  }
}

main().catch((err) => {
  console.error(`[bot] Fatal error: ${err.message}`);
  process.exit(1);
});
