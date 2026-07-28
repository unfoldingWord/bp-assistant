#!/usr/bin/env node
// log-tee.js — dependency-free rotating copy of the bot's stdout/stderr (#290).
//
// `fly logs -a uw-bt-bot --no-tail` only reaches back ~2.4 minutes; Fly has no
// retention knob, so anything older is gone. That cost us the #289 investigation:
// the per-tool-call SDK lines that would have shown whether the PreToolUse
// allow-all hook fired for the Wave-2 analysts had already expired by the time
// anyone looked. This writes a durable COPY to the 25 GB volume so those lines
// survive. It is a copy, not a redirect — every byte is still passed through to
// the real stdout, so `fly logs` is completely unchanged.
//
// Wired from entrypoint.sh via bash process substitution:
//
//     exec node src/index.js > >(exec node /app/scripts/log-tee.js) 2>&1
//
// NOT `node src/index.js | log-tee`. A pipe makes the *shell* PID 1, so Fly's
// `kill_signal = "SIGINT"` (fly.toml) would land on bash instead of the bot and
// the graceful-shutdown path that finishes in-flight pipeline work would never
// run. Process substitution keeps node as PID 1 and preserves signal delivery.
// (The batch-style sibling app reached the opposite conclusion because it has no
// in-flight work to drain; this app does.)
//
// THE PRIME DIRECTIVE: this process must never be able to take the bot down.
// It sits on the other end of the bot's stdout pipe, so if it dies, the next
// write from the bot raises EPIPE/SIGPIPE and kills a running pipeline. Every
// failure mode here — disk full, bad permissions, rotation error, unexpected
// throw — degrades to plain pass-through and keeps draining stdin forever.
// Nothing in this file is allowed to exit early on an error.

'use strict';

const fs = require('fs');
const path = require('path');

const LOG_FILE = process.env.BP_LOG_TEE_FILE || '/data/logs/app.log';
// 64 MB x (1 live + 5 rotated) = ~384 MB worst case against a 25 GB volume.
const MAX_BYTES = intFromEnv('BP_LOG_TEE_MAX_BYTES', 64 * 1024 * 1024);
const KEEP = intFromEnv('BP_LOG_TEE_KEEP', 5);

function intFromEnv(name, fallback) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// --- self-test -------------------------------------------------------------
// entrypoint.sh runs `--selftest` BEFORE committing to the process substitution.
// If the volume is unwritable (the ownership class of failure that has bitten
// this container before) we want to find out while we can still fall back to a
// plain `exec node src/index.js`, rather than after the bot's stdout is already
// wired to a writer that cannot function.
if (process.argv.includes('--selftest')) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    // Exercise the exact syscalls rotation needs: create, rename, unlink.
    const probe = `${LOG_FILE}.probe`;
    fs.writeFileSync(probe, 'probe\n');
    fs.renameSync(probe, `${probe}.1`);
    fs.unlinkSync(`${probe}.1`);
    fs.closeSync(fs.openSync(LOG_FILE, 'a'));
    process.exit(0);
  } catch (err) {
    process.stderr.write(`[log-tee] selftest failed: ${err.message}\n`);
    process.exit(1);
  }
}

// --- state -----------------------------------------------------------------

let fd = null;
let size = 0;
let degraded = false;

// One-way latch into pass-through-only mode. Called from every fs failure path.
// We deliberately keep reading stdin after this: dropping the reader is what
// would EPIPE the bot.
function degrade(err) {
  if (degraded) return;
  degraded = true;
  try {
    if (fd !== null) fs.closeSync(fd);
  } catch { /* already broken; nothing to salvage */ }
  fd = null;
  // Goes to the real stdout, so the reason is visible in `fly logs` even though
  // the durable copy is exactly what just stopped working.
  safeStdout(`[log-tee] file logging disabled (${err && err.message}); `
    + 'passing through to stdout only\n');
}

function safeStdout(chunk) {
  try {
    process.stdout.write(chunk);
  } catch { /* real stdout is gone; nothing we can do, and not worth dying for */ }
}

function open() {
  if (degraded) return;
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fd = fs.openSync(LOG_FILE, 'a');
    size = fs.fstatSync(fd).size; // resume the existing file across restarts
  } catch (err) {
    degrade(err);
  }
}

// app.log -> app.log.1 -> ... -> app.log.<KEEP>, oldest pruned.
function rotate() {
  try {
    if (fd !== null) fs.closeSync(fd);
    fd = null;
    try {
      fs.unlinkSync(`${LOG_FILE}.${KEEP}`);
    } catch { /* nothing to prune on the first few rotations */ }
    for (let i = KEEP - 1; i >= 1; i--) {
      try {
        fs.renameSync(`${LOG_FILE}.${i}`, `${LOG_FILE}.${i + 1}`);
      } catch { /* that generation does not exist yet */ }
    }
    fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
    fd = fs.openSync(LOG_FILE, 'a');
    size = 0;
  } catch (err) {
    degrade(err);
  }
}

function append(chunk) {
  if (degraded || fd === null) return;
  try {
    // Roll before writing so the cap is a real ceiling. `size > 0` stops a chunk
    // larger than MAX_BYTES from rotating an empty file on every write.
    if (size > 0 && size + chunk.length > MAX_BYTES) rotate();
    if (degraded || fd === null) return;
    size += fs.writeSync(fd, chunk);
  } catch (err) {
    degrade(err);
  }
}

// --- signals ---------------------------------------------------------------
// Fly signals PID 1 (node), but a signal delivered to the whole process group
// would otherwise kill this writer mid-shutdown — and the graceful-shutdown path
// is exactly the output we most want on disk. Ignore the shutdown signals and
// exit only on stdin EOF, which is the bot's stdout actually closing.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  try {
    process.on(sig, () => {});
  } catch { /* signal not supported on this platform */ }
}

// Last-resort net: a throw from anywhere must not become a dead reader.
process.on('uncaughtException', (err) => degrade(err));
process.stdout.on('error', () => {});
process.stdin.on('error', () => {});

// --- main ------------------------------------------------------------------

open();

process.stdin.on('data', (chunk) => {
  safeStdout(chunk); // pass-through first: `fly logs` must never lose a byte
  append(chunk);
});

process.stdin.on('end', () => {
  try {
    if (fd !== null) fs.closeSync(fd);
  } catch { /* closing a broken fd changes nothing */ }
});
