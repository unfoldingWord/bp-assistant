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

// Bumped from 4KB to fit up to 50 hints with full prose seeds. The
// per-field caps on HintSchema below bound the worst case well under this.
const MAX_BODY_BYTES = 32 * 1024;
const RATE_LIMIT_RPM = 60;
const RATE_LIMIT_WINDOW_MS = 60_000;

const PIPELINE_TYPES = Object.keys(API_PIPELINE_ROUTE_NAMES);

// Canonical TN row-id format: lowercase letter + 3 alphanumerics. Same shape
// as INTRO_ID_RE in src/lib/insert-tn-rows.js — hint rowIds are preserved
// verbatim as TSV column-1 IDs, so they must conform to the TSV ID grammar.
const HINT_ROW_ID_RE = /^[a-z][a-z0-9]{3}$/;

const HintSchema = z.object({
  rowId: z.string().regex(HINT_ROW_ID_RE),
  verse: z.number().int().min(1).max(200),
  quote: z.string().max(500),                   // source-language; may be ''
  supportReference: z.string().max(200).nullable(),
  seed: z.string().max(4000).nullable(),
}).strict().refine(
  // A hint must carry signal: either a quote to anchor the note to a specific
  // source phrase, or a seed framing what the note should say (a general-
  // information note). With both empty, tn-writer has no phrase and no framing
  // — nothing to produce — so reject it as a client error rather than
  // emitting an empty/arbitrary note. quote OR seed may be empty, never both.
  (h) => (typeof h.quote === 'string' && h.quote.trim() !== '')
      || (typeof h.seed === 'string' && h.seed.trim() !== ''),
  {
    message: 'hint must carry a non-empty quote or seed (a general-information '
      + 'note needs a seed; a phrase-anchored note needs a quote)',
    path: ['seed'],
  },
);

const OptionsSchema = z.object({
  // Common — currently a no-op on the wire (model is fixed per pipeline today),
  // but accepted for forward compatibility with the contract doc.
  model: z.enum(['sonnet', 'opus']).optional(),
  // Common — re-run after a previous failed/paused run, clears checkpoint & prior outputs.
  fresh: z.boolean().optional(),
  // generate-only:
  // Restrict to a subset of content types. Default is both. Single-element array
  // routes to a per-type skill (ULT-gen / UST-gen) inside the pipeline.
  contentTypes: z.array(z.enum(['ult', 'ust'])).min(1).max(2).optional(),
  // Skip alignment + repo-insert. Mutually exclusive with alignOnly and textOnly.
  noAlign: z.boolean().optional(),
  // Reuse existing generated files; only align + repo-insert. Mutually exclusive
  // with noAlign and textOnly.
  alignOnly: z.boolean().optional(),
  // Push unaligned USFM files (no alignment). Mutually exclusive with noAlign and alignOnly.
  textOnly: z.boolean().optional(),
  // notes-only:
  noIntro: z.boolean().optional(),
  pauseBeforeATs: z.boolean().optional(),
  // translate-only (see src/translate-pipeline.js). Source rows are fetched
  // from the published repo at sourceRef — NOT sent inline — because the
  // 32 KB body cap can't fit a chapter of notes and the published repo is
  // the source of truth for translation (bp-bot/translate-pipeline/DECISION.md).
  targetLang: z.string().min(2).max(12).regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/).optional(),
  targetOrg: z.string().min(1).max(60).regex(/^[A-Za-z0-9._-]+$/).optional(),
  repoName: z.string().min(1).max(60).regex(/^[A-Za-z0-9._-]+$/).optional(),
  sourceRef: z.string().min(3).max(200).regex(/^[^/@\s]+\/[^/@\s]+@\S+$/).optional(),
  contextRef: z.string().min(3).max(200).regex(/^[^/@\s]+\/[^/@\s]+@\S+$/).optional(),
  branchOnly: z.boolean().optional(),
  delivery: z.enum(['path', 'branch']).optional(),
  direction: z.enum(['ltr', 'rtl']).optional(),
  // Individual-note / subset selection: translate only these published rows
  // and UPDATE them by ID into the existing target book (verse scoping uses
  // the top-level verseStart/verseEnd instead).
  rowIds: z.array(z.string().regex(HINT_ROW_ID_RE)).min(1).max(50).optional(),
  // Editor-marked TN row "hints" — each entry seeds one specific note the
  // pipeline must produce, and suppresses competing notes for the same
  // (verse, supportReference, fuzzy-quote). hint.rowId is preserved as the
  // TSV ID column for the expanded row, so bible-editor can UPDATE the
  // existing stub row in place by ID. Each hint must carry a non-empty quote
  // or seed (see HintSchema.refine).
  hints: z.array(HintSchema).max(50).optional(),
}).strict();

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
  options: OptionsSchema.optional(),
}).superRefine((body, ctx) => {
  const o = body.options || {};
  // Mutually-exclusive align mode flags.
  const alignFlags = ['noAlign', 'alignOnly', 'textOnly'].filter((k) => o[k]);
  if (alignFlags.length > 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['options'],
      message: `options.${alignFlags.join(' / options.')} are mutually exclusive`,
    });
  }
  // generate-only flags must not appear on notes/tqs.
  if (body.pipelineType !== 'generate') {
    for (const k of ['contentTypes', 'noAlign', 'alignOnly', 'textOnly']) {
      if (o[k] !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['options', k],
          message: `options.${k} only valid for pipelineType "generate"`,
        });
      }
    }
  }
  // translate-only fields must not appear on other types; targetLang is
  // required for translate.
  if (body.pipelineType === 'translate') {
    if (!o.targetLang) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['options', 'targetLang'],
        message: 'options.targetLang is required for pipelineType "translate"',
      });
    }
    // Verse scoping is single-chapter only: the verse filter is applied to
    // every chapter in the range, so a verse range across multiple chapters
    // would translate those verse numbers in each chapter. Require one chapter.
    const endCh = body.endChapter ?? body.startChapter;
    if (body.verseStart != null && endCh !== body.startChapter) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['verseStart'],
        message: 'verse scoping requires a single chapter (startChapter must equal endChapter)',
      });
    }
  } else {
    for (const k of ['targetLang', 'targetOrg', 'repoName', 'sourceRef', 'contextRef', 'branchOnly', 'delivery', 'direction', 'rowIds']) {
      if (o[k] !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['options', k],
          message: `options.${k} only valid for pipelineType "translate"`,
        });
      }
    }
  }
  // notes-only flags must not appear on generate/tqs.
  if (body.pipelineType !== 'notes') {
    for (const k of ['noIntro', 'pauseBeforeATs', 'hints']) {
      if (o[k] !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['options', k],
          message: `options.${k} only valid for pipelineType "notes"`,
        });
      }
    }
  }
  // hints — reject duplicate rowIds within a single request. The rowId is
  // the stable TN row identifier and gets preserved as the TSV ID column;
  // duplicates would produce ambiguous matches on bible-editor's apply side.
  if (Array.isArray(o.hints) && o.hints.length > 1) {
    const seen = new Set();
    for (let i = 0; i < o.hints.length; i++) {
      const id = o.hints[i] && o.hints[i].rowId;
      if (id && seen.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['options', 'hints', i, 'rowId'],
          message: `duplicate hint rowId "${id}"`,
        });
      }
      if (id) seen.add(id);
    }
  }
  // hints carry verse but not chapter, so multi-chapter scopes would
  // produce ambiguous routing (verse 7 could mean ch.7v7 or ch.8v7 …).
  // Until bible-editor's wire-shape includes chapter-per-hint, require a
  // single-chapter scope when hints are present.
  if (Array.isArray(o.hints) && o.hints.length > 0) {
    const endCh = body.endChapter ?? body.startChapter;
    if (endCh !== body.startChapter) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['options', 'hints'],
        message: 'options.hints requires a single-chapter scope (startChapter must equal endChapter)',
      });
    }
  }
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
      options: body.options || {},
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
  HintSchema,
  HINT_ROW_ID_RE,
  buildApiJobId,
};
