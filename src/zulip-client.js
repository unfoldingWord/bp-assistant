require('dotenv').config();
// Defense-in-depth for the Node 22.23.0 http.Agent keep-alive regression that
// severs reused sockets mid-response (zulip-js -> node-fetch -> "Premature
// close"). Disable keep-alive on the global agents so each request uses a fresh
// socket; lets us safely lift the Dockerfile Node pin later.
const http = require('node:http');
const https = require('node:https');
http.globalAgent = new http.Agent({ keepAlive: false });
https.globalAgent = new https.Agent({ keepAlive: false });
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

// Stream name used by triggerPipelineFromApi as a synthetic display_recipient.
// Pipelines for API-triggered runs surface their status via publishAdminStatus
// to the existing /admin page; we suppress duplicate Zulip writes here so the
// bot doesn't spam errors trying to post to a stream that doesn't exist.
// Override via BT_API_SUPPRESS_STREAM (set to '' to disable suppression and
// route API-run status to a real Zulip stream named in BT_API_ZULIP_STREAM).
const API_SUPPRESS_STREAM = process.env.BT_API_SUPPRESS_STREAM ?? 'bp-api';

function isApiSuppressedSender(userId) {
  // Synthetic API messages set sender_id to -1; DMs back to that id would be no-ops.
  return userId === -1 || userId === '-1';
}

async function sendMessage(stream, topic, content) {
  if (API_SUPPRESS_STREAM && stream === API_SUPPRESS_STREAM) {
    console.log(`[zulip-api-suppress] ${stream}/${topic}: ${String(content).slice(0, 200)}`);
    return { result: 'success', id: -1, suppressed: true };
  }
  const z = await getClient();
  return z.messages.send({
    type: 'stream',
    to: stream,
    topic,
    content,
  });
}

async function sendDM(userId, content) {
  if (isApiSuppressedSender(userId)) {
    console.log(`[zulip-api-suppress] DM to ${userId}: ${String(content).slice(0, 200)}`);
    return { result: 'success', id: -1, suppressed: true };
  }
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
  if (messageId === -1 || messageId === '-1' || messageId == null) {
    return { result: 'success', suppressed: true };
  }
  const z = await getClient();
  return z.callEndpoint(`/messages/${messageId}/reactions`, 'POST', {
    emoji_name: emojiName,
  });
}

async function removeReaction(messageId, emojiName) {
  if (messageId === -1 || messageId === '-1' || messageId == null) {
    return { result: 'success', suppressed: true };
  }
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
