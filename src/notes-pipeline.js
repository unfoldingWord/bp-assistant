// notes-pipeline.js — Multi-skill sequential pipeline for translation note writing
// Triggered by: "write notes <book> <chapter>" or "write notes <book> <start>-<end>"
// Skills: [post-edit-review OR deep-issue-id] → chapter-intro → tn-writer → tn-quality-check → repo-insert → repo-verify

const fs = require('fs');
const path = require('path');
const config = require('../config.json');
const { sendMessage, sendDM, addReaction, removeReaction, uploadFile } = require('./zulip-client');
const { runClaude } = require('./claude-runner');
const { getDoor43Username, checkExistingBranch, resolveOutputFile, checkPrerequisites, calcSkillTimeout, CSKILLBP_DIR } = require('./pipeline-utils');
const { verifyRepoPush } = require('./repo-verify');

const LOG_DIR = path.resolve(__dirname, '../logs');

const POST_EDIT_REVIEW_HINT =
  'Use Task subagents for the Diff Analyzer and Issue Reconciler. Do NOT use TeamCreate or SendMessage.';

// --- Parse "write notes BOOK CH" or "write notes BOOK CH:VS-VS" or "write notes BOOK CH1-CH2" ---
function parseWriteNotesCommand(content) {
  // Range: write notes PSA 66-72 or write notes for PSA 66-72
  const rangeMatch = content.match(/write notes(?:\s+for)?\s+(\w+)\s+(\d+)\s*[-–—to]+\s*(\d+)/i);
  if (rangeMatch) {
    return {
      book: rangeMatch[1].toUpperCase(),
      startChapter: parseInt(rangeMatch[2], 10),
      endChapter: parseInt(rangeMatch[3], 10),
    };
  }

  // Single with verse range: write notes PSA 119:169-176
  const verseMatch = content.match(/write notes(?:\s+for)?\s+(\w+)\s+(\d+):(\d+)[-–—](\d+)/i);
  if (verseMatch) {
    const ch = parseInt(verseMatch[2], 10);
    return {
      book: verseMatch[1].toUpperCase(),
      startChapter: ch,
      endChapter: ch,
      verseStart: parseInt(verseMatch[3], 10),
      verseEnd: parseInt(verseMatch[4], 10),
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
    };
  } else {
    parsed = parseWriteNotesCommand(message.content);
  }

  if (!parsed) {
    await addReaction(msgId, 'cross_mark');
    await status('Could not parse command. Expected: `write notes <book> <chapter>` or `write notes <book> <start>-<end>`');
    return;
  }

  const { book, startChapter, endChapter, verseStart, verseEnd } = parsed;
  const chapterCount = endChapter - startChapter + 1;
  const rangeLabel = startChapter === endChapter
    ? `${book} ${startChapter}`
    : `${book} ${startChapter}–${endChapter}`;

  // --- Look up Door43 username ---
  const username = getDoor43Username(message.sender_email);
  if (!username) {
    await addReaction(msgId, 'cross_mark');
    await status(`No Door43 username mapped for ${message.sender_email}. Add it to door43-users.json.`);
    return;
  }

  await addReaction(msgId, 'working_on_it');
  await status(`Starting notes pipeline for **${rangeLabel}** (${chapterCount} chapter(s), user: ${username})`);

  // --- Pre-check: existing TN branch ---
  const existingBranch = checkExistingBranch(username, 'en_tn', '{username}-tc-create-1');
  if (existingBranch) {
    await removeReaction(msgId, 'working_on_it');
    await addReaction(msgId, 'stop_sign');
    await reply(
      `You have an existing TN branch \`${existingBranch}\`. ` +
      `Please merge it using gatewayEdit or tcCreate, then run \`write notes ${rangeLabel}\` again.`
    );
    return;
  }

  // Ensure log directory
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const logFile = path.join(LOG_DIR, 'notes.log');
  const model = isTestFast ? 'haiku' : undefined;

  const pipelineStart = Date.now();
  let totalSuccess = 0;
  let totalFail = 0;

  // --- Chapter loop ---
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

    // --- Build skill chain based on prerequisite availability ---
    const skills = [];

    if (hasAIArtifacts) {
      // AI artifacts found → post-edit-review path
      issuesPath = resolved['issues TSV'];
      await status(`**${ref}**: AI artifacts found → post-edit-review path`);

      skills.push({
        name: 'post-edit-review',
        prompt: `${skillRef} --issues ${issuesPath}`,
        appendSystemPrompt: POST_EDIT_REVIEW_HINT,
        expectedOutput: issuesPath,
        ops: 1,
      });
    } else {
      // No AI artifacts → deep-issue-id path (fetches from Door43 master)
      issuesPath = `output/issues/${tag}.tsv`;
      await status(`**${ref}**: No AI artifacts (missing: ${missing.join(', ')}) → deep-issue-id --lite path`);

      skills.push({
        name: 'deep-issue-id --lite',
        prompt: `${book} ${ch}`,
        expectedOutput: `output/issues/${tag}.tsv`,
        ops: 3, // 2 analysts + challenger/merge
      });
    }

    // Common tail: chapter-intro → tn-writer → tn-quality-check → repo-insert
    skills.push({
      name: 'chapter-intro',
      prompt: `${skillRef} --issues ${issuesPath}`,
      expectedOutput: issuesPath,
      ops: 1,
    });

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

    skills.push({
      name: 'repo-insert',
      prompt: `tn ${skillRef} ${username} --no-pr --source output/notes/${tag}.tsv`,
      expectedOutput: null, // side effect: git push
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
          await status(`**${skill.name}** failed for ${ref} — expected output not found: ${skill.expectedOutput} (${duration}s)`);
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

    // --- Repo verify (JS-level, not a Claude skill) ---
    if (!failedSkill) {
      const branchName = `${username}-tc-create-1`;
      await status(`Verifying push for ${ref}...`);
      const verify = await verifyRepoPush({
        repo: 'en_tn',
        branch: branchName,
        expectedFiles: [],  // Just check branch existence for now
      });
      if (!verify.success) {
        await status(`Repo verify warning for ${ref}: ${verify.details}`);
        console.warn(`[notes] Repo verify failed for ${ref}: ${verify.details}`);
        // Don't fail the pipeline — just warn. repo-insert may still have worked.
      } else {
        await status(`Repo verify OK for ${ref}: ${verify.details}`);
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
        downloadLink = ` · [Download](${uri})`;
      } catch (err) {
        console.error(`[notes] Failed to upload notes TSV: ${err.message}`);
        downloadLink = ' · (file upload failed)';
      }
    }

    if (chapterCount === 1) {
      // Single chapter — give full reply at end
    } else {
      await reply(`**${ref}** notes complete (${chapterDuration}s)${downloadLink}`);
    }
  }

  const totalDuration = ((Date.now() - pipelineStart) / 1000).toFixed(1);

  // --- Final reaction and report ---
  await removeReaction(msgId, 'working_on_it');

  if (totalFail > 0 && totalSuccess === 0) {
    await addReaction(msgId, 'warning');
    await reply(`Notes pipeline for **${rangeLabel}** failed — all ${totalFail} chapter(s) had errors. Check admin DMs for details.`);
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

      const branchName = `${username}-tc-create-1`;
      await reply(
        `Notes pipeline complete for **${rangeLabel}** (${totalDuration}s).\n` +
        `Branch: \`${branchName}\` on en_tn` +
        downloadLink
      );
    } else {
      const branchName = `${username}-tc-create-1`;
      await reply(
        `Notes pipeline complete for **${rangeLabel}**: all ${totalSuccess} chapter(s) succeeded (${totalDuration}s).\n` +
        `Branch: \`${branchName}\` on en_tn`
      );
    }
  }

  await status(`Notes pipeline complete for **${rangeLabel}** in ${totalDuration}s — ${totalSuccess} ok, ${totalFail} failed.`);
}

module.exports = { notesPipeline };
