const fs = require('fs');
const path = require('path');
const config = require('./config');
const { sendMessage, sendDM, addReaction } = require('./zulip-client');
const { runClaude, DEFAULT_RESTRICTED_TOOLS, isTransientOutageError } = require('./claude-runner');
const { getDoor43Username, emailToFallbackUsername, buildBranchName, calcSkillTimeout, normalizeBookName, CSKILLBP_DIR } = require('./pipeline-utils');
const { door43Push, checkConflictingBranches, getRepoFilename } = require('./door43-push');
const { verifyRepoPush, verifyDcsToken } = require('./repo-verify');
const { getCheckpoint, setCheckpoint, clearCheckpoint } = require('./pipeline-checkpoints');
const { recordMetrics, getCumulativeTokens, recordRunSummary } = require('./usage-tracker');
const { verifyTq } = require('./workspace-tools/misc-tools');
const { getChapterCount } = require('./verse-counts');
const { publishAdminStatus } = require('./admin-status');
const { dispatchSelfDiagnosis } = require('./self-diagnosis');

function cleanContent(content) {
  return String(content || '').replace(/^@\*\*[^*]+\*\*\s*/, '').trim();
}

function parseWriteTqsCommand(content) {
  const raw = cleanContent(content);
  const match = raw.match(/^write\s+tqs?(?:\s+for)?\s+(\w+)(?:\s+(\d+(?:\s*[-–—]\s*\d+)?))?(?:\s+(--fresh))?\s*$/i)
    || raw.match(/^write\s+tqs?(?:\s+for)?\s+(\w+)(?:\s+(\d+(?:\s*[-–—]\s*\d+)?))?\s*$/i);
  if (!match) return null;

  const book = normalizeBookName(match[1]);
  const scope = match[2] ? String(match[2]).replace(/[-–—]/g, '-').replace(/\s+/g, '') : null;
  const fresh = /--fresh\b|--new\b/i.test(raw);

  if (!scope) {
    return { book, startChapter: 1, endChapter: getChapterCount(book), wholeBook: true, fresh };
  }

  const range = scope.match(/^(\d+)-(\d+)$/);
  if (range) {
    return {
      book,
      startChapter: Number(range[1]),
      endChapter: Number(range[2]),
      wholeBook: false,
      fresh,
    };
  }

  const chapter = Number(scope);
  if (!Number.isFinite(chapter)) return null;
  return { book, startChapter: chapter, endChapter: chapter, wholeBook: false, fresh };
}

function buildParsedTqsRequest(route, content) {
  if (route && route._synthetic) {
    return {
      book: route._book,
      startChapter: route._startChapter,
      endChapter: route._endChapter,
      wholeBook: !!route._wholeBook,
      fresh: /--fresh\b|--new\b/i.test(String(content || '')),
    };
  }
  return parseWriteTqsCommand(content);
}

function getOutputPath(book, chapter) {
  const tag = `${book}-${String(chapter).padStart(3, '0')}.tsv`;
  return path.join(CSKILLBP_DIR, 'output', 'tq', book, tag);
}

function listOutputCandidates(book, chapter) {
  const dir = path.join(CSKILLBP_DIR, 'output', 'tq', book);
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch (_) {
    return [];
  }
  const chapterNum = Number(chapter);
  if (!Number.isFinite(chapterNum)) return [];
  return files.filter((name) => {
    const m = String(name).match(/^([A-Z0-9]{3})-(\d{1,3})\.tsv$/);
    if (!m) return false;
    if (m[1] !== book) return false;
    return Number(m[2]) === chapterNum;
  }).sort();
}

function resolveOutputPath(book, chapter) {
  const canonicalPath = getOutputPath(book, chapter);
  const canonicalName = path.basename(canonicalPath);
  if (fs.existsSync(canonicalPath)) {
    return {
      ok: true,
      path: canonicalPath,
      normalizedFrom: null,
      candidates: [canonicalName],
    };
  }

  const candidates = listOutputCandidates(book, chapter);
  if (candidates.length !== 1) {
    return {
      ok: false,
      reason: candidates.length === 0 ? 'missing' : 'ambiguous',
      path: canonicalPath,
      candidates,
    };
  }

  const chosen = candidates[0];
  const chosenPath = path.join(path.dirname(canonicalPath), chosen);
  try {
    fs.renameSync(chosenPath, canonicalPath);
    return {
      ok: true,
      path: canonicalPath,
      normalizedFrom: chosen,
      candidates,
    };
  } catch (_) {
    try {
      fs.copyFileSync(chosenPath, canonicalPath);
      return {
        ok: true,
        path: canonicalPath,
        normalizedFrom: chosen,
        candidates,
      };
    } catch (err) {
      return {
        ok: false,
        reason: `normalize_failed:${err.message}`,
        path: canonicalPath,
        candidates,
      };
    }
  }
}

function hasVerifyErrors(output) {
  const match = String(output || '').match(/(\d+)\s+error\(s\):/i);
  return match ? Number(match[1]) > 0 : false;
}

async function tqsPipeline(route, message) {
  const stream = message.type === 'stream' ? message.display_recipient : null;
  const topic = message.subject || '';
  const msgId = message.id;

  async function status(text) {
    try {
      return await publishAdminStatus({
        source: 'tqs-pipeline',
        pipelineType: 'tqs',
        message: text,
      });
    } catch (err) {
      console.error(`[tqs] Failed to publish admin status: ${err.message}`);
      return null;
    }
  }

  function fireDiagnosis(event, extra = {}) {
    if (!event || event.severity !== 'error') return;
    dispatchSelfDiagnosis({ event, ...extra }).catch((err) => {
      console.error(`[tqs] dispatchSelfDiagnosis threw: ${err && err.message}`);
    });
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
      console.error(`[tqs] Failed to send reply: ${err.message}`);
    }
  }

  const parsed = buildParsedTqsRequest(route, message.content);
  if (!parsed) {
    await status('Could not parse command. Expected: `write tqs for HAB`, `write tqs for PSA 23`, or `write tqs for PSA 1-10`');
    return;
  }

  let { book, startChapter, endChapter, wholeBook, fresh } = parsed;
  if (!book || !Number.isFinite(startChapter) || !Number.isFinite(endChapter) || startChapter > endChapter) {
    await status(`Invalid TQ scope for ${book || 'unknown book'}.`);
    return;
  }

  const sessionKey = stream ? `stream-${stream}-${topic}` : `dm-${message.sender_id}`;
  const checkpointRef = {
    sessionKey,
    pipelineType: 'tqs',
    scope: { book, startChapter, endChapter, verseStart: null, verseEnd: null },
  };
  let existingCheckpoint = getCheckpoint(checkpointRef);
  const rangeLabel = wholeBook
    ? book
    : startChapter === endChapter
      ? `${book} ${startChapter}`
      : `${book} ${startChapter}-${endChapter}`;

  let username = getDoor43Username(message.sender_email);
  if (!username) {
    username = emailToFallbackUsername(message.sender_email);
    await status(`No Door43 username mapped for ${username} — using fallback username.`);
  }

  if (fresh) {
    clearCheckpoint(checkpointRef);
    existingCheckpoint = null;
    await status(`Fresh mode enabled for **${rangeLabel}** — cleared existing checkpoint.`);
  }

  await addReaction(msgId, 'working_on_it');
  await status(`Starting TQ pipeline for **${rangeLabel}** (user: ${username})`);

  const tokensBefore = getCumulativeTokens();
  let totalSuccess = Number(existingCheckpoint?.totalSuccess || 0);
  let totalFail = Number(existingCheckpoint?.totalFail || 0);
  const canResume = existingCheckpoint?.resume?.chapter != null
    && ['paused_for_outage', 'paused_for_usage_limit', 'failed', 'running'].includes(existingCheckpoint?.state);
  let resumeChapter = canResume ? Number(existingCheckpoint.resume.chapter) : startChapter;
  if (canResume && totalFail > 0) totalFail--;

  setCheckpoint(checkpointRef, {
    state: 'running',
    totalSuccess,
    totalFail,
    resume: { chapter: resumeChapter, skill: existingCheckpoint?.resume?.skill || 'tq-writer' },
  });

  if (canResume && resumeChapter > startChapter) {
    await status(`Resuming TQ pipeline from **${book} ${resumeChapter}**.`);
    await reply(`Resuming translation questions for **${rangeLabel}** from **${book} ${resumeChapter}**.`);
  }

  for (let chapter = startChapter; chapter <= endChapter; chapter++) {
    if (chapter < resumeChapter) continue;

    const ref = `${book} ${chapter}`;
    const branch = buildBranchName(book, chapter);
    const outputPath = getOutputPath(book, chapter);
    const outputRel = path.relative(CSKILLBP_DIR, outputPath).replace(/\\/g, '/');

    await status(`Processing **${ref}**...`);
    setCheckpoint(checkpointRef, {
      state: 'running',
      totalSuccess,
      totalFail,
      current: { chapter, skill: 'tq-writer', status: 'running' },
      resume: { chapter, skill: 'tq-writer' },
    });

    let result;
    try {
      result = await runClaude({
        skill: 'tq-writer',
        model: 'sonnet',
        cwd: CSKILLBP_DIR,
        prompt: `Write translation questions for ${book} chapter ${chapter}.`,
        mcpToolSet: 'workspace',
        allowedTools: DEFAULT_RESTRICTED_TOOLS,
        disableLocalSettings: true,
        forceNoAutoBashSandbox: true,
        timeoutMs: calcSkillTimeout(book, chapter, 1),
      });
      recordMetrics({ pipeline: 'tqs', skill: 'tq-writer', book, chapter, result, success: true, userId: message.sender_id });
    } catch (err) {
      recordMetrics({ pipeline: 'tqs', skill: 'tq-writer', book, chapter, result: { usage: {} }, success: false, userId: message.sender_id });
      const outage = isTransientOutageError(err);
      const state = outage ? 'paused_for_outage' : 'failed';
      setCheckpoint(checkpointRef, {
        state,
        totalSuccess,
        totalFail: totalFail + 1,
        current: { chapter, skill: 'tq-writer', status: 'failed', errorKind: outage ? 'outage' : 'writer_failed' },
        resume: { chapter, skill: 'tq-writer' },
      });
      recordRunSummary({ pipeline: 'tqs', book, startCh: startChapter, endCh: endChapter, tokensBefore, success: false, userId: message.sender_id });
      const writerEvent = await status(`**${ref}** failed during tq-writer: ${err.message}`);
      await reply(`Translation questions failed for **${ref}**: ${err.message}`);
      fireDiagnosis(writerEvent, {
        checkpoint: getCheckpoint(checkpointRef),
        errorText: err && err.stack ? err.stack : err && err.message,
      });
      return;
    }

    const resolvedOutput = resolveOutputPath(book, chapter);
    if (!resolvedOutput.ok) {
      totalFail++;
      setCheckpoint(checkpointRef, {
        state: 'failed',
        totalSuccess,
        totalFail,
        current: { chapter, skill: 'tq-writer', status: 'failed', errorKind: 'missing_output' },
        resume: { chapter, skill: 'tq-writer' },
      });
      recordRunSummary({ pipeline: 'tqs', book, startCh: startChapter, endCh: endChapter, tokensBefore, success: false, userId: message.sender_id });
      const outputDir = path.join(CSKILLBP_DIR, 'output', 'tq', book);
      const siblingText = resolvedOutput.candidates.length > 0
        ? ` candidates: ${resolvedOutput.candidates.join(', ')}`
        : '';
      const detail = resolvedOutput.reason === 'ambiguous'
        ? `ambiguous output files for chapter ${chapter}:${siblingText}`
        : `expected output file missing: ${outputRel}${siblingText}`;
      const missingEvent = await status(`**${ref}** failed: ${detail}`);
      await reply(`Translation questions failed for **${ref}** because the expected output file is missing.`);
      fireDiagnosis(missingEvent, {
        checkpoint: getCheckpoint(checkpointRef),
        errorText: `Expected output path: ${outputPath}\nOutput dir: ${outputDir}\nResolved output reason: ${resolvedOutput.reason || 'unknown'}\nCandidates: ${(resolvedOutput.candidates || []).join(', ') || '(none)'}\nWriter result subtype: ${result?.subtype || 'unknown'}\nWriter result text head: ${(typeof result?.result === 'string' ? result.result : '').slice(0, 1000)}`,
      });
      return;
    }

    if (resolvedOutput.normalizedFrom) {
      await status(`Normalized output filename for **${ref}**: ${resolvedOutput.normalizedFrom} -> ${path.basename(outputPath)}`);
    }

    const verifyOutput = verifyTq({ tsvFile: outputRel });
    if (hasVerifyErrors(verifyOutput)) {
      totalFail++;
      setCheckpoint(checkpointRef, {
        state: 'failed',
        totalSuccess,
        totalFail,
        current: { chapter, skill: 'verify-tq', status: 'failed', errorKind: 'verification_failed' },
        resume: { chapter, skill: 'tq-writer' },
      });
      recordRunSummary({ pipeline: 'tqs', book, startCh: startChapter, endCh: endChapter, tokensBefore, success: false, userId: message.sender_id });
      const verifyEvent = await status(`**${ref}** failed verification:\n${verifyOutput}`);
      await reply(`Translation questions failed verification for **${ref}**.`);
      fireDiagnosis(verifyEvent, {
        checkpoint: getCheckpoint(checkpointRef),
        errorText: `verifyTq output:\n${verifyOutput}`,
      });
      return;
    }

    const dcsCheck = await verifyDcsToken();
    if (!dcsCheck.valid) {
      totalFail++;
      setCheckpoint(checkpointRef, {
        state: 'failed',
        totalSuccess,
        totalFail,
        current: { chapter, skill: 'door43-push', status: 'failed', errorKind: 'token_invalid' },
        resume: { chapter, skill: 'door43-push' },
      });
      recordRunSummary({ pipeline: 'tqs', book, startCh: startChapter, endCh: endChapter, tokensBefore, success: false, userId: message.sender_id });
      await status(`**${ref}** skipped: ${dcsCheck.details}`);
      await reply(`Translation questions could not be pushed for **${ref}** because Door43 auth is invalid.`);
      return;
    }

    const conflicts = await checkConflictingBranches('en_tq', getRepoFilename('tq', book), chapter);
    if (conflicts.length > 0) {
      totalFail++;
      setCheckpoint(checkpointRef, {
        state: 'failed',
        totalSuccess,
        totalFail,
        current: { chapter, skill: 'door43-push', status: 'failed', errorKind: 'conflicting_branches' },
        resume: { chapter, skill: 'door43-push' },
      });
      recordRunSummary({ pipeline: 'tqs', book, startCh: startChapter, endCh: endChapter, tokensBefore, success: false, userId: message.sender_id });
      await status(`**${ref}** blocked by conflicting branches: ${conflicts.map((c) => c.branch).join(', ')}`);
      await reply(`Translation questions for **${ref}** are blocked by conflicting branches: ${conflicts.map((c) => c.branch).join(', ')}.`);
      return;
    }

    setCheckpoint(checkpointRef, {
      state: 'running',
      totalSuccess,
      totalFail,
      current: { chapter, skill: 'door43-push', status: 'running' },
      resume: { chapter, skill: 'door43-push' },
    });

    const pushStartTime = new Date().toISOString();
    const pushResult = await door43Push({
      type: 'tq',
      book,
      chapter,
      username,
      branch,
      source: outputRel,
    });
    if (!pushResult.success) {
      totalFail++;
      setCheckpoint(checkpointRef, {
        state: 'failed',
        totalSuccess,
        totalFail,
        current: { chapter, skill: 'door43-push', status: 'failed', errorKind: 'push_failed' },
        resume: { chapter, skill: 'door43-push' },
      });
      recordRunSummary({ pipeline: 'tqs', book, startCh: startChapter, endCh: endChapter, tokensBefore, success: false, userId: message.sender_id });
      const pushEvent = await status(`**${ref}** push failed: ${pushResult.details}`);
      await reply(`Translation questions failed to push for **${ref}**.`);
      fireDiagnosis(pushEvent, {
        checkpoint: getCheckpoint(checkpointRef),
        errorText: `Door43 push failed.\nDetails: ${pushResult.details}`,
      });
      return;
    }

    const verifyPush = await verifyRepoPush({ repo: 'en_tq', stagingBranch: branch, since: pushStartTime });
    if (!verifyPush.success) {
      totalFail++;
      setCheckpoint(checkpointRef, {
        state: 'failed',
        totalSuccess,
        totalFail,
        current: { chapter, skill: 'door43-push', status: 'failed', errorKind: 'verify_push_failed' },
        resume: { chapter, skill: 'door43-push' },
      });
      recordRunSummary({ pipeline: 'tqs', book, startCh: startChapter, endCh: endChapter, tokensBefore, success: false, userId: message.sender_id });
      const verifyPushEvent = await status(`**${ref}** push verification failed: ${verifyPush.details}`);
      await reply(`Translation questions could not be verified on Door43 for **${ref}**.`);
      fireDiagnosis(verifyPushEvent, {
        checkpoint: getCheckpoint(checkpointRef),
        errorText: `Push verify failed.\nDetails: ${verifyPush.details}`,
      });
      return;
    }

    totalSuccess++;
    setCheckpoint(checkpointRef, {
      state: 'running',
      totalSuccess,
      totalFail,
      current: { chapter, skill: 'door43-push', status: 'succeeded' },
      resume: { chapter: chapter + 1, skill: 'tq-writer' },
    });
    await status(`Completed **${ref}**: ${pushResult.details}`);
  }

  recordRunSummary({ pipeline: 'tqs', book, startCh: startChapter, endCh: endChapter, tokensBefore, success: true, userId: message.sender_id });
  clearCheckpoint(checkpointRef);
  await reply(`Translation questions complete for **${rangeLabel}**.`);
}

module.exports = {
  tqsPipeline,
  parseWriteTqsCommand,
  buildParsedTqsRequest,
  resolveOutputPath,
};
