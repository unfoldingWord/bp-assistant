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
// This must never take the bot down. Any file error (disk full, bad perms) is
// reported once to stderr and then swallowed; stdin keeps draining to stdout.

const fs = require('fs');
const path = require('path');

const target = process.argv[2];
if (!target) {
  process.stderr.write('[log-tee] usage: log-tee.js <logfile>\n');
  process.exit(2);
}

const MAX_BYTES = Number(process.env.LOG_TEE_MAX_BYTES) || 50 * 1024 * 1024;
const KEEP = Number(process.env.LOG_TEE_KEEP) || 5;

let broken = false;
let size = 0;

function fail(err) {
  if (!broken) {
    broken = true;
    process.stderr.write(`[log-tee] disabling file logging: ${err.message}\n`);
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
}

let fd;
try {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fd = fs.openSync(target, 'a');
  size = fs.fstatSync(fd).size;
} catch (err) {
  fail(err);
}

process.stdin.on('data', (chunk) => {
  process.stdout.write(chunk);
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
