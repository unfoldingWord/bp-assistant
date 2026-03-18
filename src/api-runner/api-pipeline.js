const { runSkill } = require('./runner');
const { sendMessage, sendDM, addReaction, removeReaction } = require('../zulip-client');
const fs = require('fs');
const path = require('path');

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

    const result = await runSkill(skillName, prompt, {
      provider,
      model,
      thinking: route.thinking || 'medium',
      maxTurns: route.maxTurns || 100,
      timeout: route.timeout || 30,
      cwd: selectedCwd,
      verbose: !!route.verbose,
      dryRun: isDryRun,
    });

    await removeReaction(msgId, 'working_on_it');
    await addReaction(msgId, 'check');

    const output = (result.finalText || '(no text response)').trim();
    const summary = `API run complete. Turns: ${result.turns}, input: ${result.inputTokens}, output: ${result.outputTokens}, est cost: $${(result.cost || 0).toFixed(4)}.`;
    await reply(`${summary}\n\n${output}`);
  } catch (error) {
    await removeReaction(msgId, 'working_on_it');
    await addReaction(msgId, 'warning');
    await reply(`API run failed for **${skillName}** via **${provider}**: ${error.message}`);
  }
}

module.exports = { apiPipeline };
