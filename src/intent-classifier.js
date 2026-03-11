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

const SYSTEM_PROMPT = `You classify Zulip messages about Bible translation work.
Extract the intent and parameters as JSON. Valid intents:
- "generate": user wants ULT and/or UST generated for chapters
- "notes": user wants translation notes produced for chapters
- "editor-review": user wants to review/compare editor changes against AI output (ULT/UST ONLY — never for translation notes/TN)
- "editor-note": user wants to file an observation or note about a book/passage for future reference
- "unknown": doesn't match any pattern

If the user asks to review or compare translation notes (TN), classify as "unknown" — editor-review only handles ULT and UST.

Always extract book as a 3-letter code (PSA for Psalms, GEN for Genesis, EXO for Exodus, JER for Jeremiah, etc.) and chapter range.
If only one chapter is mentioned, startChapter and endChapter should be the same.
If you can't determine the book or chapters, use intent "unknown".

For editor-review, also extract contentTypes: ["ult"] if user mentions only ULT, ["ust"] if only UST, ["ult","ust"] if both or neither specified.

For editor-note, also extract noteText: a concise summary of the observation the user wants to file.

Respond ONLY with valid JSON, no other text: {"intent":"...","book":"...","startChapter":N,"endChapter":N,"contentTypes":["ult","ust"],"noteText":"..."}`;

/**
 * Classify a Zulip message into a pipeline intent.
 * Only called when regex routes don't match.
 *
 * @param {string} messageContent - Raw message text
 * @returns {Promise<{intent: string, book: string, startChapter: number, endChapter: number, contentTypes: string[]}>}
 */
async function classifyIntent(messageContent) {
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

  let replyText = '';
  try {
    for await (const event of conversation) {
      if (abortController.signal.aborted) break;
      if (event.type === 'assistant' && event.message?.content) {
        for (const block of event.message.content) {
          if (block && typeof block.text === 'string') replyText += block.text;
        }
      }
    }
  } finally {
    clearTimeout(timer);
    try { conversation.close(); } catch (_) {}
  }

  // Extract JSON from response (may be wrapped in markdown code fences)
  const jsonMatch = replyText.match(/\{[\s\S]*\}/);
  const text = jsonMatch ? jsonMatch[0] : replyText.trim();

  try {
    const parsed = JSON.parse(text);
    if (!parsed.intent || !['generate', 'notes', 'editor-review', 'editor-note', 'unknown'].includes(parsed.intent)) {
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
      contentTypes,
      noteText: parsed.noteText || null,
    };
  } catch (err) {
    console.error(`[intent-classifier] Failed to parse response: ${replyText.slice(0, 200)}`);
    return { intent: 'unknown', book: null, startChapter: null, endChapter: null, contentTypes: ['ult', 'ust'] };
  }
}

module.exports = { classifyIntent };
