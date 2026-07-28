#!/usr/bin/env node
// Rotating tee: copies stdin to stdout unchanged AND appends it to a file on the
// Fly volume, so logs survive past Fly's short live-tail retention.
//
// Usage: <cmd> 2>&1 | node scripts/log-tee.js /data/logs/app.log
//   or:  <cmd> > >(node scripts/log-tee.js /data/logs/app.log) 2>&1
//
// Rotation: when the file exceeds LOG_TEE_MAX_BYTES it becomes app.log.1,
// app.log.1 becomes app.log.2, and so on up to LOG_TEE_KEEP files.
//
// Retention: rotated siblings (app.log.1, .2, ...) older than
// LOG_TEE_MAX_AGE_DAYS (default 30) are pruned at startup and after each
// rotation. The active file (app.log itself) is never pruned or truncated by
// age — only rotated siblings are ever removed this way.
//
// This must never take the bot down. Any file error (disk full, bad perms) is
// reported once to stderr and then swallowed; stdin keeps draining to stdout.
// Likewise, if stdout itself breaks (EPIPE/EIO — the downstream reader is
// gone), we stop writing to it but keep draining stdin and keep appending to
// the log file. We deliberately do NOT exit here: this script sits between an
// upstream producer and this pipe in a shell pipeline (producer | log-tee),
// and exiting would close the pipe's read end, sending the producer SIGPIPE
// and corrupting its real exit code (as seen via bash PIPESTATUS). Staying
// alive and draining stdin keeps the producer's exit code intact and keeps
// the one surviving copy of the logs — the file — flowing.

const fs = require('fs');
const path = require('path');

const target = process.argv[2];
if (!target) {
  process.stderr.write('[log-tee] usage: log-tee.js <logfile>\n');
  process.exit(2);
}

const MAX_BYTES = Number(process.env.LOG_TEE_MAX_BYTES) || 50 * 1024 * 1024;
const KEEP = Number(process.env.LOG_TEE_KEEP) || 5;
const MAX_AGE_DAYS = Number(process.env.LOG_TEE_MAX_AGE_DAYS) || 30;
const MAX_AGE_MS = MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

let broken = false;
let size = 0;

function fail(err) {
  if (!broken) {
    broken = true;
    process.stderr.write(`[log-tee] disabling file logging: ${err.message}\n`);
  }
}

// Removes rotated siblings (<target>.1, .2, ...) whose mtime is older than
// MAX_AGE_MS. Never touches the active target file. Cheap to call only at
// startup and after each rotation — never per-chunk.
function pruneOldRotated() {
  if (!(MAX_AGE_MS > 0)) return;
  try {
    const dir = path.dirname(target);
    const base = path.basename(target);
    const cutoff = Date.now() - MAX_AGE_MS;
    const entries = fs.readdirSync(dir);
    for (const name of entries) {
      if (!name.startsWith(`${base}.`)) continue;
      const suffix = name.slice(base.length + 1);
      if (!/^\d+$/.test(suffix)) continue; // only numbered rotated siblings
      const full = path.join(dir, name);
      try {
        const st = fs.statSync(full);
        if (st.mtimeMs < cutoff) fs.unlinkSync(full);
      } catch {
        /* vanished mid-scan or transient error — skip it, never fail the run */
      }
    }
  } catch {
    /* directory unreadable or similar — pruning is best-effort only */
  }
}

function rotate() {
  fs.closeSync(fd);
  for (let i = KEEP - 1; i >= 1; i--) {
    try {
      fs.renameSync(`${target}.${i}`, `${target}.${i + 1}`);
    } catch {
      /* missing rung — nothing to shift */
    }
  }
  fs.renameSync(target, `${target}.1`);
  fd = fs.openSync(target, 'a');
  size = 0;
  pruneOldRotated();
}

let fd;
try {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fd = fs.openSync(target, 'a');
  size = fs.fstatSync(fd).size;
} catch (err) {
  fail(err);
}
pruneOldRotated();

// stdout backpressure: when a downstream reader (Fly's log collector, a
// terminal, whatever) drains slower than the producer emits, write() returns
// false. Pausing stdin until 'drain' lets the OS pipe throttle the producer
// the same way it would without log-tee in between, instead of log-tee
// queuing unbounded data in its own heap while it keeps draining stdin.
let stdoutBroken = false;

// Marks stdout as unusable and makes sure stdin keeps flowing. If stdin was
// paused waiting for a 'drain' that will now never come (the stream we were
// waiting on is dead), resume it — otherwise the pipe would stall forever
// instead of continuing to drain into the log file.
function markStdoutBroken() {
  if (stdoutBroken) return;
  stdoutBroken = true;
  try {
    process.stdin.resume();
  } catch {
    /* already gone */
  }
}

// If stdout itself breaks (EPIPE/EIO — the reader on the other end is gone),
// there's nothing useful left to do with stdout. Without this handler an
// 'error' event with no listener throws and crashes the process; swallow it
// and fall back to file-only logging instead of exiting — see the header
// comment for why exiting here would be actively harmful.
process.stdout.on('error', (err) => {
  if (err && (err.code === 'EPIPE' || err.code === 'EIO')) {
    markStdoutBroken();
  }
});

// stdin can likewise raise EPIPE/EIO in edge cases; swallow rather than let
// an unhandled 'error' event throw. 'end'/'close' handle exit.
process.stdin.on('error', () => {
  /* nothing useful to do here; 'end'/'close' handle exit */
});

process.stdin.on('data', (chunk) => {
  if (!stdoutBroken) {
    const ok = process.stdout.write(chunk);
    if (!ok) {
      process.stdin.pause();
      process.stdout.once('drain', () => {
        if (!stdoutBroken) process.stdin.resume();
      });
    }
  }

  if (broken) return;
  try {
    fs.writeSync(fd, chunk);
    size += chunk.length;
    if (size >= MAX_BYTES) rotate();
  } catch (err) {
    fail(err);
  }
});

process.stdin.on('end', () => {
  if (!broken) {
    try {
      fs.closeSync(fd);
    } catch {
      /* already gone */
    }
  }
});
