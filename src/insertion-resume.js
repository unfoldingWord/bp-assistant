// insertion-resume.js — Resume deferred repo-insert after user merges branches
// Called by the router when user says "merged" and there's a pending merge state.

const fs = require('fs');
const path = require('path');
const { sendMessage, sendDM, addReaction, removeReaction } = require('./zulip-client');
const { checkExistingBranch, buildBranchName, CSKILLBP_DIR } = require('./pipeline-utils');
const { verifyRepoPush } = require('./repo-verify');
const { door43Push, checkConflictingBranches, getRepoFilename } = require('./door43-push');
const { getPendingMerge, setPendingMerge, clearPendingMerge } = require('./pending-merges');
const { publishAdminStatus } = require('./admin-status');

// Extract --source value from legacy repoInsertPrompt strings
function extractSourceFromPrompt(prompt) {
  if (!prompt) return '';
  const m = prompt.match(/--source\s+(\S+)/);
  return m ? m[1] : '';
}

async function status(text) {
  try {
    await publishAdminStatus({
      source: 'insertion-resume',
      pipelineType: 'resume',
      message: text,
    });
  } catch (err) {
    console.error(`[insertion-resume] Failed to publish admin status: ${err.message}`);
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

  // Re-check: are there still user branches modifying the target files?
  const repos = pipelineType === 'notes'
    ? [{ type: 'tn', repo: 'en_tn' }]
    : [{ type: 'ult', repo: 'en_ult' }, { type: 'ust', repo: 'en_ust' }];

  const chapters = completedChapters.map(c => c.ch);
  const stillBlocking = [];
  for (const { type, repo } of repos) {
    const targetFile = getRepoFilename(type, book);
    for (const ch of chapters) {
      const conflicts = await checkConflictingBranches(repo, targetFile, ch);
      stillBlocking.push(...conflicts.map(c => `${c.branch} (${repo})`));
    }
  }
  // Deduplicate
  const uniqueBlocking = [...new Set(stillBlocking)];

  if (uniqueBlocking.length > 0) {
    // Update retry count
    pending.retryCount = (pending.retryCount || 0) + 1;
    setPendingMerge(sessionKey, pending);

    await replyTo(triggerMessage,
      `Branches still exist -- please merge them first:\n` +
      uniqueBlocking.map(b => `- \`${b}\``).join('\n') +
      `\nSay **merged** when done.`
    );
    return;
  }

  // Branches are clear -- run insertion (pushes to master now)
  await status(`[insertion-resume] Branches clear for ${sessionKey}, running deferred insertion...`);

  let success = 0;
  let fail = 0;

  if (pipelineType === 'generate') {
    ({ success, fail } = await runGenerateInsertPhase(completedChapters, username, book));
  } else if (pipelineType === 'notes') {
    ({ success, fail } = await runNotesInsertPhase(completedChapters, username, book));
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
        (fail > 0 ? `\n(${fail} chapter(s) had insertion errors -- check admin DMs for details.)` : '') +
        `\nYou may need to refresh the tcCreate or gatewayEdit page to see the new content.`
      );
    } else {
      await replyTo(triggerMessage, `Insertion failed for all chapters of **${rangeLabel}**. Check admin DMs for details.`);
    }
  } else {
    if (success > 0) {
      await replyTo(triggerMessage,
        `Notes insertion complete for **${rangeLabel}**.\n` +
        `Content pushed to master on en_tn` +
        (fail > 0 ? `\n(${fail} chapter(s) had insertion errors -- check admin DMs for details.)` : '') +
        `\nYou may need to refresh the tcCreate or gatewayEdit page to see the new content.`
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
async function runGenerateInsertPhase(completedChapters, username, book) {
  let success = 0;
  let fail = 0;

  for (const ch of completedChapters) {
    let chapterFailed = false;
    let ultNoChanges = false;
    let ustNoChanges = false;
    const pushStartTime = new Date().toISOString();

    // door43-push ULT
    await status(`Running deferred **door43-push** (ULT) for ${book} ${ch.ch}...`);
    try {
      const pushResultUlt = await door43Push({
        type: 'ult', book, chapter: ch.ch,
        username, branch: buildBranchName(book, ch.ch),
        source: ch.ultAligned,
      });
      if (!pushResultUlt.success) {
        console.error(`[insertion-resume] door43-push ULT failed for ${book} ${ch.ch}: ${pushResultUlt.details}`);
        await status(`**door43-push** (ULT) failed for ${book} ${ch.ch}: ${pushResultUlt.details}`);
        chapterFailed = true;
      } else {
        ultNoChanges = pushResultUlt.noChanges === true;
        await status(`**door43-push** (ULT) done for ${book} ${ch.ch}: ${pushResultUlt.details}`);
      }
    } catch (err) {
      console.error(`[insertion-resume] door43-push ULT error for ${book} ${ch.ch}: ${err.message}`);
      await status(`**door43-push** (ULT) failed for ${book} ${ch.ch}: ${err.message}`);
      chapterFailed = true;
    }

    // door43-push UST
    if (!chapterFailed) {
      await status(`Running deferred **door43-push** (UST) for ${book} ${ch.ch}...`);
      try {
        const pushResultUst = await door43Push({
          type: 'ust', book, chapter: ch.ch,
          username, branch: buildBranchName(book, ch.ch),
          source: ch.ustAligned,
        });
        if (!pushResultUst.success) {
          console.error(`[insertion-resume] door43-push UST failed for ${book} ${ch.ch}: ${pushResultUst.details}`);
          await status(`**door43-push** (UST) failed for ${book} ${ch.ch}: ${pushResultUst.details}`);
          chapterFailed = true;
        } else {
          ustNoChanges = pushResultUst.noChanges === true;
          await status(`**door43-push** (UST) done for ${book} ${ch.ch}: ${pushResultUst.details}`);
        }
      } catch (err) {
        console.error(`[insertion-resume] door43-push UST error for ${book} ${ch.ch}: ${err.message}`);
        await status(`**door43-push** (UST) failed for ${book} ${ch.ch}: ${err.message}`);
        chapterFailed = true;
      }
    }

    // repo-verify: belt-and-suspenders check
    if (!chapterFailed) {
      const stagingBranch = buildBranchName(book, ch.ch);
      const verifyUlt = !ultNoChanges;
      const verifyUst = !ustNoChanges;
      const skippedTypes = [ultNoChanges && 'ULT', ustNoChanges && 'UST'].filter(Boolean);
      if (skippedTypes.length > 0) {
        await status(`Repo verify SKIPPED (${skippedTypes.join(' and ')}) for ${book} ${ch.ch}: no content changes to push`);
      }
      if (verifyUlt || verifyUst) {
        await status(`Verifying merges for ${book} ${ch.ch}...`);
      }
      const ultVerify = verifyUlt ? await verifyRepoPush({ repo: 'en_ult', stagingBranch, since: pushStartTime }) : { success: true };
      const ustVerify = verifyUst ? await verifyRepoPush({ repo: 'en_ust', stagingBranch, since: pushStartTime }) : { success: true };

      if (verifyUlt && !ultVerify.success) {
        await status(`Repo verify FAILED (ULT) for ${book} ${ch.ch}: ${ultVerify.details}`);
        chapterFailed = true;
      }
      if (verifyUst && !ustVerify.success) {
        await status(`Repo verify FAILED (UST) for ${book} ${ch.ch}: ${ustVerify.details}`);
        chapterFailed = true;
      }
      if (ultVerify.success && ustVerify.success && (verifyUlt || verifyUst)) await status(`Repo verify OK for ${book} ${ch.ch}`);
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
async function runNotesInsertPhase(completedChapters, username, book) {
  let success = 0;
  let fail = 0;

  for (const ch of completedChapters) {
    let chapterFailed = false;
    let pushNoChanges = false;
    const pushStartTime = new Date().toISOString();

    await status(`Running deferred **door43-push** (TN) for ${book} ${ch.ch}...`);
    try {
      const pushResult = await door43Push({
        type: 'tn', book, chapter: ch.ch,
        username, branch: buildBranchName(book, ch.ch),
        source: ch.notesSource || extractSourceFromPrompt(ch.repoInsertPrompt),
      });
      if (!pushResult.success) {
        console.error(`[insertion-resume] door43-push TN failed for ${book} ${ch.ch}: ${pushResult.details}`);
        await status(`**door43-push** (TN) failed for ${book} ${ch.ch}: ${pushResult.details}`);
        chapterFailed = true;
      } else {
        pushNoChanges = pushResult.noChanges === true;
        await status(`**door43-push** (TN) done for ${book} ${ch.ch}: ${pushResult.details}`);
      }
    } catch (err) {
      console.error(`[insertion-resume] door43-push TN error for ${book} ${ch.ch}: ${err.message}`);
      await status(`**door43-push** (TN) failed for ${book} ${ch.ch}: ${err.message}`);
      chapterFailed = true;
    }

    // repo-verify: belt-and-suspenders check
    if (!chapterFailed) {
      if (pushNoChanges) {
        await status(`Repo verify SKIPPED for ${book} ${ch.ch}: no content changes to push`);
      } else {
        const stagingBranch = buildBranchName(book, ch.ch);
        await status(`Verifying merge for ${book} ${ch.ch}...`);
        const verify = await verifyRepoPush({ repo: 'en_tn', stagingBranch, since: pushStartTime });
        if (!verify.success) {
          await status(`Repo verify FAILED for ${book} ${ch.ch}: ${verify.details}`);
          chapterFailed = true;
        } else {
          await status(`Repo verify OK for ${book} ${ch.ch}`);
        }
      }
    }

    if (chapterFailed) fail++;
    else success++;
  }

  return { success, fail };
}

module.exports = { resumeInsertion };
