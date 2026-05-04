const config = require('./config');
const { runPipeline } = require('./pipeline-runner');
const { sendMessage, sendDM, addReaction, removeReaction } = require('./zulip-client');
const { getSession, clearSession, hasActiveStreamSession } = require('./session-store');
const { getTotalVerses, getChapterCount } = require('./verse-counts');
const { classifyIntent } = require('./intent-classifier');
const { preflightCheck, estimateTokens } = require('./usage-tracker');
const { getPendingMerge, clearPendingMerge, getAllPendingMerges } = require('./pending-merges');
const { getCheckpoint, setCheckpoint, clearCheckpoint } = require('./pipeline-checkpoints');
const { listCheckpoints } = require('./pipeline-checkpoints');
const { resumeInsertion } = require('./insertion-resume');
const { normalizeBookName, isValidBook } = require('./pipeline-utils');
const { isTransientOutageError } = require('./claude-runner');
const { publishAdminStatus } = require('./admin-status');
const { handlePendingHumanDecisionConflictReply } = require('./issue-report-pipeline');

// In-memory pending confirmations for stream messages
const pendingConfirmations = new Map();
const PROCESS_STARTED_AT_MS = Date.now();

// TEMPORARY TEST LOCK:
// Restrict bot interactions to admin user during branch validation.
// Flip to false (or remove) after testing is complete.
const TEMP_SINGLE_USER_TEST_MODE = false;
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
function buildEditorReviewSystemPrompt(contentTypes, senderName, scopeText) {
  const types = contentTypes || ['ult', 'ust'];
  const typeLabel = types.map(t => t.toUpperCase()).join(' and ');
  const typeInstruction = types.length === 1
    ? `Run prepare_compare.py for ${types[0].toUpperCase()} only.`
    : `Run prepare_compare.py for both ULT and UST (skip if no AI output for a type).`;

  const senderLine = senderName
    ? `Responding to user: ${senderName}. Use this name if you need to address them.\n`
    : '';

  const scopeLine = scopeText
    ? `Requested scope from user: ${scopeText}. If this includes verse ranges (for example 1:1-6 or 2:10-3:5), restrict analysis strictly to that scope and DO NOT expand to the whole chapter/book.\n`
    : '';

  return `This is an editor-review request. Use the editor-compare skill (.claude/skills/editor-compare/). Extract the book and all chapter numbers from the user's message.

${senderLine}${scopeLine}Do NOT generate @**Name** mentions -- the system handles that automatically.

For MULTIPLE chapters: spawn a subagent (Task tool) per chapter to run in parallel. Each subagent runs ${typeInstruction} analyzes the diffs, and writes its detailed analysis to tmp/editor-compare/<BOOK>-<CH>.md. Wait for all subagents, then read all summaries and do a cross-chapter analysis.

For a SINGLE chapter: run the comparison directly, no subagent needed. ${typeInstruction}

When using prepare_compare:
- Pass verse filtering when the user asked for verse scope (verses argument, e.g. "1-6").
- Treat differences that are only curly braces/quote marks as formatting noise unless substantive wording differs.

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

function parseMergeCommand(content) {
  const t = content.trim().replace(/^@\*\*[^*]+\*\*\s*/, '');
  const m = t.match(/^(?:merged?)\s+(\w+)\s+(\d+)[\s.!]*$/i);
  if (!m) return null;
  const book = normalizeBookName(m[1]);
  return book ? { book, chapter: parseInt(m[2]) } : null;
}

function buildConfirmMessage(template, captures) {
  if (!template) return null;
  return template.replace(/\$(\d+)/g, (_, idx) => {
    const val = captures[parseInt(idx) - 1] || '';
    return /^[a-zA-Z]+$/.test(val) ? val.toUpperCase() : val;
  });
}

function buildGenerateConfirmText(baseText, rawContent) {
  if (!baseText) return baseText;
  const content = String(rawContent || '');
  if (!/^generate\b/i.test(content)) return baseText;
  if (!/--text-only\b/i.test(content)) return baseText;

  return baseText.replace(
    'generate the initial content (ULT & UST, issues draft)',
    'generate the ULT & UST files only'
  );
}

function buildWriteTqsConfirmText(route, captures) {
  let book = null;
  let startChapter = null;
  let endChapter = null;
  let wholeBook = false;

  if (route && route._synthetic) {
    book = route._book || null;
    startChapter = route._startChapter ?? null;
    endChapter = route._endChapter ?? startChapter;
    wholeBook = !!route._wholeBook;
  } else {
    const parsed = getParsedRouteScope(route || { type: 'tqs' }, captures || []);
    book = parsed.book;
    startChapter = parsed.chapters.length ? Math.min(...parsed.chapters) : null;
    endChapter = parsed.chapters.length ? Math.max(...parsed.chapters) : startChapter;
    wholeBook = !!parsed.wholeBook;
  }

  const label = !book
    ? 'that scope'
    : wholeBook
      ? book
      : startChapter === endChapter
        ? `${book} ${startChapter}`
        : `${book} ${startChapter}-${endChapter}`;
  return `I'll write translation questions for **${label}**. Sound right? (yes/no)`;
}

function normalizeScopeText(scopeText) {
  if (!scopeText) return null;
  return scopeText
    .replace(/\s*[-–—]\s*/g, '-')
    .replace(/\s*:\s*/g, ':')
    .replace(/\s*,\s*/g, ', ')
    .trim();
}

function parseIntentScope(scopeText, startChapter, endChapter) {
  const normalized = normalizeScopeText(scopeText);
  const fallbackStart = Number.isFinite(startChapter) ? startChapter : null;
  const fallbackEnd = Number.isFinite(endChapter) ? endChapter : fallbackStart;

  if (!normalized) {
    return { scopeText: null, startChapter: fallbackStart, endChapter: fallbackEnd, verseStart: null, verseEnd: null };
  }

  const crossChapterVerseRange = normalized.match(/^(\d+):(\d+)-(\d+):(\d+)$/);
  if (crossChapterVerseRange) {
    return {
      scopeText: normalized,
      startChapter: Number(crossChapterVerseRange[1]),
      endChapter: Number(crossChapterVerseRange[3]),
      verseStart: null,
      verseEnd: null,
    };
  }

  const verseRange = normalized.match(/^(\d+):(\d+)-(\d+)$/);
  if (verseRange) {
    const chapter = Number(verseRange[1]);
    return {
      scopeText: normalized,
      startChapter: chapter,
      endChapter: chapter,
      verseStart: Number(verseRange[2]),
      verseEnd: Number(verseRange[3]),
    };
  }

  const singleVerse = normalized.match(/^(\d+):(\d+)$/);
  if (singleVerse) {
    const chapter = Number(singleVerse[1]);
    const verse = Number(singleVerse[2]);
    return {
      scopeText: normalized,
      startChapter: chapter,
      endChapter: chapter,
      verseStart: verse,
      verseEnd: verse,
    };
  }

  const chapterRange = normalized.match(/^(\d+)-(\d+)$/);
  if (chapterRange) {
    return {
      scopeText: normalized,
      startChapter: Number(chapterRange[1]),
      endChapter: Number(chapterRange[2]),
      verseStart: null,
      verseEnd: null,
    };
  }

  const singleChapter = normalized.match(/^(\d+)$/);
  if (singleChapter) {
    const chapter = Number(singleChapter[1]);
    return {
      scopeText: normalized,
      startChapter: chapter,
      endChapter: chapter,
      verseStart: null,
      verseEnd: null,
    };
  }

  return {
    scopeText: normalized,
    startChapter: fallbackStart,
    endChapter: fallbackEnd,
    verseStart: null,
    verseEnd: null,
  };
}

function parseEditorNoteRemainder(remainder) {
  const raw = (remainder || '').trim();
  if (!raw) return { scope: null, noteText: '' };
  const withoutCh = raw.replace(/^ch\.?\s+/i, '');

  // Ordered from most specific to most general
  const scopePatterns = [
    /^(\d+:\d+\s*-\s*\d+:\d+)\s+(.+)$/i,                      // 2:10-3:5
    /^(\d+:\d+(?:\s*,\s*\d+:\d+(?:\s*-\s*\d+)?)*)\s+(.+)$/i, // 2:4, 2:6, 3:1-3
    /^(\d+:\d+(?:\s*-\s*\d+)?(?:\s*,\s*\d+(?:\s*-\s*\d+)?)*)\s+(.+)$/i, // 2:4,6-8
    /^(\d+(?:\s*-\s*\d+)?(?:\s*,\s*\d+(?:\s*-\s*\d+)?)*)\s+(.+)$/i,      // 2 / 2-4 / 2,4,6
  ];

  const normalizedWithoutCh = withoutCh.replace(/\s*[-–—]\s*/g, '-');

  for (const re of scopePatterns) {
    const m = normalizedWithoutCh.match(re);
    if (m) {
      return {
        scope: normalizeScopeText(m[1]),
        noteText: (m[2] || '').trim(),
      };
    }
  }

  // No recognized scope prefix -> treat as book-wide note text.
  return { scope: null, noteText: raw };
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
    // Pre-normalize dashes to standard hyphens
    const s = String(c).trim().replace(/[-–—]/g, '-');
    // Book name: all letters
    if (/^[a-zA-Z]+$/.test(s)) {
      book = normalizeBookName(s);
    } else {
      // Verse-range format "CH:VS-VS"
      const verseRange = s.match(/^(\d+):(\d+)-(\d+)$/);
      if (verseRange) {
        chapterNums.push(Number(verseRange[1]));
        verseStart = Number(verseRange[2]);
        verseEnd = Number(verseRange[3]);
      // Single-verse format "CH:VS"
      } else if (/^(\d+):(\d+)$/.test(s)) {
        const sv = s.match(/^(\d+):(\d+)$/);
        chapterNums.push(Number(sv[1]));
        verseStart = Number(sv[2]);
        verseEnd = Number(sv[2]);
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

function getParsedRouteScope(route, captures) {
  if (route && route._synthetic) {
    const start = route._startChapter;
    const end = route._endChapter ?? start;
    const chapters = [];
    if (Number.isFinite(start) && Number.isFinite(end)) {
      for (let i = start; i <= end; i++) chapters.push(i);
    }
    return {
      book: route._book || null,
      chapters,
      verseStart: route._verseStart ?? null,
      verseEnd: route._verseEnd ?? null,
      wholeBook: !!route._wholeBook,
    };
  }

  const parsed = parseBookChapters(captures || []);
  if (route?.type === 'tqs' && parsed.book && (!captures || !captures[1])) {
    const end = getChapterCount(parsed.book);
    const chapters = [];
    for (let ch = 1; ch <= end; ch++) chapters.push(ch);
    return { book: parsed.book, chapters, verseStart: null, verseEnd: null, wholeBook: true };
  }

  return { ...parsed, wholeBook: false };
}

/**
 * Calculate timeout based on actual verse counts.
 * timeout = totalVerses x operations x 5min/verse/op
 * route.operations: number of distinct operations (e.g., 3 for generate = ULT+UST+issues)
 */
function calcTimeout(route, captures) {
  const { book, chapters } = getParsedRouteScope(route, captures);
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
  if (route.type === 'tqs') return 'tqs';
  return null;
}

function getAdminPipelineType(route) {
  if (route?.type === 'sdk') return 'generate';
  if (route?.type === 'notes') return 'notes';
  if (route?.type === 'tqs') return 'tqs';
  if (route?.type === 'issue-report') return 'issue-report';
  return 'system';
}

function inferRouteScope(route, message) {
  if (route?._book && Number.isFinite(route?._startChapter) && Number.isFinite(route?._endChapter)) {
    const start = route._startChapter;
    const end = route._endChapter;
    const scope = start === end ? `${route._book} ${start}` : `${route._book} ${start}-${end}`;
    if (Number.isFinite(route?._verseStart) && Number.isFinite(route?._verseEnd) && start === end) {
      return `${route._book} ${start}:${route._verseStart}-${route._verseEnd}`;
    }
    return scope;
  }

  const content = String(message?.content || '');
  const match = content.match(/\b([1-3]?[A-Za-z]{2,})\s+(\d+(?::\d+(?:[-–—]\d+)?)?(?:\s*[-–—]\s*\d+)?)\b/);
  if (!match) return null;
  const book = normalizeBookName(match[1]);
  if (!book) return null;
  return `${book} ${String(match[2]).replace(/\s+/g, '')}`;
}

async function publishRouterFailure(route, message, err) {
  const routeName = route?.name || 'unknown';
  const errorMessage = err?.message || String(err);
  const statusMessage = `Pipeline "${routeName}" failed: ${errorMessage}`;
  try {
    await publishAdminStatus({
      source: 'router',
      pipelineType: getAdminPipelineType(route),
      scope: inferRouteScope(route, message),
      phase: 'router-dispatch',
      severity: 'error',
      message: statusMessage,
    });
  } catch (statusErr) {
    console.error(`[router] Failed to publish admin status for pipeline failure: ${statusErr.message}`);
  }
}

function getResumeCheckpoint(route, sessionKey, captures) {
  const pipelineType = getPipelineType(route);
  if (!pipelineType) return null;
  const parsed = getParsedRouteScope(route, captures || []);
  if (!parsed.book || !parsed.chapters || parsed.chapters.length === 0) return null;
  const startChapter = Math.min(...parsed.chapters);
  const endChapter = Math.max(...parsed.chapters);
  const checkpoint = getCheckpoint({
    sessionKey,
    pipelineType,
    scope: {
      book: parsed.book,
      startChapter,
      endChapter,
      verseStart: parsed.verseStart ?? null,
      verseEnd: parsed.verseEnd ?? null,
    },
  });
  if (!checkpoint) return null;
  const resumable = checkpoint.state === 'paused_for_outage' || checkpoint.state === 'paused_for_usage_limit' || checkpoint.state === 'failed' || checkpoint.state === 'running';
  if (!resumable || checkpoint?.resume?.chapter == null) return null;
  return checkpoint;
}

function getActiveCheckpoint(route, sessionKey, captures) {
  const pipelineType = getPipelineType(route);
  if (!pipelineType) return null;
  const parsed = getParsedRouteScope(route, captures || []);
  if (!parsed.book || !parsed.chapters || parsed.chapters.length === 0) return null;
  const startChapter = Math.min(...parsed.chapters);
  const endChapter = Math.max(...parsed.chapters);
  return getCheckpoint({
    sessionKey,
    pipelineType,
    scope: {
      book: parsed.book,
      startChapter,
      endChapter,
      verseStart: parsed.verseStart ?? null,
      verseEnd: parsed.verseEnd ?? null,
    },
  });
}

function isStaleRunningCheckpoint(cp) {
  if (!cp || cp.state !== 'running') return false;
  const updatedMs = Date.parse(cp.updatedAt || '');
  if (!Number.isFinite(updatedMs)) return false;
  // If checkpoint was last updated before this bot process started,
  // it cannot represent an actively running in-memory pipeline.
  return updatedMs < PROCESS_STARTED_AT_MS;
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

function isResumeStatusCommand(content) {
  const t = String(content || '').trim().toLowerCase();
  return t === 'status resume' || t === 'resume status' || t === 'operator status';
}

function isCurateCommand(content) {
  const t = String(content || '').trim().toLowerCase();
  return /^(update\s+data|curate\s+data|update\s+published|setup\s+data)/.test(t);
}

function parseCurateCommand(content) {
  const t = String(content || '').trim().toLowerCase();
  const force = t.includes('force') || t.includes('setup');
  // "update data check" / "curate data fetch-door43" / "setup data"
  const stepMatch = t.match(/\b(check|setup|fetch-door43|fetch-google|extract-english|resolve-quotes|build-indexes)\b/);
  return { step: stepMatch ? stepMatch[1] : null, force };
}

function isResumeCommand(content) {
  const cleaned = String(content || '').replace(/^@\*\*[^*]+\*\*\s*/, '').trim();
  return /^\s*resume\s*$/i.test(cleaned);
}

function hasFreshCommandFlag(content) {
  const t = String(content || '');
  return /--fresh\b/i.test(t) || /--new\b/i.test(t);
}

function formatCheckpointScope(cp) {
  const scope = cp?.scope || {};
  const book = scope.book || '?';
  const s = scope.startChapter;
  const e = scope.endChapter;
  const vs = scope.verseStart;
  const ve = scope.verseEnd;
  if (vs != null && ve != null && s === e) return `${book} ${s}:${vs}-${ve}`;
  if (s === e) return `${book} ${s}`;
  return `${book} ${s}-${e}`;
}

function matchRoute(content) {
  // Strip @mentions like @**Bot Name** or @**Bot Name|1234**
  const cleanContent = content.replace(/^@\*\*[^*]+\*\*\s*/, '').trim();
  const looksLikeApiGenerate = /^api generate\b/i.test(cleanContent);
  const looksLikeApiWriteNotes = /^api write[\s-]?notes\b/i.test(cleanContent);

  for (const route of config.routes) {
    if ((looksLikeApiGenerate || looksLikeApiWriteNotes) && route.type !== 'api') {
      continue;
    }
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
      const chapterLabel = intent.scopeText
        ? ` ${intent.scopeText}`
        : (intent.startChapter ? ` ${intent.startChapter}` : '');
      const scopeLabel = chapterLabel
        ? `**${bookLabel}${chapterLabel}**`
        : `**${bookLabel}** (book-wide)`;
    const notePreview = intent.noteText ? `: '${intent.noteText}'` : '';
    return {
      name: 'editor-note',
      type: 'editor-note',
      reply: true,
      _synthetic: true,
      _book: bookLabel,
        _scope: intent.scopeText || (intent.startChapter ? String(intent.startChapter) : null),
      _chapter: intent.startChapter || null,
      _noteText: intent.noteText || '',
      confirmMessage: `I'll file this note for ${scopeLabel}${notePreview}. Sound right? (yes/no)`,
    };
  }

  const routeNameMap = {
    'generate': 'generate-content',
    'notes': 'write-notes',
    'tqs': 'write-tqs',
    'editor-review': 'editor-review',
  };
  const targetName = routeNameMap[intent.intent];
  const baseRoute = targetName ? config.routes.find(r => r.name === targetName) : null;
  if (!baseRoute) return null;

  const rangeLabel = intent.scopeText
    ? `${intent.book} ${intent.scopeText}`
    : (intent.startChapter === intent.endChapter
      ? `${intent.book} ${intent.startChapter}`
      : `${intent.book} ${intent.startChapter}–${intent.endChapter}`);
  const parsedScope = parseIntentScope(intent.scopeText, intent.startChapter, intent.endChapter);

  if (intent.intent === 'editor-review') {
    const types = intent.contentTypes || ['ult', 'ust'];
    const typeLabel = types.map(t => t.toUpperCase()).join(' & ');
    return {
      ...baseRoute,
      _synthetic: true,
      _book: intent.book,
      _startChapter: parsedScope.startChapter,
      _endChapter: parsedScope.endChapter,
      _scopeText: parsedScope.scopeText,
      _verseStart: parsedScope.verseStart,
      _verseEnd: parsedScope.verseEnd,
      _contentTypes: types,
      confirmMessage: `I'll compare the human-edited **${rangeLabel}** ${typeLabel} against what the AI generated and identify improvements. Sound right? (yes/no)`,
        systemPrompt: buildEditorReviewSystemPrompt(types, senderName, intent.scopeText),
    };
  }

  if (intent.intent === 'tqs') {
    const wholeBook = !intent.scopeText && !Number.isFinite(intent.startChapter) && !Number.isFinite(intent.endChapter);
    const wholeBookEnd = wholeBook ? getChapterCount(intent.book) : null;
    const parsedScope = wholeBook
      ? { scopeText: null, startChapter: 1, endChapter: wholeBookEnd, verseStart: null, verseEnd: null }
      : parseIntentScope(intent.scopeText, intent.startChapter, intent.endChapter);

    return {
      ...baseRoute,
      _synthetic: true,
      _book: intent.book,
      _startChapter: parsedScope.startChapter,
      _endChapter: parsedScope.endChapter,
      _scopeText: parsedScope.scopeText,
      _verseStart: null,
      _verseEnd: null,
      _wholeBook: wholeBook,
      confirmMessage: buildWriteTqsConfirmText({
        _synthetic: true,
        _book: intent.book,
        _startChapter: parsedScope.startChapter,
        _endChapter: parsedScope.endChapter,
        _wholeBook: wholeBook,
      }),
    };
  }

  return {
    ...baseRoute,
    _synthetic: true,
    _book: intent.book,
    _startChapter: parsedScope.startChapter,
    _endChapter: parsedScope.endChapter,
    _scopeText: parsedScope.scopeText,
    _verseStart: parsedScope.verseStart,
    _verseEnd: parsedScope.verseEnd,
    confirmMessage: intent.intent === 'generate'
      ? `I'll generate the initial content (ULT & UST, issues draft) for **${rangeLabel}**. Sound right? (yes/no)`
      : `I'll write translation notes for **${rangeLabel}**. Sound right? (yes/no)`,
  };
}

/**
 * Build a synthetic route from a paused checkpoint so the pipeline can resume.
 */
function buildResumeRoute(checkpoint) {
  const routeNameMap = { generate: 'generate-content', notes: 'write-notes', tqs: 'write-tqs' };
  const targetName = routeNameMap[checkpoint.pipelineType];
  const baseRoute = targetName ? config.routes.find(r => r.name === targetName) : null;
  if (!baseRoute) return null;

  const scope = checkpoint.scope;
  const rangeLabel = scope.verseStart != null && scope.verseEnd != null && scope.startChapter === scope.endChapter
    ? `${scope.book} ${scope.startChapter}:${scope.verseStart}-${scope.verseEnd}`
    : scope.startChapter === scope.endChapter
      ? `${scope.book} ${scope.startChapter}`
      : `${scope.book} ${scope.startChapter}-${scope.endChapter}`;

  return {
    ...baseRoute,
    _synthetic: true,
    _book: scope.book,
    _startChapter: scope.startChapter,
    _endChapter: scope.endChapter,
    _verseStart: scope.verseStart || null,
    _verseEnd: scope.verseEnd || null,
    _wholeBook: scope.startChapter === 1 && scope.endChapter === getChapterCount(scope.book),
    _scopeText: rangeLabel.replace(/^\S+\s+/, ''), // chapter/verse part only
    confirmMessage: checkpoint.pipelineType === 'tqs'
      ? `I'll resume translation questions for **${rangeLabel}**. Sound right? (yes/no)`
      : `I'll resume ${checkpoint.pipelineType} for **${rangeLabel}**. Sound right? (yes/no)`,
  };
}

/**
 * Calculate timeout for a resume operation based on checkpoint scope.
 */
function calcResumeTimeout(checkpoint) {
  const scope = checkpoint.scope;
  const chapters = [];
  for (let i = scope.startChapter; i <= scope.endChapter; i++) chapters.push(i);
  const routeName = checkpoint.pipelineType === 'generate'
    ? 'generate-content'
    : checkpoint.pipelineType === 'tqs'
      ? 'write-tqs'
      : 'write-notes';
  const baseRoute = config.routes.find(r => r.name === routeName);
  const ops = baseRoute?.operations || 1;
  const totalVerses = getTotalVerses(scope.book, chapters);
  return Math.max(totalVerses * ops * MS_PER_VERSE_OP, MIN_TIMEOUT_MS);
}

/**
 * Extract pipeline conflict keys (routeName-BOOK-CH) for a route+message.
 * Returns an array of keys, or null for route types that don't need conflict detection.
 */
function getPipelineKeys(route, message) {
  if (route.type !== 'sdk' && route.type !== 'notes' && route.type !== 'tqs') return null;

  let book, chapters;

  const parsed = route._synthetic
    ? getParsedRouteScope(route, [])
    : getParsedRouteScope(route, matchRoute(message.content).captures);
  book = parsed.book;
  chapters = parsed.chapters;

  if (!book || !chapters.length) return null;
  return chapters.map(ch => `${route.name}-${book}-${ch}`);
}

/**
 * Fire-and-forget pipeline wrapper with conflict detection.
 * Launches the pipeline without awaiting it so the event loop stays responsive.
 */
function firePipeline(route, message) {
  const keys = getPipelineKeys(route, message);
  let activeCp = null;

  // Guard against duplicate retriggers for the same scope while resume/work is in progress.
  if (route.type === 'sdk' || route.type === 'notes' || route.type === 'tqs') {
    const captures = route._synthetic ? [] : matchRoute(message.content).captures;
    const sessionKey = message.type === 'stream'
      ? `stream-${message.display_recipient}-${message.subject}`
      : `dm-${message.sender_id}`;
    activeCp = getActiveCheckpoint(route, sessionKey, captures);
    if (isStaleRunningCheckpoint(activeCp)) {
      // Convert interrupted 'running' to 'failed' so it becomes resumable
      // instead of clearing the checkpoint and losing the resume point.
      setCheckpoint({
        sessionKey: activeCp.sessionKey,
        pipelineType: activeCp.pipelineType,
        scope: activeCp.scope,
      }, { state: 'failed', current: { ...activeCp.current, status: 'failed', errorKind: 'interrupted' } });
      console.warn(
        `[router] Converted interrupted checkpoint to resumable for ${activeCp.pipelineType} ${activeCp.scope?.book || ''} ` +
        `${activeCp.scope?.startChapter || ''}-${activeCp.scope?.endChapter || ''}`.trim()
      );
      activeCp = null;
    }
    if (activeCp?.state === 'running') {
      const skill = activeCp?.current?.skill || activeCp?.resume?.skill || 'current step';
      const chapter = activeCp?.current?.chapter || activeCp?.resume?.chapter || '?';
      const label = activeCp?.scope ? formatCheckpointScope(activeCp) : `${activeCp?.scope?.book || ''} ${chapter}`.trim();
      const text = `A run is already in progress for **${label}** (currently: ${skill}). ` +
        `Not starting another one; please wait for this run to finish.`;
      if (message.type === 'stream') {
        sendMessage(message.display_recipient, message.subject, text).catch(err =>
          console.error(`[router] Failed to send active-run message: ${err.message}`));
      } else {
        sendDM(message.sender_id, text).catch(err =>
          console.error(`[router] Failed to send active-run DM: ${err.message}`));
      }
      return;
    }
  }

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
    .catch(async (err) => {
      console.error(`[router] Pipeline "${route.name}" failed: ${err.message}`);
      await publishRouterFailure(route, message, err);
    })
    .finally(() => {
      if (keys) {
        for (const k of keys) activePipelines.delete(k);
      }
    });
}

const HELP_TEXT = `I can help with:\n` +
  `- **generate PSA 79** -- run initial content for a chapter\n` +
  `  - also: **generate PSA 79-81**, **generate PSA 79:1-6**, **generate PSA 79 ULT** or **UST**\n` +
  `  - flags: **--fresh**/**--new** clears old checkpoint/output; **--text-only** uploads just unaligned USFM files; **--no-align** skips alignment/repo insert; **--align-only** reuses generated files and only aligns/inserts\n` +
  `- **write notes for PSA 82** -- generate translation notes\n` +
  `  - also: **write notes PSA 82-84**, **write notes PSA 82:1-6**\n` +
  `  - flags: **--fresh**/**--new**, **--no-intro**, **--pause-before-ats**\n` +
  `- **write tqs for HAB** -- generate translation questions for a whole book\n` +
  `  - also: **write tqs for PSA 1-10** or **write tq PSA 3**; flag: **--fresh**\n` +
  `- **PSA 82 review** -- review editor changes against AI output\n` +
  `  - add **ULT** or **UST** to review just one (default: both)\n` +
  `- **note HAB 3 lots of parallelism** -- file an observation for a book/chapter\n` +
  `- **report: ...** / **issue: ...** / **bug: ...** -- file bot feedback or a bug report\n` +
  `- **resume** -- resume a paused/failed run in this topic\n` +
  `- **merged** or **merged PSA 82** -- continue insertion after you merge pending branches\n` +
  `- **api generate PSA 79** / **api write notes PSA 82** -- use the API runner`;

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
    if (isResumeStatusCommand(message.content)) {
      const paused = listCheckpoints()
        .filter((cp) => cp && (cp.state === 'paused_for_outage' || cp.state === 'paused_for_usage_limit'))
        .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
      if (paused.length === 0) {
        await sendDM(message.sender_id, 'No paused checkpoints found.');
        return;
      }
      const lines = paused.slice(0, 25).map((cp, idx) => {
        const skill = cp?.resume?.skill || cp?.current?.skill || 'unknown-skill';
        const chapter = cp?.resume?.chapter || cp?.current?.chapter || '?';
        return `${idx + 1}. ${cp.pipelineType} | ${formatCheckpointScope(cp)} | resume ${chapter} (${skill}) | updated ${cp.updatedAt || 'unknown'}`;
      });
      await sendDM(
        message.sender_id,
        `Paused checkpoints (${paused.length}):\n${lines.join('\n')}`
      );
      return;
    }
    // ── Admin DM: update published data ─────────────────────────────────
    if (isCurateCommand(message.content)) {
      const { curatePublishedData } = require('./curate-data');
      const parsed = parseCurateCommand(message.content);
      await sendDM(message.sender_id, 'Starting data curation' + (parsed.step ? ' (step: ' + parsed.step + ')' : '') + (parsed.force ? ' [force]' : '') + '...');
      try {
        const result = await curatePublishedData({
          step: parsed.step,
          force: parsed.force,
          onProgress: null, // progress goes to console logs
        });
        const summary = result.messages.slice(-5).join('\n');
        await sendDM(message.sender_id, 'Curation complete.\n' + summary);
      } catch (err) {
        console.error('[router] Curation failed:', err);
        await sendDM(message.sender_id, 'Curation failed: ' + err.message);
      }
      return;
    }
  } else {
    const handledIssueReportConflict = await handlePendingHumanDecisionConflictReply(message, { isYes, isNo });
    if (handledIssueReportConflict) return;

    // Check for pending confirmation BEFORE auth check — otherwise non-authorized
    // users talking in a topic with a pending confirmation get an unauthorized reply
    // instead of being silently ignored.
    if (pendingConfirmations.has(sessionKey)) {
      const pending = pendingConfirmations.get(sessionKey);
      const isOriginalSender = message.sender_id === pending.message.sender_id;

      if (!isOriginalSender) {
        // Someone else is talking in this topic — ignore silently
        console.log(`[router] Ignoring message from ${message.sender_full_name} in topic with pending confirmation for ${pending.message.sender_full_name}`);
        return;
      }

      if (isYes(message.content)) {
        pendingConfirmations.delete(sessionKey);
        clearSession(sessionKey);
        try { await addReaction(message.id, 'working_on_it'); } catch (_) {}
        const routeWithTimeout = { ...pending.route, timeoutMs: pending.timeoutMs };
        console.log(`[router] Confirmed -- running "${pending.route.name}" for ${sessionKey} (timeout: ${pending.timeoutMs / 60000}min)`);
        if (pending.route.name === 'editor-note') {
          try {
            await runPipeline(routeWithTimeout, pending.message);
            try { await removeReaction(message.id, 'working_on_it'); } catch (_) {}
            try { await addReaction(message.id, 'check'); } catch (_) {}
          } catch (err) {
            console.error(`[router] Pipeline "${pending.route.name}" failed: ${err.message}`);
            try { await removeReaction(message.id, 'working_on_it'); } catch (_) {}
            try { await addReaction(message.id, 'warning'); } catch (_) {}
          }
        } else {
          firePipeline(routeWithTimeout, pending.message);
        }
        return;
      } else if (isNo(message.content)) {
        pendingConfirmations.delete(sessionKey);
        console.log(`[router] Declined -- cleared pending for ${sessionKey}`);
        await sendMessage(message.display_recipient, message.subject,
          `No problem. ${HELP_TEXT}`);
        return;
      } else {
        // Not yes/no from original sender -- clear pending and re-route the new message
        pendingConfirmations.delete(sessionKey);
        console.log(`[router] New message while pending -- re-routing for ${sessionKey}`);
      }
    }

    if (!isAuthorized) {
      console.log(`[router] Unauthorized stream mention from ${message.sender_id} (${message.sender_full_name})`);
      await sendMessage(message.display_recipient, message.subject, config.unauthorizedReply);
      return;
    }
  }

  // Handle explicit "merge PSA 88" command — works from any topic
  if (isStream) {
    const mergeCmd = parseMergeCommand(message.content);
    if (mergeCmd) {
      const allPending = getAllPendingMerges();
      const match = allPending.find(pm =>
        pm.book === mergeCmd.book && pm.startChapter <= mergeCmd.chapter && pm.endChapter >= mergeCmd.chapter);
      if (match) {
        try { await addReaction(message.id, 'working_on_it'); } catch (_) {}
        console.log(`[router] Explicit merge command for ${mergeCmd.book} ${mergeCmd.chapter} — resuming ${match.sessionKey}`);
        resumeInsertion(match.sessionKey, message).catch(err =>
          console.error(`[router] resumeInsertion failed: ${err.message}`));
      } else {
        await sendMessage(message.display_recipient, message.subject,
          `No pending insertion found for ${mergeCmd.book} ${mergeCmd.chapter}.`);
      }
      return;
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
      // New commands pass through to normal routing — pending merge doesn't block new work
    }
  }

  // Handle bare "resume" command — find paused checkpoints for this topic
  if (isStream && isResumeCommand(message.content)) {
    const paused = listCheckpoints()
      .filter(cp => cp && cp.sessionKey === sessionKey &&
        (cp.state === 'paused_for_outage' || cp.state === 'paused_for_usage_limit' || cp.state === 'failed'))
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));

    if (paused.length === 0) {
      await sendMessage(message.display_recipient, message.subject,
        `@**${message.sender_full_name}** No paused pipelines to resume in this topic.`);
      return;
    }

    const cp = paused[0];
    const scope = formatCheckpointScope(cp);
    const skill = cp.resume?.skill || cp.current?.skill || '';
    const skillLabel = skill ? ` at **${skill}**` : '';
    const confirmText = `Resume **${cp.pipelineType}** for **${scope}**${skillLabel}? (yes/no)`;

    const syntheticRoute = buildResumeRoute(cp);
    if (!syntheticRoute) {
      await sendMessage(message.display_recipient, message.subject,
        `@**${message.sender_full_name}** Found a paused checkpoint but couldn't build a route for it. Try re-sending the original command.`);
      return;
    }

    const timeoutMs = calcResumeTimeout(cp);
    pendingConfirmations.set(sessionKey, { route: syntheticRoute, message, timeoutMs });
    console.log(`[router] Resume command — awaiting confirmation for ${cp.pipelineType} ${scope} in ${sessionKey}`);
    await sendMessage(message.display_recipient, message.subject,
      `@**${message.sender_full_name}** ${confirmText}`);
    return;
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
        systemPrompt: buildEditorReviewSystemPrompt(types, message.sender_full_name, captures[1]),
      };
    }

    // Editor-note: enrich with captures, simple confirmation (no timeout/usage tracking)
    if (route.name === 'editor-note') {
      const book = normalizeBookName(captures[0] || '');
      const parsed = parseEditorNoteRemainder(captures[1] || '');
      const scopeLabel = parsed.scope ? ` ${parsed.scope}` : ' (book-wide)';
      activeRoute = {
        ...route,
        _captures: captures,
        _book: book,
        _scope: parsed.scope,
        _noteText: parsed.noteText,
        confirmMessage: `I'll file this note for **${book}${scopeLabel}**. Sound right? (yes/no)`,
      };

      if (!parsed.noteText) {
        await sendMessage(
          message.display_recipient,
          message.subject,
          `@**${message.sender_full_name}** Please include note text after the scope. Example: \`note ${book} 2:10-3:5 your note here\``
        );
        return;
      }

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
      let confirmText = activeRoute.name === 'write-tqs'
        ? buildWriteTqsConfirmText(activeRoute, captures)
        : activeRoute._contentTypes
          ? activeRoute.confirmMessage
          : buildConfirmMessage(activeRoute.confirmMessage, captures);
      if (activeRoute.name === 'write-notes' && /--pause-before-ats\b/i.test(message.content)) {
        confirmText += `\n\nPause mode enabled: I will stop after writing notes and wait for \`resume\` before alternate translations.`;
      }
      if (activeRoute.name === 'generate-content') {
        confirmText = buildGenerateConfirmText(confirmText, message.content);
      }
      const timeoutMs = calcTimeout(activeRoute, captures);

      // Pre-flight usage check for generate/notes pipelines
      const pipelineType = getPipelineType(activeRoute);
      if (pipelineType) {
          const { book: pfBook, chapters: pfChapters, verseStart: pfVS, verseEnd: pfVE } = getParsedRouteScope(activeRoute, captures);
        if (pfBook && pfChapters.length) {
          const pfStart = Math.min(...pfChapters);
          const pfEnd = Math.max(...pfChapters);
          const preflight = await preflightCheck({ pipeline: pipelineType, book: pfBook, startCh: pfStart, endCh: pfEnd });

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
      const resumeCheckpoint = getResumeCheckpoint(activeRoute, sessionKey, captures);
      const freshRequested = hasFreshCommandFlag(message.content);
      if (freshRequested) {
        confirmText += `\n\nFresh mode requested: I will clear old artifacts/checkpoint for this scope and start from scratch.`;
      } else if (resumeCheckpoint?.resume?.chapter) {
        const resumeSkill = resumeCheckpoint.resume.skill ? ` (${resumeCheckpoint.resume.skill})` : '';
        confirmText += `\n\nI found saved progress and will resume from **${resumeCheckpoint.scope.book} ${resumeCheckpoint.resume.chapter}**${resumeSkill} after you confirm.`;
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
    // Admin DMs: try Haiku classification for structured commands before interactive DM fallback
    let dmHaikuMatched = false;
    try {
      const intent = await classifyIntent(message.content);
      console.log(`[router] DM Haiku classified as: ${JSON.stringify(intent)}`);

      if (intent.intent === 'editor-note' && intent.book) {
        const syntheticRoute = buildSyntheticRoute(intent, message.sender_full_name);
        if (syntheticRoute) {
          console.log(`[router] DM Haiku → routing to editor-note for ${intent.book}`);
          firePipeline(syntheticRoute, message);
          dmHaikuMatched = true;
        }
      }
    } catch (err) {
      console.error(`[router] DM Haiku classification failed: ${err.message}`);
      if (isTransientOutageError(err)) {
        await sendDM(message.sender_id, 'Claude is temporarily down, please retry shortly.');
        return;
      }
    }

    if (!dmHaikuMatched) {
      // Fall back to interactive DM session for open-ended requests
      console.log(`[router] No match -- running interactive DM pipeline for admin ${message.id}`);
      firePipeline(config.dmDefaultPipeline, message);
    }
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
      } else if (intent.intent !== 'unknown' && intent.book && (intent.startChapter || intent.intent === 'tqs')) {
        const syntheticRoute = buildSyntheticRoute(intent, message.sender_full_name);
        if (syntheticRoute) {
          const captures = intent.scopeText
            ? [intent.book, intent.scopeText]
            : (!intent.startChapter && intent.intent === 'tqs')
              ? [intent.book]
              : (intent.startChapter === intent.endChapter
              ? [intent.book, String(intent.startChapter)]
              : [intent.book, String(intent.startChapter), String(intent.endChapter)]);
          let confirmText = syntheticRoute.name === 'write-tqs'
            ? buildWriteTqsConfirmText(syntheticRoute, captures)
            : buildConfirmMessage(syntheticRoute.confirmMessage, captures);
          if (syntheticRoute.name === 'write-notes' && /--pause-before-ats\b/i.test(message.content)) {
            confirmText += `\n\nPause mode enabled: I will stop after writing notes and wait for \`resume\` before alternate translations.`;
          }
          if (syntheticRoute.name === 'generate-content') {
            confirmText = buildGenerateConfirmText(confirmText, message.content);
          }
          const timeoutMs = calcTimeout(syntheticRoute, captures);

          // Pre-flight usage check for generate/notes pipelines
          const pipelineType = getPipelineType(syntheticRoute);
          if (pipelineType) {
            const preflight = await preflightCheck({
              pipeline: pipelineType, book: syntheticRoute._book,
              startCh: syntheticRoute._startChapter, endCh: syntheticRoute._endChapter,
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
          const resumeCheckpoint = getResumeCheckpoint(syntheticRoute, sessionKey, captures);
          const freshRequested = hasFreshCommandFlag(message.content);
          if (freshRequested) {
            confirmText += `\n\nFresh mode requested: I will clear old artifacts/checkpoint for this scope and start from scratch.`;
          } else if (resumeCheckpoint?.resume?.chapter) {
            const resumeSkill = resumeCheckpoint.resume.skill ? ` (${resumeCheckpoint.resume.skill})` : '';
            confirmText += `\n\nI found saved progress and will resume from **${resumeCheckpoint.scope.book} ${resumeCheckpoint.resume.chapter}**${resumeSkill} after you confirm.`;
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
      if (isTransientOutageError(err)) {
        await sendMessage(message.display_recipient, message.subject, `@**${message.sender_full_name}** Claude is temporarily down, you'll need to re-trigger.`);
        return;
      }
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

module.exports = {
  routeMessage,
  hasPendingAction,
  hasActiveSession,
  extractContentTypes,
  buildGenerateConfirmText,
  buildWriteTqsConfirmText,
  buildSyntheticRoute,
  parseIntentScope,
};
