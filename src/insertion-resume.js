// insertion-resume.js — Resume deferred repo-insert after user merges branches
// Called by the router when user says "merged" and there's a pending merge state.
// Note: No new pending merges are created (push-to-master workflow eliminated them).
// This file is kept for transition safety in case pending merges exist from before the change.

const fs = require('fs');
const path = require('path');
const config = require('./config');
const { sendMessage, sendDM, addReaction, removeReaction } = require('./zulip-client');
const { runClaude } = require('./claude-runner');
const { checkExistingBranch, buildBranchName, calcSkillTimeout, CSKILLBP_DIR } = require('./pipeline-utils');
const { verifyRepoPush } = require('./repo-verify');
const { getPendingMerge, setPendingMerge, clearPendingMerge } = require('./pending-merges');

const adminUserId = config.adminUserId;

async function status(text) {
  try { await sendDM(adminUserId, text); } catch (err) {
    console.error(`[insertion-resume] Failed to send status DM: ${err.message}`);
  }
}

async function replyTo(msg, text) {
  try {
    if (msg.type === 'stream') {
      await sendMessage(msg.display_recipient, msg.subject, text);
    } else {
      await sendDM(msg.sender_id, text);
    }
  } catch (err) {
    console.error(`[insertion-resume] Failed to send reply: ${err.message}`);
  }
}

/**
 * Resume insertion for a pending merge. Re-checks branches first.
 * @param {string} sessionKey
 * @param {object} triggerMessage - the Zulip message that triggered resume
 */
async function resumeInsertion(sessionKey, triggerMessage) {
  const pending = getPendingMerge(sessionKey);
  if (!pending) {
    await replyTo(triggerMessage, 'No pending insertion found for this topic.');
    return;
  }

  const { pipelineType, username, book, completedChapters, originalMessage } = pending;
  const msg = originalMessage;

  // Re-check blocking branches
  const stillBlocking = [];
  for (const branchInfo of pending.blockingBranches) {
    const { repo, branchPattern } = branchInfo;
    const result = checkExistingBranch(username, repo, branchPattern, book);
    if (result) stillBlocking.push(result);
  }

  if (stillBlocking.length > 0) {
    // Update retry count
    pending.retryCount = (pending.retryCount || 0) + 1;
    setPendingMerge(sessionKey, pending);

    await replyTo(triggerMessage,
      `Branches still exist -- please merge them first:\n` +
      stillBlocking.map(b => `- \`${b}\``).join('\n') +
      `\nSay **merged** when done.`
    );
    return;
  }

  // Branches are clear -- run insertion (pushes to master now)
  await status(`[insertion-resume] Branches clear for ${sessionKey}, running deferred insertion...`);

  const isTestFast = process.env.TEST_FAST === '1';
  const model = isTestFast ? 'haiku' : undefined;

  let success = 0;
  let fail = 0;

  if (pipelineType === 'generate') {
    ({ success, fail } = await runGenerateInsertPhase(completedChapters, username, book, model));
  } else if (pipelineType === 'notes') {
    ({ success, fail } = await runNotesInsertPhase(completedChapters, username, book, model));
  }

  // Clear pending state
  clearPendingMerge(sessionKey);

  // Update reaction on original message
  try {
    await removeReaction(msg.id, 'hourglass');
  } catch (_) {}

  if (fail === 0) {
    try { await addReaction(msg.id, 'check'); } catch (_) {}
  } else {
    try { await addReaction(msg.id, 'warning'); } catch (_) {}
  }

  // Report results
  const startChapter = pending.startChapter;
  const endChapter = pending.endChapter;
  const rangeLabel = startChapter === endChapter ? `${book} ${startChapter}` : `${book} ${startChapter}\u2013${endChapter}`;

  if (pipelineType === 'generate') {
    if (success > 0) {
      await replyTo(triggerMessage,
        `Content for **${rangeLabel}** pushed to master in en_ult and en_ust.` +
        (fail > 0 ? `\n(${fail} chapter(s) had insertion errors -- check admin DMs for details.)` : '')
      );
    } else {
      await replyTo(triggerMessage, `Insertion failed for all chapters of **${rangeLabel}**. Check admin DMs for details.`);
    }
  } else {
    if (success > 0) {
      await replyTo(triggerMessage,
        `Notes insertion complete for **${rangeLabel}**.\n` +
        `Content pushed to master on en_tn` +
        (fail > 0 ? `\n(${fail} chapter(s) had insertion errors -- check admin DMs for details.)` : '')
      );
    } else {
      await replyTo(triggerMessage, `Notes insertion failed for all chapters of **${rangeLabel}**. Check admin DMs for details.`);
    }
  }

  await status(`[insertion-resume] Deferred insertion complete for ${sessionKey}: ${success} ok, ${fail} failed.`);
}

/**
 * Run repo-insert + repo-verify for ULT and UST per chapter.
 * Pushes to master via the repo-insert skill's merge-to-master workflow.
 */
async function runGenerateInsertPhase(completedChapters, username, book, model) {
  let success = 0;
  let fail = 0;

  for (const ch of completedChapters) {
    let chapterFailed = false;

    // repo-insert ULT
    await status(`Running deferred **repo-insert** (ULT) for ${book} ${ch.ch}...`);
    try {
      const riTimeout = calcSkillTimeout(book, ch.ch, 1);
      await runClaude({
        prompt: `ult ${book} ${ch.ch} ${username} --branch ${buildBranchName(book, ch.ch)} --source ${ch.ultAligned}`,
        cwd: CSKILLBP_DIR,
        model,
        skill: 'repo-insert',
        timeoutMs: riTimeout,
      });
      await status(`**repo-insert** (ULT) done for ${book} ${ch.ch}`);
    } catch (err) {
      console.error(`[insertion-resume] repo-insert ULT error for ${book} ${ch.ch}: ${err.message}`);
      await status(`**repo-insert** (ULT) failed for ${book} ${ch.ch}: ${err.message}`);
      chapterFailed = true;
    }

    // repo-insert UST
    if (!chapterFailed) {
      await status(`Running deferred **repo-insert** (UST) for ${book} ${ch.ch}...`);
      try {
        const riTimeout = calcSkillTimeout(book, ch.ch, 1);
        await runClaude({
          prompt: `ust ${book} ${ch.ch} ${username} --branch ${buildBranchName(book, ch.ch)} --source ${ch.ustAligned}`,
          cwd: CSKILLBP_DIR,
          model,
          skill: 'repo-insert',
          timeoutMs: riTimeout,
        });
        await status(`**repo-insert** (UST) done for ${book} ${ch.ch}`);
      } catch (err) {
        console.error(`[insertion-resume] repo-insert UST error for ${book} ${ch.ch}: ${err.message}`);
        await status(`**repo-insert** (UST) failed for ${book} ${ch.ch}: ${err.message}`);
        chapterFailed = true;
      }
    }

    // repo-verify: check staging branch was merged (deleted from remote)
    if (!chapterFailed) {
      const stagingBranch = buildBranchName(book, ch.ch);
      await status(`Verifying merges for ${book} ${ch.ch}...`);
      const ultVerify = await verifyRepoPush({ repo: 'en_ult', stagingBranch });
      const ustVerify = await verifyRepoPush({ repo: 'en_ust', stagingBranch });

      if (!ultVerify.success) {
        await status(`Repo verify FAILED (ULT) for ${book} ${ch.ch}: ${ultVerify.details}`);
        chapterFailed = true;
      }
      if (!ustVerify.success) {
        await status(`Repo verify FAILED (UST) for ${book} ${ch.ch}: ${ustVerify.details}`);
        chapterFailed = true;
      }
      if (ultVerify.success && ustVerify.success) await status(`Repo verify OK for ${book} ${ch.ch}`);
    }

    if (chapterFailed) fail++;
    else success++;
  }

  return { success, fail };
}

/**
 * Run repo-insert + repo-verify for TN per chapter.
 * Pushes to master via the repo-insert skill's merge-to-master workflow.
 */
async function runNotesInsertPhase(completedChapters, username, book, model) {
  let success = 0;
  let fail = 0;

  for (const ch of completedChapters) {
    let chapterFailed = false;

    await status(`Running deferred **repo-insert** (TN) for ${book} ${ch.ch}...`);
    try {
      const riTimeout = calcSkillTimeout(book, ch.ch, 1);
      await runClaude({
        prompt: ch.repoInsertPrompt,
        cwd: CSKILLBP_DIR,
        model,
        skill: 'repo-insert',
        timeoutMs: riTimeout,
      });
      await status(`**repo-insert** (TN) done for ${book} ${ch.ch}`);
    } catch (err) {
      console.error(`[insertion-resume] repo-insert TN error for ${book} ${ch.ch}: ${err.message}`);
      await status(`**repo-insert** (TN) failed for ${book} ${ch.ch}: ${err.message}`);
      chapterFailed = true;
    }

    // repo-verify: check staging branch was merged (deleted from remote)
    if (!chapterFailed) {
      const stagingBranch = buildBranchName(book, ch.ch);
      await status(`Verifying merge for ${book} ${ch.ch}...`);
      const verify = await verifyRepoPush({ repo: 'en_tn', stagingBranch });
      if (!verify.success) {
        await status(`Repo verify FAILED for ${book} ${ch.ch}: ${verify.details}`);
        chapterFailed = true;
      } else {
        await status(`Repo verify OK for ${book} ${ch.ch}`);
      }
    }

    if (chapterFailed) fail++;
    else success++;
  }

  return { success, fail };
}

module.exports = { resumeInsertion };
