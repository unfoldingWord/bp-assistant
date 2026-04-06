// claude-config-init.js — auto-repair .claude.json on every container start
// Ensures /workspace is trusted and all needed tools are allowed.
// Safe to run on every startup; idempotent.

const fs = require('fs');

const CLAUDE_JSON_PATH = '/claude-config/.claude.json';
const NEEDED_TOOLS = [
  'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'Task', 'TaskOutput', 'Skill', 'SendMessage',
  'Agent', 'TeamCreate', 'TeamDelete',
  'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet',
  'NotebookEdit', 'WebFetch', 'WebSearch',
];

function ensureClaudeConfig() {
  try {
    let data = {};
    if (fs.existsSync(CLAUDE_JSON_PATH)) {
      data = JSON.parse(fs.readFileSync(CLAUDE_JSON_PATH, 'utf8'));
    }
    if (!data.projects) data.projects = {};
    const ws = data.projects['/workspace'] || {};
    let changed = false;
    if (!ws.hasTrustDialogAccepted) {
      ws.hasTrustDialogAccepted = true;
      changed = true;
    }
    if (!ws.allowedTools || ws.allowedTools.length === 0) {
      ws.allowedTools = NEEDED_TOOLS;
      changed = true;
    }
    if (changed) {
      data.projects['/workspace'] = ws;
      fs.writeFileSync(CLAUDE_JSON_PATH, JSON.stringify(data, null, 2));
      console.log('[startup] Updated .claude.json: trusted /workspace, set allowedTools');
    } else {
      console.log('[startup] .claude.json already configured for /workspace');
    }
  } catch (err) {
    console.warn('[startup] Could not update .claude.json:', err.message);
  }
}

module.exports = { ensureClaudeConfig };
