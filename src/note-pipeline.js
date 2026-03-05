// note-pipeline.js — Store editor observations about books/chapters
const fs = require('fs');
const path = require('path');
const { sendMessage, sendDM } = require('./zulip-client');
const { normalizeBookName } = require('./pipeline-utils');

const NOTES_DIR = '/workspace/data/editor-notes';

/**
 * Run the editor-note pipeline: parse, append to file, reply with count.
 */
async function editorNotePipeline(route, message) {
  // Extract fields from regex captures or Haiku-extracted data
  let book, chapter, noteText;

  if (route._noteText) {
    // Haiku NLU path — fields pre-extracted
    book = route._book ? normalizeBookName(route._book) : null;
    chapter = route._chapter || null;
    noteText = route._noteText;
  } else {
    // Regex path — captures: [book, chapter?, noteText]
    const captures = route._captures || [];
    book = captures[0] ? normalizeBookName(captures[0]) : null;
    chapter = captures[1] || null;
    noteText = captures[2] || '';
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
  const scope = chapter ? `Chapter ${chapter}` : 'Book-wide';
  const sender = message.sender_full_name || 'Unknown';

  const entry = `## ${date} — ${sender}\n**Scope:** ${scope}\n${noteText.trim()}\n\n---\n\n`;

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

  console.log(`[editor-note] Filed note for ${book}${chapter ? ' ch' + chapter : ''} from ${sender}`);
}

module.exports = { editorNotePipeline };
