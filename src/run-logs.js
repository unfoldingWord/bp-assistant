// run-logs.js — durable, per-query run logs on the Fly volume.
//
// Why this exists: until now the only record of what a pipeline query actually
// did was `console.log` -> stdout -> the fly.io log stream. That stream is
// ephemeral (a snapshot taken 2026-07-23T00:01Z reached back only to ~22:42Z —
// about 80 minutes, most of it heartbeats), and every interesting line was
// truncated at the source: assistant text `.slice(0, 200)`, tool input
// `.slice(0, 150)`. So by the time a failure was triaged the evidence was
// either gone or too short to read. The AMO 8 align failures (#264/#265) were
// closed as an "intermittent LLM flake" on timing alone, because nobody could
// see the tool calls; the transcripts showed a permission lockout instead.
//
// Two things are recorded here:
//
//   1. A JSONL run log per `runClaude` query, written to the volume with
//      generous per-field caps. Survives deploys and machine restarts.
//   2. The SDK's own session id and the path to the transcript it writes under
//      CLAUDE_CONFIG_DIR. Those transcripts already existed and already carried
//      full sub-agent detail — they were simply never linked to a pipeline
//      failure, so no triage path led to them. Recording the pointer is most of
//      the diagnostic value in this module.
//
// Every function here is defensive: logging must never take down a pipeline
// run, so all filesystem work is wrapped and failures degrade to a no-op.
'use strict';

const fs = require('fs');
const path = require('path');

// Volume-backed by default (fly.toml mounts workspace_vol at /data). Override
// for dev/test. Falls back to a repo-local dir when the volume is absent.
const RUN_LOG_DIR = process.env.BP_RUN_LOG_DIR
  || (fs.existsSync('/data') ? '/data/run-logs' : path.join(process.cwd(), 'logs', 'runs'));

// Retention. Runs are small (a few hundred KB at most) and the volume is 25GB,
// so the age bound is what normally applies; the byte bound is a backstop
// against a pathological run-away.
const MAX_AGE_DAYS = Number(process.env.BP_RUN_LOG_MAX_AGE_DAYS) > 0
  ? Number(process.env.BP_RUN_LOG_MAX_AGE_DAYS)
  : 30;
const MAX_TOTAL_BYTES = Number(process.env.BP_RUN_LOG_MAX_BYTES) > 0
  ? Number(process.env.BP_RUN_LOG_MAX_BYTES)
  : 2 * 1024 * 1024 * 1024; // 2 GB

// Per-field caps. Deliberately ~40x the old console caps: enough to read a full
// tool input or an agent's closing report, still bounded so one runaway message
// can't fill the volume.
const MAX_TEXT = 8 * 1024;
const MAX_TOOL_INPUT = 8 * 1024;
const MAX_TOOL_RESULT = 4 * 1024;

// --- redaction ---------------------------------------------------------------
// Run logs persist tool inputs and agent text to disk for 30 days, and the
// self-diagnosis agent is pointed at them when drafting a PUBLIC GitHub issue.
// Pipelines run with `enableBash: true`, so an agent that shells out (or reads
// an env dump) could surface credential material in a tool result. Previously
// that was ephemeral, console-only and truncated at 150 chars; persisting it
// creates a real path from "secret appears in agent output" to "secret quoted
// into a public issue". Scrub on the way to disk, so nothing downstream — issue
// bodies included — can leak what was never written.
//
// Two layers: exact values of secret-ish env vars (precise, catches anything
// this process actually holds), then shape-based patterns (catches secrets that
// never passed through our env, e.g. one printed by a remote command).

const SECRET_ENV_RE = /(TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_KEY)/i;
const MIN_SECRET_LEN = 8;

// Cached, but invalidated on a signature of the secret-named keys and their
// value lengths — NOT on the env key count, which is unchanged by a set
// followed by a delete and would serve a stale (unredacting) list. Ordinary env
// churn on non-secret names never triggers a rebuild. Scanning the key names is
// cheap next to the file write this feeds.
let _secretCache = { sig: null, entries: [] };

function secretEnvValues() {
  const names = [];
  for (const name of Object.keys(process.env)) {
    if (SECRET_ENV_RE.test(name)) names.push(name);
  }
  names.sort();
  const sig = names.map((n) => `${n}:${(process.env[n] || '').length}`).join('|');
  if (_secretCache.sig === sig) return _secretCache.entries;

  const entries = [];
  for (const name of names) {
    const value = process.env[name];
    if (typeof value !== 'string' || value.length < MIN_SECRET_LEN) continue;
    // Skip values that are obviously not credentials (flags the config
    // legitimately logs) so we don't redact harmless text.
    if (/^(0|1|true|false)$/i.test(value)) continue;
    entries.push([value, `[redacted:${name}]`]);
  }
  // Longest first so an overlapping shorter value can't partially mask a longer one.
  entries.sort((a, b) => b[0].length - a[0].length);
  _secretCache = { sig, entries };
  return entries;
}

const SECRET_PATTERNS = [
  [/sk-ant-[A-Za-z0-9_-]{16,}/g, '[redacted:anthropic-key]'],
  [/sk-[A-Za-z0-9]{32,}/g, '[redacted:api-key]'],
  [/gh[pousr]_[A-Za-z0-9]{16,}/g, '[redacted:github-token]'],
  [/github_pat_[A-Za-z0-9_]{20,}/g, '[redacted:github-pat]'],
  [/xai-[A-Za-z0-9]{16,}/g, '[redacted:xai-key]'],
  [/AIza[A-Za-z0-9_-]{20,}/g, '[redacted:google-key]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[redacted:jwt]'],
  [/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi, '[redacted:auth-header]'],
  // KEY=value / "token": "value" style assignments of credential-named fields.
  [/\b([A-Za-z_][A-Za-z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL))\b(\s*[:=]\s*"?)([^\s"',;]{8,})/gi,
    (_m, name, sep) => `${name}${sep}[redacted]`],
];

function redact(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  for (const [value, replacement] of secretEnvValues()) {
    if (out.includes(value)) out = out.split(value).join(replacement);
  }
  for (const [re, replacement] of SECRET_PATTERNS) {
    out = out.replace(re, replacement);
  }
  return out;
}

function truncate(value, max) {
  if (value == null) return value;
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  if (typeof s !== 'string') return s;
  const scrubbed = redact(s);
  if (scrubbed.length <= max) return scrubbed;
  return `${scrubbed.slice(0, max)}…[+${scrubbed.length - max} chars]`;
}

// The Claude CLI stores transcripts under
// $CLAUDE_CONFIG_DIR/projects/<escaped-cwd>/<sessionId>.jsonl, with sub-agent
// transcripts in a sibling <sessionId>/subagents/ directory. The escaping maps
// every non-alphanumeric character to '-', so /data/workspace -> -data-workspace
// (verified against the live machine).
function escapeProjectDir(cwd) {
  return String(cwd || '').replace(/[^A-Za-z0-9]/g, '-');
}

function transcriptPathFor(cwd, sessionId) {
  if (!sessionId) return null;
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  if (!configDir) return null;
  return path.join(configDir, 'projects', escapeProjectDir(cwd), `${sessionId}.jsonl`);
}

// Sub-agent transcripts live beside the parent's — this is the directory a
// triager wants when a fan-out (align, initial-pipeline) is what failed.
function subagentDirFor(cwd, sessionId) {
  if (!sessionId) return null;
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  if (!configDir) return null;
  return path.join(configDir, 'projects', escapeProjectDir(cwd), sessionId, 'subagents');
}

function slug(text) {
  return String(text || 'run')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'run';
}

// A no-op handle, returned whenever the log file can't be opened. Callers use
// the same API either way, so no call site needs a null check.
function nullHandle() {
  return {
    enabled: false,
    file: null,
    sessionId: null,
    event() {},
    setSession() {},
    close() { return Promise.resolve(); },
    paths() { return { runLog: null, transcript: null, subagents: null }; },
  };
}

function createRunLog({ queryId, label, skill, cwd, model, timeoutMs, pipelineType, scope } = {}) {
  let stream;
  let file;
  try {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const dir = path.join(RUN_LOG_DIR, day);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = now.toISOString().slice(11, 19).replace(/:/g, '');
    file = path.join(dir, `${stamp}-${queryId || 'noid'}-${slug(label || skill)}.jsonl`);
    stream = fs.createWriteStream(file, { flags: 'a' });
    // A write error (volume full, permissions) must not crash the pipeline.
    stream.on('error', (err) => {
      console.warn(`[run-logs] write error on ${file}: ${err.message}`);
    });
  } catch (err) {
    console.warn(`[run-logs] could not open run log: ${err.message}`);
    return nullHandle();
  }

  const handle = {
    enabled: true,
    file,
    sessionId: null,
    transcript: null,
    subagents: null,
  };

  handle.event = function event(type, payload) {
    if (!stream || stream.destroyed) return;
    try {
      stream.write(`${JSON.stringify({ t: new Date().toISOString(), type, ...payload })}\n`);
    } catch (err) {
      console.warn(`[run-logs] event write failed: ${err.message}`);
    }
  };

  // Called when the SDK emits its init message. This is the link that makes the
  // full transcript (including sub-agents) findable from a pipeline failure.
  handle.setSession = function setSession(sessionId) {
    if (!sessionId || handle.sessionId) return;
    handle.sessionId = sessionId;
    handle.transcript = transcriptPathFor(cwd, sessionId);
    handle.subagents = subagentDirFor(cwd, sessionId);
    handle.event('session', {
      sessionId,
      transcript: handle.transcript,
      subagents: handle.subagents,
    });
  };

  handle.paths = function paths() {
    return { runLog: handle.file, transcript: handle.transcript, subagents: handle.subagents };
  };

  // Returns a promise that settles once the queued events have actually reached
  // disk. Callers on the pipeline path ignore it (closing is fire-and-forget
  // there), but anything that reads the log back needs a real signal rather than
  // a sleep — `end()` only queues the flush, so a busy machine can leave the
  // file empty for hundreds of milliseconds.
  //
  // It must always settle, and never reject. A stream that already failed (bad
  // open, ENOSPC mid-run) has destroyed itself and emitted 'error'/'close'
  // BEFORE this runs, so waiting on those events would wait forever — hence the
  // `destroyed` short-circuit. Getting that wrong is worse than the flake this
  // signal exists to fix: `node --test` has no default timeout, so a pending
  // promise hangs the suite instead of failing it. Resolving with no value keeps
  // `await log.close()` from evaluating to an Error; the failure itself is
  // already reported by the stream's error handler.
  let flushed;
  handle.close = function close(summary) {
    handle.event('end', summary || {});
    const closing = stream;
    stream = null;
    if (!closing) return flushed;
    flushed = new Promise((resolve) => {
      if (closing.destroyed) return resolve();
      closing.once('close', () => resolve());
      closing.once('error', () => resolve());
    });
    try { closing.end(); } catch (_) { /* already closed */ }
    return flushed;
  };

  handle.event('start', {
    queryId, label, skill, cwd, model, timeoutMs, pipelineType, scope,
  });
  return handle;
}

// --- message recording ------------------------------------------------------
// Split out from runClaude's loop so the shapes stay unit-testable without
// standing up an SDK query.

function recordAssistantMessage(log, message) {
  if (!log || !log.enabled) return;
  const content = message && message.message && message.message.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block && typeof block.text === 'string') {
      log.event('assistant_text', { text: truncate(block.text, MAX_TEXT) });
    } else if (block && block.name) {
      log.event('tool_use', {
        tool: block.name,
        id: block.id,
        input: truncate(block.input || {}, MAX_TOOL_INPUT),
      });
    }
  }
}

// The SDK reports tool results (and auto-denials) as `user` messages. Denials
// are flagged explicitly: a run that dies from them should be greppable by
// `"denied":true` rather than by matching prose after the fact.
const DENIAL_RE = /STOP what you are doing and wait/;

function recordUserMessage(log, text) {
  if (!log || !log.enabled) return;
  const s = typeof text === 'string' ? text : JSON.stringify(text || '');
  log.event('tool_result', {
    denied: DENIAL_RE.test(s),
    text: truncate(s, MAX_TOOL_RESULT),
  });
}

function recordResult(log, result) {
  if (!log || !log.enabled) return;
  log.event('result', {
    subtype: result && result.subtype,
    numTurns: result && result.num_turns,
    costUsd: result && result.total_cost_usd,
    durationMs: result && result.duration_ms,
    text: truncate((result && result.result) || '', MAX_TEXT),
  });
}

// --- retention --------------------------------------------------------------

// Delete day-directories older than maxAgeDays, then, if the tree is still over
// maxTotalBytes, drop whole days oldest-first. Day granularity keeps this cheap
// (no per-file stat of a large tree) and keeps a day's runs together.
function pruneRunLogs({ dir = RUN_LOG_DIR, maxAgeDays = MAX_AGE_DAYS, maxTotalBytes = MAX_TOTAL_BYTES } = {}) {
  const removed = [];
  let days;
  try {
    days = fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name))
      .map((d) => d.name)
      .sort();
  } catch {
    return { removed, bytes: 0 }; // dir absent — nothing to prune
  }

  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const keep = [];
  for (const day of days) {
    if (Date.parse(`${day}T23:59:59Z`) < cutoff) {
      try {
        fs.rmSync(path.join(dir, day), { recursive: true, force: true });
        removed.push(day);
      } catch (err) {
        console.warn(`[run-logs] prune failed for ${day}: ${err.message}`);
      }
    } else {
      keep.push(day);
    }
  }

  const sizeOf = (day) => {
    let total = 0;
    try {
      for (const f of fs.readdirSync(path.join(dir, day))) {
        try { total += fs.statSync(path.join(dir, day, f)).size; } catch { /* raced */ }
      }
    } catch { /* raced */ }
    return total;
  };

  const sizes = new Map(keep.map((day) => [day, sizeOf(day)]));
  let total = [...sizes.values()].reduce((a, b) => a + b, 0);
  // Never evict the current day: a query in flight holds an open stream into it,
  // and on Linux the unlinked file keeps receiving writes while becoming
  // invisible to triage — silently defeating the durability this module exists
  // for. Better to sit over the byte bound for a day than to lose live evidence.
  const today = new Date().toISOString().slice(0, 10);
  for (const day of keep) {
    if (total <= maxTotalBytes) break;
    if (day === today) continue;
    try {
      fs.rmSync(path.join(dir, day), { recursive: true, force: true });
      total -= sizes.get(day) || 0;
      removed.push(day);
    } catch (err) {
      console.warn(`[run-logs] size-prune failed for ${day}: ${err.message}`);
    }
  }

  return { removed, bytes: total };
}

module.exports = {
  createRunLog,
  pruneRunLogs,
  recordAssistantMessage,
  recordUserMessage,
  recordResult,
  transcriptPathFor,
  subagentDirFor,
  escapeProjectDir,
  truncate,
  RUN_LOG_DIR,
  MAX_AGE_DAYS,
  MAX_TOTAL_BYTES,
};
