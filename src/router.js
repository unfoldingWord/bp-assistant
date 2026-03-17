const config = require('./config');
const { runPipeline } = require('./pipeline-runner');
const { sendMessage, addReaction } = require('./zulip-client');
const { getSession, clearSession, hasActiveStreamSession } = require('./session-store');
const { getTotalVerses } = require('./verse-counts');
const { classifyIntent } = require('./intent-classifier');
const { preflightCheck, estimateTokens } = require('./usage-tracker');
const { getPendingMerge, clearPendingMerge } = require('./pending-merges');
const { resumeInsertion } = require('./insertion-resume');
const { normalizeBookName, isValidBook } = require('./pipeline-utils');

// In-memory pending confirmations for stream messages
const pendingConfirmations = new Map();

// TEMPORARY TEST LOCK:
// Restrict bot interactions to admin user during branch validation.
// Flip to false (or remove) after testing is complete.
const TEMP_SINGLE_USER_TEST_MODE = true;
const TEMP_TEST_LOCK_REPLY = 'I am temporarily in maintenance/testing mode for about an hour while we validate an update. Please retry shortly.';

/**
 * Detect whether the user asked for ULT only, UST only, or both.
 */
function extractContentTypes(text) {
  const upper = text.toUpperCase();
  const hasUlt = /\bULT\b/.test(upper);
  const hasUst = /\bUST\b/.test(upper);
  if (hasUlt && !hasUst) return ['ult'];
  if (hasUst && !hasUlt) return ['ust'];
  return ['ult', 'ust'];
}

/**
 * Build the editor-review system prompt dynamically based on content types.
 * @param {string[]} contentTypes
 * @param {string} [senderName] the Zulip sender's display name
 */
function buildEditorReviewSystemPrompt(contentTypes, senderName) {
  const types = contentTypes || ['ult', 'ust'];
  const typeLabel = types.map(t => t.toUpperCase()).join(' and ');
  const typeInstruction = types.length === 1
    ? `Run prepare_compare.py for ${types[0].toUpperCase()} only.`
    : `Run prepare_compare.py for both ULT and UST (skip if no AI output for a type).`;

  const senderLine = senderName
    ? `Responding to user: ${senderName}. Use this name if you need to address them.\n`
    : '';

  return `This is an editor-review request. Use the editor-compare skill (.claude/skills/editor-compare/). Extract the book and all chapter numbers from the user's message.

${senderLine}Do NOT generate @**Name** mentions -- the system handles that automatically.

For MULTIPLE chapters: spawn a subagent (Task tool) per chapter to run in parallel. Each subagent runs ${typeInstruction} analyzes the diffs, and writes its detailed analysis to tmp/editor-compare/<BOOK>-<CH>.md. Wait for all subagents, then read all summaries and do a cross-chapter analysis.

For a SINGLE chapter: run the comparison directly, no subagent needed. ${typeInstruction}

This is a MULTI-TURN conversation. Follow this protocol:

TURN 1 -- Present discrepancy list:
1. Write the FULL verse-by-verse analysis to output/editor-compare/<BOOK>/<BOOK>-<CH>-review.md
2. In your Zulip reply, present a NUMBERED discrepancy list:
   - Rank by frequency/impact: patterns in 3+ verses first, then 2, then 1
   - Each item shows: number, verse ref (ch:vs), side-by-side (AI original | Editor edit -- relevant phrase only), one-line hypothesis, category tag (vocabulary / structure / brackets / voice)
   - Use a compact markdown table or numbered list -- keep UNDER 4000 characters
   - End with: "Reply with which items to ignore (e.g. 'not 2, 8'), mark as situational (e.g. '10 is situational'), or say 'all good' to accept all. No @-mention needed."
   - Do NOT write to glossary, quick-ref, or any memory files yet.

TURN 2 -- Parse editor response and confirm:
- Parse natural language responses flexibly. Examples: "don't do 2, 8", "ai was right on 2, 8", "yes to all", "all good", "for 10, that's situational", "1, 3-7, 9 only"
- Default: if an item is NOT mentioned as ignored/situational, the human edit is accepted
- Confirm back in plain language, e.g.: "Applying human edits for 1, 3-7, 9. Ignoring 2, 8 (keeping AI version). Item 10 flagged as situational. Anything to adjust?"
- Wait for approval before executing.

TURN 3 -- Execute after approval:
- For ACCEPTED items: update glossary/quick-ref per the editor-compare skill Steps 4-5
- For IGNORED items (AI was right): log to data/editor-feedback/proofreader_patterns.csv with columns: Date,Book,Chapter,Verse,Strong,Hebrew,ProofreaderEdit,AIOriginal,Hypothesis,EditorVerdict
- For SITUATIONAL items: add conditional entries with context notes ("use X when Y, use Z when W")
- Report what was done. End with "Review complete."

OUTPUT CONSTRAINTS:
- Keep each Zulip message under 4000 characters
- Use markdown tables for the discrepancy list where practical
- Do NOT include full verse text in the Zulip reply -- only the changed phrase
- Full analysis goes in the output file`;
}

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
  let verseStart = null;
  let verseEnd = null;
  const chapterNums = [];

  for (const c of captures) {
    if (c == null) continue;
    const s = String(c).trim();
    // Book name: all letters
    if (/^[a-zA-Z]+$/.test(s)) {
      book = normalizeBookName(s);
    } else {
      // Verse-range format "CH:VS-VS" — only the chapter matters here
      const verseRange = s.match(/^(\d+):(\d+)[-–—](\d+)$/);
      if (verseRange) {
        chapterNums.push(Number(verseRange[1]));
        verseStart = Number(verseRange[2]);
        verseEnd = Number(verseRange[3]);
      } else {
        // Extract all numbers
        const nums = s.match(/\d+/g);
        if (nums) chapterNums.push(...nums.map(Number));
      }
    }
  }

  // If exactly 2 numbers and no commas in captures, treat as range
  if (chapterNums.length === 2) {
    const text = captures.filter(c => c != null).join(' ');
    if (!text.includes(',')) {
      const [a, b] = chapterNums.sort((x, y) => x - y);
      const range = [];
      for (let i = a; i <= b; i++) range.push(i);
      return { book, chapters: range, verseStart, verseEnd };
    }
  }

  return { book, chapters: chapterNums.length ? chapterNums : [1], verseStart, verseEnd };
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

/**
 * Determine the pipeline type for a route (for usage tracking).
 */
function getPipelineType(route) {
  if (route.type === 'sdk') return 'generate';
  if (route.type === 'notes') return 'notes';
  return null;
}

/**
 * Build an enriched confirmation message with token/time estimates.
 */
function buildEstimateLabel(estimate, book, startCh, endCh, verseStart, verseEnd) {
  const chCount = endCh - startCh + 1;
  let totalVerses = estimate.perChapter.reduce((s, c) => s + c.verses, 0);
  // If verse range specified, override verse count
  if (verseStart != null && verseEnd != null && chCount === 1) {
    totalVerses = verseEnd - verseStart + 1;
  }
  return `(${chCount} ch, ~${totalVerses} verses). Est: ~${estimate.estimatedMinutes} min`;
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
 * @param {{ intent: string, book: string, startChapter: number, endChapter: number, contentTypes?: string[] }} intent
 * @param {string} [senderName] the Zulip sender's display name
 */
function buildSyntheticRoute(intent, senderName) {
  // editor-note doesn't need a base route from config — handle it first
  if (intent.intent === 'editor-note') {
    const bookLabel = intent.book || 'unknown';
    const chapterLabel = intent.startChapter ? ` ${intent.startChapter}` : '';
    const scopeLabel = intent.startChapter ? `**${bookLabel} ${intent.startChapter}**` : `**${bookLabel}** (book-wide)`;
    const notePreview = intent.noteText ? `: '${intent.noteText}'` : '';
    return {
      name: 'editor-note',
      type: 'editor-note',
      reply: true,
      _synthetic: true,
      _book: bookLabel,
      _chapter: intent.startChapter || null,
      _noteText: intent.noteText || '',
      confirmMessage: `I'll file this note for ${scopeLabel}${notePreview}. Sound right? (yes/no)`,
    };
  }

  const routeNameMap = {
    'generate': 'generate-content',
    'notes': 'write-notes',
    'editor-review': 'editor-review',
  };
  const targetName = routeNameMap[intent.intent];
  const baseRoute = targetName ? config.routes.find(r => r.name === targetName) : null;
  if (!baseRoute) return null;

  const rangeLabel = intent.startChapter === intent.endChapter
    ? `${intent.book} ${intent.startChapter}`
    : `${intent.book} ${intent.startChapter}–${intent.endChapter}`;

  if (intent.intent === 'editor-review') {
    const types = intent.contentTypes || ['ult', 'ust'];
    const typeLabel = types.map(t => t.toUpperCase()).join(' & ');
    return {
      ...baseRoute,
      _synthetic: true,
      _book: intent.book,
      _startChapter: intent.startChapter,
      _endChapter: intent.endChapter,
      _contentTypes: types,
      confirmMessage: `I'll compare the human-edited **${rangeLabel}** ${typeLabel} against what the AI generated and identify improvements. Sound right? (yes/no)`,
      systemPrompt: buildEditorReviewSystemPrompt(types, senderName),
    };
  }

  return {
    ...baseRoute,
    _synthetic: true,
    _book: intent.book,
    _startChapter: intent.startChapter,
    _endChapter: intent.endChapter,
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
  `- **PSA 82 review** -- review editor changes against AI output\n` +
  `  - add **ULT** or **UST** to review just one (default: both)\n` +
  `- **note HAB 3 lots of parallelism** -- file an observation for a book/chapter`;

async function routeMessage(message) {
  const isAdmin = message.sender_id === config.adminUserId;
  const isAuthorized = config.authorizedUserIds.includes(message.sender_id);

  const isStream = message.type === 'stream';
  const sessionKey = isStream
    ? `stream-${message.display_recipient}-${message.subject}`
    : `dm-${message.sender_id}`;

  if (TEMP_SINGLE_USER_TEST_MODE && !isAdmin) {
    if (isStream) {
      console.log(`[router] Temporary test lock active — blocking user ${message.sender_id} (${message.sender_full_name})`);
      await sendMessage(message.display_recipient, message.subject, TEMP_TEST_LOCK_REPLY);
    } else {
      console.log(`[router] Temporary test lock active — ignoring DM from ${message.sender_id} (${message.sender_full_name})`);
    }
    return;
  }

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

  let { route, captures } = matchRoute(message.content);

  // Validate book name for editor-note regex matches — reject bogus captures early
  if (route && route.name === 'editor-note' && captures[0] && !isValidBook(captures[0])) {
    console.log(`[router] editor-note regex matched but "${captures[0]}" is not a valid book — falling through to Haiku`);
    route = null;
  }

  if (route) {
    // For editor-review, enrich with content types and dynamic system prompt
    let activeRoute = route;
    if (route.name === 'editor-review') {
      // Editor-review only handles ULT/UST — reject if user asked about notes/TN
      if (/\b(notes?|tn|translation[\s-]?notes?)\b/i.test(message.content)) {
        if (isStream) {
          await sendMessage(message.display_recipient, message.subject,
            'Editor-review only handles ULT and UST. Translation notes review is done manually.');
        } else {
          await sendDM(message.sender_id,
            'Editor-review only handles ULT and UST. Translation notes review is done manually.');
        }
        return;
      }
      const types = extractContentTypes(message.content);
      const typeLabel = types.map(t => t.toUpperCase()).join(' & ');
      const { book } = parseBookChapters(captures);
      const chapterPart = captures[1] || '';
      activeRoute = {
        ...route,
        _contentTypes: types,
        confirmMessage: `I'll compare the human-edited **${book || captures[0]} ${chapterPart}** ${typeLabel} against what the AI generated and identify improvements. Sound right? (yes/no)`,
        systemPrompt: buildEditorReviewSystemPrompt(types, message.sender_full_name),
      };
    }

    // Editor-note: enrich with captures, simple confirmation (no timeout/usage tracking)
    if (route.name === 'editor-note') {
      const book = normalizeBookName(captures[0] || '');
      const chapter = captures[1] || null;
      const chapterLabel = chapter ? ` ${chapter}` : ' (book-wide)';
      activeRoute = {
        ...route,
        _captures: captures,
        _book: book,
        confirmMessage: `I'll file this note for **${book}${chapterLabel}**. Sound right? (yes/no)`,
      };

      if (isStream && activeRoute.confirmMessage) {
        pendingConfirmations.set(sessionKey, { route: activeRoute, message, timeoutMs: MIN_TIMEOUT_MS });
        console.log(`[router] Awaiting confirmation for "${activeRoute.name}" in ${sessionKey}`);
        await sendMessage(message.display_recipient, message.subject,
          `@**${message.sender_full_name}** ${activeRoute.confirmMessage}`);
        return;
      }
      firePipeline(activeRoute, message);
      return;
    }

    // Stream messages get confirmation before running (if route has confirmMessage)
    if (isStream && activeRoute.confirmMessage) {
      // editor-review confirmMessage is already baked in; others need placeholder substitution
      let confirmText = activeRoute._contentTypes
        ? activeRoute.confirmMessage
        : buildConfirmMessage(activeRoute.confirmMessage, captures);
      const timeoutMs = calcTimeout(activeRoute, captures);

      // Pre-flight usage check for generate/notes pipelines
      const pipelineType = getPipelineType(activeRoute);
      if (pipelineType) {
        const { book: pfBook, chapters: pfChapters, verseStart: pfVS, verseEnd: pfVE } = parseBookChapters(captures);
        if (pfBook && pfChapters.length) {
          const pfStart = Math.min(...pfChapters);
          const pfEnd = Math.max(...pfChapters);
          const preflight = preflightCheck({ pipeline: pipelineType, book: pfBook, startCh: pfStart, endCh: pfEnd });

          if (preflight.decision === 'reject') {
            await sendMessage(message.display_recipient, message.subject,
              `@**${message.sender_full_name}** ${preflight.reason}`);
            return;
          }

          // Enrich confirmation with estimate
          const estLabel = buildEstimateLabel(preflight.estimate, pfBook, pfStart, pfEnd, pfVS, pfVE);
          confirmText = confirmText.replace(/\. Sound right\?/, ` ${estLabel}. Sound right?`);

        }
      }

      pendingConfirmations.set(sessionKey, { route: activeRoute, message, timeoutMs });
      console.log(`[router] Awaiting confirmation for "${activeRoute.name}" in ${sessionKey}`);
      await sendMessage(message.display_recipient, message.subject,
        `@**${message.sender_full_name}** ${confirmText}`);
      return;
    }
    console.log(`[router] Running route "${activeRoute.name}" for message ${message.id}`);
    firePipeline(activeRoute, message);
  } else if (!isStream && isAdmin && config.dmDefaultPipeline) {
    // Admin DMs get interactive session if no route matches
    console.log(`[router] No match -- running interactive DM pipeline for admin ${message.id}`);
    firePipeline(config.dmDefaultPipeline, message);
  } else if (isStream) {
    // Check for active session first -- follow-up messages go directly to session resume
    const session = getSession(sessionKey);
    if (session && session.sessionId) {
      console.log(`[router] Active session found — resuming for ${sessionKey}`);
      firePipeline(config.dmDefaultPipeline, message);
      return;
    }

    // No active session -- try Haiku classification for new commands
    console.log(`[router] No regex match, no active session — trying haiku intent classification`);
    let haikuMatched = false;
    try {
      const intent = await classifyIntent(message.content);
      console.log(`[router] Haiku classified as: ${JSON.stringify(intent)}`);

      // editor-note only needs book, not startChapter
      if (intent.intent === 'editor-note' && intent.book) {
        const syntheticRoute = buildSyntheticRoute(intent, message.sender_full_name);
        if (syntheticRoute) {
          const confirmText = syntheticRoute.confirmMessage;
          pendingConfirmations.set(sessionKey, { route: syntheticRoute, message, timeoutMs: MIN_TIMEOUT_MS });
          console.log(`[router] Haiku → awaiting confirmation for synthetic "editor-note" in ${sessionKey}`);
          await sendMessage(message.display_recipient, message.subject,
            `@**${message.sender_full_name}** ${confirmText}`);
          haikuMatched = true;
        }
      } else if (intent.intent !== 'unknown' && intent.book && intent.startChapter) {
        const syntheticRoute = buildSyntheticRoute(intent, message.sender_full_name);
        if (syntheticRoute) {
          const captures = intent.startChapter === intent.endChapter
            ? [intent.book, String(intent.startChapter)]
            : [intent.book, String(intent.startChapter), String(intent.endChapter)];
          let confirmText = buildConfirmMessage(syntheticRoute.confirmMessage, captures);
          const timeoutMs = calcTimeout(syntheticRoute, captures);

          // Pre-flight usage check for generate/notes pipelines
          const pipelineType = getPipelineType(syntheticRoute);
          if (pipelineType) {
            const preflight = preflightCheck({
              pipeline: pipelineType, book: intent.book,
              startCh: intent.startChapter, endCh: intent.endChapter,
            });

            if (preflight.decision === 'reject') {
              await sendMessage(message.display_recipient, message.subject,
                `@**${message.sender_full_name}** ${preflight.reason}`);
              return; // Exit routeMessage -- rejection sent
            }

            // Enrich confirmation with estimate
            const estLabel = buildEstimateLabel(preflight.estimate, intent.book, intent.startChapter, intent.endChapter);
            confirmText = confirmText.replace(/\. Sound right\?/, ` ${estLabel}. Sound right?`);

            if (preflight.decision === 'warn') {
              confirmText += `\n\n**Warning:** ${preflight.reason}`;
            }
          }

          pendingConfirmations.set(sessionKey, { route: syntheticRoute, message, timeoutMs });
          console.log(`[router] Haiku → awaiting confirmation for synthetic "${syntheticRoute.name}" in ${sessionKey}`);
          await sendMessage(message.display_recipient, message.subject,
            `@**${message.sender_full_name}** ${confirmText}`);
          haikuMatched = true;
        }
      }
    } catch (err) {
      console.error(`[router] Haiku classification failed: ${err.message}`);
    }

    if (!haikuMatched) {
      console.log(`[router] Haiku fallback didn't match — sending help`);
      await sendMessage(message.display_recipient, message.subject, HELP_TEXT);
    }
  } else {
    console.log(`[router] No match for message ${message.id}, skipping`);
  }
}

/**
 * Check if a stream topic has a pending confirmation or pending merge.
 */
function hasPendingAction(channel, topic) {
  const sessionKey = `stream-${channel}-${topic}`;
  return pendingConfirmations.has(sessionKey) || !!getPendingMerge(sessionKey);
}

/**
 * Check if a stream topic has an active interactive session for a specific sender.
 */
function hasActiveSession(channel, topic, senderId) {
  return hasActiveStreamSession(channel, topic, senderId);
}

module.exports = { routeMessage, hasPendingAction, hasActiveSession };
