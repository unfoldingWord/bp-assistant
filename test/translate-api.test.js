// StartBodySchema rules for pipelineType "translate", plus the start-time
// provider/model/apiKey gates on handleStartRequest.
'use strict';

process.env.BT_API_TOKEN = 'test-bt-api-token';
delete process.env.BT_API_TOKEN_FILE;
delete process.env.BOT_SECRETS_DIR;

const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

const { StartBodySchema, handleStartRequest } = require('../src/api/pipeline');

const base = {
  pipelineType: 'translate',
  book: 'OBA',
  startChapter: 1,
  username: 'tester',
  sessionKey: 'bible-editor/u1/run-1',
};

test('translate start body accepts full options', () => {
  const res = StartBodySchema.safeParse({
    ...base,
    options: {
      targetLang: 'ar',
      targetOrg: 'ar_gl',
      sourceRef: 'unfoldingWord/en_tn@master',
      contextRef: 'ar_gl/translation-context@0123456789012345678901234567890123456789',
      branchOnly: true,
    },
  });
  assert.ok(res.success, JSON.stringify(res.error?.issues));
});

test('translate requires options.targetLang', () => {
  const res = StartBodySchema.safeParse({ ...base, options: {} });
  assert.ok(!res.success);
  assert.ok(res.error.issues.some((i) => i.path.join('.') === 'options.targetLang'));
});

test('targetLang accepts region subtags, rejects garbage', () => {
  const ok = StartBodySchema.safeParse({ ...base, options: { targetLang: 'es-419' } });
  assert.ok(ok.success, JSON.stringify(ok.error?.issues));
  const bad = StartBodySchema.safeParse({ ...base, options: { targetLang: 'ARABIC LANGUAGE' } });
  assert.ok(!bad.success);
});

test('translate-only fields rejected on notes', () => {
  const res = StartBodySchema.safeParse({
    ...base,
    pipelineType: 'notes',
    options: { targetLang: 'ar' },
  });
  assert.ok(!res.success);
  assert.ok(res.error.issues.some((i) => /only valid for pipelineType "translate"/.test(i.message)));
});

test('notes-only hints rejected on translate', () => {
  const res = StartBodySchema.safeParse({
    ...base,
    options: {
      targetLang: 'ar',
      hints: [{ rowId: 'ab12', verse: 1, quote: 'x', supportReference: null, seed: null }],
    },
  });
  assert.ok(!res.success);
  assert.ok(res.error.issues.some((i) => /only valid for pipelineType "notes"/.test(i.message)));
});

test('rowIds accepted on translate, rejected elsewhere, shape-checked', () => {
  const ok = StartBodySchema.safeParse({ ...base, options: { targetLang: 'ar', rowIds: ['xm1w', 'k9wc'] } });
  assert.ok(ok.success, JSON.stringify(ok.error?.issues));
  const badShape = StartBodySchema.safeParse({ ...base, options: { targetLang: 'ar', rowIds: ['BAD-ID'] } });
  assert.ok(!badShape.success);
  const onNotes = StartBodySchema.safeParse({ ...base, pipelineType: 'notes', options: { rowIds: ['xm1w'] } });
  assert.ok(!onNotes.success);
});

test('delivery/direction accepted on translate only', () => {
  const ok = StartBodySchema.safeParse({ ...base, options: { targetLang: 'ar', delivery: 'path', direction: 'rtl' } });
  assert.ok(ok.success, JSON.stringify(ok.error?.issues));
  const bad = StartBodySchema.safeParse({ ...base, pipelineType: 'tqs', options: { delivery: 'path' } });
  assert.ok(!bad.success);
});

test('verse range spanning multiple chapters is rejected', () => {
  const res = StartBodySchema.safeParse({
    ...base, startChapter: 1, endChapter: 2,
    verseStart: 1, verseEnd: 3,
    options: { targetLang: 'ar' },
  });
  assert.ok(!res.success);
  assert.ok(res.error.issues.some((i) => /single chapter/.test(i.message)));
});

test('verseEnd without verseStart is rejected', () => {
  const res = StartBodySchema.safeParse({
    ...base, startChapter: 1, endChapter: 1, verseEnd: 5,
    options: { targetLang: 'ar' },
  });
  assert.ok(!res.success);
  assert.ok(res.error.issues.some((i) => /verseEnd requires verseStart/.test(i.message)));
});

test('verse scope within a single chapter is accepted', () => {
  const res = StartBodySchema.safeParse({
    ...base, startChapter: 1, endChapter: 1,
    verseStart: 5, verseEnd: 7,
    options: { targetLang: 'ar' },
  });
  assert.ok(res.success, JSON.stringify(res.error?.issues));
});

test('sourceRef/contextRef must be org/repo@ref shaped', () => {
  const res = StartBodySchema.safeParse({
    ...base,
    options: { targetLang: 'ar', sourceRef: 'not-a-ref' },
  });
  assert.ok(!res.success);
});

// --- resourceType / articles ---

test('tq resourceType still requires book + startChapter', () => {
  const ok = StartBodySchema.safeParse({ ...base, options: { resourceType: 'tq', targetLang: 'ar' } });
  assert.ok(ok.success, JSON.stringify(ok.error?.issues));
  const noBook = StartBodySchema.safeParse({ pipelineType: 'translate', username: 'u', sessionKey: 's', options: { resourceType: 'tq', targetLang: 'ar' } });
  assert.ok(!noBook.success);
  assert.ok(noBook.error.issues.some((i) => i.path.join('.') === 'book'));
});

test('tw article accepts articleId without book/startChapter', () => {
  const res = StartBodySchema.safeParse({
    pipelineType: 'translate', username: 'u', sessionKey: 's',
    options: { resourceType: 'tw', targetLang: 'ar', articleId: 'kt/god' },
  });
  assert.ok(res.success, JSON.stringify(res.error?.issues));
});

test('ta article accepts a Door43 articleUrl', () => {
  const res = StartBodySchema.safeParse({
    pipelineType: 'translate', username: 'u', sessionKey: 's',
    options: { resourceType: 'ta', targetLang: 'ar', articleUrl: 'https://git.door43.org/unfoldingWord/en_ta/src/branch/master/translate/figs-aside' },
  });
  assert.ok(res.success, JSON.stringify(res.error?.issues));
});

test('article requires exactly one of articleId / articleUrl', () => {
  const both = StartBodySchema.safeParse({
    pipelineType: 'translate', username: 'u', sessionKey: 's',
    options: { resourceType: 'tw', targetLang: 'ar', articleId: 'kt/god', articleUrl: 'https://git.door43.org/x/y/src/branch/master/a.md' },
  });
  assert.ok(!both.success);
  const neither = StartBodySchema.safeParse({
    pipelineType: 'translate', username: 'u', sessionKey: 's',
    options: { resourceType: 'tw', targetLang: 'ar' },
  });
  assert.ok(!neither.success);
});

test('articleId rejected on tsv resources; rowIds rejected on articles', () => {
  const idOnTn = StartBodySchema.safeParse({ ...base, options: { resourceType: 'tn', targetLang: 'ar', articleId: 'kt/god' } });
  assert.ok(!idOnTn.success);
  const rowsOnTw = StartBodySchema.safeParse({
    pipelineType: 'translate', username: 'u', sessionKey: 's',
    options: { resourceType: 'tw', targetLang: 'ar', articleId: 'kt/god', rowIds: ['xm1w'] },
  });
  assert.ok(!rowsOnTw.success);
});

test('sourceLang accepted on translate only', () => {
  const ok = StartBodySchema.safeParse({ ...base, options: { targetLang: 'ka', sourceLang: 'ru', sourceRef: 'ru_gl/ru_tn@master' } });
  assert.ok(ok.success, JSON.stringify(ok.error?.issues));
  const bad = StartBodySchema.safeParse({ ...base, pipelineType: 'notes', options: { sourceLang: 'ru' } });
  assert.ok(!bad.success);
});

// --- direct multi-provider fields (top-level provider / model / apiKey) ----

const KEY = 'sk-test-abcdef0123456789';
const opts = { targetLang: 'ar' };

test('provider + apiKey + model accepted on translate', () => {
  const res = StartBodySchema.safeParse({
    ...base, provider: 'openai', model: 'gpt-5.4-mini', apiKey: KEY, options: opts,
  });
  assert.ok(res.success, JSON.stringify(res.error?.issues));
  assert.strictEqual(res.data.provider, 'openai');
  assert.strictEqual(res.data.model, 'gpt-5.4-mini');
});

test('provider + apiKey without model accepted (provider default resolves later)', () => {
  const res = StartBodySchema.safeParse({ ...base, provider: 'claude', apiKey: KEY, options: opts });
  assert.ok(res.success, JSON.stringify(res.error?.issues));
});

test('apiKey without provider is rejected', () => {
  const res = StartBodySchema.safeParse({ ...base, apiKey: KEY, options: opts });
  assert.ok(!res.success);
  assert.ok(res.error.issues.some((i) => /apiKey requires provider/.test(i.message)));
});

test('provider without apiKey is rejected (no fallback to the bot keys)', () => {
  const res = StartBodySchema.safeParse({ ...base, provider: 'gemini', options: opts });
  assert.ok(!res.success);
  assert.ok(res.error.issues.some((i) => /provider requires apiKey/.test(i.message)));
});

test('top-level model without provider is rejected', () => {
  const res = StartBodySchema.safeParse({ ...base, model: 'gpt-5.4', options: opts });
  assert.ok(!res.success);
  assert.ok(res.error.issues.some((i) => /model requires provider/.test(i.message)));
});

test('provider/model/apiKey rejected on notes, generate and tqs', () => {
  for (const pipelineType of ['notes', 'generate', 'tqs']) {
    const res = StartBodySchema.safeParse({
      ...base, pipelineType, provider: 'claude', apiKey: KEY, options: {},
    });
    assert.ok(!res.success, `${pipelineType} accepted provider`);
    assert.ok(res.error.issues.some((i) => /only valid for pipelineType "translate"/.test(i.message)),
      `${pipelineType}: ${JSON.stringify(res.error.issues)}`);
  }
});

test('unknown provider is rejected by the enum', () => {
  const res = StartBodySchema.safeParse({ ...base, provider: 'llama', apiKey: KEY, options: opts });
  assert.ok(!res.success);
});

test('options.model stays enum-limited and is independent of the provider model', () => {
  const bad = StartBodySchema.safeParse({ ...base, options: { ...opts, model: 'gpt-5.4' } });
  assert.ok(!bad.success);
  // A provider run may still carry the (ignored) agentic alias in options.
  const ok = StartBodySchema.safeParse({
    ...base, provider: 'claude', model: 'claude-opus-5', apiKey: KEY, options: { ...opts, model: 'sonnet' },
  });
  assert.ok(ok.success, JSON.stringify(ok.error?.issues));
});

// --- handleStartRequest gates (both paths answer before anything launches) --

function fakeReq(body) {
  const req = new EventEmitter();
  req.headers = { authorization: `Bearer ${process.env.BT_API_TOKEN}` };
  const raw = Buffer.from(JSON.stringify(body), 'utf8');
  // Emitted on the next tick so readBody's listeners are attached first.
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

test('unknown provider model → 400 model_not_found listing the valid ids', async () => {
  const r = await post({ ...base, provider: 'claude', model: 'claude-nope-9', apiKey: KEY, options: opts });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.json.error, 'model_not_found');
  assert.match(r.json.message, /Unknown claude model "claude-nope-9"/);
  assert.match(r.json.message, /claude-opus-5/);
  assert.ok(!r.raw.includes(KEY), 'model_not_found body leaked the key');
});

test('a rejected apiKey never appears in the 400 body', async () => {
  const secret = 'sk-super-secret-key-value-9999';
  // Too long for the 512-char cap → a zod string issue, which must not echo the value.
  const r = await post({ ...base, provider: 'claude', apiKey: secret.repeat(30), options: opts });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.json.error, 'validation_failed');
  assert.ok(!r.raw.includes(secret), `400 body echoed the submitted key: ${r.raw}`);
});

test('a rejected apiKey on a non-translate pipeline never appears in the 400 body', async () => {
  const secret = 'sk-another-secret-value-1234';
  const r = await post({ ...base, pipelineType: 'notes', provider: 'claude', apiKey: secret, options: {} });
  assert.strictEqual(r.status, 400);
  assert.ok(!r.raw.includes(secret), `400 body echoed the submitted key: ${r.raw}`);
});
