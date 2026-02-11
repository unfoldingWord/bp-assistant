# Replace CLI subprocess with Agent SDK

## Context

The bot currently runs `claude -p "/initial-pipeline --lite PSA 79"` as a shell subprocess from `generate.sh`. This uses `-p` (piped/one-shot) mode which breaks the team-based coordination in `initial-pipeline` -- the orchestrator can't receive SendMessage responses from teammates, so the pipeline stalls after ULT generation.

The TypeScript Agent SDK (`@anthropic-ai/claude-agent-sdk`) provides the full Claude Code agent loop programmatically. It runs as an async generator that naturally completes when the task finishes -- no TTY, no hanging, teams work.

## What Changes

### 1. Install the SDK

```bash
npm install @anthropic-ai/claude-agent-sdk
```

### 2. New module: `src/claude-runner.js`

Wraps the Agent SDK `query()` call. Replaces what `generate.sh` does with `claude -p`.

```javascript
const { query } = require('@anthropic-ai/claude-agent-sdk');

async function runPipeline({ skill, book, chapter, model }) {
  const prompt = `/${skill} ${book} ${chapter}`;

  const conversation = query({
    prompt,
    options: {
      cwd: '/home/bmw/Documents/dev/cSkillBP',
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      tools: { type: 'preset', preset: 'claude_code' },
      settingSources: ['user', 'project', 'local'],
      allowedTools: [
        'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash',
        'Task', 'Skill', 'SendMessage', 'WebFetch',
        'TeamCreate', 'TeamDelete',
        'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet',
      ],
      model: model || undefined,
      sandbox: {
        enabled: true,
        autoAllowBashIfSandboxed: true,
      },
    },
  });

  let result = null;
  for await (const message of conversation) {
    if (message.type === 'result') {
      result = message;
    }
  }

  return result; // { result, total_cost_usd, duration_ms, is_error, ... }
}

module.exports = { runPipeline };
```

### 3. New pipeline: `src/generate-pipeline.js`

Move the loop/posting logic from `generate.sh` into Node.js so it can call `runPipeline()` directly. This file handles:

- Parsing book + chapter range from the message (reuse regex from config.json route)
- Looping through chapters
- Calling `runPipeline()` for each chapter
- Reading output files (`output/AI-ULT/*.usfm`, `output/AI-UST/*.usfm`)
- Posting results back to Zulip via `zulip-client.js`
- Error handling and status DMs to admin

### 4. Update `pipeline-runner.js`

Add a second execution path. If a route has `"type": "sdk"` (or similar), call the Node.js pipeline instead of spawning a shell script.

```javascript
// In pipeline-runner.js
if (route.type === 'sdk') {
  const { generatePipeline } = require('./generate-pipeline');
  await generatePipeline(route, messageContext, zulipClient);
} else {
  // existing shell script spawn
  spawnShellPipeline(route.pipeline, env);
}
```

### 5. Update `config.json`

Change the generate-content route to use the SDK path:

```json
{
  "name": "generate-content",
  "match": "/generate\\s+(\\w+)\\s+(\\d+)(?:\\s*[-–—to]+\\s*(\\d+))?/i",
  "type": "sdk",
  "skill": "initial-pipeline --lite",
  "reply": false
}
```

### 6. What stays the same

- `index.js` -- event loop, message polling, filtering (unchanged)
- `router.js` -- pattern matching (unchanged)
- `zulip-client.js` -- API wrapper (unchanged, used by new pipeline)
- `zulip-helpers.sh` -- still available for any remaining shell pipelines
- `config.json` structure -- just add `type` field to SDK routes
- Other routes (proofread-complete) -- keep as shell scripts

## Files to create/modify

| File | Action | Purpose |
|------|--------|---------|
| `src/claude-runner.js` | Create | SDK wrapper for `query()` |
| `src/generate-pipeline.js` | Create | Chapter loop + Zulip posting (replaces generate.sh logic) |
| `src/pipeline-runner.js` | Modify | Add SDK execution path alongside shell scripts |
| `config.json` | Modify | Add `type: "sdk"` to generate-content route |
| `package.json` | Modify | Add `@anthropic-ai/claude-agent-sdk` dependency |

## What this fixes

- **Team coordination works**: Full agent loop means SendMessage/TeamCreate function properly
- **No TTY needed**: SDK is pure programmatic API
- **Auto-exits when done**: Async generator completes naturally
- **No `-p` mode limitations**: Skills, teams, multi-turn coordination all work
- **Uses existing auth**: SDK spawns Claude Code subprocess, inherits login session
- **Cost tracking**: `result.total_cost_usd` available for logging/budgeting

## Verification

1. `npm install` in zulip-bot
2. Test with a single chapter: send "generate psa 117" to the bot
3. Confirm the full pipeline completes (ULT + issues + UST)
4. Confirm output files appear in cSkillBP/output/
5. Confirm results posted back to Zulip
6. Test chapter range: "generate psa 117-118"
