// claude-runner.js — SDK wrapper for Claude Agent SDK query()
// Replaces `claude -p` subprocess calls with programmatic SDK usage

let _query = null;

async function getQuery() {
  if (!_query) {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    _query = sdk.query;
  }
  return _query;
}

// Default: 10 minutes per invocation, 200 turns max
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_TURNS = 200;

async function runClaude({ prompt, cwd, model, allowedTools, skill, maxTurns, timeoutMs }) {
  const query = await getQuery();

  const fullPrompt = skill ? `/${skill} ${prompt}` : prompt;

  const abortController = new AbortController();
  const timeout = timeoutMs || DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => {
    console.warn(`[claude-runner] Timeout reached (${timeout / 1000}s) — aborting query`);
    abortController.abort();
  }, timeout);

  const options = {
    cwd,
    abortController,
    maxTurns: maxTurns || DEFAULT_MAX_TURNS,
    allowedTools: allowedTools || [
      'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash',
      'Task', 'Skill', 'SendMessage',
    ],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    settingSources: ['user', 'project', 'local'],
  };

  if (model) {
    options.model = model;
  }

  console.log(`[claude-runner] Starting query in ${cwd}`);
  console.log(`[claude-runner] Prompt: ${fullPrompt.slice(0, 200)}`);
  console.log(`[claude-runner] maxTurns: ${options.maxTurns}, timeout: ${timeout / 1000}s`);

  const conversation = query({ prompt: fullPrompt, options });

  let result = null;

  try {
    for await (const message of conversation) {
      if (message.type === 'assistant' && message.message?.content) {
        for (const block of message.message.content) {
          if ('text' in block) {
            console.log(`[claude] ${block.text.slice(0, 200)}`);
          } else if ('name' in block) {
            console.log(`[claude] Tool: ${block.name}`);
          }
        }
      } else if (message.type === 'result') {
        result = message;
      }
    }
  } catch (err) {
    if (err.name === 'AbortError' || abortController.signal.aborted) {
      console.warn(`[claude-runner] Query aborted (timeout or manual abort)`);
    } else {
      throw err;
    }
  } finally {
    clearTimeout(timer);
    // Ensure the query is cleaned up even if the loop didn't finish naturally
    try { conversation.close(); } catch (_) {}
  }

  if (result) {
    console.log(`[claude-runner] Finished — subtype: ${result.subtype}, turns: ${result.num_turns}, cost: $${result.total_cost_usd?.toFixed(4) || '?'}, duration: ${(result.duration_ms / 1000).toFixed(1)}s`);
  } else {
    console.warn(`[claude-runner] Query ended without a result message (timeout or abort)`);
  }

  return result;
}

module.exports = { runClaude };
