// generate-pipeline.js — SDK-based generation pipeline
// Replaces generate.sh: parses command, loops chapters, calls Claude SDK, posts results to Zulip

const fs = require('fs');
const path = require('path');
const config = require('../config.json');
const { sendMessage, sendDM, addReaction, removeReaction, uploadFile } = require('./zulip-client');
const { runClaude } = require('./claude-runner');

const CSKILLBP_DIR = path.resolve(__dirname, '../../cSkillBP');
const LOG_DIR = path.resolve(__dirname, '../logs');

function parseGenerateCommand(content) {
  const input = content.toLowerCase();

  // Range: generate psa 79-89, generate psa 79–89, generate psa 79 to 89
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
        await sendMessage(stream, topic, text);
      } else {
        await sendDM(message.sender_id, text);
      }
    } catch (err) {
      console.error(`[generate] Failed to send reply: ${err.message}`);
    }
  }

  // Parse command
  const parsed = parseGenerateCommand(message.content);
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

  // Token estimate check
  const perChapter = (route.tokenEstimate && route.tokenEstimate.perChapter) || 5000000;
  const sessionBudget = (route.tokenEstimate && route.tokenEstimate.sessionBudget) || 45000000;
  const estimatedTotal = chapterCount * perChapter;

  if (estimatedTotal > sessionBudget) {
    await addReaction(msgId, 'cross_mark');
    await status(`Estimated token usage (~${estimatedTotal}) exceeds session budget (~${sessionBudget}). Try a smaller range (max ~${Math.floor(sessionBudget / perChapter)} chapters).`);
    return;
  }

  // Signal working
  await addReaction(msgId, 'working_on_it');
  await status(`Starting generation for **${book}** chapters ${start}\u2013${end} (${chapterCount} chapter(s), ~${estimatedTotal} tokens estimated)`);

  // Ensure log directory
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const logFile = path.join(LOG_DIR, 'generate.log');

  // Determine model
  const model = isTestFast ? 'haiku' : undefined;

  // Determine skill from route config
  const skill = route.skill || 'initial-pipeline --lite';

  let success = 0;
  let fail = 0;

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
        claudeResult = await runClaude({
          prompt: `${book} ${ch}`,
          cwd: CSKILLBP_DIR,
          model,
          skill,
        });
      } catch (err) {
        console.error(`[generate] Claude SDK error for ${book} ${ch}: ${err.message}`);
        claudeResult = null;
      }
    }

    const duration = ((Date.now() - chapterStart) / 1000).toFixed(1);
    const sdkSuccess = claudeResult?.subtype === 'success';

    // UST is the last artifact the pipeline produces (ULT is created first,
    // then revised, then UST is generated). If UST exists the work is done,
    // even if the SDK query hit maxTurns or timed out during team cleanup.
    const ultFile = path.join(CSKILLBP_DIR, 'output', 'AI-ULT', `${book}-${ch}.usfm`);
    const ustFile = path.join(CSKILLBP_DIR, 'output', 'AI-UST', `${book}-${ch}.usfm`);
    const hasUlt = fs.existsSync(ultFile);
    const hasUst = fs.existsSync(ustFile);

    // Log timing
    const logLine = `${new Date().toISOString()} | ${book} ${ch} | sdk=${sdkSuccess} | ult=${hasUlt} | ust=${hasUst} | duration=${duration}s\n`;
    fs.appendFileSync(logFile, logLine);

    if (!hasUst) {
      // UST missing means the pipeline didn't finish its real work
      await status(`Failed to generate **${book} ${ch}**. UST not produced${hasUlt ? ' (ULT exists but may be incomplete)' : ''}. Check logs for details.`);
      fail++;
      continue;
    }

    if (!sdkSuccess) {
      console.log(`[generate] SDK exited with ${claudeResult?.subtype || 'no result'} but UST exists — treating as success`);
    }

    // Upload output files and post download links to channel
    const links = [];

    if (hasUlt) {
      try {
        const ultUri = await uploadFile(ultFile, `${book} ${ch} ULT.usfm`);
        links.push(`[${book} ${ch} ULT.usfm](${ultUri})`);
      } catch (err) {
        console.error(`[generate] Failed to upload ULT: ${err.message}`);
        links.push(`ULT upload failed: ${err.message}`);
      }
    }

    if (hasUst) {
      try {
        const ustUri = await uploadFile(ustFile, `${book} ${ch} UST.usfm`);
        links.push(`[${book} ${ch} UST.usfm](${ustUri})`);
      } catch (err) {
        console.error(`[generate] Failed to upload UST: ${err.message}`);
        links.push(`UST upload failed: ${err.message}`);
      }
    }

    await reply(`**${book} ${ch}** — ${links.join(' · ')}`);

    // DM token usage to admin if available
    if (claudeResult?.usage) {
      const u = claudeResult.usage;
      // SDK usage fields may be snake_case (BetaUsage) or camelCase (ModelUsage)
      const inTok = u.input_tokens ?? u.inputTokens ?? 0;
      const outTok = u.output_tokens ?? u.outputTokens ?? 0;
      const cacheRead = u.cache_read_input_tokens ?? u.cacheReadInputTokens ?? 0;
      const cacheCreate = u.cache_creation_input_tokens ?? u.cacheCreationInputTokens ?? 0;
      const total = inTok + outTok + cacheRead + cacheCreate;
      const cost = claudeResult.total_cost_usd;
      await status(`**${book} ${ch}** tokens: ${total.toLocaleString()} (in: ${inTok.toLocaleString()}, out: ${outTok.toLocaleString()}, cache read: ${cacheRead.toLocaleString()})${cost != null ? ` · $${cost.toFixed(4)}` : ''} · ${duration}s`);
    }

    success++;
  }

  // Swap emoji and send final status
  await removeReaction(msgId, 'working_on_it');
  if (fail === 0) {
    await addReaction(msgId, 'check');
  } else {
    await addReaction(msgId, 'warning');
  }
  await status(`Generation complete for **${book} ${start}\u2013${end}**: ${success} succeeded, ${fail} failed.`);
}

module.exports = { generatePipeline };
