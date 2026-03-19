// prompt-builder.js — Assembles system prompts from workspace skills
// Reads SKILL.md + CLAUDE.md, combines into a system prompt with tool catalog

const fs = require('fs');
const path = require('path');
const { TOOL_SCHEMAS } = require('./tools');

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
  const skillExists = fs.existsSync(skillPath);
  if (!skillExists) {
    throw new Error(`Skill not found: ${skillPath}`);
  }
  const skillContent = fs.readFileSync(skillPath, 'utf8');

  let claudeMd = '';
  const claudeMdPath = path.join(cwd, 'CLAUDE.md');
  if (fs.existsSync(claudeMdPath)) {
    claudeMd = fs.readFileSync(claudeMdPath, 'utf8');
  }

  return assemblePreamble(cwd, date) + '\n\n' + buildToolCatalog() + '\n\n' + claudeMd + '\n\n---\n\n' + skillContent;
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

  return assemblePreamble(cwd, date) + '\n\n' + buildToolCatalog() + '\n\n' + systemText;
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

/**
 * Build a dynamic tool catalog from TOOL_SCHEMAS, grouped by category.
 */
function buildToolCatalog() {
  const categories = {
    'File Tools': ['Read', 'Write', 'Edit', 'Glob', 'Grep'],
    'Bible Translation Data': ['get_verse_data', 'get_existing_notes', 'get_template'],
    'Agent & Team Tools': ['TeamCreate', 'TeamDelete', 'Agent', 'SendMessage', 'TaskCreate', 'TaskGet'],
  };

  // Build known set for categorization
  const categorized = new Set();
  for (const names of Object.values(categories)) {
    for (const n of names) categorized.add(n);
  }

  // Collect workspace tools (everything not in a known category, excluding MCP-prefixed duplicates)
  const workspaceTools = [];
  for (const schema of TOOL_SCHEMAS) {
    if (!categorized.has(schema.name) && !schema.name.startsWith('mcp__')) {
      workspaceTools.push(schema);
    }
  }
  if (workspaceTools.length > 0) {
    categories['Workspace Tools'] = workspaceTools.map(s => s.name);
  }

  // Build the catalog text
  const lines = ['# Available Tools', '', 'You have access to these tools. Use them proactively — don\'t guess at data you can look up.'];

  for (const [category, toolNames] of Object.entries(categories)) {
    lines.push('', `## ${category}`);
    for (const toolName of toolNames) {
      const schema = TOOL_SCHEMAS.find(s => s.name === toolName);
      if (schema) {
        lines.push(`- **${schema.name}** — ${schema.description}`);
      }
    }
  }

  // Static workflow guidance
  lines.push('', '## Working Style');
  lines.push('- Before writing content, ALWAYS fetch the source data first (get_verse_data for ULT, UST, alignment)');
  lines.push('- Before using an issue type, validate it with get_template');
  lines.push('- When encountering unfamiliar Hebrew, look it up via build_strongs_index');
  lines.push('- Use Grep/Glob to explore workspace files before assuming structure');
  lines.push('- For multi-step work, use Agent to delegate sub-tasks to specialists');
  lines.push('- Each Agent can use a different provider/model — pick the best fit for the task');

  return lines.join('\n');
}

module.exports = { buildSkillPrompt, buildCustomPrompt, buildToolCatalog };
