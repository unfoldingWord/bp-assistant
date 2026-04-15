// team-manager.js — Multi-agent team management
// Manages named teams of agents, each with their own provider/model/conversation state.

const MAX_DEPTH = 3;
const { isConfiguredModel, resolveProviderModel } = require('./provider-config');

// Global state
const teams = new Map();   // teamName → Team
const tasks = new Map();   // taskId → { status, result, promise }

/**
 * @typedef {Object} AgentState
 * @property {string} name
 * @property {string} systemPrompt
 * @property {string} provider
 * @property {string} model
 * @property {string} thinking
 * @property {Array} messages - Conversation history
 * @property {'idle'|'running'|'completed'} status
 * @property {string} lastResult - Last text output
 */

/**
 * @typedef {Object} Team
 * @property {string} name
 * @property {Map<string, AgentState>} agents
 * @property {number} createdAt
 */

// ---------------------------------------------------------------------------
// Team lifecycle
// ---------------------------------------------------------------------------

function createTeam(name) {
  if (teams.has(name)) {
    return { ok: false, error: `Team "${name}" already exists` };
  }
  teams.set(name, { name, agents: new Map(), createdAt: Date.now() });
  return { ok: true, message: `Team "${name}" created` };
}

function deleteTeam(name) {
  if (!teams.has(name)) {
    return { ok: false, error: `Team "${name}" not found` };
  }
  teams.delete(name);
  return { ok: true, message: `Team "${name}" deleted` };
}

function getTeam(name) {
  return teams.get(name) || null;
}

// ---------------------------------------------------------------------------
// Agent spawning
// ---------------------------------------------------------------------------

/**
 * Spawn a new agent and run it to completion.
 *
 * @param {Object} opts
 * @param {string} opts.name - Agent name
 * @param {string} opts.prompt - User message to start the agent
 * @param {string} [opts.system] - Custom system prompt (default: inherited)
 * @param {string} [opts.provider] - Provider name
 * @param {string} [opts.model] - Model ID
 * @param {string} [opts.thinking] - Thinking level
 * @param {string} [opts.teamName] - Team to register in
 * @param {number} [opts.depth=0] - Current nesting depth
 * @param {Object} parentOpts - Parent agent's options (for defaults)
 * @param {Function} runAgentLoopFn - Reference to runAgentLoop (avoids circular dep)
 * @returns {Promise<string>} Agent's final text output
 */
async function spawnAgent(opts, parentOpts, runAgentLoopFn) {
  const depth = (opts.depth || 0);
  if (depth >= MAX_DEPTH) {
    return `Error: Maximum agent nesting depth (${MAX_DEPTH}) reached. Cannot spawn "${opts.name}".`;
  }

  const provider = resolveAgentProvider(opts, parentOpts);
  const requestedModel = opts.model || (provider === parentOpts.provider ? parentOpts.model : undefined);
  const model = normalizeAgentModel(provider, requestedModel);
  const thinking = opts.thinking || parentOpts.thinking || 'medium';
  const cwd = parentOpts.cwd || '/srv/bot/workspace';
  const apiKey = parentOpts.apiKeyResolver ? parentOpts.apiKeyResolver(provider) : parentOpts.apiKey;

  // Build system prompt for the sub-agent
  const system = opts.system || `You are "${opts.name}", a specialist sub-agent. Complete your assigned task thoroughly and return your final answer as text.`;

  console.log(`[team-manager] Spawning agent "${opts.name}" (provider: ${provider}, model: ${model || 'default'}, depth: ${depth})`);

  // Register in team if specified
  let agentState;
  if (opts.teamName) {
    let team = teams.get(opts.teamName);
    if (!team) {
      // Auto-create team
      teams.set(opts.teamName, { name: opts.teamName, agents: new Map(), createdAt: Date.now() });
      team = teams.get(opts.teamName);
    }
    agentState = {
      name: opts.name,
      systemPrompt: system,
      provider,
      model,
      thinking,
      messages: [],
      status: 'running',
      lastResult: '',
    };
    team.agents.set(opts.name, agentState);
  }

  try {
    const result = await runAgentLoopFn({
      provider,
      model,
      system,
      userMessage: opts.prompt,
      maxTurns: opts.maxTurns || 50,
      timeoutMs: (opts.timeout || 15) * 60 * 1000,
      cwd,
      verbose: parentOpts.verbose || false,
      thinking,
      apiKey,
      depth: depth + 1,
      lockProvider: !!parentOpts.lockProvider,
    });

    const finalText = result.finalText || '(no output)';

    // Update agent state in team
    if (agentState) {
      agentState.status = 'completed';
      agentState.lastResult = finalText;
      agentState.messages = result._messages || [];
    }

    console.log(`[team-manager] Agent "${opts.name}" completed — ${result.turns} turns, $${result.cost.toFixed(4)}`);
    return finalText;
  } catch (err) {
    if (agentState) {
      agentState.status = 'idle';
      agentState.lastResult = `Error: ${err.message}`;
    }
    return `Error running agent "${opts.name}": ${err.message}`;
  }
}

// ---------------------------------------------------------------------------
// Send message to existing agent
// ---------------------------------------------------------------------------

/**
 * Send a follow-up message to a named agent within a team.
 *
 * @param {Object} opts
 * @param {string} opts.to - Agent name
 * @param {string} opts.teamName - Team name
 * @param {string} opts.message - Message to send
 * @param {Object} parentOpts - Parent agent's options
 * @param {Function} runAgentLoopFn - Reference to runAgentLoop
 * @returns {Promise<string>} Agent's response
 */
async function sendMessageToAgent(opts, parentOpts, runAgentLoopFn) {
  const team = teams.get(opts.teamName);
  if (!team) {
    return `Error: Team "${opts.teamName}" not found`;
  }

  const agent = team.agents.get(opts.to);
  if (!agent) {
    return `Error: Agent "${opts.to}" not found in team "${opts.teamName}"`;
  }

  console.log(`[team-manager] Sending message to "${opts.to}" in team "${opts.teamName}"`);

  agent.status = 'running';
  const apiKey = parentOpts.apiKeyResolver ? parentOpts.apiKeyResolver(agent.provider) : parentOpts.apiKey;

  try {
    const result = await runAgentLoopFn({
      provider: agent.provider,
      model: normalizeAgentModel(agent.provider, agent.model),
      system: agent.systemPrompt,
      userMessage: opts.message,
      existingMessages: agent.messages,
      maxTurns: 50,
      timeoutMs: 15 * 60 * 1000,
      cwd: parentOpts.cwd || '/srv/bot/workspace',
      verbose: parentOpts.verbose || false,
      thinking: agent.thinking,
      apiKey,
      depth: (parentOpts.depth || 0) + 1,
      lockProvider: !!parentOpts.lockProvider,
    });

    agent.status = 'completed';
    agent.lastResult = result.finalText || '(no output)';
    agent.messages = result._messages || [];

    console.log(`[team-manager] Agent "${opts.to}" responded — ${result.turns} turns, $${result.cost.toFixed(4)}`);
    return agent.lastResult;
  } catch (err) {
    agent.status = 'idle';
    agent.lastResult = `Error: ${err.message}`;
    return `Error from agent "${opts.to}": ${err.message}`;
  }
}

// ---------------------------------------------------------------------------
// Async tasks (fire-and-forget)
// ---------------------------------------------------------------------------

function createTask(opts, parentOpts, runAgentLoopFn) {
  const id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const entry = { status: 'running', result: null };

  const promise = spawnAgent({
    name: `task-${id}`,
    prompt: opts.prompt,
    system: opts.system,
    provider: opts.provider,
    model: opts.model,
    thinking: opts.thinking,
    depth: opts.depth || 0,
  }, parentOpts, runAgentLoopFn);

  promise.then(result => {
    entry.status = 'completed';
    entry.result = result;
  }).catch(err => {
    entry.status = 'failed';
    entry.result = `Error: ${err.message}`;
  });

  entry.promise = promise;
  tasks.set(id, entry);

  return { id, status: 'running' };
}

function getTask(id) {
  const entry = tasks.get(id);
  if (!entry) {
    return { error: `Task "${id}" not found` };
  }
  return { id, status: entry.status, result: entry.result };
}

function normalizeAgentModel(provider, requestedModel) {
  if (!requestedModel) return undefined;
  const resolved = resolveProviderModel(provider, requestedModel);
  if (isConfiguredModel(provider, resolved)) {
    return resolved;
  }
  return undefined;
}

function resolveAgentProvider(opts, parentOpts) {
  if (parentOpts?.lockProvider && parentOpts?.provider) {
    return parentOpts.provider;
  }
  return opts.provider || parentOpts.provider || 'gemini';
}

module.exports = {
  createTeam,
  deleteTeam,
  getTeam,
  spawnAgent,
  sendMessageToAgent,
  createTask,
  getTask,
  MAX_DEPTH,
  normalizeAgentModel,
  resolveAgentProvider,
};
