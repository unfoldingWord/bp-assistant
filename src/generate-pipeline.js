// generate-pipeline.js — SDK-based generation pipeline
// Replaces generate.sh: parses command, loops chapters, calls Claude SDK, posts results to Zulip
// fileResponseUserIds get files uploaded; others get align + repo-insert + repo-verify
//
// Two-phase design for non-file-response users:
//   Phase 1: Generate + align (always runs, expensive)
//   Phase 2: Repo insert — push to master (cheap, always runs inline)

const fs = require('fs');
const path = require('path');
const config = require('./config');
const { sendMessage, sendDM, addReaction, removeReaction, uploadFile } = require('./zulip-client');
const { runClaude, DEFAULT_RESTRICTED_TOOLS, isTransientOutageError } = require('./claude-runner');
const { getDoor43Username, buildBranchName, resolveOutputFile, calcSkillTimeout, normalizeBookName, resolveConflictMention, CSKILLBP_DIR } = require('./pipeline-utils');
const { verifyRepoPush, verifyDcsToken } = require('./repo-verify');
const { ensureFreshToken, isAuthError } = require('./auth-refresh');
const { recordMetrics, getCumulativeTokens, recordRunSummary } = require('./usage-tracker');
const { door43Push, checkConflictingBranches, REPO_MAP, getRepoFilename } = require('./door43-push');
const { setPendingMerge } = require('./pending-merges');
const { getCheckpoint, setCheckpoint, clearCheckpoint } = require('./pipeline-checkpoints');

const LOG_DIR = path.resolve(__dirname, '../logs');
const REQUIRED_INITIAL_PIPELINE_FILES = [
  '.claude/skills/initial-pipeline/SKILL.md',
  '.claude/skills/issue-identification/orchestration-conventions.md',
  '.claude/skills/issue-identification/analyst-domains.md',
  '.claude/skills/issue-identification/challenger-protocol.md',
  '.claude/skills/issue-identification/merge-procedure.md',
  '.claude/skills/issue-identification/gemini-review-wave.md',
];

function hasFreshFlag(content) {
  return /--fresh\b/i.test(String(content || '')) || /--new\b/i.test(String(content || ''));
}

function removeIfExists(absPath) {
  try {
    if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
  } catch (_) {
    // non-fatal best-effort cleanup
  }
}

function cleanupGenerateArtifacts({ book, chapter, verseStart, verseEnd }) {
  const width = book.toUpperCase() === 'PSA' ? 3 : 2;
  const tag = `${book}-${String(chapter).padStart(width, '0')}`;
  const hasVerseRange = verseStart != null && verseEnd != null;
  const verseTag = hasVerseRange ? `${tag}-vv${verseStart}-${verseEnd}` : tag;

  const candidates = [
    // generation outputs
    `output/AI-ULT/${tag}.usfm`,
    `output/AI-UST/${tag}.usfm`,
    `output/AI-ULT/${book}/${tag}.usfm`,
    `output/AI-UST/${book}/${tag}.usfm`,
    // aligned outputs
    `output/AI-ULT/${tag}-aligned.usfm`,
    `output/AI-UST/${tag}-aligned.usfm`,
    `output/AI-ULT/${book}/${tag}-aligned.usfm`,
    `output/AI-UST/${book}/${tag}-aligned.usfm`,
    // issue files potentially reused by initial pipeline variants
    `output/issues/${tag}.tsv`,
    `output/issues/${verseTag}.tsv`,
    `output/issues/${book}/${tag}.tsv`,
    `output/issues/${book}/${verseTag}.tsv`,
  ];

  for (const rel of candidates) {
    removeIfExists(path.resolve(CSKILLBP_DIR, rel));
  }
}

function parseGenerateCommand(content) {
  const input = content.toLowerCase();

  // Verse range in a single chapter: generate lam 2:1-3
  const verseMatch = input.match(/generate\s+([a-z0-9]+)\s+(\d+):(\d+)\s*[-\u2013\u2014]\s*(\d+)/);
  if (verseMatch) {
    const chapter = parseInt(verseMatch[2], 10);
    return {
      book: normalizeBookName(verseMatch[1]),
      start: chapter,
      end: chapter,
      verseStart: parseInt(verseMatch[3], 10),
      verseEnd: parseInt(verseMatch[4], 10),
      fresh: hasFreshFlag(content),
    };
  }

  // Range: generate psa 79-89, generate psa 79\u201389, generate psa 79 to 89
  const rangeMatch = input.match(/generate\s+([a-z0-9]+)\s+(\d+)\s*[-\u2013\u2014to]+\s*(\d+)/);
  if (rangeMatch) {
    return {
      book: normalizeBookName(rangeMatch[1]),
      start: parseInt(rangeMatch[2], 10),
      end: parseInt(rangeMatch[3], 10),
      verseStart: null,
      verseEnd: null,
      fresh: hasFreshFlag(content),
    };
  }

  // Single: generate psa 79
  const singleMatch = input.match(/generate\s+([a-z0-9]+)\s+(\d+)/);
  if (singleMatch) {
    const ch = parseInt(singleMatch[2], 10);
    return {
      book: normalizeBookName(singleMatch[1]),
      start: ch,
      end: ch,
      verseStart: null,
      verseEnd: null,
      fresh: hasFreshFlag(content),
    };
  }

  return null;
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
  if (resetUtc.getTime() <= now.getTime()) resetUtc.setUTCDate(resetUtc.getUTCDate() + 1);
  return `<time:${chicagoIsoFromUtcDate(resetUtc)}>`;
}

function isFreshOutput(relPath, minMs) {
  if (!relPath) return false;
  try {
    const abs = path.resolve(CSKILLBP_DIR, relPath);
    return fs.statSync(abs).mtimeMs >= (minMs - 2000);
  } catch {
    return false;
  }
}

async function generatePipeline(route, message) {
  const adminUserId = config.adminUserId;
  const stream = message.type === 'stream' ? message.display_recipient : null;
  const topic = message.subject || '';
  const msgId = message.id;

  const isDryRun = process.env.DRY_RUN === '1';
  const isTestFast = process.env.TEST_FAST === '1';
  const fileUserIds = config.fileResponseUserIds || [config.chrisUserId];
  const isFileResponse = fileUserIds.includes(message.sender_id);

  // Helper: DM status to admin
  async function status(text) {
    try {
      await sendDM(adminUserId, text);
    } catch (err) {
      console.error(`[generate] Failed to send status DM: ${err.message}`);
    }
  }

  // Helper: reply to the originating stream
  async function reply(text) {
    try {
      if (stream) {
        const mention = message.sender_full_name ? `@**${message.sender_full_name}** ` : '';
        await sendMessage(stream, topic, mention + text);
      } else {
        await sendDM(message.sender_id, text);
      }
    } catch (err) {
      console.error(`[generate] Failed to send reply: ${err.message}`);
    }
  }

  // Parse command \u2014 support both regex-parsed and synthetic routes from intent classifier
  let parsed;
  if (route._synthetic) {
    parsed = {
      book: route._book,
      start: route._startChapter,
      end: route._endChapter,
      verseStart: route._verseStart ?? null,
      verseEnd: route._verseEnd ?? null,
      fresh: hasFreshFlag(message.content),
    };
  } else {
    parsed = parseGenerateCommand(message.content);
  }

  if (!parsed) {
    await addReaction(msgId, 'cross_mark');
    await status('Could not parse command. Expected format: `generate <book> <chapter>`, `generate <book> <start>-<end>`, or `generate <book> <chapter>:<startVerse>-<endVerse>`');
    return;
  }

  const { book, start, end, verseStart, verseEnd, fresh } = parsed;
  const sessionKey = stream ? `stream-${stream}-${topic}` : `dm-${message.sender_id}`;
  const checkpointRef = {
    sessionKey,
    pipelineType: 'generate',
    scope: { book, startChapter: start, endChapter: end, verseStart: verseStart ?? null, verseEnd: verseEnd ?? null },
  };
  let existingCheckpoint = getCheckpoint(checkpointRef);
  const chapterCount = end - start + 1;
  const hasVerseRange = verseStart != null && verseEnd != null && start === end;

  if (chapterCount < 1) {
    await addReaction(msgId, 'cross_mark');
    await status(`Invalid chapter range: ${start}-${end}`);
    return;
  }
  if (hasVerseRange && verseEnd < verseStart) {
    await addReaction(msgId, 'cross_mark');
    await status(`Invalid verse range: ${start}:${verseStart}-${verseEnd}`);
    return;
  }

  // Token estimate (informational only — no hard rejection based on estimates)
  const perChapter = (route.tokenEstimate && route.tokenEstimate.perChapter) || 5000000;
  const estimatedTotal = chapterCount * perChapter;

  // --- Non-file-response pre-checks: Door43 username ---
  let username = null;
  if (!isFileResponse) {
    username = getDoor43Username(message.sender_email);
    if (!username) {
      await addReaction(msgId, 'cross_mark');
      await status(`No Door43 username mapped for ${message.sender_email}. Add it to door43-users.json.`);
      return;
    }
  }

  if (fresh) {
    clearCheckpoint(checkpointRef);
    for (let ch = start; ch <= end; ch++) {
      cleanupGenerateArtifacts({ book, chapter: ch, verseStart, verseEnd });
    }
    existingCheckpoint = null;
    const freshLabel = hasVerseRange ? `${book} ${start}:${verseStart}-${verseEnd}` : `${book} ${start}\u2013${end}`;
    await status(`Fresh mode enabled for **${freshLabel}** — cleared existing checkpoint and prior artifacts.`);
  }

  // Signal working
  await addReaction(msgId, 'working_on_it');
  const modeLabel = isFileResponse ? 'files-only' : 'full pipeline (align + repo-insert)';
  const refLabel = hasVerseRange ? `${book} ${start}:${verseStart}-${verseEnd}` : `${book} ${start}\u2013${end}`;
  await status(`Starting generation for **${refLabel}** (${chapterCount} chapter(s), mode: ${modeLabel}, ~${estimatedTotal} tokens estimated)`);

  // Ensure log directory
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const logFile = path.join(LOG_DIR, 'generate.log');

  // Determine model
  const model = isTestFast ? 'haiku' : undefined;

  // Determine skill from route config
  const skill = route.skill || 'initial-pipeline';
  const isInitialPipelineSkill = skill.split(/\s+/)[0] === 'initial-pipeline';

  if (isInitialPipelineSkill) {
    const missingFiles = REQUIRED_INITIAL_PIPELINE_FILES.filter((relPath) => !fs.existsSync(path.join(CSKILLBP_DIR, relPath)));
    if (missingFiles.length > 0) {
      await addReaction(msgId, 'cross_mark');
      await status(
        `Generate preflight failed: required skill files are missing under ${CSKILLBP_DIR}:\n` +
        missingFiles.map((f) => `- \`${f}\``).join('\n')
      );
      return;
    }
  }

  const tokensBefore = getCumulativeTokens();
  let success = Number(existingCheckpoint?.success || 0);
  let fail = Number(existingCheckpoint?.fail || 0);
  const completedChapters = Array.isArray(existingCheckpoint?.completedChapters) ? [...existingCheckpoint.completedChapters] : []; // Phase 1 results for non-file-response users
  let abortForUsageLimit = false;
  let abortForOutage = false;
  let usageLimitTag = null;
  let resumeChapter = Number(existingCheckpoint?.resume?.chapter || start);
  let resumeSkill = existingCheckpoint?.resume?.skill || null;

  const canResumeFromCheckpoint = (
    existingCheckpoint?.resume?.chapter != null &&
    (existingCheckpoint?.state === 'paused_for_outage' || existingCheckpoint?.state === 'failed')
  );
  if (!fresh && canResumeFromCheckpoint && resumeChapter >= start) {
    await status(`Resuming generation from checkpoint at **${book} ${resumeChapter}** (${resumeSkill || 'chapter start'}).`);
    await reply(`Resuming generation for **${refLabel}** from **${book} ${resumeChapter}** (${resumeSkill || 'chapter start'}).`);
  } else {
    resumeChapter = start;
    resumeSkill = null;
  }
  setCheckpoint(checkpointRef, {
    state: 'running',
    success,
    fail,
    completedChapters,
    resume: { chapter: resumeChapter, skill: resumeSkill },
  });

  // =========================================================================
  // Phase 1: Generate + Align (always runs)
  // =========================================================================
  for (let ch = start; ch <= end; ch++) {
    if (ch < resumeChapter) continue;
    console.log(`[generate] Processing ${book} chapter ${ch}...`);
    const chapterRef = hasVerseRange ? `${book} ${ch}:${verseStart}-${verseEnd}` : `${book} ${ch}`;
    await status(`Processing **${chapterRef}**...`);

    const chapterStart = Date.now();
    let claudeResult = null;
    let sdkError = null;
    const runInitialSkill = !(ch === resumeChapter && resumeSkill === 'align-all-parallel');

    if (!runInitialSkill) {
      await status(`Resuming ${chapterRef} at **align-all-parallel**.`);
    } else if (isDryRun) {
      const dryRunRef = hasVerseRange ? `${book} ${ch}:${verseStart}-${verseEnd}` : `${book} ${ch}`;
      console.log(`[dry-run] Would run Claude SDK: /${skill} ${dryRunRef} (in ${CSKILLBP_DIR})`);

      // Create stub output files
      const ultDir = path.join(CSKILLBP_DIR, 'output', 'AI-ULT');
      const ustDir = path.join(CSKILLBP_DIR, 'output', 'AI-UST');
      fs.mkdirSync(ultDir, { recursive: true });
      fs.mkdirSync(ustDir, { recursive: true });

      fs.writeFileSync(
        path.join(ultDir, `${book}-${ch}.usfm`),
        `\\id ${book}\n\\c ${ch}\n\\v 1 [Stub ULT verse 1]\n\\v 2 [Stub ULT verse 2]\n`
      );
      fs.writeFileSync(
        path.join(ustDir, `${book}-${ch}.usfm`),
        `\\id ${book}\n\\c ${ch}\n\\v 1 [Stub UST verse 1]\n\\v 2 [Stub UST verse 2]\n`
      );

      // Simulate brief delay
      await new Promise((r) => setTimeout(r, 200));
      claudeResult = { subtype: 'success', num_turns: 0, duration_ms: 200, total_cost_usd: 0 };
    } else {
      setCheckpoint(checkpointRef, {
        state: 'running',
        success,
        fail,
        completedChapters,
        current: { chapter: ch, skill: skill, status: 'running', startedAt: new Date(chapterStart).toISOString() },
        resume: { chapter: ch, skill },
      });
      // Delete expected outputs so Claude must recreate them (prevents stale-mtime false failures on resume)
      for (const rel of [`output/AI-ULT/${book}-${ch}.usfm`, `output/AI-UST/${book}-${ch}.usfm`]) {
        const resolved = resolveOutputFile(rel, book);
        if (resolved) {
          try { fs.unlinkSync(path.resolve(CSKILLBP_DIR, resolved)); } catch (_) { /* fine if missing */ }
        }
      }
      try {
        const timeoutMs = calcSkillTimeout(book, ch, 3); // 3 ops for initial-pipeline
        const skillRef = hasVerseRange ? `${book} ${ch}:${verseStart}-${verseEnd}` : `${book} ${ch}`;
        if (runInitialSkill) {
          claudeResult = await runClaude({
            prompt: skillRef,
            cwd: CSKILLBP_DIR,
            model,
            skill,
            tools: DEFAULT_RESTRICTED_TOOLS,
            disallowedTools: ['Bash'],
            disableLocalSettings: true,
            forceNoAutoBashSandbox: true,
            timeoutMs,
          });
        } else {
          claudeResult = { subtype: 'success', resumed: true };
        }
      } catch (err) {
        sdkError = err;
        console.error(`[generate] Claude SDK error for ${book} ${ch}: ${err.message}`);
        if (isTransientOutageError(err)) {
          abortForOutage = true;
          setCheckpoint(checkpointRef, {
            state: 'paused_for_outage',
            success,
            fail,
            completedChapters,
            current: { chapter: ch, skill, status: 'failed', errorKind: 'transient_outage', error: err.message },
            resume: { chapter: ch, skill },
          });
          break;
        }
        if (isAuthError(err)) {
          await reply('Claude auth expired. Waiting for re-authentication...');
          await status(`Auth error on ${book} ${ch} — waiting for reauth`);
          const restored = await ensureFreshToken();
          if (restored) {
            await status(`Auth restored — retrying ${book} ${ch}`);
            ch--;
            continue;
          }
          await status(`Auth could not be restored — aborting remaining chapters`);
          fail += (end - ch + 1);
          setCheckpoint(checkpointRef, {
            state: 'failed',
            success,
            fail,
            completedChapters,
            current: { chapter: ch, skill, status: 'failed', errorKind: 'auth_error', error: err.message },
            resume: { chapter: ch, skill },
          });
          break;
        }
      }
    }

    const duration = ((Date.now() - chapterStart) / 1000).toFixed(1);
    const sdkSuccess = claudeResult?.subtype === 'success';

    // UST is the last artifact the pipeline produces
    // Check both flat (output/AI-ULT/PSA-133.usfm) and subfolder (output/AI-ULT/PSA/PSA-133.usfm) paths
    const ultRel = resolveOutputFile(`output/AI-ULT/${book}-${ch}.usfm`, book);
    const ustRel = resolveOutputFile(`output/AI-UST/${book}-${ch}.usfm`, book);
    const hasUlt = !!ultRel;
    const hasUst = !!ustRel;

    // Log timing
    const logLine = `${new Date().toISOString()} | ${book} ${ch} | sdk=${sdkSuccess} | ult=${hasUlt} | ust=${hasUst} | duration=${duration}s\n`;
    fs.appendFileSync(logFile, logLine);

    if (sdkError) {
      const errText = sdkError.message || String(sdkError);
      if (isUsageLimitError(errText)) {
        abortForUsageLimit = true;
        usageLimitTag = buildUsageLimitResetTag(errText);
        setCheckpoint(checkpointRef, {
          state: 'failed',
          success,
          fail,
          completedChapters,
          current: { chapter: ch, skill, status: 'failed', errorKind: 'usage_limit', error: errText },
          resume: { chapter: ch, skill },
        });
        break;
      }
      await status(`Failed to generate **${book} ${ch}**: ${errText}`);
      fail++;
      setCheckpoint(checkpointRef, {
        state: 'failed',
        success,
        fail,
        completedChapters,
        current: { chapter: ch, skill, status: 'failed', errorKind: 'sdk_error', error: errText },
        resume: { chapter: ch, skill },
      });
      continue;
    }

    if (!claudeResult || claudeResult.subtype !== 'success') {
      const errText = claudeResult?.error || claudeResult?.result || `Claude returned subtype "${claudeResult?.subtype || 'unknown'}"`;
      if (isUsageLimitError(errText)) {
        abortForUsageLimit = true;
        usageLimitTag = buildUsageLimitResetTag(errText);
        setCheckpoint(checkpointRef, {
          state: 'failed',
          success,
          fail,
          completedChapters,
          current: { chapter: ch, skill, status: 'failed', errorKind: 'usage_limit', error: errText },
          resume: { chapter: ch, skill },
        });
        break;
      }
      await status(`Failed to generate **${book} ${ch}**: ${errText}`);
      fail++;
      setCheckpoint(checkpointRef, {
        state: 'failed',
        success,
        fail,
        completedChapters,
        current: { chapter: ch, skill, status: 'failed', errorKind: 'non_success_result', error: errText },
        resume: { chapter: ch, skill },
      });
      continue;
    }

    if (!hasUst) {
      await status(`Failed to generate **${book} ${ch}**. UST not produced${hasUlt ? ' (ULT exists but may be incomplete)' : ''}. Check logs for details.`);
      fail++;
      setCheckpoint(checkpointRef, {
        state: 'failed',
        success,
        fail,
        completedChapters,
        current: { chapter: ch, skill, status: 'failed', errorKind: 'missing_output', outputStatus: 'missing' },
        resume: { chapter: ch, skill },
      });
      continue;
    }

    if (!isFreshOutput(ustRel, chapterStart)) {
      await status(`Failed to generate **${book} ${ch}**: output appears stale from an earlier run (${ustRel}).`);
      fail++;
      setCheckpoint(checkpointRef, {
        state: 'failed',
        success,
        fail,
        completedChapters,
        current: { chapter: ch, skill, status: 'failed', errorKind: 'stale_output', outputStatus: 'stale', outputPath: ustRel },
        resume: { chapter: ch, skill },
      });
      continue;
    }

    // DM token usage to admin if available
    if (claudeResult?.usage) {
      const u = claudeResult.usage;
      const inTok = u.input_tokens ?? u.inputTokens ?? 0;
      const outTok = u.output_tokens ?? u.outputTokens ?? 0;
      const cacheRead = u.cache_read_input_tokens ?? u.cacheReadInputTokens ?? 0;
      const cacheCreate = u.cache_creation_input_tokens ?? u.cacheCreationInputTokens ?? 0;
      const total = inTok + outTok + cacheRead + cacheCreate;
      const cost = claudeResult.total_cost_usd;
      await status(`**${book} ${ch}** tokens: ${total.toLocaleString()} (in: ${inTok.toLocaleString()}, out: ${outTok.toLocaleString()}, cache read: ${cacheRead.toLocaleString()})${cost != null ? ` \u00b7 $${cost.toFixed(4)}` : ''} \u00b7 ${duration}s`);
    }

    // Record metrics for initial-pipeline
    const metricRef = hasVerseRange ? `${book} ${ch}:${verseStart}-${verseEnd}` : `${book} ${ch}`;
    console.log(`[generate] Metrics ref: initial-pipeline ${metricRef}`);
    recordMetrics({
      pipeline: 'generate', skill: route.skill || 'initial-pipeline',
      book, chapter: ch, result: claudeResult, success: hasUst, userId: message.sender_id,
    });
    setCheckpoint(checkpointRef, {
      state: 'running',
      success,
      fail,
      completedChapters,
      current: { chapter: ch, skill, status: 'succeeded' },
      resume: null,
    });

    // --- File-response path: upload files only ---
    if (isFileResponse) {
      const links = [];

      if (hasUlt) {
        try {
          const ultUri = await uploadFile(path.join(CSKILLBP_DIR, ultRel), `${book} ${ch} ULT.usfm`);
          links.push(`[${book} ${ch} ULT.usfm](${ultUri})`);
        } catch (err) {
          console.error(`[generate] Failed to upload ULT: ${err.message}`);
          links.push(`ULT upload failed: ${err.message}`);
        }
      }

      if (hasUst) {
        try {
          const ustUri = await uploadFile(path.join(CSKILLBP_DIR, ustRel), `${book} ${ch} UST.usfm`);
          links.push(`[${book} ${ch} UST.usfm](${ustUri})`);
        } catch (err) {
          console.error(`[generate] Failed to upload UST: ${err.message}`);
          links.push(`UST upload failed: ${err.message}`);
        }
      }

      await reply(`**${book} ${ch}** \u2014 ${links.join(' \u00b7 ')}`);
      success++;
      setCheckpoint(checkpointRef, {
        state: 'running',
        success,
        fail,
        completedChapters,
        current: { chapter: ch, status: 'chapter_succeeded' },
        resume: null,
      });
      continue;
    }

    // --- Non-file-response path: Phase 1 \u2014 align and collect results ---

    // Step 2: align-all-parallel
    await status(`Running **align-all-parallel** for ${book} ${ch}...`);
    setCheckpoint(checkpointRef, {
      state: 'running',
      success,
      fail,
      completedChapters,
      current: { chapter: ch, skill: 'align-all-parallel', status: 'running' },
      resume: { chapter: ch, skill: 'align-all-parallel' },
    });
    // Delete expected aligned outputs so Claude must recreate them (prevents stale-mtime false failures on resume)
    for (const rel of [`output/AI-ULT/${book}-${ch}-aligned.usfm`, `output/AI-UST/${book}-${ch}-aligned.usfm`]) {
      const resolved = resolveOutputFile(rel, book);
      if (resolved) {
        try { fs.unlinkSync(path.resolve(CSKILLBP_DIR, resolved)); } catch (_) { /* fine if missing */ }
      }
    }
    try {
      const alignTimeout = calcSkillTimeout(book, ch, 2);
      const alignRef = hasVerseRange ? `${book} ${ch}:${verseStart}-${verseEnd}` : `${book} ${ch}`;
      const alignResult = await runClaude({
        prompt: alignRef,
        cwd: CSKILLBP_DIR,
        model,
        skill: 'align-all-parallel',
        tools: DEFAULT_RESTRICTED_TOOLS,
        disallowedTools: ['Bash'],
        disableLocalSettings: true,
        forceNoAutoBashSandbox: true,
        timeoutMs: alignTimeout,
      });
      const alignDuration = ((Date.now() - chapterStart) / 1000).toFixed(1);

      if (!alignResult || alignResult.subtype !== 'success') {
        const errText = alignResult?.error || alignResult?.result || `Claude returned subtype "${alignResult?.subtype || 'unknown'}"`;
        if (isUsageLimitError(errText)) {
          abortForUsageLimit = true;
          usageLimitTag = buildUsageLimitResetTag(errText);
          setCheckpoint(checkpointRef, {
            state: 'failed',
            success,
            fail,
            completedChapters,
            current: { chapter: ch, skill: 'align-all-parallel', status: 'failed', errorKind: 'usage_limit', error: errText },
            resume: { chapter: ch, skill: 'align-all-parallel' },
          });
          break;
        }
        await status(`**align-all-parallel** failed for ${book} ${ch}: ${errText}`);
        fail++;
        setCheckpoint(checkpointRef, {
          state: 'failed',
          success,
          fail,
          completedChapters,
          current: { chapter: ch, skill: 'align-all-parallel', status: 'failed', errorKind: 'non_success_result', error: errText },
          resume: { chapter: ch, skill: 'align-all-parallel' },
        });
        continue;
      }

      // Record metrics for align-all-parallel
      const alignMetricRef = hasVerseRange ? `${book} ${ch}:${verseStart}-${verseEnd}` : `${book} ${ch}`;
      console.log(`[generate] Metrics ref: align-all-parallel ${alignMetricRef}`);
      recordMetrics({
        pipeline: 'generate', skill: 'align-all-parallel',
        book, chapter: ch, result: alignResult,
        success: alignResult?.subtype === 'success', userId: message.sender_id,
      });

      // Check aligned output files via resolveOutputFile (handles padding + subdirs)
      const alignedUltRel = resolveOutputFile(`output/AI-ULT/${book}-${ch}-aligned.usfm`, book);
      const alignedUstRel = resolveOutputFile(`output/AI-UST/${book}-${ch}-aligned.usfm`, book);

      if (!alignedUltRel || !alignedUstRel) {
        await status(`**align-all-parallel** failed for ${book} ${ch} \u2014 aligned files not found (${alignDuration}s)`);
        fail++;
        setCheckpoint(checkpointRef, {
          state: 'failed',
          success,
          fail,
          completedChapters,
          current: { chapter: ch, skill: 'align-all-parallel', status: 'failed', errorKind: 'missing_output', outputStatus: 'missing' },
          resume: { chapter: ch, skill: 'align-all-parallel' },
        });
        continue;
      }
      if (!isFreshOutput(alignedUltRel, chapterStart) || !isFreshOutput(alignedUstRel, chapterStart)) {
        await status(`**align-all-parallel** failed for ${book} ${ch} \u2014 aligned output appears stale from an earlier run`);
        fail++;
        setCheckpoint(checkpointRef, {
          state: 'failed',
          success,
          fail,
          completedChapters,
          current: { chapter: ch, skill: 'align-all-parallel', status: 'failed', errorKind: 'stale_output', outputStatus: 'stale' },
          resume: { chapter: ch, skill: 'align-all-parallel' },
        });
        continue;
      }
      await status(`**align-all-parallel** done for ${book} ${ch} (${alignDuration}s)`);

      // Collect for Phase 2 insertion (must be inside try block — alignedUltRel/alignedUstRel are block-scoped)
      if (!completedChapters.some((c) => c.ch === ch)) {
        completedChapters.push({ ch, ultAligned: alignedUltRel, ustAligned: alignedUstRel });
      }
      setCheckpoint(checkpointRef, {
        state: 'running',
        success,
        fail,
        completedChapters,
        current: { chapter: ch, skill: 'align-all-parallel', status: 'succeeded' },
        resume: null,
      });
    } catch (err) {
      console.error(`[generate] align-all-parallel error for ${book} ${ch}: ${err.message}`);
      if (isTransientOutageError(err)) {
        abortForOutage = true;
        setCheckpoint(checkpointRef, {
          state: 'paused_for_outage',
          success,
          fail,
          completedChapters,
          current: { chapter: ch, skill: 'align-all-parallel', status: 'failed', errorKind: 'transient_outage', error: err.message },
          resume: { chapter: ch, skill: 'align-all-parallel' },
        });
        break;
      }
      if (isUsageLimitError(err.message || '')) {
        abortForUsageLimit = true;
        usageLimitTag = buildUsageLimitResetTag(err.message || '');
        setCheckpoint(checkpointRef, {
          state: 'failed',
          success,
          fail,
          completedChapters,
          current: { chapter: ch, skill: 'align-all-parallel', status: 'failed', errorKind: 'usage_limit', error: err.message },
          resume: { chapter: ch, skill: 'align-all-parallel' },
        });
        break;
      }
      await status(`**align-all-parallel** error for ${book} ${ch}: ${err.message}`);
      fail++;
      setCheckpoint(checkpointRef, {
        state: 'failed',
        success,
        fail,
        completedChapters,
        current: { chapter: ch, skill: 'align-all-parallel', status: 'failed', errorKind: 'sdk_error', error: err.message },
        resume: { chapter: ch, skill: 'align-all-parallel' },
      });
      continue;
    }

    success++;
    setCheckpoint(checkpointRef, {
      state: 'running',
      success,
      fail,
      completedChapters,
      current: { chapter: ch, status: 'chapter_succeeded' },
      resume: null,
    });
  }

  if (abortForOutage) {
    await removeReaction(msgId, 'working_on_it');
    await addReaction(msgId, 'warning');
    await reply('Claude is temporarily down, you\'ll need to re-trigger. I saved progress and will resume from the failed skill.');
    await status(`Generation paused for **${refLabel}** due to transient Claude outage; waiting for re-trigger to resume.`);
    return;
  }

  if (abortForUsageLimit) {
    await removeReaction(msgId, 'working_on_it');
    await addReaction(msgId, 'warning');
    const when = usageLimitTag ? ` around ${usageLimitTag}` : ' after the limit resets';
    await reply(
      `Generation pipeline paused: I hit our Claude usage limit and stopped before push/verify for unfinished work. ` +
      `I can resume${when}.`
    );
    recordRunSummary({
      pipeline: 'generate', book, startCh: start, endCh: end,
      tokensBefore, success: false, userId: message.sender_id,
    });
    await status(`Generation paused for **${refLabel}** due to usage limit.`);
    clearCheckpoint(checkpointRef);
    return;
  }

  // =========================================================================
  // Phase 2: Repo insert \u2014 push to master (non-file-response users only)
  // =========================================================================
  if (!isFileResponse && completedChapters.length > 0) {
    // Pre-flight: verify DCS token before spending time on repo-insert
    const dcsCheck = await verifyDcsToken();
    if (!dcsCheck.valid) {
      await status(`**ABORTING repo-insert phase**: ${dcsCheck.details}`);
      await reply(`Generation complete but repo-insert skipped — DCS token invalid. Content is in output/ but not pushed.`);
      fail += completedChapters.length;
      success -= completedChapters.length;
    } else {

    // Pre-flight: check for conflicting user branches on target files
    // Pass chapter numbers so we only flag PRs that actually touch our chapters
    const ultFile = getRepoFilename('ult', book);
    const ustFile = getRepoFilename('ust', book);
    const chapters = completedChapters.map(c => c.ch);
    const allConflicts = [];
    for (const ch of chapters) {
      const ultConflicts = await checkConflictingBranches('en_ult', ultFile, ch);
      const ustConflicts = await checkConflictingBranches('en_ust', ustFile, ch);
      allConflicts.push(
        ...ultConflicts.map(c => ({ ...c, repo: 'en_ult', file: ultFile })),
        ...ustConflicts.map(c => ({ ...c, repo: 'en_ust', file: ustFile })),
      );
    }
    // Deduplicate (same PR could appear for multiple chapters)
    const seen = new Set();
    const dedupedConflicts = allConflicts.filter(c => {
      const key = `${c.pr}-${c.repo}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    if (dedupedConflicts.length > 0) {
      const sessionKey = stream
        ? `stream-${stream}-${topic}`
        : `dm-${message.sender_id}`;
      const branchList = dedupedConflicts.map(c => `\`${c.branch}\` (${c.repo})`).join(', ');
      const fileList = [...new Set(dedupedConflicts.map(c => `\`${c.file}\``))].join(', ');

      setPendingMerge(sessionKey, {
        sessionKey,
        pipelineType: 'generate',
        username,
        book,
        startChapter: start,
        endChapter: end,
        completedChapters,
        blockingBranches: dedupedConflicts.map(c => ({ repo: c.repo, branchPattern: c.branch })),
        originalMessage: message,
        createdAt: new Date().toISOString(),
        retryCount: 0,
      });

      const mention = await resolveConflictMention(
        dedupedConflicts[0].branch,
        message.sender_full_name
      );

      const deferredRange = completedChapters.length === 1
        ? `${book} ${completedChapters[0].ch}`
        : `${book} ${completedChapters[0].ch}\u2013${completedChapters[completedChapters.length - 1].ch}`;

      await removeReaction(msgId, 'working_on_it');
      await addReaction(msgId, 'hourglass');
      // Use sendMessage directly to control the @-mention (reply() auto-prepends sender)
      const conflictMsg = `${mention} I have content ready for **${deferredRange}**, but ${branchList} ` +
        `has edits to ${fileList}. Please merge your branch first, then say **merged** or **done** ` +
        `so I can proceed with the insertion.`;
      if (stream) {
        await sendMessage(stream, topic, conflictMsg);
      } else {
        await sendDM(message.sender_id, conflictMsg);
      }

      const deferLabel = start === end ? `${book} ${start}` : `${book} ${start}\u2013${end}`;
      await status(`Generate pipeline for **${deferLabel}**: generation done, push deferred — waiting for branch merge`);

      recordRunSummary({
        pipeline: 'generate', book, startCh: start, endCh: end,
        tokensBefore, success: fail === 0, userId: message.sender_id,
      });
      console.log(`[generate] Run summary ref: ${deferLabel}`);
      clearCheckpoint(checkpointRef);
      return;
    }

    for (const chData of completedChapters) {
      let chapterFailed = false;

      // Pre-flight: verify source files exist
      const ultPath = path.resolve(CSKILLBP_DIR, chData.ultAligned);
      const ustPath = path.resolve(CSKILLBP_DIR, chData.ustAligned);
      if (!fs.existsSync(ultPath)) {
        await status(`**door43-push** SKIPPED (ULT) for ${book} ${chData.ch}: source file missing: ${chData.ultAligned}`);
        chapterFailed = true;
      }
      if (!chapterFailed && !fs.existsSync(ustPath)) {
        await status(`**door43-push** SKIPPED (UST) for ${book} ${chData.ch}: source file missing: ${chData.ustAligned}`);
        chapterFailed = true;
      }

      const pushStartTime = new Date().toISOString();

      // door43-push ULT
      if (!chapterFailed) {
        await status(`Running **door43-push** (ULT) for ${book} ${chData.ch}...`);
        try {
          const pushResultUlt = await door43Push({
            type: 'ult', book, chapter: chData.ch,
            username, branch: buildBranchName(book, chData.ch),
            source: chData.ultAligned,
            verses: hasVerseRange ? `${verseStart}-${verseEnd}` : undefined,
          });
          if (!pushResultUlt.success) {
            console.error(`[generate] door43-push ULT failed for ${book} ${chData.ch}: ${pushResultUlt.details}`);
            await status(`**door43-push** (ULT) failed for ${book} ${chData.ch}: ${pushResultUlt.details}`);
            chapterFailed = true;
          } else {
            await status(`**door43-push** (ULT) done for ${book} ${chData.ch}: ${pushResultUlt.details}`);
          }
        } catch (err) {
          console.error(`[generate] door43-push ULT error for ${book} ${chData.ch}: ${err.message}`);
          await status(`**door43-push** (ULT) failed for ${book} ${chData.ch}: ${err.message}`);
          chapterFailed = true;
        }
      }

      // door43-push UST
      if (!chapterFailed) {
        await status(`Running **door43-push** (UST) for ${book} ${chData.ch}...`);
        try {
          const pushResultUst = await door43Push({
            type: 'ust', book, chapter: chData.ch,
            username, branch: buildBranchName(book, chData.ch),
            source: chData.ustAligned,
            verses: hasVerseRange ? `${verseStart}-${verseEnd}` : undefined,
          });
          if (!pushResultUst.success) {
            console.error(`[generate] door43-push UST failed for ${book} ${chData.ch}: ${pushResultUst.details}`);
            await status(`**door43-push** (UST) failed for ${book} ${chData.ch}: ${pushResultUst.details}`);
            chapterFailed = true;
          } else {
            await status(`**door43-push** (UST) done for ${book} ${chData.ch}: ${pushResultUst.details}`);
          }
        } catch (err) {
          console.error(`[generate] door43-push UST error for ${book} ${chData.ch}: ${err.message}`);
          await status(`**door43-push** (UST) failed for ${book} ${chData.ch}: ${err.message}`);
          chapterFailed = true;
        }
      }

      // repo-verify: belt-and-suspenders check
      if (!chapterFailed) {
        const stagingBranch = buildBranchName(book, chData.ch);
        await status(`Verifying merges for ${book} ${chData.ch}...`);
        const ultVerify = await verifyRepoPush({ repo: 'en_ult', stagingBranch, since: pushStartTime });
        const ustVerify = await verifyRepoPush({ repo: 'en_ust', stagingBranch, since: pushStartTime });

        if (!ultVerify.success) {
          await status(`Repo verify FAILED (ULT) for ${book} ${chData.ch}: ${ultVerify.details}`);
          chapterFailed = true;
        }
        if (!ustVerify.success) {
          await status(`Repo verify FAILED (UST) for ${book} ${chData.ch}: ${ustVerify.details}`);
          chapterFailed = true;
        }
        if (ultVerify.success && ustVerify.success) await status(`Repo verify OK for ${book} ${chData.ch}: ULT and UST merged to master`);
      }

      if (chapterFailed) {
        // Move from success to fail (was counted as success during Phase 1)
        success--;
        fail++;
      }
    }
    } // end DCS token valid else block
  }

  // Swap emoji and send final status
  await removeReaction(msgId, 'working_on_it');
  if (fail === 0) {
    await addReaction(msgId, 'check');
  } else {
    await addReaction(msgId, 'warning');
  }

  // Final message
  if (!isFileResponse && success > 0) {
    const rangeLabel = hasVerseRange
      ? `${book} ${start}:${verseStart}-${verseEnd}`
      : (start === end ? `${book} ${start}` : `${book} ${start}\u2013${end}`);
    await reply(
      `Content for **${rangeLabel}** pushed to master in en_ult and en_ust.` +
      (fail > 0 ? `\n(${fail} chapter(s) had errors \u2014 check admin DMs for details.)` : '') +
      `\nYou may need to refresh the tcCreate or gatewayEdit page to see the new content.`
    );
  }

  recordRunSummary({
    pipeline: 'generate', book, startCh: start, endCh: end,
    tokensBefore, success: fail === 0, userId: message.sender_id,
  });
  const summaryRef = hasVerseRange ? `${book} ${start}:${verseStart}-${verseEnd}` : `${book} ${start}-${end}`;
  console.log(`[generate] Run summary ref: ${summaryRef}`);

  const finalLabel = hasVerseRange
    ? `${book} ${start}:${verseStart}-${verseEnd}`
    : `${book} ${start}\u2013${end}`;
  await status(`Generation complete for **${finalLabel}**: ${success} succeeded, ${fail} failed.`);
  clearCheckpoint(checkpointRef);
}

module.exports = { generatePipeline };
