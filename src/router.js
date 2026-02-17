const config = require('../config.json');
const { runPipeline } = require('./pipeline-runner');
const { sendMessage, addReaction } = require('./zulip-client');
const { getSession, clearSession } = require('./session-store');
const { getTotalVerses } = require('./verse-counts');
const { classifyIntent } = require('./intent-classifier');
const { getPendingMerge, clearPendingMerge } = require('./pending-merges');
const { resumeInsertion } = require('./insertion-resume');

// In-memory pending confirmations for stream messages
const pendingConfirmations = new Map();

// Track running pipelines to block duplicate chapter runs
const activePipelines = new Set();

const MIN_TIMEOUT_MS = 10 * 60 * 1000; // 10 min floor
const MS_PER_VERSE_OP = 5 * 60 * 1000; // 5 min per verse per operation

function isYes(content) {
  const t = content.trim().toLowerCase().replace(/^@\*\*[^*]+\*\*\s*/, '');
  return /^(y|yes|yep|yeah|yea|correct|sure|do it|go|go ahead|ok|okay)[\s.!]*$/.test(t);
}

function isNo(content) {
  const t = content.trim().toLowerCase().replace(/^@\*\*[^*]+\*\*\s*/, '');
  return /^(n|no|nope|nah|cancel|wrong|never ?mind)[\s.!]*$/.test(t);
}

function isMerged(content) {
  const t = content.trim().toLowerCase().replace(/^@\*\*[^*]+\*\*\s*/, '');
  return /^(merged|done|i merged|it'?s merged|branches? merged|go ahead)[\s.!]*$/.test(t);
}

function isCancelMerge(content) {
  const t = content.trim().toLowerCase().replace(/^@\*\*[^*]+\*\*\s*/, '');
  return /^(cancel|discard|nevermind|never ?mind|forget it|start over)[\s.!]*$/.test(t);
}

function buildConfirmMessage(template, captures) {
  if (!template) return null;
  return template.replace(/\$(\d+)/g, (_, idx) => {
    const val = captures[parseInt(idx) - 1] || '';
    return /^[a-zA-Z]+$/.test(val) ? val.toUpperCase() : val;
  });
}

/**
 * Parse book and chapter numbers from regex captures.
 * Returns { book, chapters[] }.
 */
function parseBookChapters(captures) {
  let book = null;
  const chapterNums = [];

  for (const c of captures) {
    if (c == null) continue;
    const s = String(c).trim();
    // Book name: all letters
    if (/^[a-zA-Z]+$/.test(s)) {
      book = s.toUpperCase();
      // Normalize psalm variants
      if (/^PSALMS?$/i.test(s)) book = 'PSA';
    } else {
      // Extract all numbers
      const nums = s.match(/\d+/g);
      if (nums) chapterNums.push(...nums.map(Number));
    }
  }

  // If exactly 2 numbers and no commas in captures, treat as range
  if (chapterNums.length === 2) {
    const text = captures.filter(c => c != null).join(' ');
    if (!text.includes(',')) {
      const [a, b] = chapterNums.sort((x, y) => x - y);
      const range = [];
      for (let i = a; i <= b; i++) range.push(i);
      return { book, chapters: range };
    }
  }

  return { book, chapters: chapterNums.length ? chapterNums : [1] };
}

/**
 * Calculate timeout based on actual verse counts.
 * timeout = totalVerses x operations x 5min/verse/op
 * route.operations: number of distinct operations (e.g., 3 for generate = ULT+UST+issues)
 */
function calcTimeout(route, captures) {
  const { book, chapters } = parseBookChapters(captures);
  const ops = route.operations || 1;
  const totalVerses = book ? getTotalVerses(book, chapters) : chapters.length * 20;
  const total = totalVerses * ops * MS_PER_VERSE_OP;
  const result = Math.max(total, MIN_TIMEOUT_MS);
  console.log(`[router] Timeout: ${totalVerses} verses x ${ops} ops x 5min = ${result / 60000}min`);
  return result;
}

function matchRoute(content) {
  // Strip @mentions like @**Bot Name** or @**Bot Name|1234**
  const cleanContent = content.replace(/^@\*\*[^*]+\*\*\s*/, '').trim();

  for (const route of config.routes) {
    const pattern = route.match;

    // Support /regex/ patterns
    const regexMatch = pattern.match(/^\/(.+)\/([gimsuy]*)$/);
    if (regexMatch) {
      const regex = new RegExp(regexMatch[1], regexMatch[2] || 'i');
      const execResult = regex.exec(cleanContent);
      if (execResult) {
        console.log(`[router] Route "${route.name}" matched "${cleanContent}"`);
        return { route, captures: Array.from(execResult).slice(1) };
      }
    } else {
      // Substring match (case-insensitive)
      if (cleanContent.toLowerCase().includes(pattern.toLowerCase())) {
        console.log(`[router] Route "${route.name}" matched "${cleanContent}"`);
        return { route, captures: [] };
      }
    }
  }

  console.log(`[router] No route matched "${cleanContent}"`);
  return { route: null, captures: [] };
}

/**
 * Build a synthetic route from haiku intent classification.
 * Reuses existing route config (confirmMessage, operations, etc.) with extracted params.
 */
function buildSyntheticRoute(intent) {
  const baseRoute = config.routes.find(r =>
    (intent.intent === 'generate' && r.name === 'generate-content') ||
    (intent.intent === 'notes' && r.name === 'write-notes')
  );
  if (!baseRoute) return null;

  const rangeLabel = intent.startChapter === intent.endChapter
    ? `${intent.book} ${intent.startChapter}`
    : `${intent.book} ${intent.startChapter}–${intent.endChapter}`;

  return {
    ...baseRoute,
    _synthetic: true,
    _book: intent.book,
    _startChapter: intent.startChapter,
    _endChapter: intent.endChapter,
    // Override confirmMessage with the extracted parameters baked in
    confirmMessage: intent.intent === 'generate'
      ? `I'll generate the initial content (ULT & UST, issues draft) for **${rangeLabel}**. Sound right? (yes/no)`
      : `I'll write translation notes for **${rangeLabel}**. Sound right? (yes/no)`,
  };
}

/**
 * Extract pipeline conflict keys (routeName-BOOK-CH) for a route+message.
 * Returns an array of keys, or null for route types that don't need conflict detection.
 */
function getPipelineKeys(route, message) {
  if (route.type !== 'sdk' && route.type !== 'notes') return null;

  let book, chapters;

  if (route._synthetic) {
    book = route._book;
    const start = route._startChapter;
    const end = route._endChapter;
    chapters = [];
    for (let i = start; i <= end; i++) chapters.push(i);
  } else {
    const { captures } = matchRoute(message.content);
    const parsed = parseBookChapters(captures);
    book = parsed.book;
    chapters = parsed.chapters;
  }

  if (!book || !chapters.length) return null;
  return chapters.map(ch => `${route.name}-${book}-${ch}`);
}

/**
 * Fire-and-forget pipeline wrapper with conflict detection.
 * Launches the pipeline without awaiting it so the event loop stays responsive.
 */
function firePipeline(route, message) {
  const keys = getPipelineKeys(route, message);

  if (keys) {
    const conflicts = keys.filter(k => activePipelines.has(k));
    if (conflicts.length > 0) {
      const [, book, ch] = conflicts[0].match(/^[^-]+-(.+)-(\d+)$/);
      const label = route.name.replace(/-/g, ' ');
      const text = `A **${label}** pipeline is already running for **${book} ${ch}**. Please wait for it to finish.`;

      if (message.type === 'stream') {
        sendMessage(message.display_recipient, message.subject, text).catch(err =>
          console.error(`[router] Failed to send conflict message: ${err.message}`));
      }
      return;
    }
    for (const k of keys) activePipelines.add(k);
  }

  runPipeline(route, message)
    .catch(err => console.error(`[router] Pipeline "${route.name}" failed: ${err.message}`))
    .finally(() => {
      if (keys) {
        for (const k of keys) activePipelines.delete(k);
      }
    });
}

const HELP_TEXT = `I can help with:\n` +
  `- **generate PSA 79** -- run the initial pipeline for a chapter\n` +
  `- **write notes for PSA 82** -- generate translation notes\n` +
  `- **PSA 82 DCS review** -- review editor changes (also works with "master")`;

async function routeMessage(message) {
  const isAdmin = message.sender_id === config.adminUserId;
  const isAuthorized = config.authorizedUserIds.includes(message.sender_id);

  const isStream = message.type === 'stream';
  const sessionKey = isStream
    ? `stream-${message.display_recipient}-${message.subject}`
    : `dm-${message.sender_id}`;

  if (!isStream) {
    // ONLY admin can DM the bot
    if (!isAdmin) {
      console.log(`[router] Ignoring DM from unauthorized user ${message.sender_id} (${message.sender_full_name})`);
      return;
    }
  } else {
    if (!isAuthorized) {
      console.log(`[router] Unauthorized stream mention from ${message.sender_id} (${message.sender_full_name})`);
      await sendMessage(message.display_recipient, message.subject, config.unauthorizedReply);
      return;
    }
  }

  // Check for pending confirmation on stream messages
  if (isStream && pendingConfirmations.has(sessionKey)) {
    const pending = pendingConfirmations.get(sessionKey);
    if (isYes(message.content)) {
      pendingConfirmations.delete(sessionKey);
      clearSession(sessionKey);
      try { await addReaction(message.id, 'working_on_it'); } catch (_) {}
      const routeWithTimeout = { ...pending.route, timeoutMs: pending.timeoutMs };
      console.log(`[router] Confirmed -- running "${pending.route.name}" for ${sessionKey} (timeout: ${pending.timeoutMs / 60000}min)`);
      firePipeline(routeWithTimeout, pending.message);
      return;
    } else if (isNo(message.content)) {
      pendingConfirmations.delete(sessionKey);
      console.log(`[router] Declined -- cleared pending for ${sessionKey}`);
      await sendMessage(message.display_recipient, message.subject,
        `No problem. ${HELP_TEXT}`);
      return;
    } else {
      // Not yes/no -- clear pending and re-route the new message
      pendingConfirmations.delete(sessionKey);
      console.log(`[router] New message while pending -- re-routing for ${sessionKey}`);
    }
  }

  // Check for pending merge (deferred repo-insert waiting for user to merge branches)
  if (isStream) {
    const pendingMerge = getPendingMerge(sessionKey);
    if (pendingMerge) {
      if (isMerged(message.content)) {
        try { await addReaction(message.id, 'working_on_it'); } catch (_) {}
        console.log(`[router] User said merged -- resuming insertion for ${sessionKey}`);
        resumeInsertion(sessionKey, message).catch(err =>
          console.error(`[router] resumeInsertion failed: ${err.message}`));
        return;
      }
      if (isCancelMerge(message.content)) {
        clearPendingMerge(sessionKey);
        console.log(`[router] User cancelled pending merge for ${sessionKey}`);
        await sendMessage(message.display_recipient, message.subject,
          `Pending insertion discarded. Generated files are still in the output folder if you need them later.`);
        return;
      }
      // Check if this is a new generate/notes command for the same book
      const { route: newRoute } = matchRoute(message.content);
      if (newRoute && (newRoute.name === 'generate-content' || newRoute.name === 'write-notes')) {
        await sendMessage(message.display_recipient, message.subject,
          `There's a pending insertion waiting for you to merge branches. Say **merged** when done, or **cancel** to discard it.`);
        return;
      }
      // Other messages pass through to normal routing
    }
  }

  const { route, captures } = matchRoute(message.content);

  if (route) {
    // Stream messages get confirmation before running (if route has confirmMessage)
    if (isStream && route.confirmMessage) {
      const confirmText = buildConfirmMessage(route.confirmMessage, captures);
      const timeoutMs = calcTimeout(route, captures);
      pendingConfirmations.set(sessionKey, { route, message, timeoutMs });
      console.log(`[router] Awaiting confirmation for "${route.name}" in ${sessionKey}`);
      await sendMessage(message.display_recipient, message.subject,
        `@**${message.sender_full_name}** ${confirmText}`);
      return;
    }
    console.log(`[router] Running route "${route.name}" for message ${message.id}`);
    firePipeline(route, message);
  } else if (!isStream && isAdmin && config.dmDefaultPipeline) {
    // Admin DMs get interactive session if no route matches
    console.log(`[router] No match -- running interactive DM pipeline for admin ${message.id}`);
    firePipeline(config.dmDefaultPipeline, message);
  } else if (isStream) {
    const session = getSession(sessionKey);
    if (session && session.sessionId) {
      console.log(`[router] Resuming stream session for ${sessionKey}`);
      firePipeline(config.dmDefaultPipeline, message);
    } else {
      // No regex match — try haiku intent classification as fallback
      console.log(`[router] No regex match — trying haiku intent classification`);
      try {
        const intent = await classifyIntent(message.content);
        console.log(`[router] Haiku classified as: ${JSON.stringify(intent)}`);

        if (intent.intent !== 'unknown' && intent.book && intent.startChapter) {
          const syntheticRoute = buildSyntheticRoute(intent);
          if (syntheticRoute) {
            const captures = intent.startChapter === intent.endChapter
              ? [intent.book, String(intent.startChapter)]
              : [intent.book, String(intent.startChapter), String(intent.endChapter)];
            const confirmText = buildConfirmMessage(syntheticRoute.confirmMessage, captures);
            const timeoutMs = calcTimeout(syntheticRoute, captures);
            pendingConfirmations.set(sessionKey, { route: syntheticRoute, message, timeoutMs });
            console.log(`[router] Haiku → awaiting confirmation for synthetic "${syntheticRoute.name}" in ${sessionKey}`);
            await sendMessage(message.display_recipient, message.subject,
              `@**${message.sender_full_name}** ${confirmText}`);
            return;
          }
        }
      } catch (err) {
        console.error(`[router] Haiku classification failed: ${err.message}`);
      }

      console.log(`[router] Haiku fallback didn't match — sending help`);
      await sendMessage(message.display_recipient, message.subject, HELP_TEXT);
    }
  } else {
    console.log(`[router] No match for message ${message.id}, skipping`);
  }
}

module.exports = { routeMessage };
