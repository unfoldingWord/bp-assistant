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
// gone), there is nothing useful left to do, so we exit quietly instead of
// crashing noisily or taking the parent down.

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

function exitQuietly() {
  if (stdoutBroken) return;
  stdoutBroken = true;
  try {
    process.stdin.pause();
  } catch {
    /* already gone */
  }
  try {
    process.stdin.destroy();
  } catch {
    /* already gone */
  }
  process.exit(0);
}

// If stdout itself breaks (EPIPE/EIO — the reader on the other end is gone),
// there's nothing useful left to do. Without this handler an 'error' event
// with no listener throws and crashes the process; swallow it and exit
// quietly instead, so a dead downstream reader can never take the parent down.
process.stdout.on('error', (err) => {
  if (err && (err.code === 'EPIPE' || err.code === 'EIO')) {
    exitQuietly();
  }
});

// stdin can likewise raise EPIPE/EIO in edge cases; swallow rather than let
// an unhandled 'error' event throw.
process.stdin.on('error', () => {
  /* nothing useful to do here; 'end'/'close' (or exitQuietly) handle exit */
});

process.stdin.on('data', (chunk) => {
  if (stdoutBroken) return;

  const ok = process.stdout.write(chunk);
  if (!ok) {
    process.stdin.pause();
    process.stdout.once('drain', () => {
      if (!stdoutBroken) process.stdin.resume();
    });
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
