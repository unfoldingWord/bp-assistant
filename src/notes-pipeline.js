// notes-pipeline.js — Multi-skill sequential pipeline for translation note writing
// Triggered by: "write notes <book> <chapter>" or "write notes <book> <start>-<end>"
// Skills: [post-edit-review OR deep-issue-id] -> [chapter-intro] -> tn-writer (Opus) -> tn-quality-check (Sonnet) -> repo-insert (Haiku)
// chapter-intro runs by default; disabled when the user opts out or auto-excluded.
//
// Each chapter is fully processed (skills + repo-insert + repo-verify) before
// moving to the next, so the editor gets access as soon as a chapter merges.
// The user is only notified after the merge to master is confirmed.

const fs = require('fs');
const path = require('path');
const config = require('./config');
const { sendMessage, sendDM, addReaction, removeReaction } = require('./zulip-client');
const { runClaude, DEFAULT_RESTRICTED_TOOLS, isTransientOutageError } = require('./claude-runner');
const { getDoor43Username, emailToFallbackUsername, buildBranchName, resolveOutputFile, discoverFreshOutput, checkPrerequisites, calcSkillTimeout, normalizeBookName, resolveConflictMention, parsePartialTsv, truncatePartialTsv, parseChunkRange, CSKILLBP_DIR } = require('./pipeline-utils');
const { splitTsv, fixTrailingNewlines } = require('./workspace-tools/tsv-tools');
const { fillTsvIds, generateIds, prepareNotes, fillOrigQuotes, resolveGlQuotes, flagNarrowQuotes, extractAlignmentData, prepareATContext, substituteAT, fixUnicodeQuotes, verifyBoldMatches, syncCanonicalHebrewQuotes } = require('./workspace-tools/tn-tools');
const { checkTnQuality } = require('./workspace-tools/quality-tools');
const { normalizeIssuesFile, buildParallelismIntroHintArgs } = require('./issue-normalizer');
const { curlyQuotes } = require('./workspace-tools/usfm-tools');
const { verifyRepoPush, verifyDcsToken } = require('./repo-verify');
const { recordMetrics, getCumulativeTokens, recordRunSummary, getAdaptiveSkillGuardrails } = require('./usage-tracker');
const { door43Push, checkConflictingBranches, REPO_MAP, getRepoFilename } = require('./door43-push');
const { setPendingMerge } = require('./pending-merges');
const { mergeTsvs } = require('./workspace-tools/tsv-tools');
const { getCheckpoint, setCheckpoint, clearCheckpoint } = require('./pipeline-checkpoints');
const { buildNotesContext, updateContextArtifacts, readContext, writeContext } = require('./pipeline-context');
const { checkUltEdits } = require('./check-ult-edits');
const { getVerseCount } = require('./verse-counts');

const LOG_DIR = path.resolve(__dirname, '../logs');

const POST_EDIT_REVIEW_HINT =
  'Use Agent teams (TeamCreate + SendMessage) for the Diff Analyzer and Issue Reconciler if available. ' +
  'If Agent teams are not available, fall back to Task subagents and poll with TaskGet until all complete. ' +
  'Do NOT output text without a tool call or the session will end prematurely.';

const DEEP_ISSUE_ID_HINT =
  'Use Agent teams (TeamCreate + SendMessage) for Wave 2 analysts and Wave 3 challenger if available. ' +
  'If Agent teams are not available, fall back to Task subagents and poll with TaskGet in a loop until all tasks show completed status. ' +
  'Do NOT output text without a tool call or the session will end prematurely.';

const TN_QUALITY_CHECK_HINT =
  'Mechanical checks have already run. Read runtime.tnQualityFindings from context.json — ' +
  'this is the starting findings list. Do not re-run fix_trailing_newlines or check_tn_quality before reviewing. ' +
  'Do not guess alternate file paths or probe missing runtime files outside context.json. ' +
  'Do the full semantic review (Steps 3a-3j), fix issues found, then re-run check_tn_quality ' +
  'at most once to verify fixes. If issues still persist after that one re-check, report them ' +
  'as unresolved and stop. Do not loop further.';

const TN_WRITER_HINT =
  'The pipeline has already run all mechanical preparation (prepare_notes, fill_orig_quotes, resolve_gl_quotes, flag_narrow_quotes). ' +
  'Read runtime.preparedNotes from context.json — all fields are populated. Do not re-run preparation MCP tools. ' +
  'Never use the raw Read tool on prepared_notes.json. Use read_prepared_notes with summaryOnly:true first, then fetch bounded slices. ' +
  'Stay in the tn-writer lane. Do not use Task/Agent/Team tools, web tools, SendMessage, or notebook editing. ' +
  'Do not hunt for alternate templates or run exploratory repair loops. ' +
  'Use only the prepared inputs, especially writer_packet, named canonical references, and workspace MCP tools needed for the documented tn-writer sequence. ' +
  'Do not re-decide templates, parse raw explanation directives again, or invent a new AT policy when the prepared item already provides them. ' +
  'Do not generate alternate translations — the pipeline handles AT generation separately after note writing. Write only the explanatory note text. ' +
  'Run the sequence once in order: read prepared data, read style/canonical refs, generate notes, assemble TSV, post-process, final review. ' +
  'Skip AT-fit verification — that is handled by the separate AT generation step. ' +
  'If a subset still fails after that bounded pass, stop and report the unresolved IDs instead of exploring side paths. ' +
  'TEMPLATE FIDELITY: Each note MUST begin by filling in writer_packet.template_text — that is the only authorized sentence structure. ' +
  'Do not prepend extra sentences before the template or substitute phrasings from Translation Academy definitions, issue-identification skill files, or published notes in data/published-tns/. ' +
  'In particular, never use phrases like "not looking for information" or "not seeking information" — these come from TA descriptions and are not part of any canonical template.';

const TN_WRITER_TOOL_BLOCKLIST = [
  'Task',
  'TaskOutput',
  'SendMessage',
  'Agent',
  'TeamCreate',
  'TeamDelete',
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
];

const PARALLELISM_HIGH_THRESHOLD = 5;
const PARALLELISM_EXCEPTION_CAP = 1;
const PARALLELISM_DUPLICATE_THRESHOLD = 0.75;

// Ranges where chapter intros are provided by the human editor and must be skipped.
const SKIP_INTRO_RANGES = [
  { book: 'PSA', start: 1, end: 150 },
];

function isIntroAutoExcluded(book, chapter) {
  return SKIP_INTRO_RANGES.some(r => r.book === book && chapter >= r.start && chapter <= r.end);
}

function shouldRunIntro(book, chapter, withIntroFlag) {
  if (!withIntroFlag) return false;
  if (isIntroAutoExcluded(book, chapter)) return false;
  return true;
}

function hasWithIntroFlag(content) {
  return /--with-?intro\b/i.test(content) || /\bwith[\s-]intro\b/i.test(content);
}

function hasNoIntroFlag(content) {
  return /--no-?intro\b/i.test(String(content || '')) || /\bno[\s-]intro\b/i.test(String(content || ''));
}

function hasFreshFlag(content) {
  return /--fresh\b/i.test(String(content || '')) || /--new\b/i.test(String(content || ''));
}

function hasPauseBeforeATsFlag(content) {
  const text = String(content || '');
  return /--pause-before-ats\b/i.test(text)
    || /--pause-ats\b/i.test(text)
    || /\bpause[\s-]+before[\s-]+ats\b/i.test(text)
    || /\bpause[\s-]+before[\s-]+alternate[\s-]+translations\b/i.test(text);
}

/**
 * Run all mechanical prep steps in Node.js before invoking tn-writer.
 * This replaces ~100 Claude MCP tool calls with direct function calls:
 *   0. extractAlignmentData — parse aligned USFM → alignment_data.json
 *   1. prepareNotes — parse issues TSV, build writer packets
 *   2. fillOrigQuotes — match English→alignment→Hebrew
 *   3. resolveGlQuotes — reverse lookup English spans
 *   4. flagNarrowQuotes — flag quotes needing expansion
 *
 * Returns a summary string for status reporting.
 */
async function runMechanicalPrep({ issuesPath, pipeDir, status }) {
  const ctx = readContext(pipeDir);

  // 0. Extract alignment data from aligned USFM before any steps that depend on it.
  //    Steps 1-3 all read alignment_data.json; it must be populated first.
  const hasAligned = ctx.sources && ctx.sources.ultAligned;
  let extractSummary;
  if (hasAligned) {
    const extractResult = extractAlignmentData({
      alignedUsfm: ctx.sources.ultAligned,
      output: ctx.runtime.alignmentData,
    });
    extractSummary = extractResult.split('\n')[0];
  } else {
    // Guard: write an empty object so JSON.parse never crashes on a 0-byte stub
    const alignPath = path.resolve(CSKILLBP_DIR, ctx.runtime.alignmentData);
    fs.mkdirSync(path.dirname(alignPath), { recursive: true });
    const existing = fs.existsSync(alignPath) ? fs.readFileSync(alignPath, 'utf8').trim() : '';
    if (!existing) fs.writeFileSync(alignPath, '{}');
    extractSummary = 'skipped (no aligned USFM)';
  }

  // 1. Prepare notes (parse issues, build writer packets, filter alignment)
  const prepResult = prepareNotes({
    inputTsv: issuesPath,
    ultUsfm: ctx.sources.ultPlain || ctx.sources.ult,
    ustUsfm: ctx.sources.ustPlain || ctx.sources.ust,
    alignedUsfm: ctx.sources.ultAligned,
    output: ctx.runtime.preparedNotes,
    alignmentJson: ctx.runtime.alignmentData,
  });
  const prepSummary = prepResult.split('\n')[0];

  // 2. Fill Hebrew orig_quotes from alignment data (skip if no alignment)
  let fillSummary;
  if (hasAligned) {
    const fillResult = fillOrigQuotes({
      preparedJson: ctx.runtime.preparedNotes,
      alignmentJson: ctx.runtime.alignmentData,
      masterUltUsfm: ctx.sources.ultAligned,
    });
    fillSummary = fillResult.split('\n')[0];
  } else {
    fillSummary = 'skipped (no alignment data)';
  }

  // 3. Resolve gl_quotes (reverse lookup from Hebrew to English spans; skip if no alignment)
  let glSummary;
  if (hasAligned) {
    const glResult = resolveGlQuotes({
      preparedJson: ctx.runtime.preparedNotes,
      alignmentJson: ctx.runtime.alignmentData,
    });
    glSummary = glResult.split('\n')[0];
  } else {
    glSummary = 'skipped (no alignment data)';
  }

  // 4. Flag narrow quotes
  const flagResult = flagNarrowQuotes({ preparedJson: ctx.runtime.preparedNotes });
  const flagSummary = flagResult.split('\n')[0];

  // 5. Generate TN IDs for all items so tn-writer receives a fully-populated
  //    prepared JSON. This prevents tn-writer from improvising ID generation
  //    via Edit calls, and ensures fillTsvIds (post-tn-writer) is a no-op safety net.
  const prepPath = path.resolve(CSKILLBP_DIR, ctx.runtime.preparedNotes);
  const prepData = JSON.parse(fs.readFileSync(prepPath, 'utf8'));
  const needsId = (prepData.items || []).filter(it => !it.id);
  let idSummary = 'skipped (all IDs present)';
  if (needsId.length > 0) {
    const idStr = await generateIds({ book: prepData.book || ctx.book, count: needsId.length });
    const newIds = idStr.split('\n').filter(Boolean);
    let idx = 0;
    for (const it of prepData.items) {
      if (!it.id) it.id = newIds[idx++] || '';
    }
    fs.writeFileSync(prepPath, JSON.stringify(prepData, null, 2));
    idSummary = `generated ${needsId.length} IDs`;
  }

  // Clear stale generated_notes so tn-writer starts fresh (must be valid JSON
  // so that downstream Read with offset and JSON.parse don't choke on empty file)
  const genPath = path.resolve(CSKILLBP_DIR, ctx.runtime.generatedNotes);
  fs.writeFileSync(genPath, '{}');

  return { extractSummary, prepSummary, fillSummary, glSummary, flagSummary, idSummary };
}

/**
 * "See how" detection pass — groups recurring issue patterns within a chapter
 * and marks subsequent occurrences as back-references to the first.
 *
 * Runs after mechanical prep, modifies prepared_notes.json in place.
 * Items marked with see_how get a programmatic "See how you translated..."
 * note instead of a full template-based note.
 *
 * @param {object} args
 * @param {string} args.pipeDir - Pipeline working directory
 * @returns {string} Summary of see-how detections
 */
function runSeeHowDetection({ pipeDir }) {
  const ctx = readContext(pipeDir);
  const prepPath = path.resolve(CSKILLBP_DIR, ctx.runtime.preparedNotes);
  const prepared = JSON.parse(fs.readFileSync(prepPath, 'utf8'));
  const items = prepared.items || [];

  if (items.length === 0) return '0 items';

  // Group items by issue type (sref)
  const bySref = {};
  for (const item of items) {
    if (!item.sref) continue;
    if (!bySref[item.sref]) bySref[item.sref] = [];
    bySref[item.sref].push(item);
  }

  let seeHowCount = 0;
  let combinedCount = 0;

  for (const [sref, group] of Object.entries(bySref)) {
    if (group.length < 2) continue;

    // Further group by gl_quote similarity (Hebrew pattern)
    // Use a simple approach: group items with the same gl_quote text
    const byQuote = {};
    for (const item of group) {
      const key = (item.gl_quote || '').toLowerCase().trim();
      if (!key) continue;
      if (!byQuote[key]) byQuote[key] = [];
      byQuote[key].push(item);
    }

    for (const [, quoteGroup] of Object.entries(byQuote)) {
      if (quoteGroup.length < 2) continue;

      // Sort by verse reference to find the first occurrence
      quoteGroup.sort((a, b) => {
        const [aCh, aVs] = (a.reference || '').split(':').map(Number);
        const [bCh, bVs] = (b.reference || '').split(':').map(Number);
        return (aCh - bCh) || (aVs - bVs);
      });

      // Check for same-verse duplicates
      const verseGroups = {};
      for (const item of quoteGroup) {
        const vs = item.reference;
        if (!verseGroups[vs]) verseGroups[vs] = [];
        verseGroups[vs].push(item);
      }

      for (const [vs, vsItems] of Object.entries(verseGroups)) {
        if (vsItems.length > 1) {
          // Same verse, same quote, same issue type — flag for combination
          for (let i = 1; i < vsItems.length; i++) {
            vsItems[i]._combine_with = vsItems[0].id;
            combinedCount++;
          }
        }
      }

      // Mark subsequent cross-verse occurrences as "see how"
      const canonicalItem = quoteGroup[0]; // First occurrence is canonical
      const canonicalRef = canonicalItem.reference;

      for (let i = 1; i < quoteGroup.length; i++) {
        const item = quoteGroup[i];
        // Skip same-verse items (handled as combinations above)
        if (item.reference === canonicalRef) continue;
        // Skip items already flagged
        if (item._combine_with) continue;

        // Build "see how" reference
        const [ch, vs] = canonicalRef.split(':');
        const bookLower = (prepared.book || '').toLowerCase();
        const chPad = String(ch).padStart(prepared.book === 'PSA' ? 3 : 2, '0');
        const vsPad = String(vs).padStart(2, '0');

        item.programmatic_note = `See how you translated the similar expression in [${canonicalRef}](../${chPad}/${vsPad}.md).`;
        if (item.at_provided) {
          item.programmatic_note += ` Alternate translation: [${item.at_provided}]`;
        }
        item.note_type = 'see_how';
        seeHowCount++;
      }
    }
  }

  // Write back modified prepared notes
  if (seeHowCount > 0 || combinedCount > 0) {
    fs.writeFileSync(prepPath, JSON.stringify(prepared, null, 2));
  }

  const summary = `${seeHowCount} see-how back-refs, ${combinedCount} same-verse combinations`;
  console.log(`[notes] See-how detection: ${summary}`);
  return summary;
}

/**
 * Run per-note generation using the Claude Agent SDK.
 * Replaces the sharded Claude Code agent approach with parallel focused SDK calls.
 * Each note gets its own runClaude call with a constrained prompt and small maxTurns.
 *
 * @param {object} args
 * @param {string} args.pipeDir - Pipeline working directory
 * @param {string} args.outputPath - Output TSV path (relative to workspace)
 * @param {function} args.status - Status reporting function
 * @param {string} args.book - Book code
 * @returns {Promise<{success: boolean, notesPath: string, summary: string}>}
 */
async function runPerNoteGeneration({ pipeDir, outputPath, status, book }) {
  const ctx = readContext(pipeDir);

  // Read prepared notes
  const prepPath = path.resolve(CSKILLBP_DIR, ctx.runtime.preparedNotes);
  const prepared = JSON.parse(fs.readFileSync(prepPath, 'utf8'));
  const items = prepared.items || [];

  if (items.length === 0) {
    return { success: true, notesPath: outputPath, summary: '0 items' };
  }

  // Load the note style guide for the system prompt
  const styleGuidePath = path.resolve(CSKILLBP_DIR, '.claude/skills/tn-writer/reference/note-style-guide.md');
  let styleGuide = '';
  try {
    styleGuide = fs.readFileSync(styleGuidePath, 'utf8');
  } catch (_) {
    styleGuide = 'Follow template exactly. Fill in only the variable parts.';
  }

  // Load canonical references if available
  let canonicalRefs = '';
  const glGuidelinesPath = path.resolve(CSKILLBP_DIR, '.claude/skills/tn-writer/reference/gl_guidelines.md');
  try {
    canonicalRefs = fs.readFileSync(glGuidelinesPath, 'utf8');
  } catch (_) { /* optional */ }

  // System prompt appended to each SDK call
  const systemPromptAppend = [
    'You are writing a single translation note for Bible translators.',
    'Follow the template exactly. Fill in only the variable parts.',
    'Output ONLY the note text, nothing else. Do not use any tools.',
    'Do NOT include an alternate translation — that is handled separately.',
    '',
    '--- NOTE STYLE GUIDE ---',
    styleGuide,
    canonicalRefs ? '\n--- GL GUIDELINES ---\n' + canonicalRefs : '',
  ].join('\n');

  await status(`Generating **${items.length} notes** via per-note SDK calls...`);
  console.log(`[notes] Per-note generation: ${items.length} items`);

  const CONCURRENCY = 10;
  const results = { success: 0, failed: 0, programmatic: 0 };
  const generatedNotes = {};

  async function generateOneNote(item) {
    // Programmatic notes don't need SDK calls
    if (item.programmatic_note) {
      return { id: item.id, success: true, note: item.programmatic_note, programmatic: true };
    }

    const packet = item.writer_packet || {};
    const prompt = [
      `TEMPLATE: "${packet.template_text || '(no template)'}"`,
      `VERSE (ULT): ${packet.ult_verse || item.ult_verse || ''}`,
      `VERSE (UST): ${packet.ust_verse || item.ust_verse || ''}`,
      `GL_QUOTE: ${packet.gl_quote || item.gl_quote || ''}`,
      `ISSUE TYPE: ${packet.sref || item.sref || ''}`,
      `REFERENCE: ${item.reference || ''}`,
      packet.clean_explanation ? `EXPLANATION: ${packet.clean_explanation}` : '',
      (packet.must_include || []).length ? `MUST INCLUDE: ${packet.must_include.join(' | ')}` : '',
      (packet.style_rules || []).length ? `STYLE RULES: ${packet.style_rules.join(', ')}` : '',
      (packet.rule_overrides || []).length ? `OVERRIDES: ${packet.rule_overrides.join(', ')}` : '',
      '',
      'Write the note text. Output ONLY the note text, nothing else.',
      'Do NOT include an alternate translation.',
    ].filter(Boolean).join('\n');

    try {
      const result = await runClaude({
        prompt,
        cwd: CSKILLBP_DIR,
        model: 'sonnet',
        maxTurns: 2,
        timeoutMs: 60 * 1000,
        appendSystemPrompt: systemPromptAppend,
        tools: [],
        disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Agent', 'Task', 'Skill'],
      });
      // Extract text from the result
      let noteText = '';
      if (result?.result?.text) {
        noteText = result.result.text.trim();
      } else if (typeof result?.result === 'string') {
        noteText = result.result.trim();
      }
      // Strip any accidentally included AT
      noteText = noteText.replace(/\s*Alternate translation:.*$/i, '').trim();

      if (!noteText) {
        return { id: item.id, success: false, reason: 'empty response' };
      }
      return { id: item.id, success: true, note: noteText };
    } catch (err) {
      console.error(`[notes] Per-note generation failed for ${item.id}: ${err.message}`);
      return { id: item.id, success: false, reason: err.message };
    }
  }

  // Run with concurrency limiter
  const queue = [...items];
  const noteResults = [];
  const running = new Set();

  while (queue.length > 0 || running.size > 0) {
    while (running.size < CONCURRENCY && queue.length > 0) {
      const item = queue.shift();
      const promise = generateOneNote(item).then(r => {
        running.delete(promise);
        noteResults.push(r);
        return r;
      });
      running.add(promise);
    }
    if (running.size > 0) {
      await Promise.race(running);
    }
  }

  // Collect results
  for (const r of noteResults) {
    if (r.success) {
      results.success++;
      if (r.programmatic) results.programmatic++;
      generatedNotes[r.id] = r.note;
    } else {
      results.failed++;
      console.warn(`[notes] Note failed for ${r.id}: ${r.reason || 'unknown'}`);
    }
  }

  // Write generated notes JSON
  const genPath = path.resolve(CSKILLBP_DIR, ctx.runtime.generatedNotes);
  fs.mkdirSync(path.dirname(genPath), { recursive: true });
  fs.writeFileSync(genPath, JSON.stringify(generatedNotes, null, 2));

  // Assemble TSV
  const { assembleNotes } = require('./workspace-tools/tn-tools');
  assembleNotes({
    preparedJson: ctx.runtime.preparedNotes,
    generatedJson: ctx.runtime.generatedNotes,
    output: outputPath,
  });

  const summary = `${results.success}/${items.length} notes generated (${results.programmatic} programmatic, ${results.failed} failed)`;
  console.log(`[notes] Per-note generation complete: ${summary}`);
  return { success: results.failed < items.length * 0.1, notesPath: outputPath, summary };
}

/**
 * Run AT generation as a separate pipeline step after tn-writer.
 * For each note item with at_required: true, makes a focused SDK call
 * to generate the AT, then a Haiku SDK call to validate it, then
 * programmatically appends "Alternate translation: [text]" to the generated notes JSON.
 *
 * @param {object} args
 * @param {string} args.notesPath - Path to assembled notes TSV (relative to workspace)
 * @param {string} args.pipeDir - Pipeline working directory
 * @param {function} args.status - Status reporting function
 * @returns {Promise<string>} Summary of AT generation results
 */
// Classify why a runClaude() call returned with no usable text.
// Returns a reason code tagged with the phase (e.g. "generate", "validate", "retry")
// so mass AT failure modes show up clearly in the run summary instead of all
// collapsing into a single "empty response" bucket.
function classifyRunClaudeEmpty(result, phase) {
  if (!result) return `no_result_${phase}`;
  if (result.timedOut || result.subtype === 'timeout') return `timeout_${phase}`;
  if (result.subtype === 'no_result') return `no_result_${phase}`;
  if (result.subtype === 'success') return `empty_text_after_success_${phase}`;
  return `non_success_${phase}:${result.subtype || 'unknown'}`;
}

async function runATGeneration({ notesPath, pipeDir, status }) {
  const ctx = readContext(pipeDir);

  // Build AT context packets
  const atCtxResult = prepareATContext({
    preparedJson: ctx.runtime.preparedNotes,
    generatedJson: ctx.runtime.generatedNotes,
  });
  const atCtx = JSON.parse(atCtxResult);

  if (!atCtx.packets || atCtx.packets.length === 0) {
    console.log('[notes] AT generation: no items need ATs');
    return '0 ATs needed';
  }

  await status(`Generating **${atCtx.packets.length} alternate translations** via SDK...`);
  console.log(`[notes] AT generation: ${atCtx.packets.length} items`);

  const CONCURRENCY = Math.max(1, parseInt(process.env.AT_CONCURRENCY, 10) || DEFAULT_AT_CONCURRENCY);
  console.log(`[notes] AT concurrency: ${CONCURRENCY}`);
  const results = {
    success: 0, failed: 0, validated: 0, retried: 0,
    reasons: Object.create(null),
  };
  const bumpReason = (reason) => {
    const key = reason || 'unknown';
    results.reasons[key] = (results.reasons[key] || 0) + 1;
  };

  // AT Writer system prompt
  const atSystemPrompt = [
    'You write alternate translations for Bible translation notes.',
    'An alternate translation replaces a specific phrase in the verse with simpler phrasing that resolves a translation issue described in a note.',
    '',
    'RULES:',
    '- Output ONLY the replacement text, nothing else. Do not use any tools.',
    '- Must read naturally when substituted into the verse',
    '- Must resolve the figure/issue (not preserve it)',
    '- Minimal changes from original text',
    '- Match capitalization of sentence position',
    '- Keep leading conjunctions/prepositions if present in original',
    '- No ending punctuation unless the note specifically suggests modifying punctuation (e.g. figs-rquestion changing ? to .)',
    '- For discontinuous quotes (with \u2026), use \u2026 between AT parts',
  ].join('\n');

  // Haiku validator system prompt
  const validatorSystemPrompt = buildAtValidatorSystemPrompt();

  // Helper to extract text from SDK result
  function extractResultText(result) {
    if (!result) return '';
    if (result.result?.text) return result.result.text.trim();
    if (typeof result.result === 'string') return result.result.trim();
    // Fallback: look for text in the result message
    if (result.result?.message?.content) {
      for (const block of result.result.message.content) {
        if (block.type === 'text' || typeof block === 'string') {
          return (block.text || block).trim();
        }
      }
    }
    return '';
  }

  // Process items with concurrency limiter
  async function generateOneAT(packet) {
    const userPrompt = [
      `VERSE: ${packet.full_verse}`,
      packet.verse_context.prev ? `PREVIOUS VERSE: ${packet.verse_context.prev}` : '',
      packet.verse_context.next ? `NEXT VERSE: ${packet.verse_context.next}` : '',
      `UST (your AT must NOT match this): ${packet.ust_verse}`,
      '',
      `ISSUE TYPE: ${packet.issue_type}`,
      `NOTE: ${packet.note_text}`,
      `TEXT TO REPLACE: ${packet.exact_ult_span}`,
      `QUOTE SCOPE MODE: ${packet.quote_scope_mode || 'focused_span'}`,
    ].filter(Boolean).join('\n');

    const classifyEmpty = (result, phase) => classifyRunClaudeEmpty(result, phase);

    try {
      // Step 1: Generate AT with Sonnet via SDK
      const atResult = await runClaude({
        prompt: userPrompt,
        cwd: CSKILLBP_DIR,
        model: 'sonnet',
        maxTurns: 2,
        timeoutMs: AT_GENERATION_TIMEOUT_MS,
        appendSystemPrompt: atSystemPrompt,
        tools: [],
        disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Agent', 'Task', 'Skill'],
      });
      let atText = extractResultText(atResult);
      // Strip any accidental brackets or "Alternate translation:" prefix
      atText = atText.replace(/^\[|\]$/g, '').replace(/^Alternate translation:\s*/i, '').trim();

      if (!atText) {
        return { id: packet.id, success: false, reason: classifyEmpty(atResult, 'generate') };
      }

      // Step 2: Programmatic substitution
      const modifiedVerse = substituteAT(packet.full_verse, packet.exact_ult_span, atText);
      if (!modifiedVerse) {
        return { id: packet.id, success: false, reason: 'gl_quote not found in verse', at: atText };
      }

      // Step 3: Haiku validation via SDK
      const validatorPrompt = [
        `ORIGINAL: ${packet.full_verse}`,
        `MODIFIED: ${modifiedVerse}`,
        `NOTE: ${packet.note_text}`,
      ].join('\n');

      const valResult = await runClaude({
        prompt: validatorPrompt,
        cwd: CSKILLBP_DIR,
        model: 'haiku',
        maxTurns: 2,
        timeoutMs: AT_VALIDATION_TIMEOUT_MS,
        appendSystemPrompt: validatorSystemPrompt,
        tools: [],
        disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Agent', 'Task', 'Skill'],
      });
      const valText = extractResultText(valResult);
      const isValid = /^YES\b/i.test(valText);

      if (isValid) {
        return { id: packet.id, success: true, at: atText, validated: true };
      }

      // Step 4: One retry with rejection feedback
      results.retried++;
      const retryPrompt = [
        userPrompt,
        '',
        `PREVIOUS ATTEMPT REJECTED: ${atText}`,
        `REASON: ${valText}`,
        'Try again with a different approach.',
      ].join('\n');

      const retryResult = await runClaude({
        prompt: retryPrompt,
        cwd: CSKILLBP_DIR,
        model: 'sonnet',
        maxTurns: 2,
        timeoutMs: AT_RETRY_TIMEOUT_MS,
        appendSystemPrompt: atSystemPrompt,
        tools: [],
        disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Agent', 'Task', 'Skill'],
      });
      let retryAt = extractResultText(retryResult);
      retryAt = retryAt.replace(/^\[|\]$/g, '').replace(/^Alternate translation:\s*/i, '').trim();

      if (!retryAt) {
        // First attempt's AT survives; tag for human review. Log retry failure reason
        // so the summary still shows when retries are timing out under load.
        const retryReason = classifyEmpty(retryResult, 'retry');
        console.warn(`[notes] AT retry produced no text for ${packet.id}: ${retryReason} — keeping first attempt`);
        return { id: packet.id, success: true, at: atText, validated: false, tag: 'at-fit', retryReason };
      }

      // Accept retry without re-validating (tag for human review if first was rejected)
      return { id: packet.id, success: true, at: retryAt, validated: false, tag: 'at-fit' };
    } catch (err) {
      console.error(`[notes] AT generation failed for ${packet.id}: ${err.message}`);
      return { id: packet.id, success: false, reason: `error:${err.message}` };
    }
  }

  // Run with concurrency limiter
  const queue = [...atCtx.packets];
  const atResults = [];
  const running = new Set();

  while (queue.length > 0 || running.size > 0) {
    while (running.size < CONCURRENCY && queue.length > 0) {
      const packet = queue.shift();
      const promise = generateOneAT(packet).then(r => {
        running.delete(promise);
        atResults.push(r);
        return r;
      });
      running.add(promise);
    }
    if (running.size > 0) {
      await Promise.race(running);
    }
  }

  // Apply results to generated notes and assembled TSV
  const genPath = path.resolve(CSKILLBP_DIR, ctx.runtime.generatedNotes);
  const generatedNotes = JSON.parse(fs.readFileSync(genPath, 'utf8'));

  const tagsToApply = new Map(); // id -> tag

  for (const r of atResults) {
    if (r.success && r.at) {
      results.success++;
      if (r.validated) results.validated++;
      if (r.retryReason) bumpReason(r.retryReason);
      // Append AT to the note text
      const existingNote = generatedNotes[r.id] || '';
      generatedNotes[r.id] = `${existingNote} Alternate translation: [${r.at}]`;
      if (r.tag) tagsToApply.set(r.id, r.tag);
    } else {
      results.failed++;
      bumpReason(r.reason);
      console.warn(`[notes] AT failed for ${r.id}: ${r.reason || 'unknown'}`);
      // Leave note without AT — quality check will flag it
    }
  }

  // Write updated generated notes
  fs.writeFileSync(genPath, JSON.stringify(generatedNotes, null, 2));

  // Re-assemble the TSV with the updated notes (includes ATs now)
  if (notesPath) {
    const { assembleNotes } = require('./workspace-tools/tn-tools');
    assembleNotes({
      preparedJson: ctx.runtime.preparedNotes,
      generatedJson: ctx.runtime.generatedNotes,
      output: notesPath,
    });
    console.log(`[notes] Re-assembled notes with ATs to ${notesPath}`);

    // Apply tags to flagged rows
    if (tagsToApply.size > 0) {
      const absNotes = path.resolve(CSKILLBP_DIR, notesPath);
      if (fs.existsSync(absNotes)) {
        const lines = fs.readFileSync(absNotes, 'utf8').split('\n');
        for (let i = 1; i < lines.length; i++) {
          if (!lines[i].trim()) continue;
          const cols = lines[i].split('\t');
          const id = cols[1] || '';
          const tag = tagsToApply.get(id);
          if (tag) {
            cols[2] = cols[2] ? `${cols[2]}, ${tag}` : tag;
            lines[i] = cols.join('\t');
          }
        }
        fs.writeFileSync(absNotes, lines.join('\n'));
      }
    }

    const postSummary = postProcessNotesTsv({
      notesPath,
      ultUsfm: ctx.sources.ultPlain || ctx.sources.ult,
      hebrewUsfm: ctx.sources.hebrew,
      preparedJson: ctx.runtime.preparedNotes,
    });
    console.log(`[notes] Final post-processing after AT generation: ${postSummary}`);
  }

  const reasonEntries = Object.entries(results.reasons)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}: ${v}`);
  const reasonBreakdown = reasonEntries.length ? ` [reasons — ${reasonEntries.join(', ')}]` : '';
  const summary = `${results.success}/${atCtx.packets.length} ATs generated (${results.validated} validated, ${results.retried} retried, ${results.failed} failed)${reasonBreakdown}`;
  console.log(`[notes] AT generation complete: ${summary}`);
  return summary;
}

function postProcessNotesTsv({ notesPath, ultUsfm, hebrewUsfm, preparedJson }) {
  const steps = [];
  steps.push(`curlyQuotes: ${curlyQuotes({ input: notesPath, inPlace: true })}`);

  if (hebrewUsfm && fs.existsSync(path.resolve(CSKILLBP_DIR, hebrewUsfm))) {
    steps.push(`fixUnicodeQuotes: ${fixUnicodeQuotes({ tsvFile: notesPath, hebrewUsfm })}`);
  } else {
    steps.push('fixUnicodeQuotes: skipped (no Hebrew USFM available)');
  }

  if (ultUsfm && fs.existsSync(path.resolve(CSKILLBP_DIR, ultUsfm))) {
    steps.push(`verifyBoldMatches: ${verifyBoldMatches({ tsvFile: notesPath, ultUsfm, preparedJson })}`);
  } else {
    steps.push('verifyBoldMatches: skipped (no ULT USFM available)');
  }

  return steps.join('; ');
}

function finalCanonicalHebrewQuoteSync({ notesPath, preparedJson, hebrewUsfm }) {
  if (!notesPath || !preparedJson || !hebrewUsfm) return 'syncCanonicalHebrewQuotes: skipped (missing notes, prepared JSON, or Hebrew USFM)';
  return syncCanonicalHebrewQuotes({
    tsvFile: notesPath,
    preparedJson,
    hebrewUsfm,
    mismatchPolicy: 'tag',
  });
}

/**
 * Run mechanical quality checks in Node.js before invoking tn-quality-check.
 * Runs fix_trailing_newlines + check_tn_quality directly so Claude reads
 * pre-run findings and cannot loop on re-checking.
 *
 * Returns a summary string for status reporting.
 */
async function runMechanicalQualityPrep({ notesPath, pipeDir }) {
  const ctx = readContext(pipeDir);
  const fixResult = fixTrailingNewlines({ file: notesPath });
  const qualityResult = await checkTnQuality({
    tsvPath: notesPath,
    preparedJson: ctx.runtime.preparedNotes,
    ultUsfm: ctx.sources.ultPlain || ctx.sources.ult,
    ustUsfm: ctx.sources.ustPlain || ctx.sources.ust,
    hebrewUsfm: ctx.sources.hebrew,
    book: ctx.book,
    output: ctx.runtime.tnQualityFindings,
  });
  const summary = qualityResult.split('\n')[0];
  console.log(`[notes] Quality mechanical prep: ${fixResult}; ${summary}`);
  return summary;
}

function buildNotesPaths(book, tag, hasVerseRange, verseStart, verseEnd) {
  const chapterRel = `output/notes/${book}/${tag}.tsv`;
  const shardRel = hasVerseRange
    ? `output/notes/${book}/${tag}-vv${verseStart}-${verseEnd}.tsv`
    : chapterRel;
  return { chapterRel, shardRel };
}

function buildIssuesPath(book, tag, hasVerseRange, verseStart, verseEnd) {
  if (!hasVerseRange) return `output/issues/${book}/${tag}.tsv`;
  return `output/issues/${book}/${tag}-v${verseStart}-${verseEnd}.tsv`;
}

function buildChapterIntroPrompt(skillRef, issuesPath, ctxFlag, introHintArgs = '') {
  return `${skillRef} --issues ${issuesPath}${ctxFlag}${introHintArgs || ''}`;
}

function removeIfExists(absPath) {
  try {
    if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
  } catch (_) {
    // non-fatal best-effort cleanup
  }
}

function cleanupNotesArtifacts({ book, chapter, verseStart, verseEnd }) {
  const width = book.toUpperCase() === 'PSA' ? 3 : 2;
  const tag = `${book}-${String(chapter).padStart(width, '0')}`;
  const hasVerseRange = verseStart != null && verseEnd != null;
  const verseTag = hasVerseRange ? `${tag}-vv${verseStart}-${verseEnd}` : tag;

  const candidates = [
    // issues
    `output/issues/${tag}.tsv`,
    `output/issues/${verseTag}.tsv`,
    `output/issues/${book}/${tag}.tsv`,
    `output/issues/${book}/${verseTag}.tsv`,
    // notes
    `output/notes/${tag}.tsv`,
    `output/notes/${verseTag}.tsv`,
    `output/notes/${book}/${tag}.tsv`,
    `output/notes/${book}/${verseTag}.tsv`,
    // quality
    `output/quality/${tag}-quality.md`,
    `output/quality/${tag}-quality.json`,
    `output/quality/${book}/${tag}-quality.md`,
    `output/quality/${book}/${tag}-quality.json`,
  ];

  for (const rel of candidates) {
    removeIfExists(path.resolve(CSKILLBP_DIR, rel));
  }

  // Clean up parallel tn-writer shard files (e.g. ZEC-01-v1-7.tsv)
  const shardDir = path.resolve(CSKILLBP_DIR, `output/notes/${book}`);
  try {
    if (fs.existsSync(shardDir)) {
      const shardPattern = new RegExp(`^${tag}-v\\d+-\\d+\\.tsv$`);
      for (const f of fs.readdirSync(shardDir)) {
        if (shardPattern.test(f)) removeIfExists(path.join(shardDir, f));
      }
    }
  } catch (_) { /* non-fatal */ }

  // Clean up split issue chunks (e.g. ZEC-01-v1-7.tsv in output/issues/)
  const issueDir = path.resolve(CSKILLBP_DIR, `output/issues/${book}`);
  try {
    if (fs.existsSync(issueDir)) {
      const chunkPattern = new RegExp(`^${tag}-v\\d+-\\d+\\.tsv$`);
      for (const f of fs.readdirSync(issueDir)) {
        if (chunkPattern.test(f)) removeIfExists(path.join(issueDir, f));
      }
    }
  } catch (_) { /* non-fatal */ }
}

function analyzeIssuesTsvShape(issuesPath) {
  const absPath = path.resolve(CSKILLBP_DIR, issuesPath);
  if (!fs.existsSync(absPath)) {
    return {
      exists: false,
      rowCount: 0,
      blankSrefRows: 0,
      blankQuoteRows: 0,
      blankBothRows: 0,
      blankSrefRatio: 0,
      blankQuoteRatio: 0,
      blankBothRatio: 0,
    };
  }

  const lines = fs.readFileSync(absPath, 'utf8').split('\n').filter((line) => line.trim());
  let rowCount = 0;
  let blankSrefRows = 0;
  let blankQuoteRows = 0;
  let blankBothRows = 0;

  for (const line of lines) {
    const cols = line.split('\t');
    if ((cols[0] || '').toLowerCase() === 'book') continue;
    rowCount++;
    const sref = String(cols[2] || '').trim();
    const quote = String(cols[3] || '').trim();
    if (!sref) blankSrefRows++;
    if (!quote) blankQuoteRows++;
    if (!sref && !quote) blankBothRows++;
  }

  return {
    exists: true,
    rowCount,
    blankSrefRows,
    blankQuoteRows,
    blankBothRows,
    blankSrefRatio: rowCount ? blankSrefRows / rowCount : 0,
    blankQuoteRatio: rowCount ? blankQuoteRows / rowCount : 0,
    blankBothRatio: rowCount ? blankBothRows / rowCount : 0,
  };
}

function isMalformedIssuesShape(shape) {
  if (!shape || !shape.exists || shape.rowCount < 5) return false;
  return shape.blankSrefRatio >= 0.8 && shape.blankQuoteRatio >= 0.8 && shape.blankBothRatio >= 0.8;
}

function backupIssuesFile({ issuesPath, pipeDir }) {
  if (!issuesPath || !pipeDir) return null;
  const absIssues = path.resolve(CSKILLBP_DIR, issuesPath);
  if (!fs.existsSync(absIssues)) return null;
  const backupRel = path.join(pipeDir, 'issues_pre_review.tsv');
  const backupAbs = path.resolve(CSKILLBP_DIR, backupRel);
  fs.mkdirSync(path.dirname(backupAbs), { recursive: true });
  fs.copyFileSync(absIssues, backupAbs);
  return backupRel;
}

function restoreIssuesBackup({ backupRel, issuesPath }) {
  if (!backupRel || !issuesPath) return false;
  const backupAbs = path.resolve(CSKILLBP_DIR, backupRel);
  const issuesAbs = path.resolve(CSKILLBP_DIR, issuesPath);
  if (!fs.existsSync(backupAbs)) return false;
  fs.mkdirSync(path.dirname(issuesAbs), { recursive: true });
  fs.copyFileSync(backupAbs, issuesAbs);
  return true;
}

function refreshChapterNotesFromShards(book, tag, chapterRel) {
  const shardGlob = `output/notes/${book}/${tag}-vv*.tsv`;
  const merged = mergeTsvs({ globPattern: shardGlob, output: chapterRel, noSort: true });
  if (!merged.startsWith('Merged')) return null;
  return chapterRel;
}

function isUsageLimitError(text) {
  return /hit your limit|usage limit|rate limit|too many requests|out of .* usage|429/i.test(String(text || ''));
}

function chicagoIsoFromUtcDate(date) {
  const wall = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const byType = Object.fromEntries(wall.map((p) => [p.type, p.value]));

  const tzName = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    timeZoneName: 'shortOffset',
  }).formatToParts(date).find((p) => p.type === 'timeZoneName')?.value || 'GMT-6';

  const offsetMatch = tzName.match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/);
  let offset = '-06:00';
  if (offsetMatch) {
    const sign = offsetMatch[1];
    const hh = String(offsetMatch[2]).padStart(2, '0');
    const mm = String(offsetMatch[3] || '00').padStart(2, '0');
    offset = `${sign}${hh}:${mm}`;
  }

  return `${byType.year}-${byType.month}-${byType.day}T${byType.hour}:${byType.minute}:${byType.second}${offset}`;
}

function buildUsageLimitResetTag(errorText) {
  // Example: "You've hit your limit · resets 8pm (UTC)"
  const m = String(errorText || '').match(/resets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(UTC\)/i);
  if (!m) return null;

  let hour = parseInt(m[1], 10);
  const minute = parseInt(m[2] || '0', 10);
  const ampm = m[3].toLowerCase();
  if (ampm === 'pm' && hour !== 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;

  const now = new Date();
  const resetUtc = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    hour,
    minute,
    0,
  ));
  if (resetUtc.getTime() <= now.getTime()) {
    resetUtc.setUTCDate(resetUtc.getUTCDate() + 1);
  }
  return `<time:${chicagoIsoFromUtcDate(resetUtc)}>`;
}

// --- Parse "write notes BOOK CH" or "write notes BOOK CH:VS-VS" or "write notes BOOK CH1-CH2" ---
function parseWriteNotesCommand(content) {
  // Range: write notes PSA 66-72 or write notes for PSA 66-72
  const withIntro = !hasNoIntroFlag(content) || hasWithIntroFlag(content);
  const pauseBeforeATs = hasPauseBeforeATsFlag(content);

  const rangeMatch = content.match(/write notes(?:\s+for)?\s+(\w+)\s+(\d+)\s*[-\u2013\u2014to]+\s*(\d+)/i);
  if (rangeMatch) {
    return {
      book: normalizeBookName(rangeMatch[1]),
      startChapter: parseInt(rangeMatch[2], 10),
      endChapter: parseInt(rangeMatch[3], 10),
      withIntro,
      fresh: hasFreshFlag(content),
      pauseBeforeATs,
    };
  }

  // Single with verse range: write notes PSA 119:169-176
  const verseMatch = content.match(/write notes(?:\s+for)?\s+(\w+)\s+(\d+):(\d+)[-\u2013\u2014](\d+)/i);
  if (verseMatch) {
    const ch = parseInt(verseMatch[2], 10);
    return {
      book: normalizeBookName(verseMatch[1]),
      startChapter: ch,
      endChapter: ch,
      verseStart: parseInt(verseMatch[3], 10),
      verseEnd: parseInt(verseMatch[4], 10),
      withIntro,
      fresh: hasFreshFlag(content),
      pauseBeforeATs,
    };
  }

  // Single chapter: write notes PSA 82
  const singleMatch = content.match(/write notes(?:\s+for)?\s+(\w+)\s+(\d+)/i);
  if (singleMatch) {
    const ch = parseInt(singleMatch[2], 10);
    return {
      book: normalizeBookName(singleMatch[1]),
      startChapter: ch,
      endChapter: ch,
      withIntro,
      fresh: hasFreshFlag(content),
      pauseBeforeATs,
    };
  }

  return null;
}

function buildParsedNotesRequest(route, content) {
  if (route && route._synthetic) {
    return {
      book: route._book,
      startChapter: route._startChapter,
      endChapter: route._endChapter,
      verseStart: route._verseStart ?? null,
      verseEnd: route._verseEnd ?? null,
      withIntro: !hasNoIntroFlag(content) || hasWithIntroFlag(content),
      fresh: hasFreshFlag(content),
      pauseBeforeATs: hasPauseBeforeATsFlag(content),
    };
  }
  return parseWriteNotesCommand(content);
}

function buildAtGenerationCheckpoint({
  totalSuccess,
  totalFail,
  skillOutputs,
  chapter,
}) {
  return {
    state: 'failed',
    totalSuccess,
    totalFail,
    skillOutputs,
    current: {
      chapter,
      skill: 'tn-quality-check',
      status: 'paused_before_at_generation',
      errorKind: 'awaiting_at_generation',
    },
    resume: { chapter, skill: 'tn-quality-check' },
  };
}

// Default verse chunk size for parallel tn-writer batching
const TN_WRITER_CHUNK_SIZE = 7;
const TN_WRITER_PARALLEL_MIN_VERSES = Number((config.notesGuardrails || {}).tnWriterParallelMinVerses || 35);
const AT_GENERATION_TIMEOUT_MS = 5 * 60 * 1000;
const AT_VALIDATION_TIMEOUT_MS = 5 * 60 * 1000;
const AT_RETRY_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_AT_CONCURRENCY = 2;
const TN_WRITER_MAX_TURNS = Number((config.notesGuardrails || {}).tnWriterMaxTurns || 1000);
const TN_WRITER_MAX_TOOL_CALLS = Number((config.notesGuardrails || {}).tnWriterMaxToolCalls || 1000);
const RESCUE_MAX_PASSES = Number((config.notesGuardrails || {}).rescueMaxPasses || 1);
const USE_PER_NOTE_GENERATION = Boolean((config.notesGuardrails || {}).usePerNoteGeneration);
const TN_WRITER_RESTRICTED_TOOLS = DEFAULT_RESTRICTED_TOOLS.filter((tool) => !TN_WRITER_TOOL_BLOCKLIST.includes(tool));

function buildAtValidatorSystemPrompt() {
  return [
    'Answer YES or NO only, then one sentence explaining why. Do not use any tools.',
    '',
    'Judge the candidate alternate translation by these priorities:',
    '1. First, confirm that it actually SOLVES the translation problem named in the note.',
    '2. Second, confirm that the modified verse reads as natural English.',
    '',
    'A candidate fails if it leaves the original problem in place, even if the English sounds natural.',
    'Examples:',
    '- If the note says passive voice is the issue, reject any candidate that still uses passive voice.',
    '- If the note says a metaphor should be changed, reject any candidate that still uses the metaphor instead of a simile or plain meaning.',
    '- If the note says a figure should be made explicit, reject any candidate that still leaves the meaning implicit.',
    '',
    'Does the modified verse read as natural English AND clearly resolve the issue described in the note?',
  ].join('\n');
}

function countIssueRows(tsvRelPath) {
  try {
    const abs = path.resolve(CSKILLBP_DIR, tsvRelPath);
    if (!fs.existsSync(abs)) return 0;
    const lines = fs.readFileSync(abs, 'utf8').split('\n').filter((l) => l.trim());
    return Math.max(0, lines.length - 1);
  } catch {
    return 0;
  }
}

function countUsfmWords(usfmRelPath) {
  try {
    const abs = path.resolve(CSKILLBP_DIR, usfmRelPath);
    if (!fs.existsSync(abs)) return 0;
    const raw = fs.readFileSync(abs, 'utf8');
    const plain = raw
      .replace(/\\zaln-[se][^*]*\*/g, ' ')
      .replace(/\\w\s+([^|]*?)\|[^\\]*?\\w\*/g, '$1')
      .replace(/\\[a-z]+\d?\s*/gi, ' ')
      .replace(/\{[^}]*\}/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return plain ? plain.split(' ').length : 0;
  } catch {
    return 0;
  }
}

function parseContextPathFlag(ctxFlag) {
  const m = String(ctxFlag || '').match(/--context\s+(\S+)/);
  return m ? m[1] : null;
}

function applySkillSpecificGuardrails(skill, guardrails) {
  if (skill !== 'tn-writer') return guardrails;
  return {
    ...guardrails,
    maxTurns: Math.min(Number(guardrails?.maxTurns || TN_WRITER_MAX_TURNS), TN_WRITER_MAX_TURNS),
    maxToolCalls: Math.min(Number(guardrails?.maxToolCalls || TN_WRITER_MAX_TOOL_CALLS), TN_WRITER_MAX_TOOL_CALLS),
  };
}

function getSkillToolConfig(skill) {
  if (skill === 'tn-writer') {
    return {
      tools: TN_WRITER_RESTRICTED_TOOLS,
      disallowedTools: ['Bash', ...TN_WRITER_TOOL_BLOCKLIST],
    };
  }
  return {
    tools: DEFAULT_RESTRICTED_TOOLS,
    disallowedTools: ['Bash'],
  };
}

function buildSkillGuardrails({ pipeline, skill, book, chapter, issuesPath, contextPath }) {
  const issues = countIssueRows(issuesPath);
  let sourceWords = 0;
  if (contextPath) {
    try {
      const ctxAbs = path.resolve(CSKILLBP_DIR, contextPath);
      const ctx = JSON.parse(fs.readFileSync(ctxAbs, 'utf8'));
      sourceWords = countUsfmWords(ctx?.sources?.ult || '');
    } catch { /* ignore */ }
  }
  const verses = (() => { try { return getVerseCount(book, chapter); } catch { return 20; } })();
  const adaptive = getAdaptiveSkillGuardrails({
    pipeline,
    skill,
    book,
    verses,
    issueCount: issues,
    sourceWordCount: sourceWords,
  });
  return applySkillSpecificGuardrails(skill, adaptive);
}

function readQualityFindings(qualityRelPath) {
  try {
    const abs = path.resolve(CSKILLBP_DIR, qualityRelPath);
    if (!fs.existsSync(abs)) return null;
    return JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch {
    return null;
  }
}

function collectUnresolvedQuoteFindings(qualityJson) {
  const findings = Array.isArray(qualityJson?.findings) ? qualityJson.findings : [];
  return findings.filter((f) => ['empty_quote', 'no_hebrew_in_quote', 'gl_quote_not_in_ult', 'scope_overreach', 'at_scope_mismatch'].includes(String(f.category || '')));
}

function appendIssueTagsToTsv(tsvRelPath, unresolvedFindings) {
  const abs = path.resolve(CSKILLBP_DIR, tsvRelPath);
  if (!fs.existsSync(abs) || !Array.isArray(unresolvedFindings) || unresolvedFindings.length === 0) return 0;
  const byId = new Map();
  for (const f of unresolvedFindings) {
    const id = String(f.id || '').trim();
    if (!id) continue;
    const code = f.category === 'empty_quote' ? 'ISSUE:QUOTE_EMPTY'
      : f.category === 'no_hebrew_in_quote' ? 'ISSUE:MATCH_FAIL'
        : 'ISSUE:GLQ_MISS';
    if (!byId.has(id)) byId.set(id, new Set());
    byId.get(id).add(code);
  }
  const lines = fs.readFileSync(abs, 'utf8').split('\n');
  let updated = 0;
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cols = lines[i].split('\t');
    while (cols.length < 7) cols.push('');
    const id = String(cols[1] || '').trim();
    if (!byId.has(id)) continue;
    const existing = String(cols[2] || '').split(',').map((s) => s.trim()).filter(Boolean);
    const merged = new Set(existing);
    for (const code of byId.get(id)) merged.add(code);
    cols[2] = Array.from(merged).join(', ');
    lines[i] = cols.slice(0, 7).join('\t');
    updated++;
  }
  fs.writeFileSync(abs, lines.join('\n'));
  return updated;
}

/**
 * Run tn-writer in parallel shards. Splits issues TSV into verse-range chunks,
 * launches independent runClaude calls per chunk, merges results, fills IDs.
 *
 * @returns {{ result: object|null, error: Error|null, shardDetails: object[] }}
 */
async function runParallelTnWriter({
  book, ch, tag, issuesPath, outputPath, ctxFlag, model,
  timeoutMs, appendSystemPrompt, checkpointRef, existingShards,
  status, isDryRun, skillRef,
}) {
  // Split issues into chunks
  const chunkResult = splitTsv({ inputTsv: issuesPath, chunkSize: TN_WRITER_CHUNK_SIZE });
  const chunkPaths = chunkResult.split('\n').filter(Boolean);

  // If only one chunk (short chapter), return null to fall through to normal single invocation
  if (chunkPaths.length <= 1) return null;

  const shardOutputDir = `output/notes/${book}`;
  const shardDetails = chunkPaths.map(cp => {
    const range = parseChunkRange(cp);
    const relPath = path.relative(path.resolve(CSKILLBP_DIR), cp);
    const shardOut = range
      ? `${shardOutputDir}/${tag}-v${range.vStart}-${range.vEnd}.tsv`
      : `${shardOutputDir}/${tag}.tsv`;
    return { chunkPath: relPath, output: shardOut, range, status: 'pending' };
  });

  // Restore completed shards from checkpoint
  const prevShards = existingShards || [];
  for (const shard of shardDetails) {
    const prev = prevShards.find(p => p.output === shard.output && p.status === 'completed');
    if (prev) {
      const absOut = path.resolve(CSKILLBP_DIR, shard.output);
      if (fs.existsSync(absOut)) {
        shard.status = 'completed';
        console.log(`[notes] Shard already completed: ${shard.output}`);
      }
    }
  }

  const pendingShards = shardDetails.filter(s => s.status !== 'completed');
  if (pendingShards.length === 0) {
    await status(`All ${shardDetails.length} tn-writer shards already completed — merging.`);
  } else {
    await status(`Running **tn-writer** in ${shardDetails.length} parallel shards (${pendingShards.length} pending)...`);
  }

  // Launch parallel runClaude calls for pending shards
  if (pendingShards.length > 0) {
    const baseContextRel = parseContextPathFlag(ctxFlag);
    let baseContext = null;
    if (baseContextRel) {
      try {
        baseContext = JSON.parse(fs.readFileSync(path.resolve(CSKILLBP_DIR, baseContextRel), 'utf8'));
      } catch (_) {
        baseContext = null;
      }
    }

    // Pre-clean pending shard outputs
    for (const shard of pendingShards) {
      // Check for partial recovery on this shard (Level 2)
      const absOut = path.resolve(CSKILLBP_DIR, shard.output);
      const partial = parsePartialTsv(absOut, book, ch);
      if (partial && partial.safeVerses.length > 0) {
        if (truncatePartialTsv(absOut, partial.safeVerses)) {
          shard.partialRecovery = partial;
          console.log(`[notes] Shard ${shard.output}: partial recovery (${partial.safeVerses.length} safe verses, resume from ${partial.resumeFromVerse})`);
        }
      }
      if (!shard.partialRecovery) {
        removeIfExists(absOut);
      }
    }

    const runPromises = pendingShards.map((shard, i) => {
      const vRange = shard.range ? `${shard.range.vStart}-${shard.range.vEnd}` : '';
      const verseArg = vRange ? `:${vRange}` : '';
      let shardCtxFlag = '';
      if (baseContext && shard.range) {
        const shardDir = path.resolve(CSKILLBP_DIR, 'tmp', 'pipeline', `${book}-${String(ch).padStart(book === 'PSA' ? 3 : 2, '0')}`, 'shards');
        fs.mkdirSync(shardDir, { recursive: true });
        const shardCtxRel = path.relative(
          path.resolve(CSKILLBP_DIR),
          path.join(shardDir, `${tag}-v${shard.range.vStart}-${shard.range.vEnd}.context.json`)
        );
        const shardCtxAbs = path.resolve(CSKILLBP_DIR, shardCtxRel);
        const shardCtx = JSON.parse(JSON.stringify(baseContext));
        shardCtx.runtime = shardCtx.runtime || {};
        const stem = `${tag}-v${shard.range.vStart}-${shard.range.vEnd}`;
        shardCtx.runtime.preparedNotes = `tmp/pipeline/${tag}/shards/${stem}.prepared_notes.json`;
        shardCtx.runtime.generatedNotes = `tmp/pipeline/${tag}/shards/${stem}.generated_notes.json`;
        shardCtx.runtime.alignmentData = `tmp/pipeline/${tag}/shards/${stem}.alignment_data.json`;
        shardCtx.runtime.tnQualityFindings = `tmp/pipeline/${tag}/shards/${stem}.quality_findings.json`;
        fs.writeFileSync(shardCtxAbs, JSON.stringify(shardCtx, null, 2));
        shardCtxFlag = ` --context ${shardCtxRel}`;
      } else if (ctxFlag) {
        shardCtxFlag = ctxFlag;
      }
      let prompt = `${skillRef}${verseArg} --issues ${shard.chunkPath} --output ${shard.output}${shardCtxFlag}`;

      // Prepend partial recovery instruction if applicable
      if (shard.partialRecovery) {
        const pr = shard.partialRecovery;
        const preamble =
          `IMPORTANT: A previous run completed notes for verses ${pr.safeVerses.join(', ')}. ` +
          `The partial file is at ${shard.output} with the header and ${pr.safeRowCount} completed rows. ` +
          `Continue writing notes starting from verse ${pr.resumeFromVerse}, APPENDING to the existing file. ` +
          `Do NOT rewrite the header or existing verses.\n\n`;
        prompt = preamble + prompt;
      }

      if (isDryRun) {
        const absPath = path.resolve(CSKILLBP_DIR, shard.output);
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        const v1 = shard.range?.vStart || 1;
        fs.writeFileSync(absPath, 'Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote\n' +
          `${book} ${ch}:${v1}\t\t\t\t\t1\t[Stub note for dry run]\n`);
        return Promise.resolve({ subtype: 'success', num_turns: 0, duration_ms: 100, total_cost_usd: 0, _shardIdx: i });
      }

      console.log(`[notes] tn-writer shard ${i}: ${prompt}`);
      const guardrails = buildSkillGuardrails({
        pipeline: 'notes',
        skill: 'tn-writer',
        book,
        chapter: ch,
        issuesPath: shard.chunkPath,
        contextPath: parseContextPathFlag(shardCtxFlag),
      });
      const toolConfig = getSkillToolConfig('tn-writer');
      return runClaude({
        prompt,
        cwd: CSKILLBP_DIR,
        model: model || undefined,
        skill: 'tn-writer',
        tools: toolConfig.tools,
        disallowedTools: toolConfig.disallowedTools,
        disableLocalSettings: true,
        forceNoAutoBashSandbox: true,
        timeoutMs,
        maxTurns: guardrails.maxTurns,
        appendSystemPrompt,
        guardrails,
      }).then(r => ({ ...r, _shardIdx: i }))
        .catch(err => ({ _shardIdx: i, _error: err, subtype: 'error' }));
    });

    const results = await Promise.allSettled(runPromises);

    // Process results and aggregate shard metrics
    let anyUsageLimit = false;
    let anyTransientOutage = false;
    let totalTurns = 0, totalDurationMs = 0, totalCostUsd = 0;
    let totalInputTokens = 0, totalOutputTokens = 0;
    for (let ri = 0; ri < results.length; ri++) {
      const r = results[ri].status === 'fulfilled' ? results[ri].value : { _shardIdx: ri, _error: results[ri].reason, subtype: 'error' };
      const shard = pendingShards[r._shardIdx ?? ri];
      if (r._error) {
        shard.status = 'failed';
        shard.error = r._error.message || String(r._error);
        if (isTransientOutageError(r._error)) anyTransientOutage = true;
        if (isUsageLimitError(shard.error)) anyUsageLimit = true;
        console.error(`[notes] tn-writer shard ${r._shardIdx} failed: ${shard.error}`);
      } else if (r.subtype !== 'success') {
        shard.status = 'failed';
        shard.error = r.error || r.result || `subtype: ${r.subtype}`;
        if (isUsageLimitError(shard.error)) anyUsageLimit = true;
        console.error(`[notes] tn-writer shard ${r._shardIdx} non-success: ${shard.error}`);
      } else {
        // Check output file exists
        const absOut = path.resolve(CSKILLBP_DIR, shard.output);
        if (fs.existsSync(absOut)) {
          shard.status = 'completed';
          totalTurns += r.num_turns || 0;
          totalDurationMs += r.duration_ms || 0;
          totalCostUsd += r.total_cost_usd || 0;
          totalInputTokens += r.usage?.input_tokens ?? r.usage?.inputTokens ?? 0;
          totalOutputTokens += r.usage?.output_tokens ?? r.usage?.outputTokens ?? 0;
          console.log(`[notes] tn-writer shard ${r._shardIdx} completed: ${shard.output}`);
        } else {
          shard.status = 'failed';
          shard.error = 'Output file not found after successful SDK run';
          console.error(`[notes] tn-writer shard ${r._shardIdx}: success but output missing`);
        }
      }
    }

    // Report shard results
    const completedCount = shardDetails.filter(s => s.status === 'completed').length;
    const failedCount = shardDetails.filter(s => s.status === 'failed').length;
    await status(`tn-writer shards: ${completedCount}/${shardDetails.length} completed, ${failedCount} failed.`);

    // If any shards failed, report as failure
    if (failedCount > 0) {
      const failedShardErrors = shardDetails.filter(s => s.status === 'failed').map(s => s.error).join('; ');
      const errorResult = {
        subtype: 'error',
        error: `${failedCount}/${shardDetails.length} shards failed: ${failedShardErrors}`,
      };
      // Synthesize appropriate error type for the pipeline's error handling
      if (anyUsageLimit) errorResult._usageLimit = true;
      if (anyTransientOutage) errorResult._transientOutage = true;
      return { result: errorResult, error: null, shardDetails };
    }
  }

  // All shards completed — merge
  await status(`Merging ${shardDetails.length} tn-writer shards...`);
  const mergeGlob = `output/notes/${book}/${tag}-v*.tsv`;
  const mergeResult = mergeTsvs({ globPattern: mergeGlob, output: outputPath });
  console.log(`[notes] Merge result: ${mergeResult}`);

  return {
    result: {
      subtype: 'success',
      num_turns: totalTurns,
      duration_ms: totalDurationMs,
      total_cost_usd: totalCostUsd,
      usage: { input_tokens: totalInputTokens, output_tokens: totalOutputTokens },
    },
    error: null,
    shardDetails,
  };
}

// --- Main pipeline ---
async function notesPipeline(route, message) {
  const adminUserId = config.adminUserId;
  const stream = message.type === 'stream' ? message.display_recipient : null;
  const topic = message.subject || '';
  const msgId = message.id;

  const isTestFast = process.env.TEST_FAST === '1';
  const isDryRun = process.env.DRY_RUN === '1';

  async function status(text) {
    try { await sendDM(adminUserId, text); } catch (err) {
      console.error(`[notes] Failed to send status DM: ${err.message}`);
    }
  }

  async function reply(text) {
    try {
      if (stream) {
        const mention = message.sender_full_name ? `@**${message.sender_full_name}** ` : '';
        await sendMessage(stream, topic, mention + text);
      } else {
        await sendDM(message.sender_id, text);
      }
    } catch (err) {
      console.error(`[notes] Failed to send reply: ${err.message}`);
    }
  }

  // --- Parse command ---
  // Support both regex-parsed commands and synthetic routes from intent classifier
  const parsed = buildParsedNotesRequest(route, message.content);

  if (!parsed) {
    await addReaction(msgId, 'cross_mark');
    await status('Could not parse command. Expected: `write notes <book> <chapter>` or `write notes <book> <start>-<end>`');
    return;
  }

  const { book, startChapter, endChapter, verseStart, verseEnd, withIntro, fresh, pauseBeforeATs } = parsed;
  const sessionKey = stream ? `stream-${stream}-${topic}` : `dm-${message.sender_id}`;
  const debugRunId = `notes-${message.id || Date.now()}`;
  const checkpointRef = {
    sessionKey,
    pipelineType: 'notes',
    scope: { book, startChapter, endChapter, verseStart: verseStart ?? null, verseEnd: verseEnd ?? null },
  };
  let existingCheckpoint = getCheckpoint(checkpointRef);
  const chapterCount = endChapter - startChapter + 1;
  const hasGlobalVerseRange = verseStart != null && verseEnd != null && startChapter === endChapter;
  const rangeLabel = hasGlobalVerseRange
    ? `${book} ${startChapter}:${verseStart}-${verseEnd}`
    : (startChapter === endChapter
      ? `${book} ${startChapter}`
      : `${book} ${startChapter}\u2013${endChapter}`);

  // --- Look up Door43 username ---
  let username = getDoor43Username(message.sender_email);
  if (!username) {
    username = emailToFallbackUsername(message.sender_email);
    console.warn(`[notes] No Door43 username for ${username} — add to door43-users.json`);
    await status(`No Door43 username mapped for ${username} — using as fallback. Add to door43-users.json to use a real username.`);
  }

  if (fresh) {
    clearCheckpoint(checkpointRef);
    for (let ch = startChapter; ch <= endChapter; ch++) {
      cleanupNotesArtifacts({ book, chapter: ch, verseStart, verseEnd });
    }
    existingCheckpoint = null;
    await status(`Fresh mode enabled for **${rangeLabel}** — cleared existing checkpoint and prior artifacts.`);
  }

  await addReaction(msgId, 'working_on_it');
  await status(`Starting notes pipeline for **${rangeLabel}** (${chapterCount} chapter(s), user: ${username})`);

  // Ensure log directory
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const logFile = path.join(LOG_DIR, 'notes.log');
  const model = isTestFast ? 'haiku' : undefined;

  const pipelineStart = Date.now();
  const tokensBefore = getCumulativeTokens();
  let totalSuccess = Number(existingCheckpoint?.totalSuccess || 0);
  let totalFail = Number(existingCheckpoint?.totalFail || 0);

  // Conflict-deferred push state: when a user branch modifies the same file,
  // we continue generating but defer all pushes until the user says "merged".
  let deferredPush = false;
  let deferredConflicts = [];   // [{ branch }]
  const deferredChapters = [];  // [{ ch, notesSource }]
  let abortForUsageLimit = false;
  let abortForOutage = false;
  let usageLimitTag = null;
  let resumeChapter = Number(existingCheckpoint?.resume?.chapter || startChapter);
  let resumeSkill = existingCheckpoint?.resume?.skill || null;
  const skillOutputs = existingCheckpoint?.skillOutputs || {};

  const canResumeFromCheckpoint = (
    existingCheckpoint?.resume?.chapter != null &&
    (existingCheckpoint?.state === 'paused_for_outage' || existingCheckpoint?.state === 'paused_for_usage_limit' || existingCheckpoint?.state === 'failed' || existingCheckpoint?.state === 'running')
  );
  // #region agent log
  fetch('http://localhost:7282/ingest/190f0e90-444d-4921-920d-f208e86f8cb3',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'7de6a4'},body:JSON.stringify({sessionId:'7de6a4',runId:debugRunId,hypothesisId:'H4',location:'notes-pipeline.js:resume-gate',message:'checkpoint and resume decision',data:{scope:{book,startChapter,endChapter,verseStart:verseStart??null,verseEnd:verseEnd??null},fresh,checkpointState:existingCheckpoint?.state||null,resume:existingCheckpoint?.resume||null,canResumeFromCheckpoint},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
  if (!fresh && canResumeFromCheckpoint && resumeChapter >= startChapter) {
    // The resume chapter was counted as failed in the previous run; undo that
    // so it isn't double-counted if it succeeds this time.
    if (totalFail > 0) totalFail--;
    await status(`Resuming notes from checkpoint at **${book} ${resumeChapter}** (${resumeSkill || 'chapter start'}).`);
    await reply(`Resuming notes run for **${rangeLabel}** from **${book} ${resumeChapter}** (${resumeSkill || 'chapter start'}).`);
  } else {
    resumeChapter = startChapter;
    resumeSkill = null;
  }
  setCheckpoint(checkpointRef, {
    state: 'running',
    totalSuccess,
    totalFail,
    skillOutputs,
    resume: { chapter: resumeChapter, skill: resumeSkill },
  });

  // =========================================================================
  // Per-chapter loop: skills -> repo-insert -> repo-verify -> notify user
  // Each chapter is merged before the next one starts, so the editor gets
  // access immediately and isn't told a chapter is done until it's on master.
  // =========================================================================
  for (let ch = startChapter; ch <= endChapter; ch++) {
    if (ch < resumeChapter) continue;
    const width = book.toUpperCase() === 'PSA' ? 3 : 2;
    const tag = `${book}-${String(ch).padStart(width, '0')}`;
    const verseRange = verseStart != null && startChapter === endChapter
      ? `:${verseStart}-${verseEnd}` : '';
    const ref = `${book} ${ch}${verseRange}`;
    const skillRef = verseStart != null && startChapter === endChapter
      ? `${book} ${ch}:${verseStart}-${verseEnd}` : `${book} ${ch}`;

    await status(`Processing chapter **${ref}**...`);
    console.log(`[notes] Processing ${ref}...`);

    // --- Check prerequisites to decide branch ---
    const hasVerseRange = verseStart != null && startChapter === endChapter;

    // Checkpoint-first: if resuming this chapter at a downstream skill and
    // the cached issue-producer output still exists on disk, honor the
    // checkpoint and skip the AI-artifact-driven restart. Prevents a full
    // deep-issue-id re-run after a mid-pipeline crash (e.g. OOM) when the
    // notes TSV was already produced.
    const chOutputsForResume = skillOutputs[ch] || {};
    const downstreamResumeSkills = new Set(['tn-writer', 'tn-quality-check', 'door43-push', 'door43-push-done']);
    const isResumingThisChapter = !fresh && canResumeFromCheckpoint
      && ch === resumeChapter && !!resumeSkill;
    let resumeIssueProducer = null;
    let resumeIssuesPath = null;
    if (isResumingThisChapter && downstreamResumeSkills.has(resumeSkill)) {
      for (const name of ['post-edit-review', 'deep-issue-id']) {
        const cachedRel = chOutputsForResume[name];
        if (cachedRel && fs.existsSync(path.resolve(CSKILLBP_DIR, cachedRel))) {
          resumeIssueProducer = name;
          resumeIssuesPath = cachedRel;
          break;
        }
      }
      if (resumeIssueProducer) {
        await status(`**${ref}**: resuming from checkpoint at ${resumeSkill} (skipping AI artifact check; using cached ${resumeIssueProducer})`);
      }
    }

    const { missing, resolved } = resumeIssueProducer
      ? { missing: [], resolved: {} }
      : checkPrerequisites(book, ch,
          hasVerseRange ? verseStart : undefined,
          hasVerseRange ? verseEnd : undefined);
    const hasAIArtifacts = resumeIssueProducer
      ? (resumeIssueProducer === 'post-edit-review')
      : missing.length === 0;

    let issuesPath;
    let issuesBackupPath = null;
    let failedSkill = null;
    const chapterStart = Date.now();
    let chapterIntroHintArgs = '';
    let issueNormalizationDone = false;

    // --- Build pipeline context (fetch authoritative ULT/UST from Door43) ---
    let contextPath = null;
    let pipeDir = null;
    try {
      const alignedUltPath = resolved['AI-ULT']
        ? resolved['AI-ULT'].replace(/\.usfm$/, '-aligned.usfm')
        : null;
      const alignedExists = alignedUltPath && fs.existsSync(path.resolve(CSKILLBP_DIR, alignedUltPath));
      const ctxResult = await buildNotesContext({
        book,
        chapter: ch,
        verseStart: hasVerseRange ? verseStart : undefined,
        verseEnd: hasVerseRange ? verseEnd : undefined,
        issuesPath: hasAIArtifacts ? resolved['issues TSV'] : undefined,
        alignedUltPath: alignedExists ? alignedUltPath : undefined,
        reuseExisting: !fresh && !!existingCheckpoint && ch === resumeChapter,
      });
      pipeDir = ctxResult.dirPath;
      contextPath = ctxResult.contextPath;
      console.log(`[notes] Pipeline context created: ${contextPath}`);
    } catch (err) {
      console.warn(`[notes] Failed to build pipeline context (non-fatal): ${err.message}`);
      // Skills fall back to their existing file-discovery behavior
    }
    const ctxFlag = contextPath ? ` --context ${contextPath}` : '';

    // --- Build skill chain based on prerequisite availability ---
    const skills = [];
    const issueProducerSkillNames = new Set(['deep-issue-id', 'post-edit-review']);

    if (resumeIssueProducer) {
      // Placeholder for cached issue-producer output — never invoked at
      // runtime; the resume logic advances startSkillIndex past it and
      // reattaches resolvedOutput from skillOutputs.
      issuesPath = resumeIssuesPath;
      skills.push({
        name: resumeIssueProducer,
        prompt: `${skillRef}${ctxFlag}`,
        expectedOutput: resumeIssuesPath,
        skipPreClean: true,
        ops: 1,
      });
    } else if (hasAIArtifacts) {
      // AI artifacts found -> run mechanical diff gate before committing to post-edit-review
      issuesPath = resolved['issues TSV'];

      let diffResult = { hasEdits: false, masterPath: null };
      try {
        diffResult = await checkUltEdits({
          book,
          chapter: ch,
          workspaceDir: CSKILLBP_DIR,
          pipeDir: pipeDir || undefined,
        });
      } catch (err) {
        // Non-fatal: if diff check fails, proceed with post-edit-review as a safe fallback
        console.warn(`[notes] checkUltEdits failed (non-fatal), proceeding with post-edit-review: ${err.message}`);
        diffResult = { hasEdits: true, masterPath: null };
      }

      if (!diffResult.hasEdits) {
        await status(`**${ref}**: No human edits detected — skipping post-edit-review.`);
      } else {
        await status(`**${ref}**: AI artifacts found \u2192 post-edit-review path`);

        // Store the plain master chapter path in context so the skill can read it
        if (diffResult.masterPath && contextPath && pipeDir) {
          try {
            const ctx = readContext(pipeDir);
            ctx.sources.ultMasterPlain = diffResult.masterPath;
            writeContext(pipeDir, ctx);
          } catch (err) {
            console.warn(`[notes] Failed to update context with ultMasterPlain: ${err.message}`);
          }
        }

        skills.push({
          name: 'post-edit-review',
          prompt: `${skillRef} --issues ${issuesPath}${ctxFlag}`,
          appendSystemPrompt: POST_EDIT_REVIEW_HINT,
          expectedOutput: issuesPath,
          skipPreClean: true,   // expectedOutput is also the input — don't delete it
          model: 'sonnet',      // validation/reconciliation — Sonnet suffices at lower cost
          ops: 1,
        });
        issuesBackupPath = backupIssuesFile({ issuesPath, pipeDir });
      }
    } else {
      // No AI artifacts -> deep-issue-id path (fetches from Door43 master)
      issuesPath = buildIssuesPath(book, tag, hasVerseRange, verseStart, verseEnd);
      await status(`**${ref}**: No AI artifacts (missing: ${missing.join(', ')}) \u2192 deep-issue-id path`);

      // Pre-create stub so Claude doesn't burn turns on Read-before-Write
      const issuesAbs = path.resolve(CSKILLBP_DIR, issuesPath);
      fs.mkdirSync(path.dirname(issuesAbs), { recursive: true });
      if (!fs.existsSync(issuesAbs)) fs.writeFileSync(issuesAbs, '');

      const verseFlag = hasVerseRange ? ` --verses ${verseStart}-${verseEnd}` : '';
      skills.push({
        name: 'deep-issue-id',
        prompt: `${book} ${ch}${verseFlag}${ctxFlag}`,
        appendSystemPrompt: DEEP_ISSUE_ID_HINT,
        expectedOutput: issuesPath,
        mcpTools: 'issue-id',
        ops: 3, // 2 analysts + challenger/merge
      });
    }

    // chapter-intro: only runs when "with intro" is requested (and not in auto-exclusion range)
    if (shouldRunIntro(book, ch, withIntro)) {
      skills.push({
        name: 'chapter-intro',
        prompt: buildChapterIntroPrompt(skillRef, issuesPath, ctxFlag, chapterIntroHintArgs),
        expectedOutput: issuesPath,
        skipPreClean: true, // expectedOutput is also input; do not delete verse issues before intro insertion
        ops: 1,
      });
    } else if (withIntro && isIntroAutoExcluded(book, ch)) {
      await status(`**${ref}**: skipping chapter-intro (auto-excluded range)`);
    }

    const { chapterRel: notesChapterRel, shardRel: notesShardRel } = buildNotesPaths(
      book, tag, hasVerseRange, verseStart, verseEnd
    );
    const tnExpectedOutput = hasVerseRange ? notesShardRel : notesChapterRel;
    // Pre-create notes output stub
    const notesAbs = path.resolve(CSKILLBP_DIR, tnExpectedOutput);
    fs.mkdirSync(path.dirname(notesAbs), { recursive: true });
    if (!fs.existsSync(notesAbs)) fs.writeFileSync(notesAbs, '');
    skills.push({
      name: 'tn-writer',
      prompt: `${skillRef} --issues ${issuesPath} --output ${tnExpectedOutput}${ctxFlag}`,
      appendSystemPrompt: TN_WRITER_HINT,
      expectedOutput: tnExpectedOutput,
      mcpTools: 'tn-writer',
      ops: 1,
    });

    // tn-quality-check runs as a separate Sonnet invocation for independent review
    const qualityTag = hasVerseRange ? `${tag}-vv${verseStart}-${verseEnd}` : tag;
    const defaultNotesPath = hasVerseRange ? notesShardRel : notesChapterRel;
    skills.push({
      name: 'tn-quality-check',
      prompt: `${skillRef} --notes ${defaultNotesPath}${ctxFlag}`,
      expectedOutput: `output/quality/${book}/${qualityTag}-quality.md`,
      appendSystemPrompt: TN_QUALITY_CHECK_HINT,
      mcpTools: 'quality',
      maxTurns: 100,
      ops: 1,
      model: 'sonnet',
    });

    // --- Run skills sequentially ---
    // If resuming at door43-push, skip the entire skill chain
    const skipAllSkills = (ch === resumeChapter && (resumeSkill === 'door43-push' || resumeSkill === 'door43-push-done'));
    let startSkillIndex = skipAllSkills ? skills.length : 0;
    if (!skipAllSkills && ch === resumeChapter && resumeSkill) {
      const idx = skills.findIndex((s) => s.name === resumeSkill);
      startSkillIndex = idx >= 0 ? idx : 0;
      if (idx < 0) {
        await status(`Checkpoint resume skill "${resumeSkill}" not found for ${ref}; restarting chapter skill chain.`);
      }
    }
    // Restore resolvedOutput for skipped skills from the manifest, validating files still exist
    const chOutputs = skillOutputs[ch] || {};
    for (let si2 = 0; si2 < startSkillIndex; si2++) {
      if (chOutputs[skills[si2].name]) {
        const absPath = path.resolve(CSKILLBP_DIR, chOutputs[skills[si2].name]);
        if (!fs.existsSync(absPath)) {
          // Cached output missing — restart chapter from this skill
          console.warn(`[notes] Cached output missing for ${skills[si2].name}: ${chOutputs[skills[si2].name]} — restarting from this skill`);
          startSkillIndex = si2;
          resumeSkill = skills[si2].name;
          await status(`Cached output for **${skills[si2].name}** (${ref}) missing on disk — restarting from this skill.`);
          break;
        }
        skills[si2].resolvedOutput = chOutputs[skills[si2].name];
      }
    }
    if (chOutputs['deep-issue-id']) issuesPath = chOutputs['deep-issue-id'];
    else if (chOutputs['post-edit-review']) issuesPath = chOutputs['post-edit-review'];

    async function runIssueNormalizationStage() {
      if (!issuesPath || issueNormalizationDone) return;
      const result = normalizeIssuesFile({
        issuesPath,
        options: {
          highParallelismThreshold: PARALLELISM_HIGH_THRESHOLD,
          exceptionCap: PARALLELISM_EXCEPTION_CAP,
          duplicateSimilarityThreshold: PARALLELISM_DUPLICATE_THRESHOLD,
        },
      });
      issueNormalizationDone = true;

      if (withIntro) {
        chapterIntroHintArgs = buildParallelismIntroHintArgs(result.introSignal);
      }

      if (pipeDir && result.introSignal) {
        updateContextArtifacts(pipeDir, 'parallelism_signal', result.introSignal);
      }

      const s = result.summary;
      const signal = result.introSignal?.parallelism_signal || 'none';
      await status(
        `**${ref}**: issue-normalizer kept ${s.kept_parallelism_rows}/${s.total_parallelism_rows} parallelism rows ` +
        `(exceptions: ${s.kept_parallelism_exceptions}, dropped: ${s.dropped_parallelism_rows}), intro signal: ${signal}.`
      );
      console.log(
        `[notes] issue-normalizer ${ref}: ` +
        `parallelism total=${s.total_parallelism_rows}, kept=${s.kept_parallelism_rows}, ` +
        `exceptions=${s.kept_parallelism_exceptions}, dropped=${s.dropped_parallelism_rows}, signal=${signal}`
      );

      // Keep downstream prompts pinned to normalized issues path and intro hint.
      for (const sk of skills) {
        if (sk.prompt && sk.prompt.includes('--issues ')) {
          sk.prompt = sk.prompt.replace(/--issues\s+\S+/, `--issues ${issuesPath}`);
        }
      }
      for (const sk of skills) {
        if (sk.name === 'chapter-intro') {
          sk.prompt = buildChapterIntroPrompt(skillRef, issuesPath, ctxFlag, chapterIntroHintArgs);
        }
      }
    }

    // If resuming after issue-producer stages, normalize before chapter-intro/tn-writer.
    if (issuesPath && skills[startSkillIndex] && !issueProducerSkillNames.has(skills[startSkillIndex].name)) {
      await runIssueNormalizationStage();
    }

    // Mechanical prep flag — set true once runMechanicalPrep() completes in the skill loop.
    let mechanicalPrepDone = false;
    // Quality mechanical prep flag — set true once runMechanicalQualityPrep() completes.
    let qualityPrepDone = false;
    let atGenerationDone = false;

    for (let si = startSkillIndex; si < skills.length; si++) {
      const skill = skills[si];

      // --- Mechanical prep: run all deterministic steps before tn-writer ---
      if (skill.name === 'tn-writer' && !mechanicalPrepDone && pipeDir && issuesPath) {
        try {
          await status(`**${ref}**: Running mechanical prep (prepare, fill quotes, resolve GL, flag narrow, generate IDs)...`);
          const prep = await runMechanicalPrep({ issuesPath, pipeDir, status });
          mechanicalPrepDone = true;
          await status(
            `**${ref}**: Mechanical prep complete — extract=${prep.extractSummary}; ${prep.prepSummary}; ${prep.fillSummary}; ${prep.glSummary}; ${prep.flagSummary}; ids=${prep.idSummary}`
          );
          console.log(`[notes] Mechanical prep ${ref}: extract=${prep.extractSummary}, prep=${prep.prepSummary}, fill=${prep.fillSummary}, gl=${prep.glSummary}, flag=${prep.flagSummary}, ids=${prep.idSummary}`);

          // Run see-how detection after mechanical prep
          try {
            const seeHowSummary = runSeeHowDetection({ pipeDir });
            if (seeHowSummary !== '0 see-how back-refs, 0 same-verse combinations') {
              await status(`**${ref}**: See-how detection — ${seeHowSummary}`);
            }
          } catch (seeHowErr) {
            console.warn(`[notes] See-how detection failed (non-fatal): ${seeHowErr.message}`);
          }
        } catch (err) {
          console.error(`[notes] Mechanical prep failed for ${ref}: ${err.message}`);
          await status(`**${ref}**: Mechanical prep failed — ${err.message}. Claude will run prep via MCP tools.`);
          // Non-fatal: tn-writer skill can still do prep via MCP tools (old path)
        }
      }

      // --- AT generation: run between tn-writer and tn-quality-check ---
      if (skill.name === 'tn-quality-check' && !atGenerationDone && pipeDir) {
        if (pauseBeforeATs && chapterCount === 1 && ch === resumeChapter && resumeSkill !== 'tn-quality-check') {
          setCheckpoint(checkpointRef, buildAtGenerationCheckpoint({
            totalSuccess,
            totalFail,
            skillOutputs,
            chapter: ch,
          }));
          await status(`**${ref}**: Notes are written. Pausing before alternate translations so you can resume AT generation from Zulip.`);
          await reply(`Notes for **${ref}** are written and saved. Say **resume** in this topic when you want me to generate the alternate translations.`);
          return;
        }
        try {
          const writerNotesPath = skills.find(s => s.name === 'tn-writer')?.resolvedOutput
            || skills.find(s => s.name === 'tn-writer')?.expectedOutput;
          if (writerNotesPath) {
            await status(`**${ref}**: Running separate AT generation...`);
            const atSummary = await runATGeneration({ notesPath: writerNotesPath, pipeDir, status });
            atGenerationDone = true;
            await status(`**${ref}**: AT generation complete — ${atSummary}`);
          }
        } catch (err) {
          console.error(`[notes] AT generation failed (non-fatal): ${err.message}`);
          await status(`**${ref}**: AT generation failed — ${err.message}. Quality check will flag missing ATs.`);
        }
      }

      // --- Quality mechanical prep: run fix_trailing_newlines + check_tn_quality before tn-quality-check ---
      if (skill.name === 'tn-quality-check' && !qualityPrepDone && pipeDir) {
        try {
          const notesPath = skills.find(s => s.name === 'tn-writer')?.resolvedOutput
            || skills.find(s => s.name === 'tn-writer')?.expectedOutput;
          if (notesPath) {
            await status(`**${ref}**: Running quality mechanical checks...`);
            const summary = await runMechanicalQualityPrep({ notesPath, pipeDir });
            qualityPrepDone = true;
            await status(`**${ref}**: Quality mechanical checks done — ${summary}`);
          }
        } catch (err) {
          console.error(`[notes] Quality mechanical prep failed (non-fatal): ${err.message}`);
        }
      }


      const skillStart = Date.now();
      // --- Partial output recovery for tn-writer on resume ---
      let partialRecovery = null;
      if (skill.name === 'tn-writer' && ch === resumeChapter && resumeSkill === 'tn-writer' && !fresh) {
        const partialPath = resolveOutputFile(skill.expectedOutput, book);
        if (partialPath) {
          const absPartial = path.resolve(CSKILLBP_DIR, partialPath);
          partialRecovery = parsePartialTsv(absPartial, book, ch);
          if (partialRecovery) {
            console.log(`[notes] Partial tn-writer output detected for ${ref}: ${partialRecovery.safeRowCount} safe rows, verses ${partialRecovery.safeVerses.join(',')}, resume from verse ${partialRecovery.resumeFromVerse}`);
            // Truncate to safe rows only
            if (truncatePartialTsv(absPartial, partialRecovery.safeVerses)) {
              await status(`Recovering partial tn-writer output for ${ref} (${partialRecovery.safeVerses.length} verses safe, resuming from verse ${partialRecovery.resumeFromVerse}).`);
              // Prepend continuation instruction to the skill prompt
              const recoveryPreamble =
                `IMPORTANT: A previous run completed notes for verses ${partialRecovery.safeVerses.join(', ')}. ` +
                `The partial file is at ${partialPath} with the header and ${partialRecovery.safeRowCount} completed rows. ` +
                `Continue writing notes starting from verse ${partialRecovery.resumeFromVerse}, APPENDING to the existing file. ` +
                `Do NOT rewrite the header or existing verses.\n\n`;
              skill.prompt = recoveryPreamble + skill.prompt;
            } else {
              // Truncation failed — fall through to normal pre-clean
              console.warn(`[notes] Partial TSV truncation failed for ${ref}, falling back to full re-run`);
              partialRecovery = null;
            }
          }
        }
      }
      // Delete expected output so Claude must recreate it (prevents stale-mtime false failures on resume)
      // Skip when expectedOutput is also the skill's input (e.g. post-edit-review)
      // Skip pre-clean when we're recovering partial output (file was already truncated to safe rows)
      if (skill.expectedOutput && !skill.skipPreClean && !partialRecovery) {
        const preClean = resolveOutputFile(skill.expectedOutput, book);
        if (preClean) {
          try { fs.unlinkSync(path.resolve(CSKILLBP_DIR, preClean)); } catch (_) { /* fine if missing */ }
        }
      }
      const timeoutMs = calcSkillTimeout(book, ch, skill.ops);
      const guardrails = buildSkillGuardrails({
        pipeline: 'notes',
        skill: skill.name,
        book,
        chapter: ch,
        issuesPath,
        contextPath: parseContextPathFlag(ctxFlag),
      });
      const maxTurns = skill.maxTurns
        ? Math.min(skill.maxTurns, guardrails.maxTurns)
        : guardrails.maxTurns;
      const toolConfig = getSkillToolConfig(skill.name);
      await status(`Running **${skill.name}** for ${ref} (timeout: ${Math.round(timeoutMs / 60000)}min)...`);
      console.log(`[notes] Running ${skill.name}: ${skill.prompt} (timeout: ${Math.round(timeoutMs / 60000)}min)`);
      // #region agent log
      fetch('http://localhost:7282/ingest/190f0e90-444d-4921-920d-f208e86f8cb3',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'7de6a4'},body:JSON.stringify({sessionId:'7de6a4',runId:debugRunId,hypothesisId:'H1',location:'notes-pipeline.js:skill-start',message:'skill start',data:{ref,skill:skill.name,expectedOutput:skill.expectedOutput||null,prompt:skill.prompt,skillStart,timeoutMs},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
      setCheckpoint(checkpointRef, {
        state: 'running',
        totalSuccess,
        totalFail,
        current: { chapter: ch, skill: skill.name, status: 'running', startedAt: new Date(skillStart).toISOString() },
        resume: { chapter: ch, skill: skill.name },
      });

      let result = null;
      let skillError = null;

      // --- Per-note generation: direct API calls per note (replaces Claude Code sessions) ---
      let usedPerNote = false;
      if (skill.name === 'tn-writer' && USE_PER_NOTE_GENERATION && !hasVerseRange && !isDryRun) {
        try {
          await status(`**${ref}**: Using per-note generation (direct API calls)...`);
          const perNoteResult = await runPerNoteGeneration({
            pipeDir,
            outputPath: skill.expectedOutput,
            status,
            book,
          });
          usedPerNote = true;
          if (perNoteResult.success) {
            result = { subtype: 'success', num_turns: 0, duration_ms: 0, total_cost_usd: 0 };
            skill.resolvedOutput = perNoteResult.notesPath;
            await status(`**${ref}**: Per-note generation — ${perNoteResult.summary}`);
          } else {
            console.warn(`[notes] Per-note generation had issues: ${perNoteResult.summary}`);
            result = { subtype: 'success', num_turns: 0, duration_ms: 0, total_cost_usd: 0 };
            skill.resolvedOutput = perNoteResult.notesPath;
          }
        } catch (err) {
          console.error(`[notes] Per-note generation failed, falling back to Claude sessions: ${err.message}`);
          usedPerNote = false; // Fall through to existing paths
        }
      }

      // --- Parallel tn-writer: split into verse-range shards ---
      let usedParallel = false;
      let chapterVerseCount = 0;
      try { chapterVerseCount = getVerseCount(book, ch); } catch { chapterVerseCount = 0; }
      if (!usedPerNote && skill.name === 'tn-writer' && !hasVerseRange && chapterVerseCount >= TN_WRITER_PARALLEL_MIN_VERSES) {
        const existingShards = (skillOutputs[ch] || {})._tnWriterShards || [];
        try {
          const parallelResult = await runParallelTnWriter({
            book, ch, tag, issuesPath, outputPath: skill.expectedOutput, ctxFlag,
            model: model || skill.model, timeoutMs, appendSystemPrompt: skill.appendSystemPrompt,
            checkpointRef, existingShards, status, isDryRun, skillRef,
          });
          if (parallelResult) {
            // Parallel mode was used (chapter had enough verses to split)
            usedParallel = true;
            result = parallelResult.result;
            // Save shard details in skillOutputs for checkpoint recovery
            if (!skillOutputs[ch]) skillOutputs[ch] = {};
            skillOutputs[ch]._tnWriterShards = parallelResult.shardDetails;
            // Handle usage limit / transient outage propagation
            if (result?._usageLimit) {
              skillError = new Error(result.error);
              result = null;
            } else if (result?._transientOutage) {
              skillError = new Error(result.error);
              skillError._transientOutage = true;
              result = null;
            }
          }
        } catch (err) {
          console.error(`[notes] Parallel tn-writer failed, falling back to single: ${err.message}`);
          // Fall through to single invocation
        }
      } else if (skill.name === 'tn-writer' && !hasVerseRange) {
        console.log(`[notes] Parallel tn-writer skipped for ${ref}: ${chapterVerseCount} verses (< ${TN_WRITER_PARALLEL_MIN_VERSES})`);
      }

      // --- Standard single invocation (for non-tn-writer skills, or single-chunk fallback) ---
      if (!usedPerNote && !usedParallel) {
      if (isDryRun) {
        console.log(`[dry-run] Would run ${skill.name}: ${skill.prompt}`);
        if (skill.expectedOutput) {
          const absPath = path.resolve(CSKILLBP_DIR, skill.expectedOutput);
          fs.mkdirSync(path.dirname(absPath), { recursive: true });
          if (skill.expectedOutput.endsWith('.tsv')) {
            fs.writeFileSync(absPath, 'Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote\n' +
              `${book} ${ch}:${verseStart || 1}\tstub1\t\t\t\t1\t[Stub note for dry run]\n`);
          } else if (skill.expectedOutput.endsWith('.md')) {
            fs.writeFileSync(absPath, `# Stub quality check for ${ref}\n\nDry run — no Claude calls made.\n`);
          }
        }
        await new Promise(r => setTimeout(r, 200));
        result = { subtype: 'success', num_turns: 0, duration_ms: 200, total_cost_usd: 0 };
      } else {
        try {
          console.log(`[notes] Starting skill ${skill.name} for ${ref}`);
          result = await runClaude({
            prompt: skill.prompt,
            cwd: CSKILLBP_DIR,
            model: model || skill.model, // TEST_FAST haiku overrides per-skill model
            skill: skill.name,
            tools: toolConfig.tools,
            disallowedTools: toolConfig.disallowedTools,
            disableLocalSettings: true,
            forceNoAutoBashSandbox: true,
            timeoutMs,
            maxTurns,
            appendSystemPrompt: skill.appendSystemPrompt,
            mcpToolSet: skill.mcpTools,
            guardrails,
            onProgress: ({ turnCount, lastTool, elapsedMs, timedOut }) => {
              const elapsed = Math.round(elapsedMs / 60000);
              const suffix = timedOut ? ' — **timed out**, aborting' : '';
              return status(`Still running **${skill.name}** for ${ref} — ${elapsed}min, ${turnCount} tool calls${lastTool ? `, last: \`${lastTool}\`` : ''}${suffix}`);
            },
          });
        } catch (err) {
          skillError = err;
          console.error(`[notes] ${skill.name} error: ${err.message}`);
        }
      }
      } // end !usedParallel
      // #region agent log
      fetch('http://localhost:7282/ingest/190f0e90-444d-4921-920d-f208e86f8cb3',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'7de6a4'},body:JSON.stringify({sessionId:'7de6a4',runId:debugRunId,hypothesisId:'H4',location:'notes-pipeline.js:skill-result',message:'skill result/error',data:{ref,skill:skill.name,hadError:!!skillError,error:skillError?String(skillError.message||skillError):null,resultSubtype:result?.subtype||null,resultError:result?.error||null},timestamp:Date.now()})}).catch(()=>{});
      // #endregion

      const duration = ((Date.now() - skillStart) / 1000).toFixed(1);
      const sdkSuccess = result?.subtype === 'success';

      // Diagnostic log: budget and token info per skill
      {
        const turns = result?.num_turns ?? '?';
        const cost = result?.total_cost_usd != null ? `$${result.total_cost_usd.toFixed(4)}` : '$?';
        const inTok = result?.usage?.input_tokens ?? result?.usage?.inputTokens ?? 0;
        const outTok = result?.usage?.output_tokens ?? result?.usage?.outputTokens ?? 0;
        const tokens = inTok + outTok;
        const budget = guardrails?.tokenBudget ?? '?';
        const multiplier = guardrails?.multiplier != null ? guardrails.multiplier.toFixed(2) : '?';
        const samples = guardrails?.historySamples ?? '?';
        console.log(
          `[notes] Skill complete: ${skill.name} ${book} ${ch} — turns=${turns}, cost=${cost}, tokens=${tokens}, budget=${budget}, multiplier=${multiplier}, historySamples=${samples}`
        );
      }

      // Log
      const logLine = `${new Date().toISOString()} | ${tag} | ${skill.name} | sdk=${sdkSuccess} | duration=${duration}s\n`;
      fs.appendFileSync(logFile, logLine);

      // Hard fail on thrown SDK errors (including usage/rate limits).
      if (skillError) {
        failedSkill = skill.name;
        const errText = skillError.message || String(skillError);
        if (isTransientOutageError(skillError)) {
          abortForOutage = true;
          setCheckpoint(checkpointRef, {
            state: 'paused_for_outage',
            totalSuccess,
            totalFail,
            current: { chapter: ch, skill: skill.name, status: 'failed', errorKind: 'transient_outage', error: errText },
            resume: { chapter: ch, skill: skill.name },
          });
          await status(`**${skill.name}** paused for ${ref}: Claude transient outage persisted for 10 minutes.`);
          break;
        }
        if (isUsageLimitError(errText)) {
          abortForUsageLimit = true;
          usageLimitTag = buildUsageLimitResetTag(errText);
          const when = usageLimitTag ? ` around ${usageLimitTag}` : ' after the limit resets';
          await status(`**${skill.name}** failed for ${ref}: usage limit reached. Retry${when}.`);
        } else {
          await status(`**${skill.name}** failed for ${ref}: ${errText}`);
        }
        setCheckpoint(checkpointRef, {
          state: abortForUsageLimit ? 'paused_for_usage_limit' : 'failed',
          totalSuccess,
          totalFail,
          current: { chapter: ch, skill: skill.name, status: 'failed', errorKind: 'sdk_error', error: errText },
          resume: { chapter: ch, skill: skill.name },
        });
        break;
      }

      // Hard fail on non-success result payloads, even if old output files exist.
      if (!result || result.subtype !== 'success') {
        failedSkill = skill.name;
        const errText = !result
          ? 'timed out or was aborted (no result returned)'
          : (result.error || result.result || `non-success subtype: "${result.subtype}"`);
        if (isUsageLimitError(errText)) {
          abortForUsageLimit = true;
          usageLimitTag = buildUsageLimitResetTag(errText);
          const when = usageLimitTag ? ` around ${usageLimitTag}` : ' after the limit resets';
          await status(`**${skill.name}** failed for ${ref}: usage limit reached. Retry${when}.`);
        } else {
          await status(`**${skill.name}** failed for ${ref}: ${errText}`);
        }
        setCheckpoint(checkpointRef, {
          state: abortForUsageLimit ? 'paused_for_usage_limit' : 'failed',
          totalSuccess,
          totalFail,
          current: { chapter: ch, skill: skill.name, status: 'failed', errorKind: 'non_success_result', error: errText },
          resume: { chapter: ch, skill: skill.name },
        });
        break;
      }

      // Check expected output — discover by recency first, fall back to resolveOutputFile
      if (skill.expectedOutput) {
        const outDir = path.dirname(skill.expectedOutput);
        const outExt = path.extname(skill.expectedOutput).replace('.', '\\.');
        const discoverPat = new RegExp(`^${book}-0*${ch}(-.*)?${outExt}$`);
        const resolved = discoverFreshOutput(outDir, book, discoverPat, skillStart)
          || resolveOutputFile(skill.expectedOutput, book);
        // #region agent log
        fetch('http://localhost:7282/ingest/190f0e90-444d-4921-920d-f208e86f8cb3',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'7de6a4'},body:JSON.stringify({sessionId:'7de6a4',runId:debugRunId,hypothesisId:'H1',location:'notes-pipeline.js:resolve-output',message:'resolved expected output',data:{ref,skill:skill.name,expectedOutput:skill.expectedOutput,resolved:resolved||null},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
        if (!resolved) {
          failedSkill = skill.name;
          await status(`**${skill.name}** failed for ${ref} \u2014 expected output not found: ${skill.expectedOutput} (${duration}s)`);
          setCheckpoint(checkpointRef, {
            state: 'failed',
            totalSuccess,
            totalFail,
            current: { chapter: ch, skill: skill.name, status: 'failed', errorKind: 'missing_output', outputStatus: 'missing' },
            resume: { chapter: ch, skill: skill.name },
          });
          break;
        }
        // Guard against stale artifacts from previous runs being treated as success.
        const absResolvedFreshness = path.resolve(CSKILLBP_DIR, resolved);
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(absResolvedFreshness).mtimeMs;
        } catch (_) {
          mtimeMs = 0;
        }
        // #region agent log
        fetch('http://localhost:7282/ingest/190f0e90-444d-4921-920d-f208e86f8cb3',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'7de6a4'},body:JSON.stringify({sessionId:'7de6a4',runId:debugRunId,hypothesisId:'H2',location:'notes-pipeline.js:freshness-check',message:'mtime freshness evaluation',data:{ref,skill:skill.name,resolved,skillStart,mtimeMs,isStale:mtimeMs<(skillStart-2000)},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
        if (mtimeMs < skillStart - 2000) {
          if (skill.name === 'post-edit-review') {
            // post-edit-review can legitimately keep an unchanged issues TSV.
            // Reuse the existing file rather than hard-failing this chapter.
            await status(`**${skill.name}** for ${ref}: issues file unchanged in this run; reusing existing file (${resolved}).`);
          } else {
            failedSkill = skill.name;
            await status(`**${skill.name}** failed for ${ref} \u2014 output file is stale from an earlier run: ${resolved}`);
            setCheckpoint(checkpointRef, {
              state: 'failed',
              totalSuccess,
              totalFail,
              current: { chapter: ch, skill: skill.name, status: 'failed', errorKind: 'stale_output', outputStatus: 'stale', outputPath: resolved },
              resume: { chapter: ch, skill: skill.name },
            });
            break;
          }
        }
        skill.resolvedOutput = resolved;
        if (!skillOutputs[ch]) skillOutputs[ch] = {};
        skillOutputs[ch][skill.name] = resolved;
        // Update issuesPath if deep-issue-id produced it in a subdirectory
        if (skill.name === 'deep-issue-id') {
          issuesPath = resolved;
          // Update subsequent skill prompts that reference issuesPath
          for (const s of skills) {
            if (s.prompt && s.prompt.includes('--issues ')) {
              s.prompt = s.prompt.replace(/--issues\s+\S+/, `--issues ${issuesPath}`);
            }
          }
        }
        if (issueProducerSkillNames.has(skill.name)) {
          if (skill.name === 'post-edit-review' && issuesPath) {
            const shape = analyzeIssuesTsvShape(issuesPath);
            if (isMalformedIssuesShape(shape)) {
              restoreIssuesBackup({ backupRel: issuesBackupPath, issuesPath });
              failedSkill = skill.name;
              const shapeSummary = `rows=${shape.rowCount}, blank_sref=${shape.blankSrefRows}, blank_quote=${shape.blankQuoteRows}, blank_both=${shape.blankBothRows}`;
              await status(`**${skill.name}** failed for ${ref} — malformed issues TSV after review (${shapeSummary}). Restored pre-review issues snapshot.`);
              setCheckpoint(checkpointRef, {
                state: 'failed',
                totalSuccess,
                totalFail,
                current: {
                  chapter: ch,
                  skill: skill.name,
                  status: 'failed',
                  errorKind: 'malformed_output',
                  outputStatus: 'malformed',
                  outputPath: issuesPath,
                  details: shapeSummary,
                },
                resume: { chapter: ch, skill: skill.name },
              });
              break;
            }
          }
          await runIssueNormalizationStage();
          // Sanity check: verify the issues TSV starts with an uppercase book code (not a row number)
          if (skill.name === 'post-edit-review' && issuesPath) {
            try {
              const absIssues = path.resolve(CSKILLBP_DIR, issuesPath);
              const content = fs.readFileSync(absIssues, 'utf8');
              const firstLine = content.split('\n').find(l => l.trim().length > 0);
              if (firstLine) {
                const col0 = firstLine.split('\t')[0];
                if (!/^[A-Z]{2,3}$/.test(col0)) {
                  console.warn(`[notes] post-edit-review TSV format warning: column 0 is "${col0}", expected uppercase book code (e.g. PSA). Row numbers may have been prepended.`);
                }
              }
            } catch (e) {
              // Non-fatal — file may not exist yet if skill was skipped
            }
          }
        }
        // Pass resolved notes path to quality-check so it can find the file
        if (skill.name === 'tn-writer') {
          if (hasVerseRange) {
            // Canonical output for partial runs is verse-scoped shard file.
            const absResolved = path.resolve(CSKILLBP_DIR, resolved);
            const absShard = path.resolve(CSKILLBP_DIR, notesShardRel);
            fs.mkdirSync(path.dirname(absShard), { recursive: true });
            if (absResolved !== absShard) {
              fs.copyFileSync(absResolved, absShard);
            }
            skill.resolvedOutput = notesShardRel;
            skillOutputs[ch]['tn-writer'] = notesShardRel;
            console.log(`[notes] Wrote verse shard: ${notesShardRel}`);
            // Keep a chapter-level assembled view up-to-date for future checks/runs.
            const assembledRel = refreshChapterNotesFromShards(book, tag, notesChapterRel);
            if (assembledRel) {
              console.log(`[notes] Refreshed chapter aggregate from shards: ${assembledRel}`);
            }
          }
          // Fill IDs on the assembled notes file (covers both single-run and parallel-shard
          // paths). Without this, chapters produce TSVs with empty ID columns, causing
          // ~100+ mechanical errors in quality-check.
          try {
            const notesPathToFill = skill.resolvedOutput || resolved;
            const fillResult = await fillTsvIds({ tsvFile: notesPathToFill, book });
            console.log(`[notes] fillTsvIds: ${fillResult}`);
          } catch (err) {
            console.warn(`[notes] fillTsvIds failed (non-fatal): ${err.message}`);
          }
          for (const s of skills) {
            if (s.name === 'tn-quality-check') {
              s.prompt = `${skillRef} --notes ${skill.resolvedOutput || resolved}`;
            }
          }
          // Backup the assembled notes file so a later resume can restore it if the
          // output gets wiped by a concurrent fresh run before push completes.
          try {
            const backupSrc = path.resolve(CSKILLBP_DIR, skill.resolvedOutput || resolved);
            const backupDest = backupSrc + '.bak';
            if (fs.existsSync(backupSrc)) {
              fs.copyFileSync(backupSrc, backupDest);
              console.log(`[notes] Backed up assembled notes to ${backupDest}`);
            }
          } catch (err) {
            console.warn(`[notes] notes backup failed (non-fatal): ${err.message}`);
          }
        }
      }

      // Record metrics for this skill
      recordMetrics({
        pipeline: 'notes', skill: skill.name,
        book, chapter: ch, result, success: !failedSkill, userId: message.sender_id,
      });

      // Report token usage if available
      if (result?.usage) {
        const u = result.usage;
        const inTok = u.input_tokens ?? u.inputTokens ?? 0;
        const outTok = u.output_tokens ?? u.outputTokens ?? 0;
        const cost = result.total_cost_usd;
        await status(`**${skill.name}** done (${duration}s, ${(inTok + outTok).toLocaleString()} tokens${cost != null ? `, $${cost.toFixed(4)}` : ''})`);
      } else {
        await status(`**${skill.name}** done (${duration}s)`);
      }
      setCheckpoint(checkpointRef, {
        state: 'running',
        totalSuccess,
        totalFail,
        skillOutputs,
        current: { chapter: ch, skill: skill.name, status: 'succeeded' },
        resume: null,
      });
    }

    const chapterDuration = ((Date.now() - chapterStart) / 1000).toFixed(1);

    if (failedSkill) {
      totalFail++;
      setCheckpoint(checkpointRef, {
        state: abortForOutage ? 'paused_for_outage' : abortForUsageLimit ? 'paused_for_usage_limit' : 'failed',
        totalSuccess,
        totalFail,
        skillOutputs,
        resume: { chapter: ch, skill: failedSkill },
      });
      await status(`Chapter ${ref} failed at **${failedSkill}** after ${chapterDuration}s`);
      if (abortForUsageLimit || abortForOutage) break;
      // Continue to next chapter instead of aborting the whole pipeline
      continue;
    }

    // --- Repo insert + verify inline so editor gets access immediately ---
    // Skip if resuming past this point on a future chapter
    const skipDoor43 = (ch === resumeChapter && resumeSkill === 'door43-push-done');
    if (skipDoor43) {
      await status(`Skipping **door43-push** for ${ref} (already completed in previous run).`);
      totalSuccess++;
      continue;
    }

    const tnWriterSkill = skills.find(s => s.name === 'tn-writer');
    const notesSource = tnWriterSkill?.resolvedOutput
      || (skillOutputs[ch] || {})['tn-writer']
      || (hasVerseRange ? notesShardRel : notesChapterRel);
    let chapterFailed = false;

    // Optional bounded rescue + graceful degradation for unresolved quote issues
    const qualityOutput = (skillOutputs[ch] || {})['tn-quality-check'];
    if (qualityOutput) {
      let quality = readQualityFindings(qualityOutput);
      let unresolved = collectUnresolvedQuoteFindings(quality);
      if (unresolved.length > 0 && RESCUE_MAX_PASSES > 0) {
        await status(`Detected ${unresolved.length} unresolved quote issue(s) in ${ref}; running bounded rescue pass.`);
        try {
          const rescueGuardrails = buildSkillGuardrails({
            pipeline: 'notes',
            skill: 'tn-quality-check',
            book,
            chapter: ch,
            issuesPath,
            contextPath: parseContextPathFlag(ctxFlag),
          });
          const rescuePrompt =
            `${skillRef} --notes ${notesSource}\n\n` +
            `BOUNDED_RESCUE_MODE: One pass only. Focus only on unresolved quote-matching/findings. ` +
            `Do not create scratch scripts and do not perform open-ended manual JSON surgery loops.`;
          await runClaude({
            prompt: rescuePrompt,
            cwd: CSKILLBP_DIR,
            model: model || 'sonnet',
            skill: 'tn-quality-check',
            tools: DEFAULT_RESTRICTED_TOOLS,
            disallowedTools: ['Bash'],
            disableLocalSettings: true,
            forceNoAutoBashSandbox: true,
            timeoutMs: Math.min(8 * 60 * 1000, calcSkillTimeout(book, ch, 1)),
            maxTurns: Math.min(12, rescueGuardrails.maxTurns),
            appendSystemPrompt: TN_QUALITY_CHECK_HINT,
            guardrails: {
              ...rescueGuardrails,
              maxConsecutiveToolErrors: Math.min(3, rescueGuardrails.maxConsecutiveToolErrors || 3),
              maxRepeatedToolErrorSignature: Math.min(2, rescueGuardrails.maxRepeatedToolErrorSignature || 2),
            },
          });
        } catch (err) {
          console.warn(`[notes] bounded rescue pass failed for ${ref}: ${err.message}`);
        }
        quality = readQualityFindings(qualityOutput);
        unresolved = collectUnresolvedQuoteFindings(quality);
      }
      if (unresolved.length > 0) {
        const tagged = appendIssueTagsToTsv(notesSource, unresolved);
        await status(`Graceful degradation for ${ref}: ${unresolved.length} unresolved quote finding(s), tagged ${tagged} row(s) in Tags column.`);
      }
    }

    const finalQuoteSyncSummary = finalCanonicalHebrewQuoteSync({
      notesPath: notesSource,
      preparedJson: ctx.runtime.preparedNotes,
      hebrewUsfm: ctx.sources.hebrew,
    });
    console.log(`[notes] Final canonical Hebrew quote sync: ${finalQuoteSyncSummary}`);

    setCheckpoint(checkpointRef, {
      state: 'running',
      totalSuccess,
      totalFail,
      current: { chapter: ch, skill: 'door43-push', status: 'running' },
      resume: { chapter: ch, skill: 'door43-push' },
    });

    // Dry-run: skip the entire door43-push/verify phase
    if (isDryRun) {
      console.log(`[dry-run] Would run door43-push (TN) for ${ref}`);
      totalSuccess++;
      continue;
    }

    // If push is already deferred due to conflicting branches, collect and skip
    if (deferredPush) {
      deferredChapters.push({ ch, notesSource });
      await status(`**door43-push deferred** for ${ref} (waiting for conflicting branches to be merged)`);
      totalSuccess++;
      continue;
    }

    // Pre-flight: verify DCS token before push
    const dcsCheck = await verifyDcsToken();
    if (!dcsCheck.valid) {
      await status(`**door43-push SKIPPED** for ${ref}: ${dcsCheck.details}`);
      chapterFailed = true;
    }

    // Pre-flight: verify source file exists (restore from backup if wiped)
    if (!chapterFailed) {
      const notesPath = path.resolve(CSKILLBP_DIR, notesSource);
      if (!fs.existsSync(notesPath)) {
        const bakPath = notesPath + '.bak';
        if (fs.existsSync(bakPath)) {
          fs.copyFileSync(bakPath, notesPath);
          console.log(`[notes] Restored notes from backup: ${bakPath}`);
          await status(`Restored notes from backup for ${ref}.`);
        } else {
          await status(`**door43-push SKIPPED** for ${ref}: source file missing: ${notesSource}`);
          chapterFailed = true;
        }
      }
    }

    // Pre-flight: check for conflicting user branches on the target file
    if (!chapterFailed) {
      const repoName = REPO_MAP['tn'];
      const targetFile = getRepoFilename('tn', book);
      const conflicts = await checkConflictingBranches(repoName, targetFile, ch);
      if (conflicts.length > 0) {
        deferredPush = true;
        deferredConflicts = conflicts;
        deferredChapters.push({ ch, notesSource });
        await status(`**door43-push deferred** for ${ref}: conflicting branches found — ${conflicts.map(c => c.branch).join(', ')}`);
        totalSuccess++;
        continue;
      }
    }

    let pushNoChanges = false;
    if (!chapterFailed) await status(`Running **door43-push** (TN) for ${ref}...`);
    const pushStartTime = new Date().toISOString();
    if (!chapterFailed) try {
      const pushResult = await door43Push({
        type: 'tn', book, chapter: ch,
        username, branch: buildBranchName(book, ch),
        source: notesSource,
      });
      if (!pushResult.success) {
        console.error(`[notes] door43-push TN failed for ${ref}: ${pushResult.details}`);
        await status(`**door43-push** (TN) failed for ${ref}: ${pushResult.details}`);
        chapterFailed = true;
      } else {
        pushNoChanges = pushResult.noChanges === true;
        await status(`**door43-push** (TN) done for ${ref}: ${pushResult.details}`);
      }
    } catch (err) {
      console.error(`[notes] door43-push TN error for ${ref}: ${err.message}`);
      await status(`**door43-push** (TN) failed for ${ref}: ${err.message}`);
      chapterFailed = true;
    }

    if (!chapterFailed && pushNoChanges) {
      await status(`Repo verify SKIPPED for ${ref}: no content changes to push`);
    }

    if (!chapterFailed && !pushNoChanges) {
      await status(`Verifying push for ${ref}...`);
      const stagingBranch = buildBranchName(book, ch);
      const verify = await verifyRepoPush({ repo: 'en_tn', stagingBranch, since: pushStartTime });
      if (!verify.success) {
        await status(`Repo verify FAILED for ${ref}: ${verify.details}`);
        console.warn(`[notes] Repo verify failed for ${ref}: ${verify.details}`);
        chapterFailed = true;
      } else {
        await status(`Repo verify OK for ${ref}: ${verify.details}`);
      }
    }

    if (chapterFailed) {
      totalFail++;
      setCheckpoint(checkpointRef, {
        state: 'failed',
        totalSuccess,
        totalFail,
        current: { chapter: ch, skill: 'door43-push', status: 'failed', errorKind: 'push_failed' },
        resume: { chapter: ch, skill: 'door43-push' },
      });
      await status(`Chapter ${ref} failed at **repo-insert/verify** after ${chapterDuration}s`);
      continue;
    }

    totalSuccess++;
    setCheckpoint(checkpointRef, {
      state: 'running',
      totalSuccess,
      totalFail,
      current: { chapter: ch, status: 'chapter_succeeded' },
      resume: null,
    });

    // Pipeline working directory is preserved for debugging (cleaned up after 30 days)
    pipeDir = null;
    contextPath = null;

    // Notify user only after merge is confirmed
    if (chapterCount > 1) {
      await reply(`**${ref}** notes merged to master on en_tn (${chapterDuration}s)`);
    }
  }

  const totalDuration = ((Date.now() - pipelineStart) / 1000).toFixed(1);

  // --- Handle deferred pushes: save to pending-merges and notify user ---
  if (deferredChapters.length > 0) {
    const sessionKey = stream
      ? `stream-${stream}-${topic}`
      : `dm-${message.sender_id}`;
    const repoName = REPO_MAP['tn'];
    const targetFile = getRepoFilename('tn', book);
    const branchList = deferredConflicts.map(c => `\`${c.branch}\``).join(', ');

    setPendingMerge(sessionKey, {
      sessionKey,
      pipelineType: 'notes',
      username,
      book,
      startChapter: deferredChapters[0].ch,
      endChapter: deferredChapters[deferredChapters.length - 1].ch,
      completedChapters: deferredChapters,
      blockingBranches: deferredConflicts.map(c => ({ repo: repoName, branchPattern: c.branch })),
      originalMessage: message,
      createdAt: new Date().toISOString(),
      retryCount: 0,
    });

    // Try to tag the branch owner; fall back to requesting user
    const mention = await resolveConflictMention(
      deferredConflicts[0].branch,
      message.sender_full_name
    );

    const deferredRange = deferredChapters.length === 1
      ? `${book} ${deferredChapters[0].ch}`
      : `${book} ${deferredChapters[0].ch}\u2013${deferredChapters[deferredChapters.length - 1].ch}`;

    await removeReaction(msgId, 'working_on_it');
    await addReaction(msgId, 'hourglass');
    // Use sendMessage directly to control the @-mention (reply() auto-prepends sender)
    const conflictMsg = `${mention} I have notes ready for **${deferredRange}**, but ${branchList} on ${repoName} ` +
      `has edits to \`${targetFile}\`. Please merge your branch first, then say **merged** or **done** ` +
      `so I can proceed with the insertion.`;
    if (stream) {
      await sendMessage(stream, topic, conflictMsg);
    } else {
      await sendDM(message.sender_id, conflictMsg);
    }

    await status(`Notes pipeline for **${rangeLabel}**: generation done, push deferred — waiting for branch merge (${totalDuration}s)`);

    recordRunSummary({
      pipeline: 'notes', book, startCh: startChapter, endCh: endChapter,
      tokensBefore, success: totalFail === 0, userId: message.sender_id,
    });
    clearCheckpoint(checkpointRef);
    return;
  }

  // --- Final reaction and report ---
  await removeReaction(msgId, 'working_on_it');

  if (abortForOutage) {
    await addReaction(msgId, 'warning');
    await reply('Claude is temporarily down, you\'ll need to re-trigger. I saved progress and will resume from the failed skill.');
    await status(`Notes pipeline paused for **${rangeLabel}** due to transient Claude outage; waiting for re-trigger to resume.`);
    return;
  }

  if (abortForUsageLimit) {
    await addReaction(msgId, 'warning');
    const when = usageLimitTag ? ` around ${usageLimitTag}` : ' after the limit resets';
    await reply(
      `Notes pipeline paused: I hit our Claude usage limit and stopped before push/verify for unfinished work. ` +
      `I can resume${when}.`
    );
    recordRunSummary({
      pipeline: 'notes', book, startCh: startChapter, endCh: endChapter,
      tokensBefore, success: false, userId: message.sender_id,
    });
    await status(`Notes pipeline paused for **${rangeLabel}** due to usage limit.`);
    return;
  }

  if (totalFail > 0 && totalSuccess === 0) {
    await addReaction(msgId, 'warning');
    await reply(`Notes pipeline for **${rangeLabel}** failed \u2014 all ${totalFail} chapter(s) had errors. Check admin DMs for details.`);
  } else if (totalFail > 0) {
    await addReaction(msgId, 'warning');
    await reply(
      `Notes pipeline for **${rangeLabel}**: ${totalSuccess} succeeded, ${totalFail} failed (${totalDuration}s). ` +
      `Check admin DMs for details.`
    );
  } else {
    await addReaction(msgId, 'check');

    if (chapterCount === 1) {
      await reply(
        `Notes pipeline complete for **${rangeLabel}** (${totalDuration}s).\n` +
        `Content pushed to master on en_tn\n` +
        `You may need to refresh the tcCreate or gatewayEdit page to see the new content.`
      );
    } else {
      await reply(
        `Notes pipeline complete for **${rangeLabel}**: all ${totalSuccess} chapter(s) succeeded (${totalDuration}s).\n` +
        `Content pushed to master on en_tn\n` +
        `You may need to refresh the tcCreate or gatewayEdit page to see the new content.`
      );
    }
  }

  recordRunSummary({
    pipeline: 'notes', book, startCh: startChapter, endCh: endChapter,
    tokensBefore, success: totalFail === 0, userId: message.sender_id,
  });

  await status(`Notes pipeline complete for **${rangeLabel}** in ${totalDuration}s \u2014 ${totalSuccess} ok, ${totalFail} failed.`);
  // Only clear checkpoint when all chapters succeeded; keep it for resume on failures
  if (totalFail === 0) {
    clearCheckpoint(checkpointRef);
  }
}

module.exports = {
  notesPipeline,
  parseWriteNotesCommand,
  buildParsedNotesRequest,
  shouldRunIntro,
  buildChapterIntroPrompt,
  _applySkillSpecificGuardrails: applySkillSpecificGuardrails,
  _getSkillToolConfig: getSkillToolConfig,
  _appendIssueTagsToTsv: appendIssueTagsToTsv,
  _analyzeIssuesTsvShape: analyzeIssuesTsvShape,
  _collectUnresolvedQuoteFindings: collectUnresolvedQuoteFindings,
  _isMalformedIssuesShape: isMalformedIssuesShape,
  _postProcessNotesTsv: postProcessNotesTsv,
  _finalCanonicalHebrewQuoteSync: finalCanonicalHebrewQuoteSync,
  _runMechanicalQualityPrep: runMechanicalQualityPrep,
  _hasPauseBeforeATsFlag: hasPauseBeforeATsFlag,
  _buildAtGenerationCheckpoint: buildAtGenerationCheckpoint,
  _classifyRunClaudeEmpty: classifyRunClaudeEmpty,
  _buildAtValidatorSystemPrompt: buildAtValidatorSystemPrompt,
  _AT_TIMEOUTS: {
    generationMs: AT_GENERATION_TIMEOUT_MS,
    validationMs: AT_VALIDATION_TIMEOUT_MS,
    retryMs: AT_RETRY_TIMEOUT_MS,
  },
  _DEFAULT_AT_CONCURRENCY: DEFAULT_AT_CONCURRENCY,
};
