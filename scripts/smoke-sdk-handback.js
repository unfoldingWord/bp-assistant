#!/usr/bin/env node
// Live smoke test for an Agent SDK bump (#407): one cheap sub-agent spawn under
// the runner's real options, in auto mode (canUseTool = decideToolPermission) and
// in bypass mode. Checks that the parent receives the child's answer (the
// SubagentHandback path), which model `opus` resolves to, and any permission
// denials. Costs a few cents. Usage: node scripts/smoke-sdk-handback.js [auto|bypass|both]
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildOptions } = require('../src/claude-runner');

const TOKEN = 'PINEAPPLE-42';
const PROMPT = `Use the Agent tool exactly once to spawn a sub-agent (subagent_type "general-purpose", model "haiku") whose only task is to reply with the single word ${TOKEN}. When it returns, reply with exactly the text the sub-agent returned and nothing else.`;

async function runMode(mode) {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const cwd = fs.mkdtempSync(path.join(process.env.SMOKE_TMP || os.tmpdir(), 'sdk-smoke-'));
  const options = buildOptions({
    cwd, model: 'opus', thinking: 'low', maxTurns: 8, timeoutMs: 5 * 60 * 1000,
    bypassPermissions: mode === 'bypass',
  });
  const out = { mode, initModel: null, toolUses: [], denials: [], resultText: null, subtype: null, costUsd: null };
  for await (const msg of query({ prompt: PROMPT, options })) {
    if (msg.type === 'system' && msg.subtype === 'init') out.initModel = msg.model;
    if (msg.type === 'assistant') {
      for (const b of msg.message?.content || []) if (b.type === 'tool_use') out.toolUses.push(b.name);
    }
    if (msg.type === 'result') {
      out.subtype = msg.subtype;
      out.resultText = msg.result ?? null;
      out.denials = (msg.permission_denials || []).map((d) => d.tool_name);
      out.costUsd = msg.total_cost_usd ?? null;
    }
  }
  out.pass = Boolean(out.resultText && out.resultText.includes(TOKEN)) && !out.denials.includes('SubagentHandback');
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
