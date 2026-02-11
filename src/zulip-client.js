require('dotenv').config();
const zulip = require('zulip-js');

let client = null;

async function getClient() {
  if (client) return client;

  const config = {
    username: process.env.ZULIP_EMAIL,
    apiKey: process.env.ZULIP_API_KEY,
    realm: process.env.ZULIP_REALM,
  };

  client = await zulip(config);
  return client;
}

async function sendMessage(stream, topic, content) {
  const z = await getClient();
  return z.messages.send({
    type: 'stream',
    to: stream,
    topic,
    content,
  });
}

async function sendDM(userId, content) {
  const z = await getClient();
  return z.messages.send({
    type: 'direct',
    to: [userId],
    content,
  });
}

async function getStreamId(streamName) {
  const z = await getClient();
  const res = await z.streams.getStreamId(streamName);
  return res.stream_id;
}

module.exports = { getClient, sendMessage, sendDM, getStreamId };
