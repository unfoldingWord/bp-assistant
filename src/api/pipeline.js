// pipeline.js — public HTTP endpoints that drive the chapter-scale Zulip
// pipelines (`generate`, `write notes`, `write tqs`) from outside the bot.
// See: /home/ubuntu/bp-bot/pipeline-api-contract.md for the client-facing
// contract this implements.
//
// Pattern mirrors src/api/tn-quick.js: same bearer auth, same body cap +
// rate limit + CORS strategy. Pipelines themselves run unchanged via the
// existing firePipeline → runPipeline path.

const crypto = require('crypto');
const { z } = require('zod');
const { readSecret } = require('../secrets');
const { getCheckpoint } = require('../pipeline-checkpoints');
const { triggerPipelineFromApi, buildApiJobId, API_PIPELINE_ROUTE_NAMES } = require('../router');
const { BOOK_NUMBERS } = require('../api-runner/verse-data');
const {
  getExpectedOutputs,
  detectLandedOutputs,
} = require('./pipeline-output');

const MAX_BODY_BYTES = 4 * 1024;          // start payloads are tiny
const RATE_LIMIT_RPM = 60;
const RATE_LIMIT_WINDOW_MS = 60_000;

const PIPELINE_TYPES = Object.keys(API_PIPELINE_ROUTE_NAMES);

const StartBodySchema = z.object({
  pipelineType: z.enum(PIPELINE_TYPES),
  book: z.string().regex(/^[A-Za-z0-9]{3}$/),
  startChapter: z.number().int().min(1).max(150),
  endChapter: z.number().int().min(1).max(150).optional(),
  verseStart: z.number().int().min(1).max(200).nullable().optional(),
  verseEnd: z.number().int().min(1).max(200).nullable().optional(),
  username: z.string().min(1).max(80).regex(/^[A-Za-z0-9._-]+$/),
  sessionKey: z.string().min(1).max(120).regex(/^[A-Za-z0-9_\-./]+$/)
    .refine((v) => !/__/.test(v), { message: 'sessionKey must not contain "__"' })
    .refine((v) => !v.replace(/[^a-zA-Z0-9_]/g, '_').includes('__'), { message: 'sessionKey collapses to "__" after sanitization' }),
  options: z.object({
    model: z.enum(['sonnet', 'opus']).optional(),
  }).optional(),
});

const rateLimits = new Map();

function checkRateLimit(token) {
  const key = crypto.createHash('sha256').update(token).digest('hex');
  const now = Date.now();
  const cur = rateLimits.get(key);
  if (!cur || now - cur.windowStartMs >= RATE_LIMIT_WINDOW_MS) {
    rateLimits.set(key, { count: 1, windowStartMs: now });
    return true;
  }
  cur.count++;
  return cur.count <= RATE_LIMIT_RPM;
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let exceeded = false;
    const chunks = [];
    req.on('data', (c) => {
      if (exceeded) return;
      size += c.length;
      if (size > maxBytes) {
        exceeded = true;
        const err = new Error('body too large');
        err.code = 'BODY_TOO_LARGE';
        reject(err);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!exceeded) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (e) => { if (!exceeded) reject(e); });
  });
}

function reply(res, status, body, extraHeaders) {
  const headers = { 'Content-Type': 'application/json', ...(extraHeaders || {}) };
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

function applyCors(req, res) {
  const raw = process.env.BT_API_CORS_ORIGINS || process.env.TN_QUICK_CORS_ORIGINS || '';
  const allowed = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (!allowed.length) return;
  const origin = req.headers.origin || '';
  if (allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  } else {
    res.removeHeader('Access-Control-Allow-Origin');
  }
}

function checkAuth(req, res) {
  const token = readSecret('bt_api_token', 'BT_API_TOKEN');
  if (!token) {
    reply(res, 503, { error: 'pipeline_api_disabled', message: 'BT_API_TOKEN not configured on server' });
    return null;
  }
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${token}`) {
    reply(res, 401, { error: 'unauthorized' });
    return null;
  }
  if (!checkRateLimit(token)) {
    reply(res, 429, { error: 'rate_limited' }, { 'Retry-After': '30' });
    return null;
  }
  return token;
}

// jobId format: `${safe(sessionKey)}__${safe(pipelineType)}__${BOOK_S_E_VS_VE}`
// where safe() replaces non-[A-Za-z0-9_] with _. Reversible because we
// validate user-supplied sessionKey to never collapse to `__`.
function parseJobId(jobId) {
  if (typeof jobId !== 'string') return null;
  const parts = jobId.split('__');
  if (parts.length !== 3) return null;
  const [sessionKey, pipelineType, scopeId] = parts;
  if (!PIPELINE_TYPES.includes(pipelineType)) return null;
  const scopeParts = scopeId.split('_');
  if (scopeParts.length !== 5) return null;
  const [book, startStr, endStr, vsStr, veStr] = scopeParts;
  const startChapter = Number(startStr);
  const endChapter = Number(endStr);
  if (!Number.isInteger(startChapter) || !Number.isInteger(endChapter)) return null;
  const verseStart = vsStr === 'na' ? null : Number(vsStr);
  const verseEnd = veStr === 'na' ? null : Number(veStr);
  return {
    sessionKey,
    pipelineType,
    scope: { book, startChapter, endChapter, verseStart, verseEnd },
  };
}

function serializeCheckpoint(jobId, cp) {
  const out = {
    jobId,
    pipelineType: cp.pipelineType,
    scope: cp.scope,
    state: cp.state,
    updatedAt: cp.updatedAt,
    createdAt: cp.createdAt,
    interrupted: false,
  };
  if (cp.current) {
    out.current = {
      chapter: cp.current.chapter,
      skill: cp.current.skill,
      status: cp.current.status,
      ...(cp.current.startedAt ? { startedAt: cp.current.startedAt } : {}),
      ...(cp.current.errorKind ? { errorKind: cp.current.errorKind } : {}),
      ...(cp.current.error ? { error: cp.current.error } : {}),
    };
  }
  const updatedMs = Date.parse(cp.updatedAt || '');
  if (Number.isFinite(updatedMs) && cp.state === 'running') {
    // Mirror /health/pipelines' heuristic: a 'running' checkpoint untouched
    // for more than 12h is almost certainly orphaned by a bot restart.
    out.interrupted = (Date.now() - updatedMs) > (12 * 60 * 60 * 1000);
  }
  return out;
}

async function handleStartRequest(req, res) {
  const startedAt = Date.now();
  try {
    applyCors(req, res);

    if (!checkAuth(req, res)) return;

    let raw;
    try {
      raw = await readBody(req, MAX_BODY_BYTES);
    } catch (err) {
      if (err.code === 'BODY_TOO_LARGE') {
        reply(res, 413, { error: 'body_too_large', maxBytes: MAX_BODY_BYTES });
        return;
      }
      throw err;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      reply(res, 400, { error: 'invalid_json' });
      return;
    }

    const result = StartBodySchema.safeParse(parsed);
    if (!result.success) {
      reply(res, 400, { error: 'validation_failed', issues: result.error.issues });
      return;
    }
    const body = result.data;
    const book = body.book.toUpperCase();
    if (!BOOK_NUMBERS[book]) {
      reply(res, 400, { error: 'unknown_book', book: body.book });
      return;
    }

    const startChapter = body.startChapter;
    const endChapter = body.endChapter ?? body.startChapter;
    if (endChapter < startChapter) {
      reply(res, 400, { error: 'validation_failed', message: 'endChapter < startChapter' });
      return;
    }
    if (body.verseStart != null && body.verseEnd != null && body.verseEnd < body.verseStart) {
      reply(res, 400, { error: 'validation_failed', message: 'verseEnd < verseStart' });
      return;
    }

    const trigger = triggerPipelineFromApi({
      pipelineType: body.pipelineType,
      book,
      startChapter,
      endChapter,
      verseStart: body.verseStart ?? null,
      verseEnd: body.verseEnd ?? null,
      username: body.username,
      apiSessionKey: body.sessionKey,
    });

    const lat = Date.now() - startedAt;
    if (trigger.status === 'conflict') {
      reply(res, 409, {
        error: 'conflict',
        jobId: trigger.jobId,
        message: trigger.message || 'another run owns this scope',
      });
      console.log(`[pipeline-api] start ${body.pipelineType} ${book} ${startChapter}-${endChapter} → 409 conflict lat=${lat}ms`);
      return;
    }
    if (trigger.status === 'invalid') {
      reply(res, 400, { error: 'validation_failed', message: trigger.message });
      return;
    }

    reply(res, trigger.status === 'already_running' ? 200 : 202, {
      jobId: trigger.jobId,
      scope: trigger.scope,
      status: trigger.status,
    });
    console.log(`[pipeline-api] start ${body.pipelineType} ${book} ${startChapter}-${endChapter} → ${trigger.status} jobId=${trigger.jobId} user=${body.username} lat=${lat}ms`);
  } catch (err) {
    console.error(`[pipeline-api] start unhandled: ${err.stack || err.message}`);
    if (!res.headersSent) {
      reply(res, 500, { error: 'internal_error' });
    }
  }
}

async function handleStatusRequest(req, res, jobId) {
  try {
    applyCors(req, res);

    if (!checkAuth(req, res)) return;

    const parsed = parseJobId(jobId);
    if (!parsed) {
      reply(res, 400, { error: 'malformed_job_id', jobId });
      return;
    }

    const cp = getCheckpoint({
      sessionKey: parsed.sessionKey,
      pipelineType: parsed.pipelineType,
      scope: parsed.scope,
    });

    if (cp) {
      reply(res, 200, serializeCheckpoint(jobId, cp));
      return;
    }

    // No checkpoint → either never started, or completed and self-cleared.
    // Probe Door43 for the expected output(s).
    let landed = null;
    try {
      const token = readSecret('door43_token', 'DOOR43_TOKEN') || readSecret('gitea_token', 'GITEA_TOKEN');
      landed = await detectLandedOutputs({
        pipelineType: parsed.pipelineType,
        book: parsed.scope.book,
        startChapter: parsed.scope.startChapter,
        endChapter: parsed.scope.endChapter,
        token,
      });
    } catch (err) {
      console.warn(`[pipeline-api] door43 probe failed: ${err.message}`);
    }

    if (landed && landed.length > 0) {
      const expected = getExpectedOutputs(parsed.pipelineType, parsed.scope.book);
      reply(res, 200, {
        jobId,
        pipelineType: parsed.pipelineType,
        scope: parsed.scope,
        state: 'done',
        interrupted: false,
        output: landed,
        // Expected count vs found count helps callers spot partial-merge edge cases (e.g. ULT merged, UST still open).
        expectedOutputCount: expected.length,
      });
      return;
    }

    reply(res, 404, { error: 'not_found', jobId });
  } catch (err) {
    console.error(`[pipeline-api] status unhandled: ${err.stack || err.message}`);
    if (!res.headersSent) {
      reply(res, 500, { error: 'internal_error' });
    }
  }
}

module.exports = {
  handleStartRequest,
  handleStatusRequest,
  // exposed for testing
  parseJobId,
  StartBodySchema,
  buildApiJobId,
};
