const config = require('./config');
const { runPipeline } = require('./pipeline-runner');
const { sendMessage, sendDM, addReaction, removeReaction } = require('./zulip-client');
const { getSession, clearSession, hasActiveStreamSession } = require('./session-store');
const { getTotalVerses, getChapterCount } = require('./verse-counts');
const { classifyIntent } = require('./intent-classifier');
const { preflightCheck, estimateTokens } = require('./usage-tracker');
const { clearPendingMerge, getAllPendingMerges, getPendingMergesForSession } = require('./pending-merges');
const { getCheckpoint, setCheckpoint, clearCheckpoint, buildCheckpointKey } = require('./pipeline-checkpoints');
const { listCheckpoints } = require('./pipeline-checkpoints');
const { resumeInsertion } = require('./insertion-resume');
const { normalizeBookName, isValidBook } = require('./pipeline-utils');
const { translateSessionSuffix } = require('./lib/translate-core');
const {
  ROUTE_RESOURCE_TYPE, ROUTE_NAME_BY_RESOURCE_TYPE, articleScopeBook, isArticleResource,
} = require('./lib/resource-types');
const { isTransientOutageError } = require('./claude-runner');
const { publishAdminStatus } = require('./admin-status');
const { handlePendingHumanDecisionConflictReply } = require('./issue-report-pipeline');
const { isInterruptedRunningCheckpoint } = require('./pipeline-liveness');

// In-memory pending confirmations for stream messages
const pendingConfirmations = new Map();

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

function stripMentions(content) {
  // Strip @**Name** or @**Name|id** from both leading and trailing positions
  // so "yes @**BPbot**" and "@**BPbot** yes" both reduce to "yes"
  return content.trim().toLowerCase()
    .replace(/^@\*\*[^*]+\*\*\s*/, '')
    .replace(/\s*@\*\*[^*]+\*\*$/, '');
}

function isYes(content) {
  const t = stripMentions(content);
  return /^(y|yes|yep|yeah|yea|correct|sure|do it|go|go ahead|ok|okay)[\s.!]*$/.test(t);
}

function isNo(content) {
  const t = stripMentions(content);
  return /^(n|no|nope|nah|cancel|wrong|never ?mind)[\s.!]*$/.test(t);
}

function isMerged(content) {
  const t = stripMentions(content);
  return /^(merged|done|i merged|it'?s merged|branches? merged|go ahead)[\s.!]*$/.test(t);
}

function isCancelMerge(content) {
  const t = stripMentions(content);
  return /^(cancel|discard|nevermind|never ?mind|forget it|start over)[\s.!]*$/.test(t);
}

function parseMergeCommand(content) {
  const t = content.trim().replace(/^@\*\*[^*]+\*\*\s*/, '');
  const m = t.match(/^(?:merged?)\s+(\w+)\s+(\d+)[\s.!]*$/i);
  if (!m) return null;
  const book = normalizeBookName(m[1]);
  return book ? { book, chapter: parseInt(m[2]) } : null;
}

// Scope-addressed counterpart to parseMergeCommand: discard one specific
// deferred run when several share a topic (e.g. the API control thread).
function parseCancelCommand(content) {
  const t = content.trim().replace(/^@\*\*[^*]+\*\*\s*/, '');
  const m = t.match(/^(?:cancel|discard)\s+(\w+)\s+(\d+)[\s.!]*$/i);
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
    // Book name: all letters. First all-letters token wins — later alpha
    // tokens (e.g. the target-language code in "translate notes OBA 1 to ar")
    // must not overwrite the book.
    if (/^[a-zA-Z]+$/.test(s)) {
      if (book === null) book = normalizeBookName(s);
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

  // translate article routes (tW/tA) have no book/chapter — their checkpoint/
  // conflict scope uses a fixed placeholder book (the sessionKey suffix carries
  // the article id). Zulip captures for these routes are [articleRef, lang].
  if (route?.type === 'translate') {
    const rt = ROUTE_RESOURCE_TYPE[route.name] || 'tn';
    if (isArticleResource(rt)) {
      return { book: articleScopeBook(rt), chapters: [1], verseStart: null, verseEnd: null, wholeBook: false };
    }
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
  if (route.type === 'translate') return 'translate';
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
  // Shared with /health/pipelines and the job-status endpoint — see
  // pipeline-liveness.js for why this must not be reimplemented inline.
  return isInterruptedRunningCheckpoint(cp);
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
  if (route.type !== 'sdk' && route.type !== 'notes' && route.type !== 'tqs' && route.type !== 'translate') return null;

  let book, chapters;

  const captures = route._synthetic ? [] : matchRoute(message.content).captures;
  const parsed = getParsedRouteScope(route, captures);
  book = parsed.book;
  chapters = parsed.chapters;

  if (!book || !chapters.length) return null;
  // translate runs are additionally keyed by target language: ar OBA 1 and
  // es OBA 1 are independent work and must not conflict. resourceType is
  // implicit in route.name (translate-notes/questions/tw/ta).
  if (route.type === 'translate') {
    const rt = route._translate?.resourceType || ROUTE_RESOURCE_TYPE[route.name] || 'tn';
    // Article routes: [articleRef, lang]; TSV routes: [book, scope, lang].
    const lang = (route._translate?.targetLang
      || String(captures[isArticleResource(rt) ? 1 : 2] || '')).toLowerCase();
    const langDim = lang ? `-${lang}` : '';
    if (isArticleResource(rt)) {
      const ref = route._translate?.articleId || route._translate?.articleUrl || String(captures[0] || '');
      const suffix = translateSessionSuffix(lang || 'x', null, { resourceType: rt, articleId: ref });
      return [`${route.name}${suffix}`];
    }
    return chapters.map(ch => `${route.name}${langDim}-${book}-${ch}`);
  }
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
  if (route.type === 'sdk' || route.type === 'notes' || route.type === 'tqs' || route.type === 'translate') {
    const captures = route._synthetic ? [] : matchRoute(message.content).captures;
    let sessionKey = message.type === 'stream'
      ? `stream-${message.display_recipient}-${message.subject}`
      : `dm-${message.sender_id}`;
    // translate checkpoints are lang-suffixed (see translate-pipeline
    // buildSessionKey); match that here or the guard never finds them. On a
    // scope mismatch getActiveCheckpoint returns null (no false block).
    if (route.type === 'translate') {
      const rt = route._translate?.resourceType || ROUTE_RESOURCE_TYPE[route.name] || 'tn';
      const article = isArticleResource(rt);
      const lang = (route._translate?.targetLang || String(captures[article ? 1 : 2] || '')).toLowerCase();
      const articleId = article
        ? (route._translate?.articleId || route._translate?.articleUrl || String(captures[0] || ''))
        : null;
      sessionKey = `${sessionKey}${translateSessionSuffix(lang, route._translate?.rowIds, { resourceType: rt, articleId })}`;
    }
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
      const m = conflicts[0].match(/^[^-]+-(.+)-(\d+)$/);
      const label = route.name.replace(/-/g, ' ');
      const scopeLabel = m ? `${m[1]} ${m[2]}` : conflicts[0];
      const text = `A **${label}** pipeline is already running for **${scopeLabel}**. Please wait for it to finish.`;

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
  `- **merged** or **merge PSA 82** -- continue insertion after you merge pending branches\n` +
  `- **cancel** or **cancel PSA 82** -- discard a pending insertion (use the scoped form when several are waiting)\n` +
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
        console.log(`[router] Explicit merge command for ${mergeCmd.book} ${mergeCmd.chapter} — resuming ${match.key || match.sessionKey}`);
        resumeInsertion(match.key || match.sessionKey, message).catch(err =>
          console.error(`[router] resumeInsertion failed: ${err.message}`));
      } else {
        await sendMessage(message.display_recipient, message.subject,
          `No pending insertion found for ${mergeCmd.book} ${mergeCmd.chapter}.`);
      }
      return;
    }
  }

  // Handle explicit "cancel PSA 88" command — discard one specific deferred run
  // (the scope-addressed counterpart to "merge PSA 88"). Works from any topic.
  if (isStream) {
    const cancelCmd = parseCancelCommand(message.content);
    if (cancelCmd) {
      const match = getAllPendingMerges().find(pm =>
        pm.book === cancelCmd.book && pm.startChapter <= cancelCmd.chapter && pm.endChapter >= cancelCmd.chapter);
      if (match) {
        clearPendingMerge(match.key || match.sessionKey);
        console.log(`[router] Explicit cancel command for ${cancelCmd.book} ${cancelCmd.chapter} — discarded ${match.key || match.sessionKey}`);
        await sendMessage(message.display_recipient, message.subject,
          `Discarded the pending insertion for **${cancelCmd.book} ${cancelCmd.chapter}**. ` +
          `Generated files are still in the output folder if you need them later.`);
      } else {
        await sendMessage(message.display_recipient, message.subject,
          `No pending insertion found for ${cancelCmd.book} ${cancelCmd.chapter}.`);
      }
      return;
    }
  }

  // Check for pending merge (deferred repo-insert waiting for user to merge branches).
  // A single topic can hold several deferred runs at once (notably the API control
  // thread, which all API runs share), so resolve by session scan: bare "merged" /
  // "cancel" act only when exactly one run is waiting; otherwise point the user at
  // the unambiguous scope-addressed "merge <BOOK> <chapter>" command.
  if (isStream) {
    const sessionPending = getPendingMergesForSession(sessionKey);
    if (sessionPending.length > 0) {
      const labelOf = (pm) => pm.startChapter === pm.endChapter
        ? `${pm.book} ${pm.startChapter}`
        : `${pm.book} ${pm.startChapter}–${pm.endChapter}`;
      const listPending = () => sessionPending.map(pm => `**${labelOf(pm)}** (${pm.pipelineType})`).join(', ');
      const mergeExample = `**merge ${sessionPending[0].book} ${sessionPending[0].startChapter}**`;
      const cancelExample = `**cancel ${sessionPending[0].book} ${sessionPending[0].startChapter}**`;

      if (isMerged(message.content)) {
        if (sessionPending.length === 1) {
          const pm = sessionPending[0];
          try { await addReaction(message.id, 'working_on_it'); } catch (_) {}
          console.log(`[router] User said merged -- resuming insertion for ${pm.key || pm.sessionKey}`);
          resumeInsertion(pm.key || pm.sessionKey, message).catch(err =>
            console.error(`[router] resumeInsertion failed: ${err.message}`));
        } else {
          await sendMessage(message.display_recipient, message.subject,
            `More than one run is waiting to merge here: ${listPending()}. ` +
            `Say **merge <BOOK> <chapter>** to pick one (e.g. ${mergeExample}).`);
        }
        return;
      }
      if (isCancelMerge(message.content)) {
        if (sessionPending.length === 1) {
          const pm = sessionPending[0];
          clearPendingMerge(pm.key || pm.sessionKey);
          console.log(`[router] User cancelled pending merge for ${pm.key || pm.sessionKey}`);
          await sendMessage(message.display_recipient, message.subject,
            `Pending insertion discarded. Generated files are still in the output folder if you need them later.`);
        } else {
          await sendMessage(message.display_recipient, message.subject,
            `More than one run is waiting here: ${listPending()}. ` +
            `Discard a specific one with **cancel <BOOK> <chapter>** (e.g. ${cancelExample}).`);
        }
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

    // Guard: bare yes/no with no pending confirmation means the user is likely replying
    // to a confirmation prompt that's no longer in memory (e.g. after a bot restart).
    // Don't pass this to Haiku — it can't do anything useful with a lone "yes".
    if (isYes(message.content) || isNo(message.content)) {
      console.log(`[router] Bare yes/no with no pending confirmation from ${message.sender_full_name} in ${sessionKey}`);
      await sendMessage(message.display_recipient, message.subject,
        `@**${message.sender_full_name}** I don't have anything waiting for confirmation right now. Please re-send your original request and I'll ask again.`);
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
  return pendingConfirmations.has(sessionKey) || getPendingMergesForSession(sessionKey).length > 0;
}

/**
 * Check if a stream topic has an active interactive session for a specific sender.
 */
function hasActiveSession(channel, topic, senderId) {
  return hasActiveStreamSession(channel, topic, senderId);
}

// ---------------------------------------------------------------------------
// triggerPipelineFromApi — HTTP-initiated pipeline launch
//
// Mirrors firePipeline's responsibilities (dedup, activePipelines bookkeeping,
// fire-and-forget runPipeline) but takes structured input and returns a
// structured result instead of sending Zulip messages on conflict. Used by
// the public `/api/pipeline/start` endpoint.
// ---------------------------------------------------------------------------

const API_PIPELINE_ROUTE_NAMES = {
  generate: 'generate-content',
  notes: 'write-notes',
  tqs: 'write-tqs',
  translate: 'translate-notes',
};

// API-triggered runs (POST /api/pipeline/start) have no originating Zulip
// thread, so we adopt a fixed control thread as their lifecycle +
// human-in-the-loop channel: the bot's watched channel (config.channel) plus a
// configurable topic. The stream is hard-locked to config.channel — the
// merge-conflict "merged" reply must land on the watched channel to be heard
// at all (see index.js handleEvents). Only the topic is configurable.
function getApiControlThread() {
  return {
    stream: config.channel,
    topic: process.env.BT_API_CONTROL_TOPIC
      || (config.apiControlThread && config.apiControlThread.topic)
      || 'Bot testing',
  };
}

// Compact, human-readable label for an API run, e.g. "ZEC 7 notes".
function buildApiRunLabel({ pipelineType, scope }) {
  const { book, startChapter, endChapter, verseStart, verseEnd } = scope;
  const chPart = verseStart != null && verseEnd != null && startChapter === endChapter
    ? `${startChapter}:${verseStart}-${verseEnd}`
    : startChapter === endChapter
      ? `${startChapter}`
      : `${startChapter}-${endChapter}`;
  const typeLabel = pipelineType === 'generate' ? 'content'
    : pipelineType === 'notes' ? 'notes'
      : pipelineType === 'translate' ? 'translate'
        : 'tqs';
  return `${book} ${chPart} ${typeLabel}`;
}

// Stamp for lifecycle posts, e.g. "ZEC 7 notes · triggered by @username · job `…`".
function buildApiRunStamp({ pipelineType, scope, username, jobId }) {
  return `${buildApiRunLabel({ pipelineType, scope })} · triggered by @${username} · job \`${jobId}\``;
}

function buildApiSyntheticRoute(pipelineType, scope, options, ai) {
  // translate picks its base route by resourceType (four routes, all type
  // 'translate'); other pipelines have a single route name.
  const routeName = pipelineType === 'translate'
    ? (ROUTE_NAME_BY_RESOURCE_TYPE[options?.resourceType || 'tn'] || API_PIPELINE_ROUTE_NAMES.translate)
    : API_PIPELINE_ROUTE_NAMES[pipelineType];
  if (!routeName) return null;
  const baseRoute = config.routes.find((r) => r.name === routeName);
  if (!baseRoute) return null;

  const { book, startChapter, endChapter, verseStart, verseEnd } = scope;
  const rangeLabel = verseStart != null && verseEnd != null && startChapter === endChapter
    ? `${book} ${startChapter}:${verseStart}-${verseEnd}`
    : startChapter === endChapter
      ? `${book} ${startChapter}`
      : `${book} ${startChapter}-${endChapter}`;

  // hints can't ride the message.content flag string (it's a stringly-typed
  // CLI grammar; an array of objects doesn't fit). Attach them structurally
  // to the route — buildParsedNotesRequest will pick them up for synthetic
  // (API-origin) routes. Zulip-triggered runs never go through here.
  const hints = options && Array.isArray(options.hints) && options.hints.length > 0
    ? options.hints
    : null;

  // translate carries its per-run parameters structurally, like hints do —
  // they can't ride the stringly-typed message flags. translate-pipeline.js
  // reads route._translate; Zulip-origin runs parse the message instead.
  const translateOpts = pipelineType === 'translate' && options
    ? {
      resourceType: options.resourceType || 'tn',
      targetLang: options.targetLang,
      targetOrg: options.targetOrg,
      repoName: options.repoName,
      sourceRef: options.sourceRef,
      sourceLang: options.sourceLang,
      contextRef: options.contextRef,
      literalRef: options.literalRef,
      simplifiedRef: options.simplifiedRef,
      writeContextBack: options.writeContextBack,
      // A direct-provider run carries the model already resolved against the
      // provider catalog (ai.model); options.model is the sonnet|opus agentic
      // alias and must not reach a provider adapter.
      model: ai && ai.provider ? ai.model : options.model,
      provider: ai && ai.provider ? ai.provider : undefined,
      branchOnly: options.branchOnly,
      delivery: options.delivery,
      direction: options.direction,
      rowIds: options.rowIds,
      articleId: options.articleId,
      articleUrl: options.articleUrl,
    }
    : null;

  const route = {
    ...baseRoute,
    _synthetic: true,
    _book: book,
    _startChapter: startChapter,
    _endChapter: endChapter,
    _verseStart: verseStart ?? null,
    _verseEnd: verseEnd ?? null,
    _hints: hints,
    _translate: translateOpts,
    _scopeText: rangeLabel.replace(/^\S+\s+/, ''),
    _apiOrigin: true,
    confirmMessage: null,
  };

  // The caller-supplied API key rides the route NON-ENUMERABLY: it must reach
  // translate-pipeline without ever being visible to JSON.stringify,
  // util.inspect, object spread or a log line that dumps the route.
  if (translateOpts && ai && ai.provider && ai.apiKey) {
    Object.defineProperty(route, '_apiKey', { value: ai.apiKey, enumerable: false });
  }

  return route;
}

function buildApiContentFlags(pipelineType, options) {
  const o = options || {};
  const flags = [];
  if (pipelineType === 'generate') {
    if (Array.isArray(o.contentTypes) && o.contentTypes.length === 1) {
      flags.push(o.contentTypes[0].toUpperCase()); // 'ULT' | 'UST' restricts to one
    }
    if (o.noAlign) flags.push('--no-align');
    if (o.alignOnly) flags.push('--align-only');
    if (o.textOnly) flags.push('--text-only');
  }
  if (pipelineType === 'notes') {
    if (o.noIntro) flags.push('--no-intro');
    if (o.pauseBeforeATs) flags.push('--pause-before-ats');
  }
  if (o.fresh) flags.push('--fresh');
  return flags;
}

function buildApiSyntheticMessage({ pipelineType, scope, username, options }) {
  const { book, startChapter, endChapter } = scope;
  const chapterPart = startChapter === endChapter ? String(startChapter) : `${startChapter}-${endChapter}`;
  const commandWord = pipelineType === 'generate' ? 'generate'
    : pipelineType === 'notes' ? 'write notes'
    : pipelineType === 'translate' ? 'translate notes'
    : 'write tqs';
  const flags = buildApiContentFlags(pipelineType, options);
  const langSuffix = pipelineType === 'translate' && options?.targetLang
    ? ['to', options.targetLang] : [];
  const content = [commandWord, book, chapterPart, ...langSuffix, ...flags].join(' ');
  // Adopt the API control thread as this run's originating stream/topic. The
  // pipelines derive sessionKey, checkpoints, pending-merge keys and all Zulip
  // posts from message.display_recipient/subject, so this single substitution
  // makes API runs visible and their merge-conflict prompts answerable in the
  // control thread with no per-pipeline changes. The caller's apiSessionKey no
  // longer participates in the sessionKey; pending-merge records are kept
  // distinct per run by scope (see pending-merges.js).
  const { stream: controlStream, topic: controlTopic } = getApiControlThread();
  return {
    id: -1,
    type: 'stream',
    display_recipient: controlStream,
    subject: controlTopic,
    sender_id: -1,
    sender_full_name: username,
    sender_email: `${username}@api.bp-assistant`,
    content,
    _apiOrigin: true,
  };
}

function buildApiSessionKey(pipelineType, options) {
  const { stream, topic } = getApiControlThread();
  // translate checkpoints are suffixed by language + rowIds (matches
  // translate-pipeline buildSessionKey via the shared translateSessionSuffix)
  // so status polling resolves the right job and distinct rowIds runs on the
  // same scope don't alias to one jobId/checkpoint.
  const suffix = pipelineType === 'translate'
    ? translateSessionSuffix(options?.targetLang, options?.rowIds, {
      resourceType: options?.resourceType || 'tn',
      articleId: options?.articleId || options?.articleUrl || null,
    })
    : '';
  return `stream-${stream}-${topic}${suffix}`;
}

function buildApiJobId({ pipelineType, scope, options }) {
  return buildCheckpointKey({ sessionKey: buildApiSessionKey(pipelineType, options), pipelineType, scope });
}

/**
 * Launch a pipeline from an HTTP/API caller.
 *
 * @param {object} input
 * @param {'generate'|'notes'|'tqs'} input.pipelineType
 * @param {string} input.book - 3-letter USFM code (already uppercased)
 * @param {number} input.startChapter
 * @param {number} input.endChapter
 * @param {number|null} [input.verseStart]
 * @param {number|null} [input.verseEnd]
 * @param {string} input.username - DCS handle for commit attribution
 * @param {string} input.apiSessionKey - caller-supplied; idempotency + scoping
 * @param {object} [input.options] - per-pipeline flag toggles (contentTypes, noAlign, alignOnly, textOnly, fresh, noIntro, pauseBeforeATs)
 * @param {object} [input.ai] - translate only: { provider, model, apiKey } for a
 *   direct multi-provider LLM run. Kept OUT of `options` so the caller-supplied
 *   apiKey never lands in a serializable per-run options object.
 * @returns {{ status: 'running'|'already_running'|'conflict'|'invalid', jobId?, scope?, conflictingJobId?, message? }}
 */
function triggerPipelineFromApi(input) {
  const {
    pipelineType,
    book,
    startChapter,
    endChapter,
    verseStart = null,
    verseEnd = null,
    username,
    apiSessionKey,
    options = {},
    ai = null,
  } = input;

  // Article translate runs have no book/chapter — synthesize a placeholder
  // scope (the sessionKey suffix carries the article id). Keep in sync with
  // translate-pipeline.translatePipeline's article checkpoint scope.
  const isTranslateArticle = pipelineType === 'translate'
    && isArticleResource(options?.resourceType || 'tn');
  const scope = isTranslateArticle
    ? { book: articleScopeBook(options.resourceType), startChapter: 1, endChapter: 1, verseStart: null, verseEnd: null }
    : { book, startChapter, endChapter, verseStart, verseEnd };
  const route = buildApiSyntheticRoute(pipelineType, scope, options, ai);
  if (!route) {
    return { status: 'invalid', message: `Unknown pipelineType: ${pipelineType}` };
  }
  const message = buildApiSyntheticMessage({ pipelineType, scope, username, options });
  const { stream: controlStream, topic: controlTopic } = getApiControlThread();
  const derivedSessionKey = buildApiSessionKey(pipelineType, options);
  const jobId = buildApiJobId({ pipelineType, scope, options });

  // Conflict check 1: same (sessionKey, pipelineType, scope) already running?
  const activeCp = getActiveCheckpoint(route, derivedSessionKey, []);
  if (activeCp && !isStaleRunningCheckpoint(activeCp) && activeCp.state === 'running') {
    return { status: 'already_running', jobId, scope };
  }
  // Stale running → flip to failed so it becomes resumable (mirrors firePipeline).
  if (isStaleRunningCheckpoint(activeCp)) {
    setCheckpoint({
      sessionKey: activeCp.sessionKey,
      pipelineType: activeCp.pipelineType,
      scope: activeCp.scope,
    }, { state: 'failed', current: { ...activeCp.current, status: 'failed', errorKind: 'interrupted' } });
  }

  // Conflict check 2: another caller is running the same (book, chapter) under a different sessionKey?
  const keys = getPipelineKeys(route, message);
  if (keys) {
    const conflicts = keys.filter((k) => activePipelines.has(k));
    if (conflicts.length > 0) {
      return {
        status: 'conflict',
        jobId,
        scope,
        message: `Another run holds ${conflicts[0]}`,
      };
    }
    for (const k of keys) activePipelines.add(k);
  }

  // Lifecycle: announce the run in the control thread (API runs have no
  // originating message to react to). Finished / per-chapter / merge-conflict
  // posts ride the pipeline's own reply()/sendMessage path to the same thread.
  const stamp = buildApiRunStamp({ pipelineType, scope, username, jobId });
  sendMessage(controlStream, controlTopic, `:rocket: Starting ${stamp}`).catch((err) =>
    console.error(`[router/api] Failed to post start message: ${err.message}`));
  // Trace the caller's idempotency key → job, since it no longer rides the sessionKey.
  console.log(`[router/api] firing ${pipelineType} ${book} ${startChapter}-${endChapter} apiSessionKey=${apiSessionKey} jobId=${jobId}`);

  // Fire and forget.
  runPipeline(route, message)
    .catch(async (err) => {
      console.error(`[router/api] Pipeline "${route.name}" failed: ${err.message}`);
      await publishRouterFailure(route, message, err);
      // The pipeline's own handled errors (outage, usage limit, conflict) post
      // to the thread already; this covers an unhandled throw, which otherwise
      // only reaches the admin status board.
      try {
        await sendMessage(controlStream, controlTopic, `:cross_mark: ${stamp} failed: ${err.message}`);
      } catch (postErr) {
        console.error(`[router/api] Failed to post error message: ${postErr.message}`);
      }
    })
    .finally(() => {
      if (keys) {
        for (const k of keys) activePipelines.delete(k);
      }
    });

  return { status: 'running', jobId, scope };
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
  triggerPipelineFromApi,
  buildApiJobId,
  // Exported so the resume endpoint can check that the checkpoint it validated
  // is the one the trigger will actually address — the session key is DERIVED
  // here, not taken from the caller, so the two can diverge.
  buildApiSessionKey,
  buildApiContentFlags,
  // Exported for tests: the translate field allowlist and the non-enumerable
  // _apiKey attachment are the two properties that keep a caller-supplied key
  // out of every serialized form of a run.
  buildApiSyntheticRoute,
  API_PIPELINE_ROUTE_NAMES,
};
