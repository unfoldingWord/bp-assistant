// intent-classifier.js — Haiku-based NLU for routing natural language messages

const Anthropic = require('@anthropic-ai/sdk');

let client = null;
function getClient() {
  if (!client) client = new Anthropic();  // uses ANTHROPIC_API_KEY from env
  return client;
}

/**
 * Classify a Zulip message into a pipeline intent.
 * Only called when regex routes don't match — cost ~$0.001 per call.
 *
 * @param {string} messageContent - Raw message text
 * @returns {Promise<{intent: string, book: string, startChapter: number, endChapter: number}>}
 */
async function classifyIntent(messageContent) {
  const response = await getClient().messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    system: `You classify Zulip messages about Bible translation work.
Extract the intent and parameters as JSON. Valid intents:
- "generate": user wants ULT and/or UST generated for chapters
- "notes": user wants translation notes produced for chapters
- "unknown": doesn't match either pattern

Always extract book as a 3-letter code (PSA for Psalms, GEN for Genesis, EXO for Exodus, etc.) and chapter range.
If only one chapter is mentioned, startChapter and endChapter should be the same.
If you can't determine the book or chapters, use intent "unknown".

Respond ONLY with JSON, no other text: {"intent":"...","book":"...","startChapter":N,"endChapter":N}`,
    messages: [{ role: 'user', content: messageContent }],
  });

  const text = response.content[0].text.trim();

  try {
    const parsed = JSON.parse(text);
    // Validate shape
    if (!parsed.intent || !['generate', 'notes', 'unknown'].includes(parsed.intent)) {
      return { intent: 'unknown', book: null, startChapter: null, endChapter: null };
    }
    return {
      intent: parsed.intent,
      book: parsed.book ? parsed.book.toUpperCase() : null,
      startChapter: parsed.startChapter ?? null,
      endChapter: parsed.endChapter ?? null,
    };
  } catch (err) {
    console.error(`[intent-classifier] Failed to parse haiku response: ${text}`);
    return { intent: 'unknown', book: null, startChapter: null, endChapter: null };
  }
}

module.exports = { classifyIntent };
