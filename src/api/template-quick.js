// template-quick.js — public HTTPS endpoint that translates a note-template
// English body into a target language while preserving placeholder tokens.
// See: /home/ubuntu/bp-bot/template-quick-contract.md for the client-facing
// contract this implements.

const fs = require('fs');
const crypto = require('crypto');
const { z } = require('zod');
const { readSecret } = require('../secrets');
const { ensureFreshToken } = require('../auth-refresh');
const { loadQuickPack, renderQuickPackText, langName } = require('../lib/quick-context');

let _agentSdkQuery = null;
async function getAgentSdkQuery() {
  if (!_agentSdkQuery) {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    _agentSdkQuery = sdk.query;
  }
  return _agentSdkQuery;
}

// Match the editor's TEMPLATE_DRAFT_MAX_BODY_BYTES (64 KiB). Bodies are ~1 KB
// in practice; the higher cap just keeps the bot from rejecting what the
// editor already accepted. Per-field string maxes use the same ceiling so a
// request that fits the serialized body is not rejected by Zod.
const MAX_BODY_BYTES = 64 * 1024;
const RATE_LIMIT_RPM = 60;
const RATE_LIMIT_WINDOW_MS = 60_000;
// Editor client ceiling is 120 s. All attempts share one request-level budget
// capped at that ceiling so a repair retry cannot push past the caller.
const EDITOR_CLIENT_CEILING_MS = 120_000;
const DEFAULT_REQUEST_BUDGET_MS = 90_000;
const MODEL_MAX_ATTEMPTS = 2;

function resolveRequestBudgetMs(envValue = process.env.TEMPLATE_QUICK_TIMEOUT_MS) {
  const raw = (envValue == null || envValue === '')
    ? DEFAULT_REQUEST_BUDGET_MS
    : Number(envValue);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_REQUEST_BUDGET_MS;
  return Math.min(Math.floor(raw), EDITOR_CLIENT_CEILING_MS);
}

const REQUEST_BUDGET_MS = resolveRequestBudgetMs();

// "org/repo@ref" (branch name or 40-hex sha), or — only when the server opts
// in via CONTEXT_PACK_ALLOW_LOCAL=1 — an existing local directory (dev
// fixtures / dry runs). See src/lib/context-pack.js for the ref contract.
function isValidContextRef(value) {
  if (/^[^/@\s]+\/[^/@\s]+@\S+$/.test(value)) return true;
  return process.env.CONTEXT_PACK_ALLOW_LOCAL === '1' && fs.existsSync(value);
}

const BodySchema = z.object({
  templateId: z.string().min(1).max(120),
  supportRef: z.string().min(1).max(200),
  type: z.string().min(1).max(80).nullable(),
  sourceMd: z.string().min(1).max(MAX_BODY_BYTES),
  targetMd: z.string().min(1).max(MAX_BODY_BYTES).nullable(),
  targetLang: z.string().min(2).max(12).regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/),
  targetOrg: z.string().min(1).max(60).regex(/^[A-Za-z0-9._-]+$/),
  direction: z.enum(['ltr', 'rtl']),
  // Accepted for forward compatibility; not required by the editor today.
  model: z.enum(['sonnet', 'opus']).default('sonnet'),
  contextRef: z.string().min(3).max(200).refine(isValidContextRef, {
    message: 'contextRef must be "org/repo@ref" or an existing local directory (CONTEXT_PACK_ALLOW_LOCAL=1)',
  }).optional(),
}).strict();

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
  const raw = process.env.TN_QUICK_CORS_ORIGINS || '';
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

const TEMPLATE_QUICK_STYLE = `You translate unfoldingWord note templates into a gateway language.

A note template is a short English snippet a translator drops into a
translationNote. Placeholder tokens are substituted by the editor at render
time — they are machinery, not prose.

Output: emit ONLY the translated template text. No preamble, no explanation,
no JSON wrapper, no quotation marks around the whole thing. Just the
translated markdown on its own.

## Hard rules (violations make the draft unusable)

1. Preserve placeholder tokens VERBATIM, in place. Do not translate, reorder,
   reformat, or wrap them. The live set includes:
   - \`[ALT]\`, \`[text]\` — bracketed substitution slots (keep brackets AND the
     literal word inside)
   - \`NOTE\` and \`SPEAKER\` — uppercase inline slots
   - \`**text**\` — the bolded literal word "text" is itself a slot; keep both
     the asterisks and the word \`text\`
   - \`{book}\` — frontend interpolation token
   - Markdown links with relative paths, e.g. \`[Genesis 1:1](../01/01.md)\` —
     keep the path exactly; translate only the link *label*
2. Preserve markdown structure: \`(1)\` / \`(2)\` enumerations, bold runs that
   are NOT the \`**text**\` slot, and line breaks. Numbering is load-bearing
   for numbered-alternatives templates.
3. Do NOT insert Unicode directional control characters (LRM/RLM/LRE/RLE/PDF
   etc.) around placeholders — the editor already sets \`dir\` attributes.
4. Translate the surrounding English prose naturally into the target language
   at a register suitable for Bible translators (clear, not scholarly jargon).
`;

// Bidirectional / directional formatting controls the editor already handles
// via dir attributes — the model must not insert these.
const BIDI_CONTROL_RE = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

// Ordered structural tokens. Link labels may be translated; only the relative
// path is load-bearing, so links contribute `link:<path>` to the sequence.
const STRUCTURAL_TOKEN_RE = /\*\*text\*\*|\{book\}|\[ALT\]|\[text\]|\bSPEAKER\b|\bNOTE\b|\[[^\]]*\]\((?!https?:\/\/|mailto:)([^)\s]+)\)/g;

const NUMBERING_RE = /\((\d+)\)/g;
// Non-nested bold runs. Inner text may be translated except for the **text** slot.
const BOLD_RUN_RE = /\*\*([^*]+)\*\*/g;

function extractStructuralTokens(md) {
  const tokens = [];
  const re = new RegExp(STRUCTURAL_TOKEN_RE.source, 'g');
  let m;
  while ((m = re.exec(md)) !== null) {
    if (m[1] != null) tokens.push(`link:${m[1]}`);
    else tokens.push(m[0]);
  }
  return tokens;
}

function extractNumbering(md) {
  return [...md.matchAll(NUMBERING_RE)].map((m) => m[1]);
}

function extractBidiControls(md) {
  return [...md.matchAll(BIDI_CONTROL_RE)].map((m) => m[0]);
}

function normalizeNewlines(md) {
  return String(md).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * Line-break structure signature: line count + blank vs non-blank pattern.
 * Leading/trailing newlines are ignored so sanitizeModelOutput's trim does not
 * create false failures; internal blank lines remain load-bearing.
 */
function lineBreakSignature(md) {
  const normalized = normalizeNewlines(md).replace(/^\n+/, '').replace(/\n+$/, '');
  if (normalized === '') return [];
  return normalized.split('\n').map((line) => (line.length === 0 ? 'blank' : 'text'));
}

/**
 * Ordered bold runs. The **text** slot must stay verbatim; other runs may have
 * translated inner text but must remain bold and in the same order/count.
 */
function extractBoldRuns(md) {
  return [...md.matchAll(BOLD_RUN_RE)].map((m) => ({
    inner: m[1],
    isSlot: m[1] === 'text',
  }));
}

function boldRunsMatch(sourceRuns, targetRuns) {
  if (sourceRuns.length !== targetRuns.length) return false;
  for (let i = 0; i < sourceRuns.length; i++) {
    const src = sourceRuns[i];
    const tgt = targetRuns[i];
    if (src.isSlot || tgt.isSlot) {
      if (src.inner !== 'text' || tgt.inner !== 'text') return false;
    }
  }
  return true;
}

function sameSequence(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Compare source vs model output for the load-bearing invariants from the
 * contract. Returns { ok: true } or { ok: false, violations: string[] }.
 */
function checkTemplateInvariants(sourceMd, targetMd) {
  const violations = [];
  const srcTokens = extractStructuralTokens(sourceMd);
  const tgtTokens = extractStructuralTokens(targetMd);
  if (!sameSequence(srcTokens, tgtTokens)) {
    violations.push(
      `placeholders: expected [${srcTokens.join(', ')}] `
        + `but got [${tgtTokens.join(', ')}]`,
    );
  }

  const srcNums = extractNumbering(sourceMd);
  const tgtNums = extractNumbering(targetMd);
  if (!sameSequence(srcNums, tgtNums)) {
    violations.push(
      `numbering: expected (${srcNums.join(')(')}) `
        + `but got (${tgtNums.join(')(')})`,
    );
  }

  const srcLines = lineBreakSignature(sourceMd);
  const tgtLines = lineBreakSignature(targetMd);
  if (!sameSequence(srcLines, tgtLines)) {
    violations.push(
      `line_breaks: expected ${srcLines.length} line(s) `
        + `[${srcLines.join(',')}] but got ${tgtLines.length} `
        + `[${tgtLines.join(',')}]`,
    );
  }

  const srcBold = extractBoldRuns(sourceMd);
  const tgtBold = extractBoldRuns(targetMd);
  if (!boldRunsMatch(srcBold, tgtBold)) {
    violations.push(
      `bold_runs: expected ${srcBold.length} run(s) `
        + `(${srcBold.map((b) => (b.isSlot ? '**text**' : '**…**')).join(', ')}) `
        + `but got ${tgtBold.length} `
        + `(${tgtBold.map((b) => (b.isSlot ? '**text**' : '**…**')).join(', ')})`,
    );
  }

  const srcBidi = extractBidiControls(sourceMd);
  const tgtBidi = extractBidiControls(targetMd);
  if (!sameSequence(srcBidi, tgtBidi)) {
    violations.push(
      `directional_controls: source had ${srcBidi.length}, `
        + `result has ${tgtBidi.length} (do not insert LRM/RLM/etc.)`,
    );
  }

  return violations.length ? { ok: false, violations } : { ok: true, violations: [] };
}

function buildUserMessage(body, repair = null) {
  const name = langName(body.targetLang);
  const dirLabel = body.direction === 'rtl' ? 'right-to-left' : 'left-to-right';
  const lines = [
    `Template id: ${body.templateId}`,
    `Support reference: ${body.supportRef}`,
    `Type: ${body.type == null ? '(none)' : body.type}`,
    `Target language: ${name} (${body.targetLang}, ${dirLabel})`,
    `Target org: ${body.targetOrg}`,
    '',
    'English source template:',
    body.sourceMd,
  ];
  if (body.targetMd) {
    lines.push(
      '',
      'Existing draft translation (revise this rather than translating from scratch):',
      body.targetMd,
      '',
      `Revise the existing draft so it accurately reflects the English source in ${name}. `
        + 'Preserve every placeholder token exactly. Output ONLY the revised template text.',
    );
  } else {
    lines.push(
      '',
      `Translate the English source template into ${name}. `
        + 'Preserve every placeholder token exactly. Output ONLY the translated template text.',
    );
  }
  if (repair) {
    lines.push(
      '',
      'Your previous draft FAILED structural checks and must be corrected:',
      ...repair.violations.map((v) => `- ${v}`),
      '',
      'Previous draft:',
      repair.previous,
      '',
      'Emit a corrected draft that restores every missing/altered placeholder, '
        + 'relative link path, (N) enumeration, bold run, and line break exactly '
        + 'as in the English source. Do not insert directional control characters. '
        + 'Output ONLY the corrected template text.',
    );
  }
  return lines.join('\n');
}

function sanitizeModelOutput(text) {
  let out = String(text || '').trim();
  // Strip a single wrapping markdown fence if the model adds one.
  const fenced = /^```(?:\w+)?\r?\n([\s\S]*?)\r?\n```$/;
  const m = fenced.exec(out);
  if (m) out = m[1].trim();
  return out;
}

async function callModel({ system, userMessage, modelTier, timeoutMs }) {
  if (!(timeoutMs > 0)) {
    const err = new Error('model call timed out (no budget remaining)');
    err.code = 'MODEL_TIMEOUT';
    throw err;
  }
  const query = await getAgentSdkQuery();
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeoutMs);
  try {
    const conversation = query({
      prompt: userMessage,
      options: {
        model: modelTier,
        systemPrompt: system,
        allowedTools: [],
        maxTurns: 1,
        permissionMode: 'auto',
        settingSources: [],
        persistSession: false,
        abortController,
      },
    });

    let text = '';
    for await (const msg of conversation) {
      if (abortController.signal.aborted) break;
      if (msg.type === 'assistant' && msg.message && Array.isArray(msg.message.content)) {
        for (const block of msg.message.content) {
          if (block && block.type === 'text' && typeof block.text === 'string') {
            text += block.text;
          }
        }
      }
    }
    if (abortController.signal.aborted) {
      const err = new Error(`model call timed out after ${timeoutMs}ms`);
      err.code = 'MODEL_TIMEOUT';
      throw err;
    }
    const trimmed = sanitizeModelOutput(text);
    if (!trimmed) {
      throw new Error('model returned empty response');
    }
    return trimmed;
  } catch (err) {
    if (err && err.code === 'MODEL_TIMEOUT') throw err;
    if (abortController.signal.aborted
      || (err && (err.name === 'AbortError' || /aborted/i.test(String(err.message || ''))))) {
      const timeoutErr = new Error(`model call timed out after ${timeoutMs}ms`);
      timeoutErr.code = 'MODEL_TIMEOUT';
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function draftWithInvariants({
  body,
  budgetMs = REQUEST_BUDGET_MS,
  now = Date.now,
  packText = null,
  // Injectable for tests only (default is the real model call); lets the
  // repair-loop behavior be verified without a live model call.
  callModelFn = callModel,
}) {
  const system = packText ? `${TEMPLATE_QUICK_STYLE}\n\n${packText}` : TEMPLATE_QUICK_STYLE;
  const deadlineMs = now() + budgetMs;
  let repair = null;
  let lastViolations = [];
  for (let attempt = 1; attempt <= MODEL_MAX_ATTEMPTS; attempt++) {
    const remainingMs = deadlineMs - now();
    if (remainingMs <= 0) {
      const err = new Error(`model call timed out after ${budgetMs}ms`);
      err.code = 'MODEL_TIMEOUT';
      throw err;
    }
    const userMessage = buildUserMessage(body, repair);
    const targetMd = await callModelFn({
      system,
      userMessage,
      modelTier: body.model,
      timeoutMs: remainingMs,
    });
    const check = checkTemplateInvariants(body.sourceMd, targetMd);
    if (check.ok) {
      return { targetMd, attempts: attempt, warnings: attempt > 1
        ? [`repaired_after_invariant_failure_attempt_${attempt - 1}`]
        : [] };
    }
    lastViolations = check.violations;
    console.warn(
      `[template-quick] invariant failure attempt=${attempt}/${MODEL_MAX_ATTEMPTS} `
        + `id=${body.templateId}: ${check.violations.join('; ')}`,
    );
    repair = { previous: targetMd, violations: check.violations };
  }
  const err = new Error(`invariant_check_failed: ${lastViolations.join('; ')}`);
  err.code = 'INVARIANT_FAILED';
  err.violations = lastViolations;
  throw err;
}

/**
 * Assemble the snake_case response body. packSha is included only when the
 * caller supplied a contextRef — omitted entirely otherwise, so a client that
 * never asked for preferences sees no new field.
 */
function buildQuickResponse({ targetMd, warnings, pack, contextRef }) {
  const response = { target_md: targetMd };
  if (warnings && warnings.length) response.warnings = warnings;
  if (contextRef) response.packSha = pack ? (pack.sha ?? null) : null;
  return response;
}

async function handleTemplateQuickRequest(req, res) {
  const startedAt = Date.now();
  let logLine = '[template-quick] ';
  try {
    applyCors(req, res);

    const token = readSecret('bt_api_token', 'BT_API_TOKEN');
    if (!token) {
      reply(res, 503, {
        error: 'template_quick_disabled',
        message: 'BT_API_TOKEN not configured on server',
      });
      return;
    }

    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${token}`) {
      reply(res, 401, { error: 'unauthorized' });
      return;
    }

    if (!checkRateLimit(token)) {
      reply(res, 429, { error: 'rate_limited' }, { 'Retry-After': '30' });
      return;
    }

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

    const result = BodySchema.safeParse(parsed);
    if (!result.success) {
      reply(res, 400, { error: 'validation_failed', issues: result.error.issues });
      return;
    }
    const body = result.data;

    const warnings = [];
    let pack = null;
    let sha10 = 'none';
    if (body.contextRef) {
      const loaded = await loadQuickPack(body.contextRef, {});
      pack = loaded.pack;
      if (loaded.warning) {
        warnings.push(loaded.warning);
        const reason = loaded.warning.replace(/^context_pack_unavailable:\s*/, '');
        console.warn(`[template-quick] context pack unavailable at ${body.contextRef}: ${reason} — drafting without preferences`);
      }
      if (pack) {
        sha10 = pack.sha ? pack.sha.slice(0, 10) : 'none';
        console.log(`[template-quick] context pack: ${body.contextRef} @ ${sha10} — ${(pack.terms || []).length} terms`);
      }
    }

    try {
      await ensureFreshToken();
    } catch (err) {
      reply(res, 503, { error: 'oauth_token_unavailable', message: err.message });
      return;
    }
    if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
      reply(res, 503, { error: 'oauth_token_unavailable' });
      return;
    }

    const packText = pack
      ? renderQuickPackText({
        pack,
        targetLang: body.targetLang,
        targetLangName: langName(body.targetLang),
        direction: body.direction,
      })
      : null;

    let draft;
    try {
      draft = await draftWithInvariants({ body, packText });
    } catch (err) {
      console.error(`[template-quick] model error: ${err.message}`);
      if (err.code === 'MODEL_TIMEOUT') {
        reply(res, 504, { error: 'model_timeout', message: err.message });
        return;
      }
      if (err.code === 'INVARIANT_FAILED') {
        reply(res, 502, {
          error: 'invariant_check_failed',
          message: err.message,
          violations: err.violations || [],
        });
        return;
      }
      reply(res, 502, { error: 'model_call_failed', message: err.message });
      return;
    }

    // Response is snake_case by contract — caller parses `target_md`, not targetMd.
    const response = buildQuickResponse({
      targetMd: draft.targetMd,
      warnings: [...warnings, ...draft.warnings],
      pack,
      contextRef: body.contextRef,
    });
    reply(res, 200, response);
    const lat = Date.now() - startedAt;
    logLine += `id=${body.templateId} lang=${body.targetLang} dir=${body.direction} `
      + `lat=${lat}ms model=${body.model} status=200 `
      + `revise=${body.targetMd ? '1' : '0'} attempts=${draft.attempts} `
      + `pack=${body.contextRef ? sha10 : 'none'}`;
    console.log(logLine);
  } catch (err) {
    console.error(`[template-quick] unhandled: ${err.stack || err.message}`);
    if (!res.headersSent) {
      reply(res, 500, { error: 'internal_error' });
    }
  }
}

module.exports = {
  handleTemplateQuickRequest,
  // exposed for testing
  BodySchema,
  buildUserMessage,
  sanitizeModelOutput,
  checkTemplateInvariants,
  extractStructuralTokens,
  extractNumbering,
  extractBoldRuns,
  lineBreakSignature,
  draftWithInvariants,
  buildQuickResponse,
  resolveRequestBudgetMs,
  TEMPLATE_QUICK_STYLE,
  MAX_BODY_BYTES,
  EDITOR_CLIENT_CEILING_MS,
  DEFAULT_REQUEST_BUDGET_MS,
  REQUEST_BUDGET_MS,
  MODEL_MAX_ATTEMPTS,
};
