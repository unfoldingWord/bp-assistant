#!/usr/bin/env node
'use strict';
// Benchmark the issue rules gate (src/issue-rules-gate.js) against what editors
// actually did to each AI issue row (ledger-<BOOK>.jsonl).
//
//   node scripts/issue-bench/gate-bench.js --models a/b,c/d --chapters EZK-01,JER-23 \
//     --rules-root <dir> --label v1 [--allow-add] [--concurrency 3]
//
// The parent process fetches sources, spawns one child per model (the gate reads
// CSKILLBP_DIR at require time, so each model needs its own process), then scores
// the children's runs.json files and writes results + summary.md.
// `--score-only` re-scores existing runs.json files without calling any model.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const CODEX_TIMEOUT_MS = 20 * 60 * 1000;
const { slugOf, norm } = require('./lib');

// BENCH_STATE: the ledger/bench state dir (default ~/.local/state/routines/issue-id-accuracy).
// GATE_SRC: the src/ dir that holds issue-rules-gate.js (default: this repo's src/).
const S = process.env.BENCH_STATE || path.join(require('os').homedir(), '.local/state/routines/issue-id-accuracy');
const GATE_SRC = process.env.GATE_SRC || path.resolve(__dirname, '../../src');
const BOOK_NUM = { JER: '24', EZK: '26' };
const PROTECT = ['figs-parallelism', 'figs-activepassive'];
const RULE_FILES = [
  '.claude/skills/issue-identification/rules-gate.md',
  'data/quick-ref/issue_decisions.csv',
  'data/translation-issues.csv',
];
// USD per 1M tokens in/out, used only when OpenRouter returns no usage.cost.
const PRICES = {
  'anthropic/claude-opus-5.5': [4, 20],
  'anthropic/claude-fable-5.1': [10, 50],
  'openai/gpt-6-astra': [10, 50],
  'openai/gpt-6.1-sol': [2, 10],
};
const KEPT_KINDS = new Set(['kept', 'kept-reid', 'reworded', 'rescoped']);

const slugModel = (m) => m.replace(/[^A-Za-z0-9.]+/g, '-').replace(/^-|-$/g, '');

// Accepts a bare slug or a full rc://*/ta/man/translate/<slug> reference.
const isProtected = (sref) => PROTECT.includes(slugOf(sref).toLowerCase());

function parseArgs(argv) {
  const a = { sources: 'ai-time', concurrency: 3, allowAdd: false, child: false, scoreOnly: false, maxModelUsd: 30 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const val = () => argv[++i];
    if (k === '--models') a.models = val().split(',').map((s) => s.trim()).filter(Boolean);
    else if (k === '--model') a.model = val();
    else if (k === '--chapters') a.chapters = val().split(',').map((s) => s.trim()).filter(Boolean);
    else if (k === '--rules-root') a.rulesRoot = path.resolve(val());
    else if (k === '--label') a.label = val();
    else if (k === '--concurrency') a.concurrency = Math.max(1, Number(val()) || 1);
    else if (k === '--max-model-usd') {
      const v = val();
      a.maxModelUsd = v === undefined || String(v).trim() === '' ? NaN : Number(v);
      if (!Number.isFinite(a.maxModelUsd) || a.maxModelUsd < 0) throw new Error(`usage: --max-model-usd must be a non-negative number, got "${v}"`);
    }
    else if (k === '--sources') { a.sources = val(); if (!['ai-time', 'master'].includes(a.sources)) throw new Error('--sources must be ai-time|master'); }
    else if (k === '--allow-add') a.allowAdd = true;
    else if (k === '--child') a.child = true;
    else if (k === '--score-only') a.scoreOnly = true;
    else throw new Error(`unknown argument ${k}`);
  }
  return a;
}

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------- prepared / ledger

function loadPrepared(tag) {
  const d = JSON.parse(fs.readFileSync(path.join(S, 'bench/prepared', `${tag}.json`), 'utf8'));
  const items = d.items.filter((i) => !i.injected_see_how && !i.programmatic_note);
  return { book: d.book, chapter: Number(d.chapter), items };
}

const ledgerCache = {};
function loadLedger(book) {
  if (ledgerCache[book]) return ledgerCache[book];
  const recs = readJsonl(path.join(S, `out/ledger-${book}.jsonl`));
  const byId = new Map();
  const humanAdded = [];
  for (const r of recs) {
    if (r.kind === 'human-added') humanAdded.push(r);
    else byId.set(r.id, r);
  }
  return (ledgerCache[book] = { byId, humanAdded });
}

// ---------------------------------------------------------------- sources

async function fetchText(url) {
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    } catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 1500 * (i + 1))); }
  }
  throw lastErr;
}

async function ensureSource(repo, book) {
  const file = `${BOOK_NUM[book]}-${book}.usfm`;
  const flat = path.join(S, 'cache/texts', `${repo}-${file}`);
  if (fs.existsSync(flat)) return flat;
  const p = path.join(S, 'cache/texts', repo, 'raw', file);
  if (fs.existsSync(p)) return p;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const url = `https://git.door43.org/api/v1/repos/unfoldingWord/${repo}/raw/${file}?ref=master`;
  fs.writeFileSync(p, await fetchText(url));
  return p;
}

// ---------------------------------------------------------------- child: run the gate

function loadApiKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  const txt = fs.readFileSync(path.join(os.homedir(), '.config/ai-keys.env'), 'utf8');
  const m = txt.match(/^\s*(?:export\s+)?OPENROUTER_API_KEY\s*=\s*(.*)$/m);
  if (!m) throw new Error('OPENROUTER_API_KEY not found');
  return m[1].trim().replace(/^['"]|['"]$/g, '');
}

// Conservative USD per 1M tokens in/out for a model with no known price.
const FALLBACK_PRICE = [10, 50];
const warnedPrice = new Set();

function costOf(model, usage) {
  if (usage && typeof usage.cost === 'number') return { cost: usage.cost, computed: false };
  const p = PRICES[model] || FALLBACK_PRICE;
  if (!PRICES[model] && !warnedPrice.has(model)) {
    warnedPrice.add(model);
    console.warn(`[warn] no known price for ${model} and no usage.cost; charging fallback $${FALLBACK_PRICE[0]}/$${FALLBACK_PRICE[1]} per 1M in/out tokens`);
  }
  const inT = (usage && usage.prompt_tokens) || 0;
  const outT = (usage && usage.completion_tokens) || 0;
  return { cost: (inT * p[0] + outT * p[1]) / 1e6, computed: true, unknownPrice: !PRICES[model] };
}

function stripFence(t) {
  const s = String(t || '').trim();
  const m = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return m ? m[1].trim() : s;
}
function parsable(text) {
  const t = stripFence(text);
  const ok = (o) => Array.isArray(o) || (o && typeof o === 'object' && Array.isArray(o.verdicts));
  try { return ok(JSON.parse(t)); } catch (_) { /* fall through */ }
  const a = t.indexOf('{'); const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return ok(JSON.parse(t.slice(a, b + 1))); } catch (_) { /* no */ } }
  return false;
}

// First balanced {...} in text (string-aware), or null.
function firstBalancedObject(text) {
  const t = String(text || '');
  const start = t.indexOf('{');
  if (start < 0) return null;
  let depth = 0; let inStr = false; let esc = false;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return t.slice(start, i + 1);
  }
  return null;
}

function runCodex(model, systemPrompt, prompt) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-bench-codex-'));
  const cwd = path.join(dir, 'cwd');
  fs.mkdirSync(cwd);
  const inFile = path.join(dir, 'prompt.txt');
  const outFile = path.join(dir, 'out.txt');
  fs.writeFileSync(inFile, `SYSTEM INSTRUCTIONS:\n${systemPrompt}\n\nTASK:\n${prompt}`);
  return new Promise((resolve, reject) => {
    const fd = fs.openSync(inFile, 'r');
    const child = spawn('codex', ['exec', '-m', model, '-c', 'model_reasoning_effort="high"', '--sandbox', 'read-only',
      '--skip-git-repo-check', '--output-last-message', outFile, '-'], { cwd, stdio: [fd, 'pipe', 'pipe'] });
    let err = '';
    child.stdout.on('data', () => {});
    child.stderr.on('data', (d) => { err += d; if (err.length > 20000) err = err.slice(-20000); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('codex timeout after 20 minutes')); }, CODEX_TIMEOUT_MS);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      fs.closeSync(fd);
      let out = '';
      try { out = fs.readFileSync(outFile, 'utf8'); } catch (_) { /* none */ }
      fs.rmSync(dir, { recursive: true, force: true });
      if (code !== 0 && !out.trim()) reject(new Error(`codex exit ${code}: ${(err.split('\n').filter((l) => /error/i.test(l)).slice(-3).join(' | ') || err.slice(-300)).slice(0, 400)}`));
      else resolve(out);
    });
  });
}

const LIMITS_FILE = path.join(os.homedir(), '.cache/tmux-agent-indicator/claude-limits.json');
const SDK_STOP_PCT = 98;
function weeklyUsedPct() {
  try {
    const w = JSON.parse(fs.readFileSync(LIMITS_FILE, 'utf8')).windows.find((x) => x.window_minutes === 10080);
    return w ? w.used_percent : null;
  } catch (_) { return null; }
}

// Claude Agent SDK, no tools, no MCP, no settings, one turn; effort 'high' like the bot.
async function runSdk(model, systemPrompt, prompt) {
  const used = weeklyUsedPct();
  if (used == null || used >= SDK_STOP_PCT) throw new Error(`budget guard: weekly Claude usage ${used}% (stop at ${SDK_STOP_PCT}%)`);
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-bench-sdk-'));
  try {
    const options = {
      cwd, model, systemPrompt, tools: [], allowedTools: [], mcpServers: {}, strictMcpConfig: true,
      settingSources: [], maxTurns: 1, persistSession: false,
      thinking: { type: 'adaptive' }, effort: 'high',
    };
    let final = null;
    for await (const msg of query({ prompt, options })) {
      if (msg.type === 'result') final = msg;
    }
    if (!final) throw new Error('sdk: no result message');
    if (final.is_error || final.subtype !== 'success') {
      throw new Error(`sdk ${final.subtype}: ${String(final.result || (final.errors || []).join(' | ') || '').slice(0, 400)}`);
    }
    return { result: final.result || '', usage: final.usage };
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function makeAdapter({ model, apiKey, workDir, calls, maxUsd }) {
  let spent = 0;
  const isCodex = model.startsWith('codex:') || model.startsWith('sdk:');
  return async function runClaudeImpl(opts) {
    if (isCodex) {
      const m = String(opts.label || '').match(/issue-rules-gate:([A-Z]+)-(\d+)/);
      const tag = m ? `${m[1]}-${String(m[2]).padStart(2, '0')}` : 'unknown';
      fs.appendFileSync(path.join(workDir, `${tag}.prompt.txt`), `=== ${opts.label} ===\n${opts.prompt}\n\n`);
      const t0 = Date.now();
      let content; let sdkUsage;
      if (model.startsWith('sdk:')) ({ result: content, usage: sdkUsage } = await runSdk(model.slice(4), opts.appendSystemPrompt, opts.prompt));
      else content = await runCodex(model.slice(6), opts.appendSystemPrompt, opts.prompt);
      const rawLen = content.length;
      if (content.trim() && !parsable(content)) {
        const first = firstBalancedObject(content);
        if (first && parsable(first)) content = first;
      }
      const rec = {
        tag, label: opts.label, model, ms: Date.now() - t0,
        tokens_in: (sdkUsage && sdkUsage.input_tokens) || 0, tokens_out: (sdkUsage && sdkUsage.output_tokens) || 0, reasoning_tokens: 0,
        cost: 0, cost_computed: false, subscription: true, unknownPrice: false, finish_reason: null,
        empty: !content.trim(), parse_failed: !!content.trim() && !parsable(content),
      };
      calls.push(rec);
      fs.appendFileSync(path.join(workDir, `${tag}.raw.txt`),
        `=== ${opts.label} ${rec.empty ? 'EMPTY' : rec.parse_failed ? 'PARSE-FAILED' : 'ok'} (raw ${rawLen} chars) ===\n${content}\n\n`);
      return { subtype: 'success', result: content, usage: sdkUsage };
    }
    if (spent > maxUsd) throw new Error(`budget guard: model spend ${spent.toFixed(2)} exceeded ${maxUsd}`);
    const m = String(opts.label || '').match(/issue-rules-gate:([A-Z]+)-(\d+)/);
    const tag = m ? `${m[1]}-${String(m[2]).padStart(2, '0')}` : 'unknown';
    const body = {
      model,
      messages: [
        { role: 'system', content: opts.appendSystemPrompt },
        { role: 'user', content: opts.prompt },
      ],
      max_tokens: 12000,
      reasoning: { effort: 'high' },
    };
    fs.appendFileSync(path.join(workDir, `${tag}.prompt.txt`), `=== ${opts.label} ===\n${opts.prompt}\n\n`);
    let json;
    const t0 = Date.now();
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 4000 * 3 ** (attempt - 1)));
      let res;
      let text;
      try {
        res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15 * 60 * 1000),
        });
        text = await res.text();
      } catch (e) { lastErr = new Error(`network error: ${e.message}`); continue; }
      if (!res.ok) {
        lastErr = new Error(`OpenRouter HTTP ${res.status}: ${text.slice(0, 400)}`);
        if (res.status === 429 || res.status >= 500) continue;
        throw lastErr;
      }
      try { json = JSON.parse(text); } catch (_) { lastErr = new Error(`OpenRouter non-JSON body: ${text.slice(0, 300)}`); continue; }
      if (json.error) {
        const code = Number(json.error.code);
        lastErr = new Error(`OpenRouter error ${json.error.code}: ${String(json.error.message).slice(0, 400)}`);
        if (code === 429 || code >= 500) { json = null; continue; }
        throw lastErr;
      }
      break;
    }
    if (!json) throw lastErr || new Error('OpenRouter: no response');

    const choice = (json.choices && json.choices[0]) || {};
    let content = choice.message && choice.message.content;
    if (Array.isArray(content)) content = content.map((p) => (typeof p === 'string' ? p : p.text || '')).join('');
    content = typeof content === 'string' ? content : '';
    const usage = json.usage || {};
    const { cost, computed, unknownPrice } = costOf(model, usage);
    spent += cost;
    const rec = {
      tag, label: opts.label, model, ms: Date.now() - t0,
      tokens_in: usage.prompt_tokens || 0, tokens_out: usage.completion_tokens || 0,
      reasoning_tokens: (usage.completion_tokens_details && usage.completion_tokens_details.reasoning_tokens) || 0,
      cost, cost_computed: computed, unknownPrice: !!unknownPrice,
      finish_reason: choice.finish_reason || null,
      empty: !content.trim(), parse_failed: !!content.trim() && !parsable(content),
    };
    calls.push(rec);
    fs.appendFileSync(path.join(workDir, `${tag}.raw.txt`),
      `=== ${opts.label} finish=${rec.finish_reason} ${rec.empty ? 'EMPTY' : rec.parse_failed ? 'PARSE-FAILED' : 'ok'} ===\n${content}\n\n`);
    return { subtype: 'success', result: content, usage: { input_tokens: rec.tokens_in, output_tokens: rec.tokens_out } };
  };
}

// Synthetic one-chapter USFM from the text the issues were written against.
function aiTimeUsfm(tag, field) {
  const d = JSON.parse(fs.readFileSync(path.join(S, 'bench/prepared', `${tag}.json`), 'utf8'));
  const seen = new Map();
  for (const it of d.items) {
    const m = String(it.reference || '').match(/^(\d+):(\d+)/);
    if (!m || !it[field] || seen.has(Number(m[2]))) continue;
    seen.set(Number(m[2]), String(it[field]).replace(/\s+/g, ' ').trim());
  }
  const vs = [...seen.entries()].sort((a, b) => a[0] - b[0]);
  return `\\c ${Number(d.chapter)}\n` + vs.map(([n, t]) => `\\v ${n} ${t}`).join('\n') + '\n';
}

function buildTsv(items, book, tag) {
  const clean = (s) => String(s == null ? '' : s).replace(/[\t\r\n]/g, ' ');
  const lines = items.map((it) => [book, clean(it.reference), clean(it.sref), clean(it.gl_quote), '', '', clean(it.explanation)].join('\t'));
  return { text: lines.join('\n') + '\n', lines, tag };
}

async function runChild(args) {
  const { model, label, rulesRoot, allowAdd, maxModelUsd } = args;
  const concurrency = (model.startsWith('codex:') || model.startsWith('sdk:')) ? Math.min(2, args.concurrency) : args.concurrency;
  const slug = slugModel(model);
  const workDir = path.join(S, 'bench/work', label, slug);
  fs.rmSync(path.join(workDir, 'output'), { recursive: true, force: true });
  for (const f of fs.readdirSync(workDir, { withFileTypes: true }).filter((d) => d.isFile())) {
    if (/\.(raw|prompt)\.txt$/.test(f.name)) fs.rmSync(path.join(workDir, f.name));
  }
  for (const rel of RULE_FILES) {
    fs.mkdirSync(path.dirname(path.join(workDir, rel)), { recursive: true });
    fs.copyFileSync(path.join(rulesRoot, rel), path.join(workDir, rel));
  }
  process.env.CSKILLBP_DIR = workDir; // before the gate is required
  // The gate's best-effort metrics write into its own worktree; keep it read-only.
  const utPath = require.resolve(path.join(GATE_SRC, 'usage-tracker'));
  require.cache[utPath] = { id: utPath, filename: utPath, loaded: true, exports: { recordMetrics() {} } };
  let runIssueRulesGate;
  try {
    ({ runIssueRulesGate } = require(path.join(GATE_SRC, 'issue-rules-gate.js')));
  } catch (e) {
    console.error(`issue-rules-gate.js not found under GATE_SRC=${GATE_SRC}; it ships in unfoldingWord/bp-assistant#420 - set GATE_SRC to a checkout of that branch's src/`);
    process.exit(1);
  }

  const apiKey = (model.startsWith('codex:') || model.startsWith('sdk:')) ? null : loadApiKey();
  const calls = [];
  const adapter = makeAdapter({ model, apiKey, workDir, calls, maxUsd: maxModelUsd });
  const sources = {};
  const srcPaths = {};
  const runs = [];
  const t0 = Date.now();
  const queue = [...args.chapters];

  async function one(tag) {
    const prep = loadPrepared(tag);
    const { text, lines } = buildTsv(prep.items, prep.book, tag);
    const rel = path.join('output/issues', prep.book, `${tag}.tsv`);
    fs.mkdirSync(path.dirname(path.join(workDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(workDir, rel), text);
    for (const [k, repo] of [['ult', 'en_ult'], ['ust', 'en_ust'], ['hebrew', 'hbo_uhb']]) {
      srcPaths[prep.book] = srcPaths[prep.book] || {};
      srcPaths[prep.book][k] = args.sourcePaths[prep.book][k];
    }
    const ctx = { sources: { ...srcPaths[prep.book] } };
    if (args.sources === 'ai-time') {
      const sd = path.join(workDir, 'sources');
      fs.mkdirSync(sd, { recursive: true });
      for (const [k, field] of [['ult', 'ult_verse'], ['ust', 'ust_verse']]) {
        const f = path.join(sd, `${tag}.${k}.usfm`);
        fs.writeFileSync(f, aiTimeUsfm(tag, field));
        ctx.sources[k] = f;
      }
    }
    const c0 = Date.now();
    const before = calls.length;
    let result = null; let error = null;
    const status = async (m) => console.log(`[${slug} ${tag}] ${m}`);
    try {
      result = await runIssueRulesGate({
        issuesPath: rel, book: prep.book, chapter: prep.chapter, ctx, hints: null,
        config: { rulesGate: { mode: 'apply', books: 'all', allowAdd, effort: 'high', protectSrefs: PROTECT } },
        env: {}, dryRun: false, model, status, runClaudeImpl: adapter,
      });
      if (result && result.error) error = result.error;
    } catch (e) { error = e.message; }
    const read = (p) => { try { return fs.readFileSync(path.join(workDir, p), 'utf8'); } catch (_) { return null; } };
    const base = tag;
    const sidecarRel = result && result.sidecarPath;
    const run = {
      tag, ms: Date.now() - c0, error, result,
      lines, // original TSV lines, index == row index the gate reports
      sidecar: sidecarRel ? JSON.parse(read(sidecarRel)) : null,
      report: read(path.join('output/review', prep.book, `${base}-rules-gate.md`)),
      finalTsv: read(rel),
      callIdx: [before, calls.length],
    };
    runs.push(run);
    console.log(`[${slug} ${tag}] done ran=${result && result.ran} reason=${result && result.reason} counts=${JSON.stringify(result && result.counts)} err=${error || ''}`);
  }
  async function worker() { while (queue.length) { const tag = queue.shift(); try { await one(tag); } catch (e) { runs.push({ tag, error: `bench: ${e.message}`, ms: 0, callIdx: [0, 0] }); } } }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  // calls are attributed by tag (callIdx is unreliable under concurrency)
  fs.writeFileSync(path.join(workDir, 'runs.json'), JSON.stringify({ model, label, allowAdd, rulesRoot, wallMs: Date.now() - t0, runs, calls }, null, 1));
}

// ---------------------------------------------------------------- scoring

function parseReportNotes(report) {
  if (!report) return [];
  const i = report.indexOf('## Notes');
  return i < 0 ? [] : report.slice(i).split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2));
}
function parseReportTable(report) {
  const rows = [];
  for (const l of String(report || '').split('\n')) {
    if (!l.startsWith('| ') || /^\| (Ref|---)/.test(l)) continue;
    const cells = l.slice(2, -2).split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
    if (cells.length >= 6) rows.push({ ref: cells[0], action: cells[1], before: cells[2], after: cells[3], reason: cells[4], rule: cells[5] || null });
  }
  return rows;
}

// When the sidecar is missing (some chunk incomplete) rebuild the change list by
// diffing original vs final lines. Rows are matched on (ref, explanation), which
// the gate never edits. Reasons come from the markdown report when they match.
function diffChanges(run) {
  const orig = run.lines.map((l) => l.split('\t'));
  const fin = String(run.finalTsv || '').split('\n').filter(Boolean).map((l) => l.split('\t'));
  const key = (c) => `${c[1]}\t${c[6]}`;
  const pool = new Map();
  fin.forEach((c) => { const k = key(c); (pool.get(k) || pool.set(k, []).get(k)).push(c); });
  const table = parseReportTable(run.report);
  const reasonFor = (action, ref, before) => table.find((t) => t.action === action && t.ref === ref && t.before === before) || {};
  const changes = [];
  orig.forEach((c, index) => {
    const list = pool.get(key(c));
    const f = list && list.shift();
    if (!f) {
      const t = reasonFor('drop', c[1], c[3]);
      changes.push({ index, ref: c[1], action: 'drop', sref: c[2], before: c[3], after: '', reason: t.reason || '(reconstructed)', rule: t.rule || null });
    } else if (f[2] !== c[2]) {
      const t = reasonFor('relabel', c[1], c[2]);
      changes.push({ index, ref: c[1], action: 'relabel', sref: f[2], fromSref: c[2], before: c[2], after: f[2], quote: c[3], reason: t.reason || '(reconstructed)', rule: t.rule || null });
    } else if (f[3] !== c[3]) {
      const t = reasonFor('rescope', c[1], c[3]);
      changes.push({ index, ref: c[1], action: 'rescope', sref: c[2], before: c[3], after: f[3], reason: t.reason || '(reconstructed)', rule: t.rule || null });
    }
  });
  let n = 0;
  for (const list of pool.values()) for (const f of list) {
    const t = reasonFor('add', f[1], '');
    changes.push({ index: -1 - n++, ref: f[1], action: 'add', sref: f[2], before: '', after: f[3], explanation: f[6], reason: t.reason || '(reconstructed)', rule: t.rule || null });
  }
  return changes;
}

const zeroM = () => ({
  rows: 0, rows_matched: 0, unmatched: 0, protected_rows: 0,
  deleted_total: 0, relabeled_total: 0, kept_total: 0, rescoped_total: 0,
  deleted_gateable: 0, relabeled_gateable: 0, kept_gateable: 0,
  human_added_total: 0,
  drops: 0, drop_TP: 0, collateral: 0, wrong_drop_relabeled: 0,
  relabels: 0, relabel_correct: 0, relabel_wrong: 0,
  rescopes: 0, rescope_agree: 0, rescope_other: {},
  adds: 0, add_hits: 0, add_misses: 0,
  incomplete_chunks: 0, parse_failures: 0, empty_responses: 0, errors: 0, drop_cap_chapters: 0,
  calls: 0, tokens_in: 0, tokens_out: 0, cost_usd: 0, wall_ms: 0,
});

function addInto(t, m) {
  for (const k of Object.keys(m)) {
    if (k === 'rescope_other') for (const [kk, v] of Object.entries(m[k])) t[k][kk] = (t[k][kk] || 0) + v;
    else t[k] += m[k];
  }
}
const ratio = (a, b) => (b ? a / b : null);
function derive(m) {
  return {
    ...m,
    drop_recall: ratio(m.drop_TP, m.deleted_total),
    drop_recall_gateable: ratio(m.drop_TP, m.deleted_gateable),
    drop_precision: ratio(m.drop_TP, m.drops),
    collateral_rate: ratio(m.collateral, m.kept_total),
    collateral_rate_gateable: ratio(m.collateral, m.kept_gateable),
    relabel_recall: ratio(m.relabel_correct, m.relabeled_total),
    relabel_recall_gateable: ratio(m.relabel_correct, m.relabeled_gateable),
    relabel_precision: ratio(m.relabel_correct, m.relabels),
    rescope_agreement: ratio(m.rescope_agree, m.rescopes),
    add_precision: ratio(m.add_hits, m.adds),
    add_recall: ratio(m.add_hits, m.human_added_total),
  };
}

function scoreChapter(run, runCalls) {
  const tag = run.tag;
  const prep = loadPrepared(tag);
  const led = loadLedger(prep.book);
  const m = zeroM();
  const changesOut = [];
  m.rows = prep.items.length;
  m.wall_ms = run.ms || 0;
  const isProt = (it) => isProtected(it.sref);

  for (const it of prep.items) {
    const rec = led.byId.get(it.id);
    if (!rec) { m.unmatched++; continue; }
    m.rows_matched++;
    const p = isProt(it);
    if (p) m.protected_rows++;
    if (rec.kind === 'deleted') { m.deleted_total++; if (!p) m.deleted_gateable++; }
    else if (rec.kind === 'relabeled') { m.relabeled_total++; if (!p) m.relabeled_gateable++; }
    else if (KEPT_KINDS.has(rec.kind)) { m.kept_total++; if (!p) m.kept_gateable++; }
    if (rec.kind === 'rescoped') m.rescoped_total++;
  }
  const humanHere = led.humanAdded.filter((r) => Number(r.chapter) === prep.chapter);
  m.human_added_total = humanHere.length;
  const matchedHuman = new Set();

  const run_ok = !!(run.result && run.result.ran) && !run.error;
  if (run.error || !run.result || !run.result.ran) m.errors++;
  const notes = parseReportNotes(run.report);
  m.incomplete_chunks = notes.filter((n) => /^chunk \d+: incomplete/.test(n)).length;
  m.drop_cap_chapters = notes.includes('drop_cap_exceeded') ? 1 : 0;
  for (const c of runCalls) {
    m.calls++; m.tokens_in += c.tokens_in; m.tokens_out += c.tokens_out; m.cost_usd += c.cost;
    if (c.parse_failed) m.parse_failures++;
    if (c.empty) m.empty_responses++;
  }

  let changes = [];
  let changeSource = 'none';
  if (run.sidecar && Array.isArray(run.sidecar.changes)) { changes = run.sidecar.changes; changeSource = 'sidecar'; }
  else if (run.finalTsv && run.result && run.result.ran) { changes = diffChanges(run); changeSource = 'diff'; }

  for (const c of changes) {
    const it = c.action === 'add' ? null : prep.items[c.index];
    const rec = it ? led.byId.get(it.id) : null;
    const out = { tag, index: c.index, id: it ? it.id : null, ref: c.ref, action: c.action, sref: c.sref, fromSref: c.fromSref || (it && it.sref) || null,
      quote: it ? it.gl_quote : c.after, before: c.before, after: c.after, reason: c.reason, rule: c.rule, change_source: changeSource,
      ledger: rec ? { kind: rec.kind, slug_final: rec.slug_final || null } : null, outcome: null };
    if (c.action === 'add') {
      m.adds++;
      const slug = slugOf(c.sref);
      const hit = humanHere.find((r) => r.ref === c.ref && slugOf(r.slug_final) === slug && !matchedHuman.has(r.id));
      if (hit) { matchedHuman.add(hit.id); m.add_hits++; out.outcome = 'add_hit'; out.ledger = { kind: 'human-added', slug_final: hit.slug_final }; }
      else { m.add_misses++; out.outcome = 'add_miss'; }
    } else if (!rec) {
      out.outcome = 'unmatched';
    } else if (c.action === 'drop') {
      m.drops++;
      if (rec.kind === 'deleted') { m.drop_TP++; out.outcome = 'drop_tp'; }
      else if (rec.kind === 'relabeled') { m.wrong_drop_relabeled++; out.outcome = 'wrong_drop_relabeled'; }
      else if (KEPT_KINDS.has(rec.kind)) { m.collateral++; out.outcome = `collateral_${rec.kind}`; }
      else out.outcome = `drop_on_${rec.kind}`;
    } else if (c.action === 'relabel') {
      m.relabels++;
      if (rec.kind === 'relabeled' && slugOf(rec.slug_final) === slugOf(c.sref)) { m.relabel_correct++; out.outcome = 'relabel_correct'; }
      else { m.relabel_wrong++; out.outcome = rec.kind === 'relabeled' ? 'relabel_wrong_slug' : `relabel_on_${rec.kind}`; }
    } else if (c.action === 'rescope') {
      m.rescopes++;
      if (rec.kind === 'rescoped') { m.rescope_agree++; out.outcome = 'rescope_agree'; }
      else { m.rescope_other[rec.kind] = (m.rescope_other[rec.kind] || 0) + 1; out.outcome = `rescope_on_${rec.kind}`; }
    }
    changesOut.push(out);
  }
  return { metrics: m, changes: changesOut, notes, changeSource, ran: run_ok, reason: run.result && run.result.reason, error: run.error || null };
}

function scoreModel(runsFile) {
  const data = JSON.parse(fs.readFileSync(runsFile, 'utf8'));
  const chapters = {};
  const pooled = zeroM();
  const allChanges = [];
  for (const run of data.runs) {
    const runCalls = data.calls.filter((c) => c.tag === run.tag);
    const sc = scoreChapter(run, runCalls);
    chapters[run.tag] = { ...derive(sc.metrics), ran: sc.ran, reason: sc.reason, error: sc.error, change_source: sc.changeSource, notes: sc.notes };
    addInto(pooled, sc.metrics);
    allChanges.push(...sc.changes);
  }
  // calls whose chapter tag was not recognised still count toward cost
  const stray = data.calls.filter((c) => !data.runs.some((r) => r.tag === c.tag));
  for (const c of stray) { pooled.calls++; pooled.tokens_in += c.tokens_in; pooled.tokens_out += c.tokens_out; pooled.cost_usd += c.cost; }
  pooled.wall_ms = data.wallMs;
  return { model: data.model, label: data.label, allowAdd: data.allowAdd, rulesRoot: data.rulesRoot, pooled: derive(pooled), chapters, changes: allChanges };
}

// ---------------------------------------------------------------- summary

const pct = (x) => (x == null ? 'n/a' : `${(x * 100).toFixed(0)}%`);
const frac = (a, b) => `${a}/${b}`;
let subModel = false;
const usd = (x) => (subModel ? 'subscription' : `$${x.toFixed(2)}`);
const mins = (ms) => `${(ms / 60000).toFixed(1)}m`;
const cell = (s) => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\s+/g, ' ');
const trunc = (s, n) => { const t = String(s == null ? '' : s); return t.length > n ? `${t.slice(0, n - 1)}...` : t; };

function renderSummary(args, scored) {
  const L = [];
  L.push(`# Issue rules gate benchmark: ${args.label}`);
  L.push('');
  L.push(`Rules root: \`${args.rulesRoot || scored[0]?.rulesRoot}\`. Sources: ${args.sources} (ULT/UST), Hebrew from master. Adds: ${scored.some((s) => s.allowAdd) ? 'enabled' : 'off'}. Chapters: ${Object.keys(scored[0]?.chapters || {}).join(', ')}.`);
  L.push('');
  L.push('Definitions: kept_total = ledger rows that survived with the same slug (kept, kept-reid, reworded, rescoped). Collateral = gate drop of one of those rows. Recall columns use gateable rows (protected parallelism/activepassive rows excluded); "all" columns include them. Rows missing from the ledger are excluded from every rate.');
  L.push('');
  L.push('| Model | rows | deleted (all/gateable) | drops | drop TP | drop recall (gateable/all) | drop precision | collateral (rate, gateable) | wrong drop of relabeled | relabels | relabel correct | relabel recall (gateable/all) | rescopes | rescope agree | adds | add hits | incomplete | parse fail | empty | errors | calls | tokens in/out | cost | wall |');
  L.push('|' + Array(24).fill('---').join('|') + '|');
  for (const s of scored) {
    subModel = s.model.startsWith('codex:') || s.model.startsWith('sdk:');
    const p = s.pooled;
    L.push(`| ${s.model} | ${p.rows_matched} | ${p.deleted_total}/${p.deleted_gateable} | ${p.drops} | ${p.drop_TP} | ${pct(p.drop_recall_gateable)}/${pct(p.drop_recall)} | ${pct(p.drop_precision)} | ${p.collateral} (${pct(p.collateral_rate_gateable)}) | ${p.wrong_drop_relabeled} | ${p.relabels} | ${p.relabel_correct} | ${pct(p.relabel_recall_gateable)}/${pct(p.relabel_recall)} | ${p.rescopes} | ${p.rescope_agree} | ${p.adds} | ${p.add_hits} | ${p.incomplete_chunks} | ${p.parse_failures} | ${p.empty_responses} | ${p.errors} | ${p.calls} | ${p.tokens_in}/${p.tokens_out} | ${usd(p.cost_usd)} | ${mins(p.wall_ms)} |`);
  }
  L.push('');
  L.push('Pooled counts behind the rates (kept_total all/gateable, relabeled_total all/gateable, rescoped_total, protected rows, unmatched, drop-cap chapters, rescope on other kinds):');
  L.push('');
  L.push('| Model | kept_total | relabeled_total | rescoped_total | protected | unmatched | drop-cap chapters | rescope on other kinds | collateral rate (all) | relabel precision | add precision | add recall |');
  L.push('|' + Array(12).fill('---').join('|') + '|');
  for (const s of scored) {
    const p = s.pooled;
    L.push(`| ${s.model} | ${p.kept_total}/${p.kept_gateable} | ${p.relabeled_total}/${p.relabeled_gateable} | ${p.rescoped_total} | ${p.protected_rows} | ${p.unmatched} | ${p.drop_cap_chapters} | ${JSON.stringify(p.rescope_other)} | ${pct(p.collateral_rate)} | ${pct(p.relabel_precision)} | ${pct(p.add_precision)} | ${pct(p.add_recall)} |`);
  }
  for (const s of scored) {
    subModel = s.model.startsWith('codex:') || s.model.startsWith('sdk:');
    L.push('');
    L.push(`## ${s.model}`);
    L.push('');
    L.push('| Chapter | ran | rows | deleted | drops | TP | recall | collateral | wrong drop relab. | relabeled | relabels | correct | rescopes | agree | adds | hits | incomplete | parse fail | errors | cost | wall | note |');
    L.push('|' + Array(22).fill('---').join('|') + '|');
    for (const [tag, c] of Object.entries(s.chapters).sort()) {
      L.push(`| ${tag} | ${c.ran} | ${c.rows_matched} | ${c.deleted_total} | ${c.drops} | ${c.drop_TP} | ${pct(c.drop_recall)} | ${c.collateral} | ${c.wrong_drop_relabeled} | ${c.relabeled_total} | ${c.relabels} | ${c.relabel_correct} | ${c.rescopes} | ${c.rescope_agree} | ${c.adds} | ${c.add_hits} | ${c.incomplete_chunks} | ${c.parse_failures} | ${c.errors} | ${usd(c.cost_usd)} | ${mins(c.wall_ms)} | ${cell(c.error ? trunc(c.error, 80) : (c.reason || '') + (c.drop_cap_chapters ? ' drop_cap_exceeded' : ''))} |`);
    }
    const rank = { collateral_kept: 0, 'collateral_kept-reid': 0, collateral_reworded: 1, collateral_rescoped: 2, wrong_drop_relabeled: 3 };
    const worst = s.changes.filter((c) => c.outcome in rank).sort((a, b) => rank[a.outcome] - rank[b.outcome] || a.tag.localeCompare(b.tag) || a.index - b.index).slice(0, 10);
    L.push('');
    L.push(`Worst ${worst.length} drops by collateral (untouched-kept first, then reworded, rescoped, relabeled):`);
    L.push('');
    if (worst.length) {
      L.push('| Ref | sref | Quote | Gate reason / rule | Editors did |');
      L.push('|---|---|---|---|---|');
      for (const w of worst) {
        L.push(`| ${w.tag} ${w.ref} | ${w.fromSref} | ${cell(trunc(w.quote, 50))} | ${cell(trunc(w.reason, 140))}${w.rule ? ` (${cell(w.rule)})` : ''} | ${w.ledger.kind}${w.ledger.kind === 'relabeled' ? ` -> ${slugOf(w.ledger.slug_final)}` : ''} |`);
      }
    } else L.push('(none)');
  }
  L.push('');
  return L.join('\n');
}

// ---------------------------------------------------------------- main

function spawnChild(args, model, sourcePaths) {
  return new Promise((resolve) => {
    const argv = [__filename, '--child', '--model', model, '--chapters', args.chapters.join(','), '--rules-root', args.rulesRoot,
      '--label', args.label, '--sources', args.sources, '--concurrency', String(args.concurrency), '--max-model-usd', String(args.maxModelUsd)];
    if (args.allowAdd) argv.push('--allow-add');
    const child = spawn(process.execPath, argv, { stdio: 'inherit', env: { ...process.env, BENCH_SOURCE_PATHS: JSON.stringify(sourcePaths) } });
    child.on('exit', (code) => resolve(code));
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.child) {
    args.sourcePaths = JSON.parse(process.env.BENCH_SOURCE_PATHS);
    return runChild(args);
  }
  if (!args.models || !args.chapters || !args.label || (!args.rulesRoot && !args.scoreOnly)) {
    throw new Error('usage: gate-bench.js --models a,b --chapters EZK-01,JER-23 --rules-root <dir> --label <name> [--allow-add] [--concurrency N] [--score-only]');
  }
  let failedModels = [];
  if (!args.scoreOnly) {
    for (const rel of RULE_FILES) if (!fs.existsSync(path.join(args.rulesRoot, rel))) throw new Error(`rules root is missing ${rel}`);
    const books = [...new Set(args.chapters.map((t) => t.split('-')[0]))];
    const sourcePaths = {};
    for (const b of books) {
      if (!BOOK_NUM[b]) throw new Error(`unknown book ${b}`);
      sourcePaths[b] = { ult: await ensureSource('en_ult', b), ust: await ensureSource('en_ust', b), hebrew: await ensureSource('hbo_uhb', b) };
    }
    for (const m of args.models) fs.mkdirSync(path.join(S, 'bench/work', args.label, slugModel(m)), { recursive: true });
    console.log(`running ${args.models.length} model(s) x ${args.chapters.length} chapter(s), label=${args.label}`);
    const codes = await Promise.all(args.models.map((m) => spawnChild(args, m, sourcePaths)));
    codes.forEach((c, i) => { if (c !== 0) console.error(`child for ${args.models[i]} exited with ${c}`); });
    failedModels = args.models.filter((m, i) => codes[i] !== 0);
    if (failedModels.length) console.error(`FAILED MODELS: ${failedModels.join(', ')}`);
  }
  const resDir = path.join(S, 'bench/results', args.label);
  fs.mkdirSync(resDir, { recursive: true });
  const scored = [];
  for (const m of args.models) {
    const rf = path.join(S, 'bench/work', args.label, slugModel(m), 'runs.json');
    if (!fs.existsSync(rf)) { console.error(`no runs.json for ${m}`); continue; }
    const sc = scoreModel(rf);
    fs.writeFileSync(path.join(resDir, `${slugModel(m)}.json`), JSON.stringify(sc, null, 1));
    scored.push(sc);
  }
  if (scored.length) {
    const banner = failedModels.length ? `FAILED MODELS: ${failedModels.join(', ')}\n\n` : '';
    fs.writeFileSync(path.join(resDir, 'summary.md'), banner + renderSummary(args, scored));
    const total = scored.reduce((a, s) => a + s.pooled.cost_usd, 0);
    console.log(`summary: ${path.join(resDir, 'summary.md')}  total cost ${usd(total)}`);
  }
  if (failedModels.length) process.exitCode = 1;
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { diffChanges, scoreChapter, parseArgs, slugModel, isProtected };
