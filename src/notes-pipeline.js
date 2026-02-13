// notes-pipeline.js — 4-skill sequential pipeline for translation note writing
// Triggered by: "write notes <book> <chapter>"
// Skills: post-edit-review → chapter-intro → tn-writer → repo-insert

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('../config.json');
const { sendMessage, sendDM, addReaction, removeReaction, uploadFile } = require('./zulip-client');
const { runClaude } = require('./claude-runner');

const CSKILLBP_DIR = path.resolve(__dirname, '../../cSkillBP');
const LOG_DIR = path.resolve(__dirname, '../logs');

const SKILL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes per skill

const POST_EDIT_REVIEW_HINT =
  'Use Task subagents for the Diff Analyzer and Issue Reconciler. Do NOT use TeamCreate or SendMessage.';

// --- Parse "write notes BOOK CH" or "write notes BOOK CH:VS-VS" ---
function parseWriteNotesCommand(content) {
  // Match: write notes PSA 119:169-176  or  write notes PSA 117
  const match = content.match(/write notes(?:\s+for)?\s+(\w+)\s+(\d+)(?::(\d+)[-–—](\d+))?/i);
  if (!match) return null;
  const result = {
    book: match[1].toUpperCase(),
    chapter: parseInt(match[2], 10),
  };
  if (match[3] && match[4]) {
    result.verseStart = parseInt(match[3], 10);
    result.verseEnd = parseInt(match[4], 10);
  }
  return result;
}

// --- Look up Door43 username from sender email ---
function getDoor43Username(senderEmail) {
  const usersFile = path.resolve(__dirname, '../door43-users.json');
  if (!fs.existsSync(usersFile)) return null;
  const users = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
  return users[senderEmail] || null;
}

// --- Check if user has an existing TN branch that needs merging ---
function checkExistingBranch(username) {
  const branchName = `${username}-tc-create-1`;
  const repoUrl = 'https://git.door43.org/unfoldingWord/en_tn.git';

  try {
    const result = execSync(
      `git ls-remote --heads ${repoUrl} ${branchName}`,
      { encoding: 'utf8', timeout: 15000 }
    ).trim();
    return result.length > 0 ? branchName : null;
  } catch (err) {
    console.error(`[notes] git ls-remote failed: ${err.message}`);
    return null; // Assume no branch on error — don't block the pipeline
  }
}

// --- Resolve an output file that may live in either output/X/ or output/X/BOOK/ ---
function resolveOutputFile(relPath, book) {
  const direct = path.join(CSKILLBP_DIR, relPath);
  if (fs.existsSync(direct)) return relPath;

  // Try output/subdir/BOOK/filename  (e.g. output/issues/PSA/PSA-117.tsv)
  const parts = relPath.split('/');
  const filename = parts.pop();
  const altPath = [...parts, book, filename].join('/');
  const alt = path.join(CSKILLBP_DIR, altPath);
  if (fs.existsSync(alt)) return altPath;

  return null;
}

// --- Verify prerequisite files exist ---
function checkPrerequisites(book, chapter) {
  const tag = `${book}-${chapter}`;
  const required = [
    { path: `output/AI-ULT/${tag}.usfm`, label: 'AI-ULT' },
    { path: `output/AI-UST/${tag}.usfm`, label: 'AI-UST' },
    { path: `output/issues/${tag}.tsv`,   label: 'issues TSV' },
  ];

  const missing = [];
  const resolved = {};
  for (const f of required) {
    const found = resolveOutputFile(f.path, book);
    if (!found) {
      missing.push(f.label);
    } else {
      resolved[f.label] = found;
    }
  }
  return { missing, resolved };
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
  const parsed = parseWriteNotesCommand(message.content);
  if (!parsed) {
    await addReaction(msgId, 'cross_mark');
    await status('Could not parse command. Expected: `write notes <book> <chapter>`');
    return;
  }

  const { book, chapter, verseStart, verseEnd } = parsed;
  const tag = `${book}-${chapter}`;
  const verseRange = verseStart != null ? `:${verseStart}-${verseEnd}` : '';
  const ref = `${book} ${chapter}${verseRange}`;  // e.g. "PSA 119:169-176" or "PSA 117"
  const skillRef = verseStart != null ? `${book} ${chapter}:${verseStart}-${verseEnd}` : `${book} ${chapter}`;

  // --- Look up Door43 username ---
  const username = getDoor43Username(message.sender_email);
  if (!username) {
    await addReaction(msgId, 'cross_mark');
    await status(`No Door43 username mapped for ${message.sender_email}. Add it to door43-users.json.`);
    return;
  }

  await addReaction(msgId, 'working_on_it');
  await status(`Starting notes pipeline for **${ref}** (user: ${username})`);

  // --- Pre-check: existing branch ---
  const existingBranch = checkExistingBranch(username);
  if (existingBranch) {
    await removeReaction(msgId, 'working_on_it');
    await addReaction(msgId, 'stop_sign');
    await reply(
      `You have an existing TN branch \`${existingBranch}\`. ` +
      `Please merge it using gatewayEdit or tcCreate, then run \`write notes ${ref}\` again.`
    );
    return;
  }

  // --- Pre-check: prerequisite files ---
  const { missing, resolved } = checkPrerequisites(book, chapter);
  if (missing.length > 0) {
    await removeReaction(msgId, 'working_on_it');
    await addReaction(msgId, 'cross_mark');
    await reply(
      `Missing prerequisite files for ${ref}: **${missing.join(', ')}**. ` +
      `Run \`generate ${book} ${chapter}\` first and ensure human-edited ULT/UST are available.`
    );
    return;
  }

  const issuesPath = resolved['issues TSV'];

  // Ensure log directory
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const logFile = path.join(LOG_DIR, 'notes.log');
  const model = isTestFast ? 'haiku' : undefined;

  const pipelineStart = Date.now();
  let failedSkill = null;

  // --- Skill definitions ---
  const skills = [
    {
      name: 'post-edit-review',
      prompt: `${skillRef} --issues ${issuesPath}`,
      appendSystemPrompt: POST_EDIT_REVIEW_HINT,
      expectedOutput: issuesPath,
    },
    {
      name: 'chapter-intro',
      prompt: `${skillRef} --issues ${issuesPath}`,
      expectedOutput: issuesPath,
    },
    {
      name: 'tn-writer',
      prompt: `${skillRef} --issues ${issuesPath}`,
      expectedOutput: `output/notes/${tag}.tsv`,
    },
    {
      name: 'repo-insert',
      prompt: `tn ${skillRef} ${username} --no-pr --source output/notes/${tag}.tsv`,
      expectedOutput: null, // side effect: git push
    },
  ];

  // --- Run skills sequentially ---
  for (const skill of skills) {
    const skillStart = Date.now();
    await status(`Running **${skill.name}** for ${ref}...`);
    console.log(`[notes] Running ${skill.name}: ${skill.prompt}`);

    let result = null;
    try {
      result = await runClaude({
        prompt: skill.prompt,
        cwd: CSKILLBP_DIR,
        model,
        skill: skill.name,
        timeoutMs: SKILL_TIMEOUT_MS,
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
      if (!fs.existsSync(outputPath)) {
        failedSkill = skill.name;
        await status(`**${skill.name}** failed for ${ref} — expected output not found: ${skill.expectedOutput} (${duration}s)`);
        break;
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

  const totalDuration = ((Date.now() - pipelineStart) / 1000).toFixed(1);

  // --- Swap reaction and report ---
  await removeReaction(msgId, 'working_on_it');

  if (failedSkill) {
    await addReaction(msgId, 'warning');
    await reply(`Notes pipeline for **${ref}** failed at **${failedSkill}** after ${totalDuration}s. Check admin DMs for details.`);
    return;
  }

  // --- Upload notes TSV ---
  const notesTsv = path.join(CSKILLBP_DIR, 'output', 'notes', `${tag}.tsv`);
  let downloadLink = '';

  if (fs.existsSync(notesTsv)) {
    try {
      const uri = await uploadFile(notesTsv, `${tag} notes.tsv`);
      downloadLink = `\nDownload: [${tag} notes.tsv](${uri})`;
    } catch (err) {
      console.error(`[notes] Failed to upload notes TSV: ${err.message}`);
      downloadLink = '\n(File upload failed)';
    }
  }

  const branchName = `${username}-tc-create-1`;
  await addReaction(msgId, 'check');
  await reply(
    `Notes pipeline complete for **${ref}** (${totalDuration}s).\n` +
    `Branch: \`${branchName}\` on en_tn` +
    downloadLink
  );

  await status(`Notes pipeline complete for **${ref}** in ${totalDuration}s.`);
}

module.exports = { notesPipeline };
