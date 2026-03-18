// notes-pipeline.js — Multi-skill sequential pipeline for translation note writing
// Triggered by: "write notes <book> <chapter>" or "write notes <book> <start>-<end>"
// Skills: [post-edit-review OR deep-issue-id] -> [chapter-intro] -> tn-writer (Opus) -> tn-quality-check (Sonnet) -> repo-insert (Haiku)
// chapter-intro is skipped by default; enabled when "with intro" is passed (unless auto-exclusion applies)
//
// Each chapter is fully processed (skills + repo-insert + repo-verify) before
// moving to the next, so the editor gets access as soon as a chapter merges.
// The user is only notified after the merge to master is confirmed.

const fs = require('fs');
const path = require('path');
const config = require('./config');
const { sendMessage, sendDM, addReaction, removeReaction } = require('./zulip-client');
const { runClaude, DEFAULT_RESTRICTED_TOOLS, isTransientOutageError } = require('./claude-runner');
const { getDoor43Username, buildBranchName, resolveOutputFile, discoverFreshOutput, checkPrerequisites, calcSkillTimeout, normalizeBookName, resolveConflictMention, CSKILLBP_DIR } = require('./pipeline-utils');
const { verifyRepoPush, verifyDcsToken } = require('./repo-verify');
const { recordMetrics, getCumulativeTokens, recordRunSummary } = require('./usage-tracker');
const { door43Push, checkConflictingBranches, REPO_MAP, getRepoFilename } = require('./door43-push');
const { setPendingMerge } = require('./pending-merges');
const { mergeTsvs } = require('./workspace-tools/tsv-tools');
const { getCheckpoint, setCheckpoint, clearCheckpoint } = require('./pipeline-checkpoints');

const LOG_DIR = path.resolve(__dirname, '../logs');

const POST_EDIT_REVIEW_HINT =
  'Use Agent teams (TeamCreate + SendMessage) for the Diff Analyzer and Issue Reconciler if available. ' +
  'If Agent teams are not available, fall back to Task subagents and poll with TaskGet until all complete. ' +
  'Do NOT output text without a tool call or the session will end prematurely.';

const DEEP_ISSUE_ID_HINT =
  'Use Agent teams (TeamCreate + SendMessage) for Wave 2 analysts and Wave 3 challenger if available. ' +
  'If Agent teams are not available, fall back to Task subagents and poll with TaskGet in a loop until all tasks show completed status. ' +
  'Do NOT output text without a tool call or the session will end prematurely.';

// Ranges where the chapter intro is written by the human editor — skip automatically.
// PSA 42-123: Books 2-4 handled by Benjamin; 119-123 is a subset but listed explicitly.
const SKIP_INTRO_RANGES = [
  { book: 'PSA', start: 42, end: 123 },
];

function shouldRunIntro(book, chapter, withIntroFlag) {
  if (!withIntroFlag) return false;
  // Auto-exclusion ranges still override even if "with intro" is requested
  if (SKIP_INTRO_RANGES.some(r => r.book === book && chapter >= r.start && chapter <= r.end)) return false;
  return true;
}

function hasWithIntroFlag(content) {
  return /--with-?intro\b/i.test(content) || /\bwith[\s-]intro\b/i.test(content);
}

function hasFreshFlag(content) {
  return /--fresh\b/i.test(String(content || '')) || /--new\b/i.test(String(content || ''));
}

function buildNotesPaths(book, tag, hasVerseRange, verseStart, verseEnd) {
  const chapterRel = `output/notes/${book}/${tag}.tsv`;
  const shardRel = hasVerseRange
    ? `output/notes/${book}/${tag}-vv${verseStart}-${verseEnd}.tsv`
    : chapterRel;
  return { chapterRel, shardRel };
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
    `output/notes/${book}/${tag}.tsv`,
    `output/notes/${book}/${verseTag}.tsv`,
    // quality
    `output/quality/${book}/${tag}-quality.md`,
  ];

  for (const rel of candidates) {
    removeIfExists(path.resolve(CSKILLBP_DIR, rel));
  }
}

function refreshChapterNotesFromShards(book, tag, chapterRel) {
  const shardGlob = `output/notes/${book}/${tag}-vv*.tsv`;
  const merged = mergeTsvs({ globPattern: shardGlob, output: chapterRel });
  if (!merged.startsWith('Merged')) return null;
  return chapterRel;
}

function isUsageLimitError(text) {
  return /hit your limit|usage limit|rate limit|too many requests|429/i.test(String(text || ''));
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
  const rangeMatch = content.match(/write notes(?:\s+for)?\s+(\w+)\s+(\d+)\s*[-\u2013\u2014to]+\s*(\d+)/i);
  if (rangeMatch) {
    return {
      book: normalizeBookName(rangeMatch[1]),
      startChapter: parseInt(rangeMatch[2], 10),
      endChapter: parseInt(rangeMatch[3], 10),
      withIntro: hasWithIntroFlag(content),
      fresh: hasFreshFlag(content),
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
      withIntro: hasWithIntroFlag(content),
      fresh: hasFreshFlag(content),
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
      withIntro: hasWithIntroFlag(content),
      fresh: hasFreshFlag(content),
    };
  }

  return null;
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
  let parsed;
  if (route._synthetic) {
    parsed = {
      book: route._book,
      startChapter: route._startChapter,
      endChapter: route._endChapter,
      withIntro: hasWithIntroFlag(message.content),
      fresh: hasFreshFlag(message.content),
    };
  } else {
    parsed = parseWriteNotesCommand(message.content);
  }

  if (!parsed) {
    await addReaction(msgId, 'cross_mark');
    await status('Could not parse command. Expected: `write notes <book> <chapter>` or `write notes <book> <start>-<end>`');
    return;
  }

  const { book, startChapter, endChapter, verseStart, verseEnd, withIntro, fresh } = parsed;
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
  const username = getDoor43Username(message.sender_email);
  if (!username) {
    await addReaction(msgId, 'cross_mark');
    await status(`No Door43 username mapped for ${message.sender_email}. Add it to door43-users.json.`);
    return;
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
    (existingCheckpoint?.state === 'paused_for_outage' || existingCheckpoint?.state === 'failed' || existingCheckpoint?.state === 'running')
  );
  // #region agent log
  fetch('http://localhost:7282/ingest/190f0e90-444d-4921-920d-f208e86f8cb3',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'7de6a4'},body:JSON.stringify({sessionId:'7de6a4',runId:debugRunId,hypothesisId:'H4',location:'notes-pipeline.js:resume-gate',message:'checkpoint and resume decision',data:{scope:{book,startChapter,endChapter,verseStart:verseStart??null,verseEnd:verseEnd??null},fresh,checkpointState:existingCheckpoint?.state||null,resume:existingCheckpoint?.resume||null,canResumeFromCheckpoint},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
  if (!fresh && canResumeFromCheckpoint && resumeChapter >= startChapter) {
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
    const { missing, resolved } = checkPrerequisites(book, ch,
      hasVerseRange ? verseStart : undefined,
      hasVerseRange ? verseEnd : undefined);
    const hasAIArtifacts = missing.length === 0;

    let issuesPath;
    let failedSkill = null;
    const chapterStart = Date.now();

    // --- Build skill chain based on prerequisite availability ---
    const skills = [];

    if (hasAIArtifacts) {
      // AI artifacts found -> post-edit-review path
      issuesPath = resolved['issues TSV'];
      await status(`**${ref}**: AI artifacts found \u2192 post-edit-review path`);

      skills.push({
        name: 'post-edit-review',
        prompt: `${skillRef} --issues ${issuesPath}`,
        appendSystemPrompt: POST_EDIT_REVIEW_HINT,
        expectedOutput: issuesPath,
        ops: 1,
      });
    } else {
      // No AI artifacts -> deep-issue-id path (fetches from Door43 master)
      const issuesVTag = hasVerseRange ? `${tag}-vv${verseStart}-${verseEnd}` : tag;
      issuesPath = `output/issues/${issuesVTag}.tsv`;
      await status(`**${ref}**: No AI artifacts (missing: ${missing.join(', ')}) \u2192 deep-issue-id path`);

      const verseFlag = hasVerseRange ? ` --verses ${verseStart}-${verseEnd}` : '';
      skills.push({
        name: 'deep-issue-id',
        prompt: `${book} ${ch}${verseFlag}`,
        appendSystemPrompt: DEEP_ISSUE_ID_HINT,
        expectedOutput: issuesPath,
        ops: 3, // 2 analysts + challenger/merge
      });
    }

    // chapter-intro: only runs when "with intro" is requested (and not in auto-exclusion range)
    if (shouldRunIntro(book, ch, withIntro)) {
      skills.push({
        name: 'chapter-intro',
        prompt: `${skillRef} --issues ${issuesPath}`,
        expectedOutput: issuesPath,
        ops: 1,
      });
    } else if (withIntro) {
      await status(`**${ref}**: skipping chapter-intro (auto-excluded range)`);
    }

    const { chapterRel: notesChapterRel, shardRel: notesShardRel } = buildNotesPaths(
      book, tag, hasVerseRange, verseStart, verseEnd
    );
    skills.push({
      name: 'tn-writer',
      prompt: `${skillRef} --issues ${issuesPath}`,
      expectedOutput: hasVerseRange ? notesShardRel : notesChapterRel,
      ops: 1,
    });

    // tn-quality-check runs as a separate Sonnet invocation for independent review
    const qualityTag = hasVerseRange ? `${tag}-vv${verseStart}-${verseEnd}` : tag;
    const defaultNotesPath = hasVerseRange ? notesShardRel : notesChapterRel;
    skills.push({
      name: 'tn-quality-check',
      prompt: `${skillRef} --notes ${defaultNotesPath}`,
      expectedOutput: `output/quality/${book}/${qualityTag}-quality.md`,
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
    // Restore resolvedOutput for skipped skills from the manifest
    const chOutputs = skillOutputs[ch] || {};
    for (let si2 = 0; si2 < startSkillIndex; si2++) {
      if (chOutputs[skills[si2].name]) {
        skills[si2].resolvedOutput = chOutputs[skills[si2].name];
      }
    }
    if (chOutputs['deep-issue-id']) issuesPath = chOutputs['deep-issue-id'];
    else if (chOutputs['post-edit-review']) issuesPath = chOutputs['post-edit-review'];

    for (let si = startSkillIndex; si < skills.length; si++) {
      const skill = skills[si];
      const skillStart = Date.now();
      // Delete expected output so Claude must recreate it (prevents stale-mtime false failures on resume)
      if (skill.expectedOutput) {
        const preClean = resolveOutputFile(skill.expectedOutput, book);
        if (preClean) {
          try { fs.unlinkSync(path.resolve(CSKILLBP_DIR, preClean)); } catch (_) { /* fine if missing */ }
        }
      }
      const timeoutMs = calcSkillTimeout(book, ch, skill.ops);
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
          result = await runClaude({
            prompt: skill.prompt,
            cwd: CSKILLBP_DIR,
            model: model || skill.model, // TEST_FAST haiku overrides per-skill model
            skill: skill.name,
            tools: DEFAULT_RESTRICTED_TOOLS,
            disallowedTools: ['Bash'],
            disableLocalSettings: true,
            forceNoAutoBashSandbox: true,
            timeoutMs,
            appendSystemPrompt: skill.appendSystemPrompt,
          });
        } catch (err) {
          skillError = err;
          console.error(`[notes] ${skill.name} error: ${err.message}`);
        }
      }
      // #region agent log
      fetch('http://localhost:7282/ingest/190f0e90-444d-4921-920d-f208e86f8cb3',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'7de6a4'},body:JSON.stringify({sessionId:'7de6a4',runId:debugRunId,hypothesisId:'H4',location:'notes-pipeline.js:skill-result',message:'skill result/error',data:{ref,skill:skill.name,hadError:!!skillError,error:skillError?String(skillError.message||skillError):null,resultSubtype:result?.subtype||null,resultError:result?.error||null},timestamp:Date.now()})}).catch(()=>{});
      // #endregion

      const duration = ((Date.now() - skillStart) / 1000).toFixed(1);
      const sdkSuccess = result?.subtype === 'success';

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
          state: 'failed',
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
        const errText = result?.error || result?.result || `Claude returned subtype "${result?.subtype || 'unknown'}"`;
        if (isUsageLimitError(errText)) {
          abortForUsageLimit = true;
          usageLimitTag = buildUsageLimitResetTag(errText);
          const when = usageLimitTag ? ` around ${usageLimitTag}` : ' after the limit resets';
          await status(`**${skill.name}** failed for ${ref}: usage limit reached. Retry${when}.`);
        } else {
          await status(`**${skill.name}** failed for ${ref}: ${errText}`);
        }
        setCheckpoint(checkpointRef, {
          state: 'failed',
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
            if (s.prompt && s.prompt.includes(`output/issues/${tag}.tsv`)) {
              s.prompt = s.prompt.replace(`output/issues/${tag}.tsv`, issuesPath);
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
          for (const s of skills) {
            if (s.name === 'tn-quality-check') {
              s.prompt = `${skillRef} --notes ${skill.resolvedOutput || resolved}`;
            }
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
        state: abortForOutage ? 'paused_for_outage' : 'failed',
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

    // Pre-flight: verify source file exists
    if (!chapterFailed) {
      const notesPath = path.resolve(CSKILLBP_DIR, notesSource);
      if (!fs.existsSync(notesPath)) {
        await status(`**door43-push SKIPPED** for ${ref}: source file missing: ${notesSource}`);
        chapterFailed = true;
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
        await status(`**door43-push** (TN) done for ${ref}: ${pushResult.details}`);
      }
    } catch (err) {
      console.error(`[notes] door43-push TN error for ${ref}: ${err.message}`);
      await status(`**door43-push** (TN) failed for ${ref}: ${err.message}`);
      chapterFailed = true;
    }

    if (!chapterFailed) {
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
    clearCheckpoint(checkpointRef);
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
  clearCheckpoint(checkpointRef);
}

module.exports = { notesPipeline };
