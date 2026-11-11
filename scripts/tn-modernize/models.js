// models.js — the three model calls tn-modernize makes, none with tools:
//   claude(...)  one Agent SDK query (tools: [], one turn) on the logged-in
//                account of CLAUDE_CONFIG_DIR, like the issue rules gate
//   jev(...)     TypeSafe's typed-decision endpoint (yes/no questions in,
//                probabilities out), for the claim check
//   parseJson()  the first JSON object in a model reply
//
// Budget guard: before each Claude call, read the statusline's per-account
// usage file (~/.claude/rate-limits.<uuid8>.json) and stop at --stop-pct of
// the weekly limit. Keep an interactive Claude session open on that account
// so the file stays fresh.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

let _sdk = null;
async function sdk() {
  if (!_sdk) {
    const entry = path.join(__dirname, '../../node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs');
    _sdk = await import(pathToFileURL(entry).href);
  }
  return _sdk;
}

function makeGuard({ limitsFile, stopPct }) {
  if (!limitsFile) return async () => ({ ok: true, used: null });
  const read = () => {
    const j = JSON.parse(fs.readFileSync(limitsFile, 'utf8'));
    const w = j.rate_limits && j.rate_limits.seven_day;
    if (!w || typeof w.used_percentage !== 'number') throw new Error('no seven_day used_percentage');
    return { used: w.used_percentage, ageS: Math.round(Date.now() / 1000 - j.captured_at_epoch) };
  };
  return async () => {
    let u;
    for (let i = 0; ; i++) {
      try { u = read(); if (u.ageS < 1800) break; } catch (e) { u = { err: e.message }; }
      if (i >= 10) throw new Error(`budget guard: usage file stale or unreadable (${JSON.stringify(u)}); keep a Claude session open on this account`);
      await new Promise((r) => setTimeout(r, 60000));
    }
    if (u.used >= stopPct) throw new Error(`budget guard: weekly usage ${u.used}% >= ${stopPct}%`);
    return { ok: true, used: u.used };
  };
}

/**
 * One tools-free Claude turn. Returns { text, usage, costUsd, ms, subtype }.
 * The SDK's own login (CLAUDE_CONFIG_DIR) is used: API keys are stripped from
 * the child env so a stray key never bills a different account.
 */
async function claude({ model, system, prompt, effort = 'medium', timeoutMs = 10 * 60 * 1000, guard }) {
  if (guard) await guard();
  const { query } = await sdk();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-modernize-'));
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const options = {
    cwd, abortController: ac, model, systemPrompt: system, env,
    tools: [], allowedTools: [], mcpServers: {}, strictMcpConfig: true, settingSources: [],
    maxTurns: 1, persistSession: false, thinking: { type: 'adaptive' }, effort,
  };
  const t0 = Date.now();
  let final = null;
  try {
    for await (const m of query({ prompt, options })) if (m.type === 'result') final = m;
  } finally {
    clearTimeout(timer);
    fs.rmSync(cwd, { recursive: true, force: true });
  }
  if (!final) throw new Error('sdk: no result message');
  return { text: final.result || '', usage: final.usage || null, costUsd: final.total_cost_usd ?? null, ms: Date.now() - t0, subtype: final.subtype };
}

/** First JSON object in a reply, ignoring code fences or stray text around it. */
function parseJson(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('no JSON object in reply');
  return JSON.parse(s.slice(start, end + 1));
}

// ---------------------------------------------------------------------------
// jev — https://api.typesafe.ai/v1/systemone (wire format verified 2026-10-16
// in ~/repos/JevBP-QA: body {model, state, questions}; a noul answer is a
// probability, either bare or as {noul: p}).
// ---------------------------------------------------------------------------

const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
const JEV_USD_PER_INPUT_TOKEN = 0.042 / 1e6; // typesafe.ai pricing, Oct 2026; output is free

function keyFromEnv(...names) {
  for (const n of names) if (process.env[n]) return process.env[n];
  const file = path.join(os.homedir(), '.config/ai-keys.env');
  if (fs.existsSync(file)) {
    const vals = {};
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.replace(/^export\s+/, '').match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) vals[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
    }
    for (const n of names) if (vals[n]) return vals[n];
  }
  return null;
}

async function jev({ state, questions, model = 'jev-latest', tries = 4 }) {
  const key = keyFromEnv('TYPESAFE_API_KEY_TN_MODERNIZE', 'TYPESAFE_API_KEY');
  if (!key) throw new Error('jev: set TYPESAFE_API_KEY_TN_MODERNIZE (or TYPESAFE_API_KEY) in the environment or ~/.config/ai-keys.env');
  const t0 = Date.now();
  for (let i = 0; ; i++) {
    const res = await fetch(JEV_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, state, questions }),
    });
    if (res.ok) {
      const r = await res.json();
      const p = {};
      for (const [name, a] of Object.entries(r.answers || {})) p[name] = typeof a === 'number' ? a : Number(a && a.noul);
      const tokens = r.usage && r.usage.input_tokens;
      return { p, model: r.model, inputTokens: tokens ?? null, costUsd: tokens ? tokens * JEV_USD_PER_INPUT_TOKEN : null, ms: Date.now() - t0 };
    }
    if ([429, 500, 502, 503, 504].includes(res.status) && i < tries - 1) {
      await new Promise((r) => setTimeout(r, 2000 * 2 ** i));
      continue;
    }
    throw new Error(`jev: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
}

module.exports = { claude, jev, parseJson, makeGuard };
