require('dotenv').config();
const zulip = require('zulip-js');
const fs = require('fs');
const { readSecret } = require('./secrets');

let client = null;

function getZulipConfig() {
  return {
    username: readSecret('zulip_email', 'ZULIP_EMAIL'),
    apiKey: readSecret('zulip_api_key', 'ZULIP_API_KEY'),
    realm: process.env.ZULIP_REALM,
  };
}

async function getClient() {
  if (client) return client;

  const config = getZulipConfig();

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

async function addReaction(messageId, emojiName) {
  const z = await getClient();
  return z.callEndpoint(`/messages/${messageId}/reactions`, 'POST', {
    emoji_name: emojiName,
  });
}

async function removeReaction(messageId, emojiName) {
  const z = await getClient();
  return z.callEndpoint(`/messages/${messageId}/reactions`, 'DELETE', {
    emoji_name: emojiName,
  });
}

function uploadFile(filePath, fileName) {
  const FormData = require('form-data');
  const cfg = getZulipConfig();
  const realm = cfg.realm;
  const auth = Buffer.from(`${cfg.username}:${cfg.apiKey}`).toString('base64');

  const form = new FormData();
  form.append('filename', fs.createReadStream(filePath), { filename: fileName });

  return new Promise((resolve, reject) => {
    form.submit({
      protocol: 'https:',
      host: new URL(realm).host,
      path: '/api/v1/user_uploads',
      headers: { Authorization: `Basic ${auth}` },
    }, (err, res) => {
      if (err) return reject(err);
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (!data.uri) {
            reject(new Error(`Upload failed: ${body}`));
          } else {
            resolve(data.uri);
          }
        } catch (e) {
          reject(new Error(`Upload response parse error: ${body}`));
        }
      });
    });
  });
}

module.exports = { getClient, sendMessage, sendDM, getStreamId, addReaction, removeReaction, uploadFile };
