// agent-tools.js — Tool schemas and executors for multi-agent team operations
// These are registered alongside file/workspace tools in tools.js

const teamManager = require('./team-manager');

// ---------------------------------------------------------------------------
// Tool schemas
// ---------------------------------------------------------------------------

const AGENT_TOOL_SCHEMAS = [
  {
    name: 'TeamCreate',
    description: 'Create a named team for coordinating multiple agents. Agents in a team persist and can be messaged.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Unique team name (e.g. "pipeline-HAB-03")' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'TeamDelete',
    description: 'Delete a team and all its agent states. Use when work is complete.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Team name to delete' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'Agent',
    description: 'Spawn a sub-agent with its own provider, model, and system prompt. Runs to completion and returns its final text. If team_name is set, the agent persists and can be messaged later via SendMessage.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Agent name (unique within team)' },
        prompt: { type: 'string', description: 'The task/message to send to the agent' },
        system: { type: 'string', description: 'Custom system prompt for this agent' },
        provider: { type: 'string', description: 'Provider: claude, openai, gemini, xai, groq, deepseek, mistral' },
        model: { type: 'string', description: 'Model ID or alias (e.g. "opus", "gpt-5.4", "gemini-3.1-pro-preview")' },
        thinking: { type: 'string', description: 'Thinking level: low, medium, high, max' },
        team_name: { type: 'string', description: 'Team to register this agent in (optional — enables SendMessage)' },
      },
      required: ['name', 'prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'SendMessage',
    description: 'Send a follow-up message to a named agent within a team. The agent resumes its conversation with full context.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Agent name to message' },
        team_name: { type: 'string', description: 'Team the agent belongs to' },
        message: { type: 'string', description: 'Message to send' },
      },
      required: ['to', 'team_name', 'message'],
      additionalProperties: false,
    },
  },
  {
    name: 'TaskCreate',
    description: 'Fire-and-forget async agent task. Returns a task ID for polling with TaskGet.',
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'Short description of the task' },
        prompt: { type: 'string', description: 'The task prompt/message' },
        system: { type: 'string', description: 'Custom system prompt' },
        provider: { type: 'string', description: 'Provider name' },
        model: { type: 'string', description: 'Model ID or alias' },
      },
      required: ['description', 'prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'TaskGet',
    description: 'Poll the status of an async task. Returns {status, result} where status is "running", "completed", or "failed".',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task ID returned by TaskCreate' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------------------
// Executor — called from tools.js executeTool()
// ---------------------------------------------------------------------------

/**
 * Execute an agent/team tool.
 *
 * @param {string} name - Tool name
 * @param {Object} params - Tool parameters
 * @param {Object} context - { parentOpts, runAgentLoopFn }
 * @returns {Promise<string>} Tool result
 */
async function executeAgentTool(name, params, context) {
  const { parentOpts, runAgentLoopFn } = context;

  switch (name) {
    case 'TeamCreate': {
      const result = teamManager.createTeam(params.name);
      return result.ok ? result.message : `Error: ${result.error}`;
    }

    case 'TeamDelete': {
      const result = teamManager.deleteTeam(params.name);
      return result.ok ? result.message : `Error: ${result.error}`;
    }

    case 'Agent': {
      return teamManager.spawnAgent({
        name: params.name,
        prompt: params.prompt,
        system: params.system,
        provider: params.provider,
        model: params.model,
        thinking: params.thinking,
        teamName: params.team_name,
        depth: parentOpts.depth || 0,
      }, parentOpts, runAgentLoopFn);
    }

    case 'SendMessage': {
      return teamManager.sendMessageToAgent({
        to: params.to,
        teamName: params.team_name,
        message: params.message,
      }, parentOpts, runAgentLoopFn);
    }

    case 'TaskCreate': {
      const result = teamManager.createTask({
        prompt: params.prompt,
        system: params.system,
        provider: params.provider,
        model: params.model,
        depth: parentOpts.depth || 0,
      }, parentOpts, runAgentLoopFn);
      return JSON.stringify(result);
    }

    case 'TaskGet': {
      const result = teamManager.getTask(params.id);
      return JSON.stringify(result);
    }

    default:
      return `Error: Unknown agent tool "${name}"`;
  }
}

/**
 * Check if a tool name is an agent tool.
 */
function isAgentTool(name) {
  return AGENT_TOOL_SCHEMAS.some(s => s.name === name);
}

module.exports = {
  AGENT_TOOL_SCHEMAS,
  executeAgentTool,
  isAgentTool,
};
