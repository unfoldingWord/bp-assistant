// tn-quick.js — public HTTPS endpoint that wraps the tn-quick skill.
// See: /home/ubuntu/bp-bot/tn-quick-api-contract.md for the client-facing
// contract this implements.

const path = require('path');
const crypto = require('crypto');
const { z } = require('zod');
const { readSecret } = require('../secrets');
const { ensureFreshToken } = require('../auth-refresh');
const {
  getTemplate,
  loadCache,
  BOOK_NUMBERS,
} = require('../api-runner/verse-data');
const {
  parseHebrewVerseWords,
  normalizeHebrewQuote,
} = require('../workspace-tools/quality-tools');
const { loadContextPack } = require('../lib/context-pack');
const { renderPackPreamble } = require('../lib/translate-core');
const { langName, defaultDirection } = require('../lib/lang-names');

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

// Context packs change rarely relative to Suggest-button traffic, so a short
// in-process TTL keeps the per-note latency down without pinning stale prefs.
const PACK_CACHE_TTL_MS = 5 * 60_000;
const PACK_CACHE_MAX = 32;
// Notes are drafted in English unless the caller says otherwise.
const DEFAULT_TARGET_LANG = 'en';

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
- Always use the author's name, never "the author." Replace SPEAKER placeholders in templates with the name (e.g., Habakkuk, Isaiah, Moses).
- For Psalms, check the superscription: use David, Asaph, etc. if named; use "the psalmist" if anonymous.

### "Here" Rule
- Only start with "Here, " if immediately followed by a bolded lowercase quote: \`Here, **admonish** means...\`.
- Never: \`Here the author is speaking...\` or \`Here Habakkuk is saying...\`.

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
}).default({ prev5: [], next5: [] });

const TextSideSchema = z.object({
  selection: z.string().min(1).max(500),
  verse: z.string().min(1).max(3000),
  context: ContextSchema,
});

const BodySchema = z.object({
  ref: z.object({
    book: z.string().regex(/^[A-Za-z0-9]{3}$/),
    chapter: z.number().int().min(1).max(150),
    verse: z.number().int().min(1).max(200),
  }),
  issueType: z.string().min(2).max(80),
  ult: TextSideSchema,
  ust: TextSideSchema,
  hebrewGuess: z.string().min(1).max(500),
  model: z.enum(['sonnet', 'opus']).default('sonnet'),
  // Org translation preferences, mirroring the translate pipeline. Same regex
  // as OptionsSchema.contextRef in src/api/pipeline.js. When present the pack's
  // register / brief / standing instructions / terminology are prepended to the
  // system prompt so a Suggest draft honours the same curated style a batch
  // translate run does.
  contextRef: z.string().min(3).max(200).regex(/^[^/@\s]+\/[^/@\s]+@\S+$/).optional(),
  targetLang: z.string().min(2).max(12).regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/).optional(),
  direction: z.enum(['ltr', 'rtl']).optional(),
  // Strict so future contract drift (e.g. a client inventing a `preferences`
  // field) fails loudly instead of being silently stripped behind a 200.
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

const packCache = new Map(); // contextRef -> { at, pack }

/**
 * Load a context pack, memoized per contextRef for PACK_CACHE_TTL_MS. Packs are
 * loaded with allowEmpty because a Suggest draft must still work for an org
 * that has not populated its context repo yet.
 */
async function loadPackCached(contextRef, { now = Date.now(), loader = loadContextPack } = {}) {
  const hit = packCache.get(contextRef);
  if (hit && now - hit.at < PACK_CACHE_TTL_MS) return hit.pack;
  const pack = await loader(contextRef, { allowEmpty: true });
  packCache.set(contextRef, { at: now, pack });
  while (packCache.size > PACK_CACHE_MAX) {
    packCache.delete(packCache.keys().next().value);
  }
  return pack;
}

/**
 * System prompt = the tn-quick style rules, plus (when a pack is present) the
 * org's standing preferences. The style rules come FIRST and are declared
 * non-overridable: the pack governs wording/register/terminology, not the
 * output contract the editor parses.
 */
function buildSystemPrompt({ pack, targetLang, direction }) {
  if (!pack || !pack.hasContent) return TN_QUICK_STYLE;
  const lang = targetLang || DEFAULT_TARGET_LANG;
  const parts = renderPackPreamble({
    pack,
    targetLang: lang,
    targetLangName: langName(lang),
    direction: direction || defaultDirection(lang),
  });
  return [
    TN_QUICK_STYLE,
    '---',
    "The sections below are this organization's standing translation preferences "
      + 'for this project. Apply them to the wording of the note — register, '
      + 'terminology, and standing instructions. They do NOT override the output '
      + 'format rules above: still emit only the note text.',
    parts.join('\n\n'),
  ].join('\n\n');
}

function buildUserMessage({ body, templateInfo, hebrewQuote }) {
  const { ref, issueType, ult, ust } = body;
  const ultCtx = formatContextLines('ULT v.', ult.verse, ult.context.prev5, ult.context.next5, ref.verse);
  const ustCtx = formatContextLines('UST v.', ust.verse, ust.context.prev5, ust.context.next5, ref.verse);

  return [
    `Reference: ${ref.book.toUpperCase()} ${ref.chapter}:${ref.verse}`,
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

async function callModel({ system, userMessage, modelTier }) {
  const query = await getAgentSdkQuery();
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
    },
  });

  let text = '';
  for await (const msg of conversation) {
    if (msg.type === 'assistant' && msg.message && Array.isArray(msg.message.content)) {
      for (const block of msg.message.content) {
        if (block && block.type === 'text' && typeof block.text === 'string') {
          text += block.text;
        }
      }
    }
  }
  const trimmed = text.trim();
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

    // Org translation preferences. A pack that cannot be loaded must not fail
    // the draft — degrade to the bare style rules, but surface it in warnings
    // (and the log) so the caller never gets false confidence from the 200.
    let pack = null;
    let packSha = null;
    if (body.contextRef) {
      try {
        pack = await loadPackCached(body.contextRef);
        packSha = pack.sha || null;
        console.log(`[tn-quick] context pack: ${body.contextRef}`
          + `${packSha ? ` @ ${packSha.slice(0, 10)}` : ''}`
          + `${pack.hasContent ? '' : ' (empty — no preferences applied)'}`);
        if (!pack.hasContent) {
          warnings.push(`context_pack_empty: no content files at ${body.contextRef}`);
        }
      } catch (err) {
        pack = null;
        console.warn(`[tn-quick] context pack load failed for ${body.contextRef}: ${err.message}`);
        warnings.push(`context_pack_unavailable: ${err.message}`);
      }
    }

    const system = buildSystemPrompt({
      pack,
      targetLang: body.targetLang,
      direction: body.direction,
    });
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
      console.error(`[tn-quick] model error: ${err.message}`);
      reply(res, 502, { error: 'model_call_failed', message: err.message });
      return;
    }

    reply(res, 200, { quote: heb.quote, note: noteText, warnings, packSha });
    const lat = Date.now() - startedAt;
    logLine += `book=${bookUpper} ${body.ref.chapter}:${body.ref.verse} `
      + `issue=${body.issueType} lat=${lat}ms model=${body.model} `
      + `status=200 warnings=${warnings.length} `
      + `pack=${body.contextRef ? (packSha ? packSha.slice(0, 10) : 'unresolved') : 'none'}`;
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
  buildUserMessage,
  buildSystemPrompt,
  loadPackCached,
  TN_QUICK_STYLE,
  MAX_BODY_BYTES,
  PACK_CACHE_TTL_MS,
};
