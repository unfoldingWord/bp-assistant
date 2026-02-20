// generate-pipeline.js — SDK-based generation pipeline
// Replaces generate.sh: parses command, loops chapters, calls Claude SDK, posts results to Zulip
// Chris (chrisUserId) gets files uploaded; others get align + repo-insert + repo-verify
//
// Two-phase design for non-Chris users:
//   Phase 1: Generate + align (always runs, expensive)
//   Phase 2: Repo insert — push to master (cheap, always runs inline)

const fs = require('fs');
const path = require('path');
const config = require('./config');
const { sendMessage, sendDM, addReaction, removeReaction, uploadFile } = require('./zulip-client');
const { runClaude } = require('./claude-runner');
const { getDoor43Username, buildBranchName, resolveOutputFile, calcSkillTimeout, CSKILLBP_DIR } = require('./pipeline-utils');
const { verifyRepoPush } = require('./repo-verify');
const { recordMetrics, getCumulativeTokens, recordRunSummary } = require('./usage-tracker');

const LOG_DIR = path.resolve(__dirname, '../logs');

function parseGenerateCommand(content) {
  const input = content.toLowerCase();

  // Range: generate psa 79-89, generate psa 79\u201389, generate psa 79 to 89
  const rangeMatch = input.match(/generate\s+([a-z0-9]+)\s+(\d+)\s*[-\u2013\u2014to]+\s*(\d+)/);
  if (rangeMatch) {
    return {
      book: rangeMatch[1].toUpperCase(),
      start: parseInt(rangeMatch[2], 10),
      end: parseInt(rangeMatch[3], 10),
    };
  }

  // Single: generate psa 79
  const singleMatch = input.match(/generate\s+([a-z0-9]+)\s+(\d+)/);
  if (singleMatch) {
    const ch = parseInt(singleMatch[2], 10);
    return {
      book: singleMatch[1].toUpperCase(),
      start: ch,
      end: ch,
    };
  }

  return null;
}

async function generatePipeline(route, message) {
  const adminUserId = config.adminUserId;
  const stream = message.type === 'stream' ? message.display_recipient : null;
  const topic = message.subject || '';
  const msgId = message.id;

  const isDryRun = process.env.DRY_RUN === '1';
  const isTestFast = process.env.TEST_FAST === '1';
  const isChris = message.sender_id === config.chrisUserId;

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
    };
  } else {
    parsed = parseGenerateCommand(message.content);
  }

  if (!parsed) {
    await addReaction(msgId, 'cross_mark');
    await status('Could not parse command. Expected format: `generate <book> <chapter>` or `generate <book> <start>-<end>`');
    return;
  }

  const { book, start, end } = parsed;
  const chapterCount = end - start + 1;

  if (chapterCount < 1) {
    await addReaction(msgId, 'cross_mark');
    await status(`Invalid chapter range: ${start}-${end}`);
    return;
  }

  // Token estimate (informational only — no hard rejection based on estimates)
  const perChapter = (route.tokenEstimate && route.tokenEstimate.perChapter) || 5000000;
  const estimatedTotal = chapterCount * perChapter;

  // --- Non-Chris pre-checks: Door43 username ---
  let username = null;
  if (!isChris) {
    username = getDoor43Username(message.sender_email);
    if (!username) {
      await addReaction(msgId, 'cross_mark');
      await status(`No Door43 username mapped for ${message.sender_email}. Add it to door43-users.json.`);
      return;
    }
  }

  // Signal working
  await addReaction(msgId, 'working_on_it');
  const modeLabel = isChris ? 'files-only' : 'full pipeline (align + repo-insert)';
  await status(`Starting generation for **${book}** chapters ${start}\u2013${end} (${chapterCount} chapter(s), mode: ${modeLabel}, ~${estimatedTotal} tokens estimated)`);

  // Ensure log directory
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const logFile = path.join(LOG_DIR, 'generate.log');

  // Determine model
  const model = isTestFast ? 'haiku' : undefined;

  // Determine skill from route config
  const skill = route.skill || 'initial-pipeline --lite';

  const tokensBefore = getCumulativeTokens();
  let success = 0;
  let fail = 0;
  const completedChapters = []; // Phase 1 results for non-Chris users

  // =========================================================================
  // Phase 1: Generate + Align (always runs)
  // =========================================================================
  for (let ch = start; ch <= end; ch++) {
    console.log(`[generate] Processing ${book} chapter ${ch}...`);
    await status(`Processing **${book} ${ch}**...`);

    const chapterStart = Date.now();
    let claudeResult = null;

    if (isDryRun) {
      console.log(`[dry-run] Would run Claude SDK: /${skill} ${book} ${ch} (in ${CSKILLBP_DIR})`);

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
      try {
        const timeoutMs = calcSkillTimeout(book, ch, 3); // 3 ops for initial-pipeline
        claudeResult = await runClaude({
          prompt: `${book} ${ch}`,
          cwd: CSKILLBP_DIR,
          model,
          skill,
          timeoutMs,
        });
      } catch (err) {
        console.error(`[generate] Claude SDK error for ${book} ${ch}: ${err.message}`);
        claudeResult = null;
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

    if (!hasUst) {
      await status(`Failed to generate **${book} ${ch}**. UST not produced${hasUlt ? ' (ULT exists but may be incomplete)' : ''}. Check logs for details.`);
      fail++;
      continue;
    }

    if (!sdkSuccess) {
      console.log(`[generate] SDK exited with ${claudeResult?.subtype || 'no result'} but UST exists \u2014 treating as success`);
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
    recordMetrics({
      pipeline: 'generate', skill: route.skill || 'initial-pipeline --lite',
      book, chapter: ch, result: claudeResult, success: hasUst, userId: message.sender_id,
    });

    // --- Chris path: upload files only ---
    if (isChris) {
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
      continue;
    }

    // --- Non-Chris path: Phase 1 \u2014 align and collect results ---

    // Step 2: align-all-parallel
    await status(`Running **align-all-parallel** for ${book} ${ch}...`);
    try {
      const alignTimeout = calcSkillTimeout(book, ch, 2);
      const alignResult = await runClaude({
        prompt: `${book} ${ch}`,
        cwd: CSKILLBP_DIR,
        model,
        skill: 'align-all-parallel',
        timeoutMs: alignTimeout,
      });
      const alignDuration = ((Date.now() - chapterStart) / 1000).toFixed(1);

      // Record metrics for align-all-parallel
      recordMetrics({
        pipeline: 'generate', skill: 'align-all-parallel',
        book, chapter: ch, result: alignResult,
        success: alignResult?.subtype === 'success', userId: message.sender_id,
      });

      // Check aligned output files exist
      const alignedUlt = path.join(CSKILLBP_DIR, 'output', 'AI-ULT', book, `${book}-${ch}-aligned.usfm`);
      const alignedUst = path.join(CSKILLBP_DIR, 'output', 'AI-UST', book, `${book}-${ch}-aligned.usfm`);
      // Also check flat path
      const alignedUltFlat = path.join(CSKILLBP_DIR, 'output', 'AI-ULT', `${book}-${ch}-aligned.usfm`);
      const alignedUstFlat = path.join(CSKILLBP_DIR, 'output', 'AI-UST', `${book}-${ch}-aligned.usfm`);

      const hasAlignedUlt = fs.existsSync(alignedUlt) || fs.existsSync(alignedUltFlat);
      const hasAlignedUst = fs.existsSync(alignedUst) || fs.existsSync(alignedUstFlat);

      if (!hasAlignedUlt || !hasAlignedUst) {
        await status(`**align-all-parallel** failed for ${book} ${ch} \u2014 aligned files not found (${alignDuration}s)`);
        fail++;
        continue;
      }
      await status(`**align-all-parallel** done for ${book} ${ch} (${alignDuration}s)`);
    } catch (err) {
      console.error(`[generate] align-all-parallel error for ${book} ${ch}: ${err.message}`);
      await status(`**align-all-parallel** error for ${book} ${ch}: ${err.message}`);
      fail++;
      continue;
    }

    // Resolve aligned file paths (prefer subdirectory, fall back to flat)
    const resolveAligned = (type) => {
      const sub = path.join(CSKILLBP_DIR, 'output', type, book, `${book}-${ch}-aligned.usfm`);
      if (fs.existsSync(sub)) return `output/${type}/${book}/${book}-${ch}-aligned.usfm`;
      return `output/${type}/${book}-${ch}-aligned.usfm`;
    };
    const ultSourceRel = resolveAligned('AI-ULT');
    const ustSourceRel = resolveAligned('AI-UST');

    // Collect for Phase 2 insertion
    completedChapters.push({ ch, ultAligned: ultSourceRel, ustAligned: ustSourceRel });
    success++;
  }

  // =========================================================================
  // Phase 2: Repo insert \u2014 push to master (non-Chris users only)
  // =========================================================================
  if (!isChris && completedChapters.length > 0) {
    for (const chData of completedChapters) {
      let chapterFailed = false;

      // repo-insert ULT
      await status(`Running **repo-insert** (ULT) for ${book} ${chData.ch}...`);
      try {
        const riTimeout = calcSkillTimeout(book, chData.ch, 1);
        const riUltResult = await runClaude({
          prompt: `ult ${book} ${chData.ch} ${username} --branch ${buildBranchName(book, chData.ch)} --source ${chData.ultAligned}`,
          cwd: CSKILLBP_DIR,
          model,
          skill: 'repo-insert',
          timeoutMs: riTimeout,
        });
        recordMetrics({
          pipeline: 'generate', skill: 'repo-insert',
          book, chapter: chData.ch, result: riUltResult,
          success: riUltResult?.subtype === 'success', userId: message.sender_id,
        });
        await status(`**repo-insert** (ULT) done for ${book} ${chData.ch}`);
      } catch (err) {
        console.error(`[generate] repo-insert ULT error for ${book} ${chData.ch}: ${err.message}`);
        await status(`**repo-insert** (ULT) failed for ${book} ${chData.ch}: ${err.message}`);
        chapterFailed = true;
      }

      // repo-insert UST
      if (!chapterFailed) {
        await status(`Running **repo-insert** (UST) for ${book} ${chData.ch}...`);
        try {
          const riTimeout = calcSkillTimeout(book, chData.ch, 1);
          const riUstResult = await runClaude({
            prompt: `ust ${book} ${chData.ch} ${username} --branch ${buildBranchName(book, chData.ch)} --source ${chData.ustAligned}`,
            cwd: CSKILLBP_DIR,
            model,
            skill: 'repo-insert',
            timeoutMs: riTimeout,
          });
          recordMetrics({
            pipeline: 'generate', skill: 'repo-insert',
            book, chapter: chData.ch, result: riUstResult,
            success: riUstResult?.subtype === 'success', userId: message.sender_id,
          });
          await status(`**repo-insert** (UST) done for ${book} ${chData.ch}`);
        } catch (err) {
          console.error(`[generate] repo-insert UST error for ${book} ${chData.ch}: ${err.message}`);
          await status(`**repo-insert** (UST) failed for ${book} ${chData.ch}: ${err.message}`);
          chapterFailed = true;
        }
      }

      // repo-verify: check staging branch was merged (deleted from remote)
      if (!chapterFailed) {
        const stagingBranch = buildBranchName(book, chData.ch);
        await status(`Verifying merges for ${book} ${chData.ch}...`);
        const ultVerify = await verifyRepoPush({ repo: 'en_ult', stagingBranch });
        const ustVerify = await verifyRepoPush({ repo: 'en_ust', stagingBranch });

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
  }

  // Swap emoji and send final status
  await removeReaction(msgId, 'working_on_it');
  if (fail === 0) {
    await addReaction(msgId, 'check');
  } else {
    await addReaction(msgId, 'warning');
  }

  // Final message
  if (!isChris && success > 0) {
    const rangeLabel = start === end ? `${book} ${start}` : `${book} ${start}\u2013${end}`;
    await reply(
      `Content for **${rangeLabel}** pushed to master in en_ult and en_ust.` +
      (fail > 0 ? `\n(${fail} chapter(s) had errors \u2014 check admin DMs for details.)` : '')
    );
  }

  recordRunSummary({
    pipeline: 'generate', book, startCh: start, endCh: end,
    tokensBefore, success: fail === 0, userId: message.sender_id,
  });

  await status(`Generation complete for **${book} ${start}\u2013${end}**: ${success} succeeded, ${fail} failed.`);
}

module.exports = { generatePipeline };
