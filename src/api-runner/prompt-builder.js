// prompt-builder.js — Assembles system prompts from workspace skills
// Reads SKILL.md + CLAUDE.md, combines into a system prompt

const fs = require('fs');
const path = require('path');
const { getToolDescriptions } = require('./tools');

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
  const tools = getToolDescriptions();
  const coreToolNames = ['Read', 'Write', 'Edit', 'Glob', 'Grep'];
  const workspaceToolLines = tools
    .filter((tool) => tool.name.startsWith('mcp__workspace-tools__'))
    .map((tool) => `- ${tool.name}: ${tool.description}`);

  return [
    `# Environment`,
    `- Working directory: ${cwd}`,
    `- Date: ${date}`,
    `- Core tools available: ${coreToolNames.join(', ')}`,
    `- Workspace tools available via mcp prefix: ${workspaceToolLines.length}`,
    ``,
    `You have access to the tools listed above to complete your task.`,
    `All file paths should be relative to the working directory unless absolute.`,
    `Use Read/Write/Edit for file operations and Glob/Grep for discovery/search.`,
    `Workspace tool aliases are available as both "<tool_name>" and "mcp__workspace-tools__<tool_name>".`,
    ``,
    `# Workspace Tools`,
    ...workspaceToolLines,
  ].join('\n');
}

module.exports = { buildSkillPrompt, buildCustomPrompt };
