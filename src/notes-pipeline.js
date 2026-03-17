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
const { runClaude } = require('./claude-runner');
const { getDoor43Username, buildBranchName, resolveOutputFile, checkPrerequisites, calcSkillTimeout, normalizeBookName, resolveConflictMention, CSKILLBP_DIR } = require('./pipeline-utils');
const { verifyRepoPush, verifyDcsToken } = require('./repo-verify');
const { recordMetrics, getCumulativeTokens, recordRunSummary } = require('./usage-tracker');
const { door43Push, checkConflictingBranches, REPO_MAP, getRepoFilename } = require('./door43-push');
const { setPendingMerge } = require('./pending-merges');

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
    };
  } else {
    parsed = parseWriteNotesCommand(message.content);
  }

  if (!parsed) {
    await addReaction(msgId, 'cross_mark');
    await status('Could not parse command. Expected: `write notes <book> <chapter>` or `write notes <book> <start>-<end>`');
    return;
  }

  const { book, startChapter, endChapter, verseStart, verseEnd, withIntro } = parsed;
  const chapterCount = endChapter - startChapter + 1;
  const rangeLabel = startChapter === endChapter
    ? `${book} ${startChapter}`
    : `${book} ${startChapter}\u2013${endChapter}`;

  // --- Look up Door43 username ---
  const username = getDoor43Username(message.sender_email);
  if (!username) {
    await addReaction(msgId, 'cross_mark');
    await status(`No Door43 username mapped for ${message.sender_email}. Add it to door43-users.json.`);
    return;
  }

  await addReaction(msgId, 'working_on_it');
  await status(`Starting notes pipeline for **${rangeLabel}** (${chapterCount} chapter(s), user: ${username})`);

  // Ensure log directory
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const logFile = path.join(LOG_DIR, 'notes.log');
  const model = isTestFast ? 'haiku' : undefined;

  const pipelineStart = Date.now();
  const tokensBefore = getCumulativeTokens();
  let totalSuccess = 0;
  let totalFail = 0;

  // Conflict-deferred push state: when a user branch modifies the same file,
  // we continue generating but defer all pushes until the user says "merged".
  let deferredPush = false;
  let deferredConflicts = [];   // [{ branch }]
  const deferredChapters = [];  // [{ ch, notesSource }]

  // =========================================================================
  // Per-chapter loop: skills -> repo-insert -> repo-verify -> notify user
  // Each chapter is merged before the next one starts, so the editor gets
  // access immediately and isn't told a chapter is done until it's on master.
  // =========================================================================
  for (let ch = startChapter; ch <= endChapter; ch++) {
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
      issuesPath = `output/issues/${tag}.tsv`;
      await status(`**${ref}**: No AI artifacts (missing: ${missing.join(', ')}) \u2192 deep-issue-id path`);

      const verseFlag = hasVerseRange ? ` --verses ${verseStart}-${verseEnd}` : '';
      const issuesVTag = hasVerseRange ? `${tag}-v${verseStart}-${verseEnd}` : tag;
      skills.push({
        name: 'deep-issue-id',
        prompt: `${book} ${ch}${verseFlag}`,
        appendSystemPrompt: DEEP_ISSUE_ID_HINT,
        expectedOutput: `output/issues/${issuesVTag}.tsv`,
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

    const vTag = hasVerseRange ? `${tag}-v${verseStart}-${verseEnd}` : tag;
    skills.push({
      name: 'tn-writer',
      prompt: `${skillRef} --issues ${issuesPath}`,
      expectedOutput: `output/notes/${vTag}.tsv`,
      ops: 1,
    });

    // tn-quality-check runs as a separate Sonnet invocation for independent review
    skills.push({
      name: 'tn-quality-check',
      prompt: `${skillRef}`,
      expectedOutput: `output/quality/${book}/${vTag}-quality.md`,
      ops: 1,
      model: 'sonnet',
    });

    // --- Run skills sequentially ---
    for (const skill of skills) {
      const skillStart = Date.now();
      const timeoutMs = calcSkillTimeout(book, ch, skill.ops);
      await status(`Running **${skill.name}** for ${ref} (timeout: ${Math.round(timeoutMs / 60000)}min)...`);
      console.log(`[notes] Running ${skill.name}: ${skill.prompt} (timeout: ${Math.round(timeoutMs / 60000)}min)`);

      let result = null;
      try {
        result = await runClaude({
          prompt: skill.prompt,
          cwd: CSKILLBP_DIR,
          model: model || skill.model, // TEST_FAST haiku overrides per-skill model
          skill: skill.name,
          timeoutMs,
          appendSystemPrompt: skill.appendSystemPrompt,
        });
      } catch (err) {
        console.error(`[notes] ${skill.name} error: ${err.message}`);
      }

      const duration = ((Date.now() - skillStart) / 1000).toFixed(1);
      const sdkSuccess = result?.subtype === 'success';

      // Log
      const logLine = `${new Date().toISOString()} | ${tag} | ${skill.name} | sdk=${sdkSuccess} | duration=${duration}s\n`;
      fs.appendFileSync(logFile, logLine);

      // Check expected output (resolveOutputFile handles padding + subdirs)
      if (skill.expectedOutput) {
        const resolved = resolveOutputFile(skill.expectedOutput, book);
        if (!resolved) {
          failedSkill = skill.name;
          await status(`**${skill.name}** failed for ${ref} \u2014 expected output not found: ${skill.expectedOutput} (${duration}s)`);
          break;
        }
        skill.resolvedOutput = resolved;
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
          for (const s of skills) {
            if (s.name === 'tn-quality-check') {
              s.prompt = `${skillRef} --notes ${resolved}`;
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
    }

    const chapterDuration = ((Date.now() - chapterStart) / 1000).toFixed(1);

    if (failedSkill) {
      totalFail++;
      await status(`Chapter ${ref} failed at **${failedSkill}** after ${chapterDuration}s`);
      // Continue to next chapter instead of aborting the whole pipeline
      continue;
    }

    // --- Repo insert + verify inline so editor gets access immediately ---
    const tnWriterSkill = skills.find(s => s.name === 'tn-writer');
    const notesSource = tnWriterSkill?.resolvedOutput || `output/notes/${tag}.tsv`;
    let chapterFailed = false;

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
      await status(`Chapter ${ref} failed at **repo-insert/verify** after ${chapterDuration}s`);
      continue;
    }

    totalSuccess++;

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
    return;
  }

  // --- Final reaction and report ---
  await removeReaction(msgId, 'working_on_it');

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
}

module.exports = { notesPipeline };
