// intent-classifier.js — Haiku-based NLU for routing natural language messages
// Uses claude-agent-sdk (OAuth) rather than @anthropic-ai/sdk (API key).

const { ensureFreshToken } = require('./auth-refresh');
const { normalizeBookName } = require('./pipeline-utils');

let _query = null;
async function getQuery() {
  if (!_query) {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    _query = sdk.query;
  }
  return _query;
}

const TRANSIENT_RETRY_WINDOW_MS = 10 * 60 * 1000;
const RETRY_BASE_DELAY_MS = 3000;
const RETRY_MAX_DELAY_MS = 30000;

function isUsageLimitError(text) {
  return /hit your limit|usage limit|rate limit|too many requests|429/i.test(String(text || ''));
}

function isTransientDowntimeError(text) {
  const t = String(text || '').toLowerCase();
  if (!t || isUsageLimitError(t)) return false;
  return (
    t.includes('internal server error') ||
    t.includes('api error: 500') ||
    t.includes('api_error') ||
    t.includes('http 500') ||
    t.includes('http 502') ||
    t.includes('http 503') ||
    t.includes('http 504') ||
    t.includes('service unavailable') ||
    t.includes('temporarily unavailable') ||
    t.includes('gateway timeout') ||
    t.includes('bad gateway') ||
    t.includes('overloaded') ||
    t.includes('connection reset') ||
    t.includes('socket hang up') ||
    t.includes('econnreset') ||
    t.includes('etimedout')
  );
}

function backoffDelayMs(attempt) {
  const exp = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * Math.pow(2, Math.max(0, attempt - 1)));
  const jitter = Math.floor(Math.random() * 1000);
  return exp + jitter;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const SYSTEM_PROMPT = `You classify Zulip messages about Bible translation work.
Extract the intent and parameters as JSON. Valid intents:
- "generate": user wants ULT and/or UST generated for chapters
- "notes": user wants translation notes produced for chapters
- "tqs": user wants translation questions written for a chapter, chapter range, or whole book
- "editor-review": user wants to review/compare editor changes against AI output (ULT/UST ONLY — never for translation notes/TN)
- "editor-note": user wants to file an observation or note about a book/passage for future reference
- "unknown": doesn't match any pattern

If the user asks to review or compare translation notes (TN), classify as "unknown" — editor-review only handles ULT and UST.

Always extract book as a 3-letter code (PSA for Psalms, GEN for Genesis, EXO for Exodus, JER for Jeremiah, etc.) and chapter range.
If only one chapter is mentioned, startChapter and endChapter should be the same.
For "tqs" only, a whole-book request may omit startChapter/endChapter if the book is clear.
If you can't determine the book, use intent "unknown".

For editor-review, also extract contentTypes: ["ult"] if user mentions only ULT, ["ust"] if only UST, ["ult","ust"] if both or neither specified.

For editor-note, also extract noteText: a concise summary of the observation the user wants to file.
For editor-review, generate, and notes, also extract scopeText when present. scopeText is the exact reference
string after the book (examples: "1", "1-3", "1:1-6", "2:10-3:5", "1,3,5").

Respond ONLY with valid JSON, no other text: {"intent":"...","book":"...","startChapter":N,"endChapter":N,"scopeText":"...","contentTypes":["ult","ust"],"noteText":"..."}`;

/**
 * Classify a Zulip message into a pipeline intent.
 * Only called when regex routes don't match.
 *
 * @param {string} messageContent - Raw message text
 * @returns {Promise<{intent: string, book: string, startChapter: number, endChapter: number, contentTypes: string[]}>}
 */
async function classifyIntent(messageContent) {
  const startedAt = Date.now();
  let attempt = 0;
  let replyText = '';

  while (true) {
    attempt++;
    await ensureFreshToken();
    const queryFn = await getQuery();

    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), 30000);

    const options = {
      cwd: process.cwd(),
      abortController,
      maxTurns: 1,
      allowedTools: [],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      persistSession: false,
      model: 'haiku',
      systemPrompt: SYSTEM_PROMPT,
    };

    const prompt = `Classify this message and respond with JSON only:\n\n${messageContent}`;
    const conversation = queryFn({ prompt, options });
    replyText = '';

    try {
      for await (const event of conversation) {
        if (abortController.signal.aborted) break;
        if (event.type === 'assistant' && event.message?.content) {
          for (const block of event.message.content) {
            if (block && typeof block.text === 'string') replyText += block.text;
          }
        }
      }
      break;
    } catch (err) {
      const errText = err?.message || String(err);
      const elapsed = Date.now() - startedAt;
      if (isTransientDowntimeError(errText) && elapsed < TRANSIENT_RETRY_WINDOW_MS) {
        const delay = backoffDelayMs(attempt);
        console.warn(`[intent-classifier] Transient SDK error, retrying in ${Math.round(delay / 1000)}s (attempt ${attempt}): ${errText.slice(0, 200)}`);
        await sleep(delay);
        continue;
      }
      if (isTransientDowntimeError(errText) && elapsed >= TRANSIENT_RETRY_WINDOW_MS) {
        const outageErr = new Error('Claude is temporarily down after retry attempts');
        outageErr.name = 'ClaudeTransientOutageError';
        throw outageErr;
      }
      throw err;
    } finally {
      clearTimeout(timer);
      try { conversation.close(); } catch (_) {}
    }
  }

  // Extract JSON from response (may be wrapped in markdown code fences)
  const jsonMatch = replyText.match(/\{[\s\S]*\}/);
  const text = jsonMatch ? jsonMatch[0] : replyText.trim();

  try {
    const parsed = JSON.parse(text);
    if (!parsed.intent || !['generate', 'notes', 'tqs', 'editor-review', 'editor-note', 'unknown'].includes(parsed.intent)) {
      return { intent: 'unknown', book: null, startChapter: null, endChapter: null, contentTypes: ['ult', 'ust'] };
    }
    const contentTypes = Array.isArray(parsed.contentTypes) && parsed.contentTypes.length > 0
      ? parsed.contentTypes.map(t => String(t).toLowerCase())
      : ['ult', 'ust'];
    return {
      intent: parsed.intent,
      book: parsed.book ? normalizeBookName(parsed.book) : null,
      startChapter: parsed.startChapter ?? null,
      endChapter: parsed.endChapter ?? null,
      scopeText: parsed.scopeText || null,
      contentTypes,
      noteText: parsed.noteText || null,
    };
  } catch (err) {
    console.error(`[intent-classifier] Failed to parse response: ${replyText.slice(0, 200)}`);
    return { intent: 'unknown', book: null, startChapter: null, endChapter: null, contentTypes: ['ult', 'ust'] };
  }
}

module.exports = { classifyIntent };
