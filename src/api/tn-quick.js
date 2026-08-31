// tn-quick.js — public HTTPS endpoint that wraps the tn-quick skill.
// See: /home/ubuntu/bp-bot/tn-quick-api-contract.md for the client-facing
// contract this implements.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { z } = require('zod');
const { readSecret } = require('../secrets');
const { ensureFreshToken } = require('../auth-refresh');
const {
  getTemplate,
  loadCache,
  BOOK_NUMBERS,
  BOOK_NAMES,
} = require('../api-runner/verse-data');
const {
  parseHebrewVerseWords,
  normalizeHebrewQuote,
} = require('../workspace-tools/quality-tools');
const { loadQuickPack, renderQuickPackText, langName } = require('../lib/quick-context');

let _agentSdkQuery = null;
async function getAgentSdkQuery() {
  if (!_agentSdkQuery) {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    _agentSdkQuery = sdk.query;
  }
  return _agentSdkQuery;
}

const HEBREW_DIR_REL = 'data/hebrew_bible';
const MAX_BODY_BYTES = 32 * 1024;
const RATE_LIMIT_RPM = 60;
const RATE_LIMIT_WINDOW_MS = 60_000;

// Canonical source of these style rules: bp-assistant-skills/.claude/skills/tn-quick/SKILL.md
// Keep in sync when style guidance there changes.
const TN_QUICK_STYLE = `You draft a single English translation note for an English support phrase highlighted in the ULT.

Output: emit ONLY the final note text. No preamble, no explanation, no JSON wrapper, no quotation marks around the whole thing. Just the note text on its own.

## Style Rules

### Templates
- Use the template from the templates field as closely as possible.
- Replace ALL CAPS placeholders with context from the verse.
- Resolve slashes by picking the appropriate word.
- Do not rephrase or condense template wording.

### Alternate Translations
- Enclose in square brackets: \`Alternate translation: [text here]\`.
- Must fit seamlessly: removing the quoted phrase from the ULT and inserting the AT should read as natural English.
- Must differ from UST phrasing for the same verse.
- Minimal change to ULT wording — only change what the issue requires.
- No punctuation at start/end of brackets unless the note is about punctuation.
- Match capitalization to sentence position of the quoted phrase.

### Bold and Quoting
- Bold words/phrases quoted from the verse: \`**quoted words**\`.
- Only bold the first occurrence.
- Match capitalization and grammatical forms exactly from the ULT.

### Quotation Marks
- Use Unicode curly quotes in note body text: “ ” (U+201C/U+201D) and ‘ ’ (U+2018/U+2019).
- Never use straight quotes (" or ') in prose — curly quotes only.
- Alternate translation brackets [] are unaffected.

### Author References
- Always use the author's name, never "the author." Replace SPEAKER placeholders in templates with the name.
- Derive that name from the book on the Reference line, using the book's traditional author. Never name an author from any other book.
- For Psalms, check the superscription: use David, Asaph, etc. if named; use "the psalmist" if anonymous.
- Only if the book's author is genuinely unknown, use "the author."

### "Here" Rule
- Only start with "Here, " if immediately followed by a bolded lowercase quote: \`Here, **admonish** means...\`.
- Never: \`Here the author is speaking...\` or \`Here the prophet is saying...\`.

### Restrictions
- No source language names (Hebrew, Greek, Aramaic) in note text.
- No linguistic jargon not present in the template (no "cognate accusative," "genitive," etc.).
- No "could mean" (reserved for TCM multi-interpretation notes).
- No extra explanation beyond what the template models.
- Do not define words for figs-abstractnouns — just resolve the abstract noun.
- For figs-activepassive, the AT must use an active verb, not passive with agent added.

### Figure of Speech Verbiage
| Figure | Standard Verbiage |
|---|---|
| Metaphor | speaking of X as if it were Y |
| Hyperbole | generalization, extreme statement |
| Idiom | was a common expression meaning |
| Merism | referring to all of X by naming two extremes |
| Metonymy | X represents Y |
| Parallelism | These two phrases mean basically the same thing |
| Personification | speaks of X as if it were a person who could... |
| Synecdoche | using one kind to mean the general category |
| Hendiadys | The phrase X and Y expresses a single idea |
| Reduplication | repeating forms of the word X to intensify |
`;

const ContextSchema = z.object({
  prev5: z.array(z.string().max(3000)).max(5).default([]),
  next5: z.array(z.string().max(3000)).max(5).default([]),
}).strict().default({ prev5: [], next5: [] });

const TextSideSchema = z.object({
  selection: z.string().min(1).max(500),
  verse: z.string().min(1).max(3000),
  context: ContextSchema,
}).strict();

// "org/repo@ref" (branch name or 40-hex sha), or — only when the server opts
// in via CONTEXT_PACK_ALLOW_LOCAL=1 — an existing local directory (dev
// fixtures / dry runs). See src/lib/context-pack.js for the ref contract.
function isValidContextRef(value) {
  if (/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+@\S+$/.test(value)) return true;
  return process.env.CONTEXT_PACK_ALLOW_LOCAL === '1' && fs.existsSync(value);
}

const BodySchema = z.object({
  ref: z.object({
    book: z.string().regex(/^[A-Za-z0-9]{3}$/),
    chapter: z.number().int().min(1).max(150),
    verse: z.number().int().min(1).max(200),
  }).strict(),
  issueType: z.string().min(2).max(80),
  ult: TextSideSchema,
  ust: TextSideSchema,
  hebrewGuess: z.string().min(1).max(500),
  model: z.enum(['sonnet', 'opus']).default('sonnet'),
  contextRef: z.string().min(3).max(200).refine(isValidContextRef, {
    message: 'contextRef must be "org/repo@ref" or an existing local directory (CONTEXT_PACK_ALLOW_LOCAL=1)',
  }).optional(),
  targetLang: z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/).optional(),
  direction: z.enum(['ltr', 'rtl']).optional(),
}).strict();

// tn-quick drafts a single English note — org terminology preferences only
// need the hard-constraint buckets, not "admitted" (valid-but-not-preferred)
// or "deprecated" (legacy guidance for existing drafts). "preferred" is also
// excluded: tn-quick drafts in the note language (usually English), while
// target-language preferred renderings are translate-pipeline guidance and
// could leak target-language words into an English note. forbidden /
// do_not_translate still guard quoted terms regardless of note language.
// (template-quick keeps all buckets — it writes target-language text.)
const TN_QUICK_TERM_STATUSES = ['forbidden', 'do_not_translate'];

// The pack's brief and standing instructions are written for the org's
// TARGET language and are often written IN it, while this endpoint drafts the
// note in the note language (English) per TN_QUICK_STYLE. Without this
// reconciliation the two halves of the system prompt contradict each other and
// the model can answer in the wrong language. Keep this immediately before the
// pack text so it governs how the pack is read.
const TN_QUICK_PACK_FRAME = `## How to use the translation context below

The context that follows is the organization's standing guidance for its own translation work. Use it ONLY as background: whose translation this serves, which terms are forbidden or must be left untranslated, and what the team cares about.

It does NOT change the language or shape of your output. You are still drafting ONE note in the same language as the English source material and the templates above, following every style rule above. The context may itself be written in another language — do not mirror that language, and do not translate the note into the organization's target language.`;

/** Build the system prompt: style rules alone, or with org preferences appended. */
function buildSystemPrompt({ pack, targetLang, targetLangName, direction }) {
  if (!pack) return TN_QUICK_STYLE;
  const packText = renderQuickPackText({
    pack, targetLang, targetLangName, direction, termStatuses: TN_QUICK_TERM_STATUSES,
  });
  return `${TN_QUICK_STYLE}\n\n${TN_QUICK_PACK_FRAME}\n\n${packText}`;
}

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

function getVerseWords(book, chapter, verse) {
  const num = BOOK_NUMBERS[book.toUpperCase()];
  if (!num) return null;
  const hebrewPath = path.posix.join(HEBREW_DIR_REL, `${num}-${book.toUpperCase()}.usfm`);
  const verseMap = parseHebrewVerseWords(hebrewPath);
  if (!verseMap || Object.keys(verseMap).length === 0) return null;
  return verseMap[`${chapter}:${verse}`] || [];
}

function formatContextLines(label, verseText, prev5, next5, refVerse) {
  const lines = [];
  for (let i = 0; i < prev5.length; i++) {
    const v = refVerse - (prev5.length - i);
    if (v >= 1) lines.push(`${label} ${v}: ${prev5[i]}`);
  }
  lines.push(`${label} ${refVerse} [TARGET VERSE]: ${verseText}`);
  for (let i = 0; i < next5.length; i++) {
    lines.push(`${label} ${refVerse + i + 1}: ${next5[i]}`);
  }
  return lines.join('\n');
}

function buildUserMessage({ body, templateInfo, hebrewQuote }) {
  const { ref, issueType, ult, ust } = body;
  const bookCode = ref.book.toUpperCase();
  const bookName = BOOK_NAMES[bookCode] || '';
  const ultCtx = formatContextLines('ULT v.', ult.verse, ult.context.prev5, ult.context.next5, ref.verse);
  const ustCtx = formatContextLines('UST v.', ust.verse, ust.context.prev5, ust.context.next5, ref.verse);

  return [
    `Reference: ${bookCode} ${ref.chapter}:${ref.verse}${bookName ? ` (${bookName})` : ''}`,
    `Issue type: ${issueType}`,
    '',
    `ULT support phrase: "${ult.selection}"`,
    `UST parallel phrase: "${ust.selection}"`,
    `Hebrew quote (validated): ${hebrewQuote}`,
    '',
    'Templates for this issue type:',
    JSON.stringify(templateInfo.templates, null, 2),
    '',
    'ULT context (±5 verses):',
    ultCtx,
    '',
    'UST context (±5 verses):',
    ustCtx,
    '',
    'Draft ONE translation note for the ULT support phrase above. Output ONLY the note text.',
  ].join('\n');
}

// Timeout for one model call. There was previously none here at all, so a hung
// request held its rate-limit slot indefinitely; raising the turn ceiling makes
// the worst case longer, so a bound is required rather than optional.
const MODEL_TIMEOUT_MS = 90_000;

function modelTimeoutError(timeoutMs) {
  const err = new Error(`model timed out after ${Math.round(timeoutMs / 1000)}s`);
  // Matches template-quick, whose handler maps this code to 504 rather than the
  // generic 502: a caller must be able to tell an upstream timeout from a model
  // failure to pick the right retry behaviour.
  err.code = 'MODEL_TIMEOUT';
  return err;
}

async function callModel({ system, userMessage, modelTier, timeoutMs = MODEL_TIMEOUT_MS }) {
  const query = await getAgentSdkQuery();
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeoutMs);

  const conversation = query({
    prompt: userMessage,
    options: {
      model: modelTier,
      systemPrompt: system,
      abortController,
      // allowedTools does NOT restrict which tools exist -- per the SDK types it
      // only lists tools that are "auto-allowed without prompting". Paired with
      // permissionMode 'auto' ("use a model classifier to approve/deny") an empty
      // list therefore left every tool reachable, with a classifier as the only
      // gate, on a public HTTPS endpoint whose prompt embeds caller-supplied text.
      // 'dontAsk' is documented as "deny if not pre-approved", which is what makes
      // the empty allowedTools an actual deny-all.
      allowedTools: [],
      permissionMode: 'dontAsk',
      // Not 1. A turn can be spent on an assistant message that stops before
      // emitting the final text, which surfaced to the caller as a hard failure
      // ("Reached maximum number of turns (1)") depending on how the model opened.
      // 2 is enough to finish; with tools denied above, the extra turn cannot
      // fetch anything.
      maxTurns: 2,
      settingSources: [],
      persistSession: false,
    },
  });

  // Keep the LAST non-empty assistant text rather than concatenating every turn.
  // Concatenating glued a preamble turn onto the answer with no separator
  // ("Here's the note:The note text") once more than one turn was allowed.
  let lastText = '';
  let resultText = '';
  let resultError = null;
  try {
    for await (const msg of conversation) {
      if (abortController.signal.aborted) break;
      if (msg.type === 'assistant' && msg.message && Array.isArray(msg.message.content)) {
        let turnText = '';
        for (const block of msg.message.content) {
          if (block && block.type === 'text' && typeof block.text === 'string') {
            turnText += block.text;
          }
        }
        if (turnText.trim()) lastText = turnText;
      } else if (msg.type === 'result') {
        // A terminal SDKResultError (subtype 'error_max_turns' and friends) can
        // arrive as an event carrying no string `result`. Without this the
        // preceding assistant text was kept and returned as a successful note,
        // so a call that still exhausted its turns produced a truncated 200.
        if (msg.is_error === true || /^error_/.test(msg.subtype || '')) {
          resultError = msg.subtype || 'error';
        } else if (typeof msg.result === 'string') {
          resultText = msg.result;
        }
      }
    }
  } catch (err) {
    if (abortController.signal.aborted) {
      throw modelTimeoutError(timeoutMs);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    try { conversation.close(); } catch (_) { /* already closed */ }
  }

  // The abort can surface as a terminal event that ends the loop instead of as a
  // thrown AbortError. Without this check the loop's `break` fell straight
  // through and a timed-out request returned its partial, truncated note as a
  // successful 200.
  if (abortController.signal.aborted) throw modelTimeoutError(timeoutMs);
  if (resultError) throw new Error(`model ended with ${resultError}`);

  const trimmed = (lastText || resultText).trim();
  if (!trimmed) {
    throw new Error('model returned empty response');
  }
  return trimmed;
}

async function handleTnQuickRequest(req, res) {
  const startedAt = Date.now();
  let logLine = '[tn-quick] ';
  try {
    applyCors(req, res);

    const token = readSecret('bt_api_token', 'BT_API_TOKEN');
    if (!token) {
      reply(res, 503, {
        error: 'tn_quick_disabled',
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

    const bookUpper = body.ref.book.toUpperCase();
    if (!BOOK_NUMBERS[bookUpper]) {
      reply(res, 400, { error: 'unknown_book', book: body.ref.book });
      return;
    }

    try {
      loadCache();
    } catch (err) {
      reply(res, 503, { error: 'cache_unavailable', message: err.message });
      return;
    }

    const templateInfo = getTemplate({ issue_type: body.issueType });
    if (templateInfo.error) {
      reply(res, 400, { error: 'unknown_issue_type', issueType: body.issueType });
      return;
    }

    const verseWords = getVerseWords(bookUpper, body.ref.chapter, body.ref.verse);
    if (!verseWords || verseWords.length === 0) {
      reply(res, 503, { error: 'uhb_missing_for_verse', ref: body.ref });
      return;
    }

    const heb = normalizeHebrewQuote(body.hebrewGuess, verseWords);
    if (heb.status === 'no_rtl') {
      reply(res, 422, {
        error: 'no_rtl',
        message: 'hebrewGuess contains no Hebrew characters',
      });
      return;
    }
    if (heb.status === 'no_words_match') {
      reply(res, 422, {
        error: 'hebrew_words_not_in_verse',
        detail: heb.warnings,
      });
      return;
    }
    const warnings = heb.warnings.map((w) => `${w.code}: ${w.detail}`);

    let pack = null;
    let sha10 = 'none';
    if (body.contextRef) {
      const loaded = await loadQuickPack(body.contextRef, {});
      pack = loaded.pack;
      if (loaded.warning) {
        warnings.push(loaded.warning);
        const reason = loaded.warning.replace(/^context_pack_unavailable:\s*/, '');
        console.warn(`[tn-quick] context pack unavailable at ${body.contextRef}: ${reason} — drafting without preferences`);
      }
      if (pack) {
        sha10 = pack.sha ? pack.sha.slice(0, 10) : 'none';
        console.log(`[tn-quick] context pack: ${body.contextRef} @ ${sha10} — ${(pack.terms || []).length} terms`);
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

    const targetLang = body.targetLang || (pack && pack.manifest && pack.manifest.language) || 'und';
    const targetLangName = langName(targetLang);
    const direction = body.direction || (pack && pack.manifest && pack.manifest.direction) || 'ltr';
    const system = buildSystemPrompt({ pack, targetLang, targetLangName, direction });
    const userMessage = buildUserMessage({
      body,
      templateInfo,
      hebrewQuote: heb.quote,
    });

    let noteText;
    try {
      noteText = await callModel({
        system,
        userMessage,
        modelTier: body.model,
      });
    } catch (err) {
      if (err && err.code === 'MODEL_TIMEOUT') {
        console.error(`[tn-quick] model timeout: ${err.message}`);
        reply(res, 504, { error: 'model_timeout', message: err.message });
        return;
      }
      console.error(`[tn-quick] model error: ${err.message}`);
      reply(res, 502, { error: 'model_call_failed', message: err.message });
      return;
    }

    const responseBody = { quote: heb.quote, note: noteText, warnings };
    if (body.contextRef) responseBody.packSha = pack ? (pack.sha ?? null) : null;
    reply(res, 200, responseBody);
    const lat = Date.now() - startedAt;
    logLine += `book=${bookUpper} ${body.ref.chapter}:${body.ref.verse} `
      + `issue=${body.issueType} lat=${lat}ms model=${body.model} `
      + `status=200 warnings=${warnings.length} pack=${body.contextRef ? sha10 : 'none'}`;
    console.log(logLine);
  } catch (err) {
    console.error(`[tn-quick] unhandled: ${err.stack || err.message}`);
    if (!res.headersSent) {
      reply(res, 500, { error: 'internal_error' });
    }
  }
}

module.exports = {
  handleTnQuickRequest,
  // exposed for testing
  BodySchema,
  buildSystemPrompt,
  buildUserMessage,
  TN_QUICK_STYLE,
  TN_QUICK_PACK_FRAME,
  TN_QUICK_TERM_STATUSES,
};
