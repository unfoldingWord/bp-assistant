#!/usr/bin/env node
// Live smoke test for Agent SDK / model changes (#407): one cheap sub-agent spawn
// under the runner's real options, in auto mode (canUseTool = decideToolPermission)
// and in bypass mode. The child reads a nonce from a file only its own prompt
// names, so the parent can only report it if the child's result really came back.
// Passes when: exactly one spawn, the parent never read the file, its final answer
// carries the nonce, and the init message reports EXPECT_MODEL (default claude-opus-5-5).
// Costs a few cents. Usage:
//   node scripts/smoke-sdk-handback.js [auto|bypass|both]
// Env: RUNNER_DIR (repo root to load src/claude-runner from; default this repo),
//      EXPECT_MODEL, SMOKE_TMP (scratch dir root).
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RUNNER_DIR = process.env.RUNNER_DIR || path.join(__dirname, '..');
const { buildOptions } = require(path.join(RUNNER_DIR, 'src/claude-runner'));
const EXPECT_MODEL = process.env.EXPECT_MODEL || 'claude-opus-5-5';

// The Agent tool_result shape varies by CLI version (plain string, text blocks,
// or nested report blocks), so search the whole serialized content.
function blockText(content) {
  return typeof content === 'string' ? content : JSON.stringify(content ?? '');
}

async function runMode(mode) {
  const { query } = await import(require.resolve('@anthropic-ai/claude-agent-sdk', { paths: [RUNNER_DIR] }));
  const cwd = fs.mkdtempSync(path.join(process.env.SMOKE_TMP || os.tmpdir(), 'sdk-smoke-'));
  const nonce = `NONCE-${crypto.randomBytes(6).toString('hex')}`;
  fs.writeFileSync(path.join(cwd, 'secret.txt'), `${nonce}\n`);
  const prompt = [
    'Use the Agent tool exactly once, in the foreground, to spawn a sub-agent',
    '(subagent_type "general-purpose", model "haiku") with this task:',
    '"Read the file secret.txt in the current directory and reply with its contents only."',
    'Do not read secret.txt yourself. When the sub-agent returns, reply with exactly',
    'the text it returned and nothing else.',
  ].join(' ');
  const options = buildOptions({
    cwd, model: 'opus', thinking: 'low', maxTurns: 10, timeoutMs: 5 * 60 * 1000,
    bypassPermissions: mode === 'bypass', foregroundSubagents: true,
  });
  const out = { mode, initModel: null, agentCalls: 0, agentResultHasNonce: false, parentReadSecret: false,
    toolUses: [], denials: [], resultText: null, subtype: null, costUsd: null, nonceSeenIn: [] };
  const agentIds = new Set();
  for await (const msg of query({ prompt, options })) {
    if (JSON.stringify(msg).includes(nonce)) {
      out.nonceSeenIn.push([msg.type, msg.subtype, msg.parent_tool_use_id ? 'child' : 'parent'].filter(Boolean).join(':'));
    }
    if (msg.type === 'system' && msg.subtype === 'init') out.initModel = msg.model;
    if (msg.type === 'assistant' && !msg.parent_tool_use_id) {
      for (const b of msg.message?.content || []) {
        if (b.type !== 'tool_use') continue;
        out.toolUses.push(b.name);
        if (b.name === 'Agent' || b.name === 'Task') { out.agentCalls += 1; agentIds.add(b.id); }
        if (JSON.stringify(b.input || {}).includes('secret.txt') && b.name === 'Read') out.parentReadSecret = true;
      }
    }
    if (msg.type === 'user' && !msg.parent_tool_use_id) {
      for (const b of msg.message?.content || []) {
        if (b.type === 'tool_result' && agentIds.has(b.tool_use_id) && blockText(b.content).includes(nonce)) {
          out.agentResultHasNonce = true;
        }
      }
    }
    if (msg.type === 'result') {
      out.subtype = msg.subtype;
      out.resultText = msg.result ?? null;
      out.denials = (msg.permission_denials || []).map((d) => d.tool_name);
      out.costUsd = msg.total_cost_usd ?? null;
    }
  }
  // In auto mode the child reports through SubagentHandback, and its text reaches
  // the parent without a parent-side Agent tool_result carrying it, so
  // agentResultHasNonce is informational. The parent never reads secret.txt, so
  // a nonce in its answer can only have come from the child.
  out.pass = out.agentCalls === 1 && !out.parentReadSecret
    && Boolean(out.resultText && out.resultText.includes(nonce))
    && out.initModel === EXPECT_MODEL;
  fs.rmSync(cwd, { recursive: true, force: true });
  return out;
}

(async () => {
  const arg = process.argv[2] || 'both';
  const modes = arg === 'both' ? ['auto', 'bypass'] : [arg];
  let ok = true;
  for (const m of modes) {
    const r = await runMode(m);
    console.log(JSON.stringify(r));
    ok = ok && r.pass;
  }
  process.exit(ok ? 0 : 1);
})().catch((err) => { console.error(err); process.exit(2); });
