// prompt-builder.js — Assembles system prompts from workspace skills
// Reads SKILL.md + CLAUDE.md, combines into a system prompt

const fs = require('fs');
const path = require('path');

const DEFAULT_WORKSPACE = '/srv/bot/workspace';

/**
 * Build a system prompt from a named workspace skill.
 * Loads SKILL.md + CLAUDE.md and combines them.
 *
 * @param {string} skillName - Skill directory name (e.g. 'ULT-gen')
 * @param {{ cwd?: string, date?: string }} opts
 * @returns {string} Combined system prompt
 */
function buildSkillPrompt(skillName, opts = {}) {
  const cwd = opts.cwd || DEFAULT_WORKSPACE;
  const date = opts.date || new Date().toISOString().split('T')[0];

  const skillPath = path.join(cwd, '.claude', 'skills', skillName, 'SKILL.md');
  if (!fs.existsSync(skillPath)) {
    throw new Error(`Skill not found: ${skillPath}`);
  }
  const skillContent = fs.readFileSync(skillPath, 'utf8');

  let claudeMd = '';
  const claudeMdPath = path.join(cwd, 'CLAUDE.md');
  if (fs.existsSync(claudeMdPath)) {
    claudeMd = fs.readFileSync(claudeMdPath, 'utf8');
  }

  return assemblePreamble(cwd, date) + '\n\n' + claudeMd + '\n\n---\n\n' + skillContent;
}

/**
 * Build a system prompt from a custom string (for challenger, merge, etc.).
 *
 * @param {string} systemText - The custom system prompt text
 * @param {{ cwd?: string, date?: string }} opts
 * @returns {string} Combined system prompt
 */
function buildCustomPrompt(systemText, opts = {}) {
  const cwd = opts.cwd || DEFAULT_WORKSPACE;
  const date = opts.date || new Date().toISOString().split('T')[0];

  return assemblePreamble(cwd, date) + '\n\n' + systemText;
}

/**
 * Build the preamble that goes at the top of every system prompt.
 */
function assemblePreamble(cwd, date) {
  return [
    `# Environment`,
    `- Working directory: ${cwd}`,
    `- Date: ${date}`,
  ].join('\n');
}

module.exports = { buildSkillPrompt, buildCustomPrompt };
