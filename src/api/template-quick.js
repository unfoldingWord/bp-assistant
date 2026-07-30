// template-quick.js — public HTTPS endpoint that translates a note-template
// English body into a target language while preserving placeholder tokens.
// See: /home/ubuntu/bp-bot/template-quick-contract.md for the client-facing
// contract this implements.

const crypto = require('crypto');
const { z } = require('zod');
const { readSecret } = require('../secrets');
const { ensureFreshToken } = require('../auth-refresh');

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
// Stay under the editor's 120 s client ceiling so a hung model call cannot
// outlive the caller and keep consuming capacity during a bulk run.
const MODEL_TIMEOUT_MS = Number(process.env.TEMPLATE_QUICK_TIMEOUT_MS) || 90_000;
const MODEL_MAX_ATTEMPTS = 2;

const LANG_NAMES = {
  ar: 'Arabic', 'es-419': 'Latin American Spanish', es: 'Spanish', ru: 'Russian',
  fr: 'French', hi: 'Hindi', sw: 'Swahili', pt: 'Portuguese', id: 'Indonesian',
  zh: 'Chinese', vi: 'Vietnamese', bn: 'Bengali', ur: 'Urdu', fa: 'Persian',
  he: 'Hebrew', am: 'Amharic', ne: 'Nepali', my: 'Burmese', th: 'Thai',
  en: 'English', ka: 'Georgian',
};

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

function langName(code) {
  return LANG_NAMES[code] || LANG_NAMES[code.split('-')[0]] || code;
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
        + 'relative link path, and (N) enumeration exactly as in the English source. '
        + 'Do not insert directional control characters. Output ONLY the corrected template text.',
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

async function callModel({ system, userMessage, modelTier, timeoutMs = MODEL_TIMEOUT_MS }) {
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

async function draftWithInvariants({ body, timeoutMs = MODEL_TIMEOUT_MS }) {
  let repair = null;
  let lastViolations = [];
  for (let attempt = 1; attempt <= MODEL_MAX_ATTEMPTS; attempt++) {
    const userMessage = buildUserMessage(body, repair);
    const targetMd = await callModel({
      system: TEMPLATE_QUICK_STYLE,
      userMessage,
      modelTier: body.model,
      timeoutMs,
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

    let draft;
    try {
      draft = await draftWithInvariants({ body });
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
    const response = { target_md: draft.targetMd };
    if (draft.warnings.length) response.warnings = draft.warnings;
    reply(res, 200, response);
    const lat = Date.now() - startedAt;
    logLine += `id=${body.templateId} lang=${body.targetLang} dir=${body.direction} `
      + `lat=${lat}ms model=${body.model} status=200 `
      + `revise=${body.targetMd ? '1' : '0'} attempts=${draft.attempts}`;
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
  draftWithInvariants,
  TEMPLATE_QUICK_STYLE,
  MAX_BODY_BYTES,
  MODEL_TIMEOUT_MS,
  MODEL_MAX_ATTEMPTS,
};
