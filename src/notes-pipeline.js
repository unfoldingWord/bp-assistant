// notes-pipeline.js — Multi-skill sequential pipeline for translation note writing
// Triggered by: "write notes <book> <chapter>" or "write notes <book> <start>-<end>"
// Skills: [post-edit-review OR deep-issue-id] -> [chapter-intro] -> tn-writer -> tn-quality-check
// chapter-intro is skipped when --no-intro is passed or auto-exclusion applies (PSA 42-123)
//
// Two-phase design:
//   Phase 1: Run all skills except repo-insert (always runs, expensive)
//   Phase 2: Repo insert — push to master (cheap, always runs inline)

const fs = require('fs');
const path = require('path');
const config = require('./config');
const { sendMessage, sendDM, addReaction, removeReaction, uploadFile } = require('./zulip-client');
const { runClaude } = require('./claude-runner');
const { getDoor43Username, buildBranchName, resolveOutputFile, checkPrerequisites, calcSkillTimeout, CSKILLBP_DIR } = require('./pipeline-utils');
const { verifyRepoPush } = require('./repo-verify');
const { recordMetrics } = require('./usage-tracker');

const LOG_DIR = path.resolve(__dirname, '../logs');

const POST_EDIT_REVIEW_HINT =
  'Use Task subagents for the Diff Analyzer and Issue Reconciler. Do NOT use TeamCreate or SendMessage.';

// Ranges where the chapter intro is written by the human editor — skip automatically.
// PSA 42-123: Books 2-4 handled by Benjamin; 119-123 is a subset but listed explicitly.
const SKIP_INTRO_RANGES = [
  { book: 'PSA', start: 42, end: 123 },
];

function shouldSkipIntro(book, chapter, noIntroFlag) {
  if (noIntroFlag) return true;
  return SKIP_INTRO_RANGES.some(r => r.book === book && chapter >= r.start && chapter <= r.end);
}

function hasNoIntroFlag(content) {
  return /--no-?intro\b/i.test(content) || /\bno[\s-]intro\b/i.test(content);
}

// --- Parse "write notes BOOK CH" or "write notes BOOK CH:VS-VS" or "write notes BOOK CH1-CH2" ---
function parseWriteNotesCommand(content) {
  // Range: write notes PSA 66-72 or write notes for PSA 66-72
  const rangeMatch = content.match(/write notes(?:\s+for)?\s+(\w+)\s+(\d+)\s*[-\u2013\u2014to]+\s*(\d+)/i);
  if (rangeMatch) {
    return {
      book: rangeMatch[1].toUpperCase(),
      startChapter: parseInt(rangeMatch[2], 10),
      endChapter: parseInt(rangeMatch[3], 10),
      noIntro: hasNoIntroFlag(content),
    };
  }

  // Single with verse range: write notes PSA 119:169-176
  const verseMatch = content.match(/write notes(?:\s+for)?\s+(\w+)\s+(\d+):(\d+)[-\u2013\u2014](\d+)/i);
  if (verseMatch) {
    const ch = parseInt(verseMatch[2], 10);
    return {
      book: verseMatch[1].toUpperCase(),
      startChapter: ch,
      endChapter: ch,
      verseStart: parseInt(verseMatch[3], 10),
      verseEnd: parseInt(verseMatch[4], 10),
      noIntro: hasNoIntroFlag(content),
    };
  }

  // Single chapter: write notes PSA 82
  const singleMatch = content.match(/write notes(?:\s+for)?\s+(\w+)\s+(\d+)/i);
  if (singleMatch) {
    const ch = parseInt(singleMatch[2], 10);
    return {
      book: singleMatch[1].toUpperCase(),
      startChapter: ch,
      endChapter: ch,
      noIntro: hasNoIntroFlag(content),
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
        await sendMessage(stream, topic, text);
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
      noIntro: hasNoIntroFlag(message.content),
    };
  } else {
    parsed = parseWriteNotesCommand(message.content);
  }

  if (!parsed) {
    await addReaction(msgId, 'cross_mark');
    await status('Could not parse command. Expected: `write notes <book> <chapter>` or `write notes <book> <start>-<end>`');
    return;
  }

  const { book, startChapter, endChapter, verseStart, verseEnd, noIntro } = parsed;
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
  let totalSuccess = 0;
  let totalFail = 0;
  const completedChapters = []; // Phase 1 results for deferred insertion

  // =========================================================================
  // Phase 1: Run all skills except repo-insert (always runs)
  // =========================================================================
  for (let ch = startChapter; ch <= endChapter; ch++) {
    const tag = `${book}-${ch}`;
    const verseRange = verseStart != null && startChapter === endChapter
      ? `:${verseStart}-${verseEnd}` : '';
    const ref = `${book} ${ch}${verseRange}`;
    const skillRef = verseStart != null && startChapter === endChapter
      ? `${book} ${ch}:${verseStart}-${verseEnd}` : `${book} ${ch}`;

    await status(`Processing chapter **${ref}**...`);
    console.log(`[notes] Processing ${ref}...`);

    // --- Check prerequisites to decide branch ---
    const { missing, resolved } = checkPrerequisites(book, ch);
    const hasAIArtifacts = missing.length === 0;

    let issuesPath;
    let failedSkill = null;
    const chapterStart = Date.now();

    // --- Build skill chain based on prerequisite availability (NO repo-insert) ---
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
      await status(`**${ref}**: No AI artifacts (missing: ${missing.join(', ')}) \u2192 deep-issue-id --lite path`);

      skills.push({
        name: 'deep-issue-id --lite',
        prompt: `${book} ${ch}`,
        expectedOutput: `output/issues/${tag}.tsv`,
        ops: 3, // 2 analysts + challenger/merge
      });
    }

    // chapter-intro: skip if --no-intro flag or auto-exclusion range
    if (!shouldSkipIntro(book, ch, noIntro)) {
      skills.push({
        name: 'chapter-intro',
        prompt: `${skillRef} --issues ${issuesPath}`,
        expectedOutput: issuesPath,
        ops: 1,
      });
    } else {
      await status(`**${ref}**: skipping chapter-intro (${noIntro ? '--no-intro flag' : 'auto-excluded range'})`);
    }

    skills.push({
      name: 'tn-writer',
      prompt: `${skillRef} --issues ${issuesPath}`,
      expectedOutput: `output/notes/${tag}.tsv`,
      ops: 1,
    });

    skills.push({
      name: 'tn-quality-check',
      prompt: `${skillRef}`,
      expectedOutput: `output/quality/${book}/${tag}-quality.md`,
      ops: 1,
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
          model,
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

      // Check expected output
      if (skill.expectedOutput) {
        const outputPath = path.join(CSKILLBP_DIR, skill.expectedOutput);
        // Also check with book subdirectory
        const altOutputPath = resolveOutputFile(skill.expectedOutput, book);
        if (!fs.existsSync(outputPath) && !altOutputPath) {
          failedSkill = skill.name;
          await status(`**${skill.name}** failed for ${ref} \u2014 expected output not found: ${skill.expectedOutput} (${duration}s)`);
          break;
        }
        // Update issuesPath if deep-issue-id produced it in a subdirectory
        if (skill.name === 'deep-issue-id --lite' && altOutputPath) {
          issuesPath = altOutputPath;
          // Update subsequent skill prompts that reference issuesPath
          for (const s of skills) {
            if (s.prompt && s.prompt.includes(`output/issues/${tag}.tsv`)) {
              s.prompt = s.prompt.replace(`output/issues/${tag}.tsv`, issuesPath);
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

    totalSuccess++;

    // --- Upload notes TSV for this chapter ---
    const notesTsv = path.join(CSKILLBP_DIR, 'output', 'notes', `${tag}.tsv`);
    const altNotesTsv = path.join(CSKILLBP_DIR, 'output', 'notes', book, `${tag}.tsv`);
    const actualNotesTsv = fs.existsSync(notesTsv) ? notesTsv : fs.existsSync(altNotesTsv) ? altNotesTsv : null;
    let downloadLink = '';

    if (actualNotesTsv) {
      try {
        const uri = await uploadFile(actualNotesTsv, `${tag} notes.tsv`);
        downloadLink = ` \u00b7 [Download](${uri})`;
      } catch (err) {
        console.error(`[notes] Failed to upload notes TSV: ${err.message}`);
        downloadLink = ' \u00b7 (file upload failed)';
      }
    }

    // Collect for Phase 2 insertion
    completedChapters.push({
      ch,
      skillRef,
      repoInsertPrompt: `tn ${skillRef} ${username} --no-pr --branch ${buildBranchName(book, ch)} --source output/notes/${tag}.tsv`,
    });

    if (chapterCount > 1) {
      await reply(`**${ref}** notes complete (${chapterDuration}s)${downloadLink}`);
    }
  }

  // =========================================================================
  // Phase 2: Repo insert \u2014 push to master
  // =========================================================================
  if (completedChapters.length > 0) {
    for (const chData of completedChapters) {
      let chapterFailed = false;

      await status(`Running **repo-insert** (TN) for ${book} ${chData.ch}...`);
      try {
        const riTimeout = calcSkillTimeout(book, chData.ch, 1);
        const riResult = await runClaude({
          prompt: chData.repoInsertPrompt,
          cwd: CSKILLBP_DIR,
          model,
          skill: 'repo-insert',
          timeoutMs: riTimeout,
        });
        recordMetrics({
          pipeline: 'notes', skill: 'repo-insert',
          book, chapter: chData.ch, result: riResult,
          success: riResult?.subtype === 'success', userId: message.sender_id,
        });
        await status(`**repo-insert** (TN) done for ${book} ${chData.ch}`);
      } catch (err) {
        console.error(`[notes] repo-insert TN error for ${book} ${chData.ch}: ${err.message}`);
        await status(`**repo-insert** (TN) failed for ${book} ${chData.ch}: ${err.message}`);
        chapterFailed = true;
      }

      // repo-verify against master
      if (!chapterFailed) {
        await status(`Verifying push for ${book} ${chData.ch}...`);
        const verify = await verifyRepoPush({
          repo: 'en_tn',
          branch: 'master',
          expectedFiles: [],
        });
        if (!verify.success) {
          await status(`Repo verify warning for ${book} ${chData.ch}: ${verify.details}`);
          console.warn(`[notes] Repo verify failed for ${book} ${chData.ch}: ${verify.details}`);
        } else {
          await status(`Repo verify OK for ${book} ${chData.ch}: ${verify.details}`);
        }
      }

      if (chapterFailed) {
        // Move from success to fail
        totalSuccess--;
        totalFail++;
      }
    }
  }

  const totalDuration = ((Date.now() - pipelineStart) / 1000).toFixed(1);

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

    // For single chapter, upload file link in the final message
    if (chapterCount === 1) {
      const tag = `${book}-${startChapter}`;
      const notesTsv = path.join(CSKILLBP_DIR, 'output', 'notes', `${tag}.tsv`);
      const altNotesTsv = path.join(CSKILLBP_DIR, 'output', 'notes', book, `${tag}.tsv`);
      const actualNotesTsv = fs.existsSync(notesTsv) ? notesTsv : fs.existsSync(altNotesTsv) ? altNotesTsv : null;
      let downloadLink = '';

      if (actualNotesTsv) {
        try {
          const uri = await uploadFile(actualNotesTsv, `${tag} notes.tsv`);
          downloadLink = `\nDownload: [${tag} notes.tsv](${uri})`;
        } catch (err) {
          console.error(`[notes] Failed to upload notes TSV: ${err.message}`);
          downloadLink = '\n(File upload failed)';
        }
      }

      await reply(
        `Notes pipeline complete for **${rangeLabel}** (${totalDuration}s).\n` +
        `Content pushed to master on en_tn` +
        downloadLink
      );
    } else {
      await reply(
        `Notes pipeline complete for **${rangeLabel}**: all ${totalSuccess} chapter(s) succeeded (${totalDuration}s).\n` +
        `Content pushed to master on en_tn`
      );
    }
  }

  await status(`Notes pipeline complete for **${rangeLabel}** in ${totalDuration}s \u2014 ${totalSuccess} ok, ${totalFail} failed.`);
}

module.exports = { notesPipeline };
