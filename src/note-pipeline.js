// note-pipeline.js — Store editor observations about books/chapters
const fs = require('fs');
const path = require('path');
const { sendMessage, sendDM } = require('./zulip-client');
const { normalizeBookName } = require('./pipeline-utils');

const CSKILLBP_DIR = process.env.CSKILLBP_DIR || '/workspace';
const NOTES_DIR = path.join(CSKILLBP_DIR, 'data', 'editor-notes');

/**
 * Run the editor-note pipeline: parse, append to file, reply with count.
 */
async function editorNotePipeline(route, message) {
  // Extract fields from regex captures or Haiku-extracted data
  let book, scope, noteText;

  if (typeof route._noteText === 'string') {
    // Parsed route path — fields pre-extracted
    book = route._book ? normalizeBookName(route._book) : null;
    scope = route._scope || null;
    noteText = route._noteText;
  } else {
    // Backward-compatible regex path
    const captures = route._captures || [];
    book = captures[0] ? normalizeBookName(captures[0]) : null;
    scope = null;
    noteText = captures[1] || '';
  }

  if (!book) {
    const replyFn = message.type === 'stream'
      ? (text) => sendMessage(message.display_recipient, message.subject, text)
      : (text) => sendDM(message.sender_id, text);
    await replyFn("Couldn't determine the book. Usage: `note JER lots of implicit info`");
    return;
  }

  // Ensure directory exists
  if (!fs.existsSync(NOTES_DIR)) {
    fs.mkdirSync(NOTES_DIR, { recursive: true });
  }

  const filePath = path.join(NOTES_DIR, `${book}.md`);
  const date = new Date().toISOString().slice(0, 10);
  const scopeText = scope ? `Scope ${scope}` : 'Book-wide';
  const sender = message.sender_full_name || 'Unknown';

  const entry = `## ${date} — ${sender}\n**Scope:** ${scopeText}\n${noteText.trim()}\n\n---\n\n`;

  fs.appendFileSync(filePath, entry, 'utf8');

  // Count notes on file
  const content = fs.readFileSync(filePath, 'utf8');
  const noteCount = (content.match(/^## \d{4}-\d{2}-\d{2}/gm) || []).length;

  const reply = `Filed for **${book}** — ${noteCount} note${noteCount === 1 ? '' : 's'} on file.`;

  if (message.type === 'stream') {
    await sendMessage(message.display_recipient, message.subject, reply);
  } else {
    await sendDM(message.sender_id, reply);
  }

  console.log(`[editor-note] Filed note for ${book}${scope ? ` (${scope})` : ''} from ${sender}`);
}

module.exports = { editorNotePipeline };
