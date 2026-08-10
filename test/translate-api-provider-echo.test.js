// handleStartRequest's 202/200 body must echo the validated provider back to
// the caller when the request carried one, and omit it entirely on a
// subscription run — bible-editor fails closed if it sent a provider and the
// response silently drops it (protects against an old bot that stripped the
// field). The real triggerPipelineFromApi does a "fire and forget" dispatch
// (Zulip posts, checkpoint writes, an actual pipeline run) that would be
// unsafe to exercise here, so it is monkey-patched on the shared router
// module BEFORE api/pipeline.js is required — api/pipeline.js destructures
// triggerPipelineFromApi off router.exports at require time, so the patch
// must land first.
'use strict';

process.env.BT_API_TOKEN = 'test-bt-api-token';
delete process.env.BT_API_TOKEN_FILE;
delete process.env.BOT_SECRETS_DIR;

const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

const router = require('../src/router');
const triggerCalls = [];
// api/pipeline.js destructures triggerPipelineFromApi at require time, so this
// single patch is the only seam — per-test reassignment would not be seen.
// Tests steer the outcome through the sessionKey instead.
router.triggerPipelineFromApi = (input) => {
  triggerCalls.push(input);
  const status = String(input.apiSessionKey || '').includes('want-already-running')
    ? 'already_running'
    : 'started';
  return { status, jobId: 'stub-job-1', scope: { book: input.book, startChapter: input.startChapter, endChapter: input.endChapter } };
};

const { handleStartRequest } = require('../src/api/pipeline');

const base = {
  pipelineType: 'translate',
  book: 'OBA',
  startChapter: 1,
  username: 'tester',
  sessionKey: 'bible-editor/u1/echo-test',
};
const KEY = 'sk-test-echo-abcdef0123456789';

function fakeReq(body) {
  const req = new EventEmitter();
  req.headers = { authorization: `Bearer ${process.env.BT_API_TOKEN}` };
  const raw = Buffer.from(JSON.stringify(body), 'utf8');
  process.nextTick(() => { req.emit('data', raw); req.emit('end'); });
  return req;
}

function fakeRes() {
  return {
    status: null,
    body: '',
    headersSent: false,
    setHeader() {},
    removeHeader() {},
    writeHead(status) { this.status = status; this.headersSent = true; },
    end(payload) { this.body = payload == null ? '' : String(payload); },
  };
}

async function post(body) {
  const req = fakeReq(body);
  const res = fakeRes();
  await handleStartRequest(req, res);
  return { status: res.status, raw: res.body, json: res.body ? JSON.parse(res.body) : null };
}

test('a provider run echoes the validated provider in the 202 body', async () => {
  triggerCalls.length = 0;
  const r = await post({ ...base, provider: 'claude', apiKey: KEY, options: { targetLang: 'ar' } });
  assert.strictEqual(r.status, 202);
  assert.strictEqual(r.json.provider, 'claude');
  assert.strictEqual(triggerCalls.length, 1);
  assert.strictEqual(triggerCalls[0].ai.provider, 'claude');
});

test('a subscription run (no provider) omits provider from the 202 body', async () => {
  triggerCalls.length = 0;
  const r = await post({ ...base, options: { targetLang: 'ar' } });
  assert.strictEqual(r.status, 202);
  assert.strictEqual(Object.keys(r.json).includes('provider'), false);
  assert.strictEqual(triggerCalls.length, 1);
  assert.strictEqual('ai' in triggerCalls[0], false);
});

// already_running means an EXISTING run holds this scope, and job identity does
// not include the caller or the provider — so that run may have been started by
// someone else, on the subscription. Echoing the provider here would tell a
// BYO-key caller "your provider run is live" and let it import another org's
// output on the bot's own subscription. The ack must be withheld so the caller
// fails closed.
test('already_running never echoes provider, even when one was requested', async () => {
  triggerCalls.length = 0;
  const r = await post({
    ...base,
    sessionKey: 'bible-editor/u1/want-already-running',
    provider: 'openai',
    apiKey: KEY,
    options: { targetLang: 'ar' },
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.status, 'already_running');
  assert.strictEqual(Object.keys(r.json).includes('provider'), false);
  assert.strictEqual(r.raw.includes(KEY), false);
});
