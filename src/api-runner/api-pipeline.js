const { runSkill } = require('./runner');
const { sendMessage, sendDM, addReaction, removeReaction } = require('../zulip-client');
const fs = require('fs');
const path = require('path');
const { door43Push } = require('../door43-push');
const { getDoor43Username, normalizeBookName, buildBranchName, discoverFreshOutput } = require('../pipeline-utils');

function parseRegexLiteral(literal) {
  if (typeof literal !== 'string') return null;
  const match = literal.match(/^\/(.+)\/([a-z]*)$/);
  if (!match) return null;
  return new RegExp(match[1], match[2]);
}

function extractPrompt(route, content) {
  const regex = parseRegexLiteral(route.match);
  if (!regex) return String(content || '').trim();
  const captures = String(content || '').match(regex);
  if (!captures) return String(content || '').trim();
  if (captures[1]) return String(captures[1]).trim();
  return String(content || '').trim();
}

function parseSkillSpec(spec) {
  const parts = String(spec || '').trim().split(/\s+/).filter(Boolean);
  const skillName = parts.shift() || 'initial-pipeline';
  return { skillName, args: parts.join(' ') };
}

function parseProviderFromMessage(content) {
  const match = String(content || '').match(/--provider\s+([a-z0-9_-]+)/i);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Extract book, chapter, and Door43 username from the prompt string.
 * Example: "zec 3 user benjamin-test" -> { book: "ZEC", chapter: 3, username: "benjamin-test" }
 */
function parseBookChapterUser(prompt, senderEmail) {
  const bookMatch = prompt.match(/^([a-z0-9]{2,3}|[a-z]+)\s+(\d+)/i);
  if (!bookMatch) return { book: null, chapter: null, username: null };

  const book = normalizeBookName(bookMatch[1]);
  const chapter = parseInt(bookMatch[2], 10);

  let username = null;
  const userMatch = prompt.match(/\buser\s+([a-z0-9_-]+)/i);
  if (userMatch) {
    username = userMatch[1];
  } else {
    username = getDoor43Username(senderEmail);
  }

  return { book, chapter, username };
}

async function apiPipeline(route, message) {
  const stream = message.type === 'stream' ? message.display_recipient : null;
  const topic = message.subject || '';
  const msgId = message.id;
  const isDryRun = process.env.DRY_RUN === '1';

  const { skillName, args } = parseSkillSpec(route.skill);
  let prompt = extractPrompt(route, message.content);
  if (args) prompt = `${args} ${prompt}`.trim();

  const provider = parseProviderFromMessage(message.content) || route.provider || 'openai';
  const model = route.model || null;
  let selectedCwd = route.cwd || '/workspace';
  const primarySkillPath = path.join(selectedCwd, '.claude', 'skills', skillName, 'SKILL.md');
  if (!fs.existsSync(primarySkillPath)) {
    const fallbackCwd = '/srv/bot/workspace';
    const fallbackSkillPath = path.join(fallbackCwd, '.claude', 'skills', skillName, 'SKILL.md');
    if (fs.existsSync(fallbackSkillPath)) {
      selectedCwd = fallbackCwd;
    }
  }

  const reply = async (text) => {
    if (stream) {
      const mention = message.sender_full_name ? `@**${message.sender_full_name}** ` : '';
      await sendMessage(stream, topic, mention + text);
    } else {
      await sendDM(message.sender_id, text);
    }
  };

  try {
    await addReaction(msgId, 'working_on_it');
    await reply(`Running **${skillName}** via **${provider}** for \`${prompt}\`...`);

    const startTime = Date.now();
    const result = await runSkill(skillName, prompt, {
      provider,
      model,
      thinking: route.thinking || 'medium',
      maxTurns: route.maxTurns || 100,
      timeout: route.timeout || 30,
      cwd: selectedCwd,
      verbose: !!route.verbose,
      dryRun: isDryRun,
      toolChoice: route.toolChoice,
    });

    await removeReaction(msgId, 'working_on_it');
    await addReaction(msgId, 'check');

    const output = (result.finalText || '(no text response)').trim();
    const summary = `API run complete. Turns: ${result.turns}, input: ${result.inputTokens}, output: ${result.outputTokens}, est cost: $${(result.cost || 0).toFixed(4)}.`;
    await reply(`${summary}\n\n${output}`);

    // --- Automatic Orchestration for initial-pipeline ---
    if (skillName === 'initial-pipeline' && !isDryRun) {
      const { book, chapter, username } = parseBookChapterUser(prompt, message.sender_email);
      if (book && chapter && username) {
        
        // 1. Run Alignment
        await reply(`LLM phase done. Starting **align-all-parallel** for ${book} ${chapter}...`);
        const alignRef = `${book} ${chapter} --ult --ust`; // always align both for now
        const alignResult = await runSkill('align-all-parallel', alignRef, {
          provider,
          model: 'sonnet', // use sonnet for alignment as it's cheaper/faster
          thinking: 'medium',
          maxTurns: 50,
          cwd: selectedCwd,
        });

        const tag = `${book}-${String(chapter).padStart(book === 'PSA' ? 3 : 2, '0')}`;
        const ultAligned = discoverFreshOutput('output/AI-ULT', book, new RegExp(`^${tag}-.*-aligned\\.usfm$`), startTime);
        const ustAligned = discoverFreshOutput('output/AI-UST', book, new RegExp(`^${tag}-.*-aligned\\.usfm$`), startTime);

        if (!ultAligned && !ustAligned) {
          throw new Error('Alignment phase failed: no aligned USFM files were produced.');
        }

        // 2. Door43 Push
        await reply(`Alignment done (turns: ${alignResult.turns}, cost: $${(alignResult.cost || 0).toFixed(4)}). Starting **door43-push** to user **${username}**...`);

        const pushResults = [];
        if (ultAligned) {
          const res = await door43Push({
            type: 'ult', book, chapter, username,
            branch: buildBranchName(book, chapter),
            source: ultAligned
          });
          pushResults.push(`ULT: ${res.branchUrl || res.details || (res.success ? 'ok' : 'failed')}`);
        }

        if (ustAligned) {
          const res = await door43Push({
            type: 'ust', book, chapter, username,
            branch: buildBranchName(book, chapter),
            source: ustAligned
          });
          pushResults.push(`UST: ${res.branchUrl || res.details || (res.success ? 'ok' : 'failed')}`);
        }

        await reply(`**door43-push** results:\n- ${pushResults.join('\n- ')}`);
      }
    }

  } catch (error) {
    await removeReaction(msgId, 'working_on_it');
    await addReaction(msgId, 'warning');
    await reply(`API run failed for **${skillName}** via **${provider}**: ${error.message}`);
  }
}

module.exports = { apiPipeline };
