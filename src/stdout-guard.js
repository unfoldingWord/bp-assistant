// stdout-guard.js — keep a broken stdout/stderr pipe from killing the bot (#290).
//
// Since #290 the container wires the bot's stdout through a durable rotating
// copy (scripts/log-tee.js) using process substitution. That writer is built so
// it cannot die on its own — every file error degrades it to pass-through — but
// "cannot die on its own" is not the same as "cannot be killed". If someone
// SIGKILLs it, the volume is force-unmounted, or the reader is otherwise torn
// away, the bot's very next console.log gets EPIPE on process.stdout.
//
// Node ignores SIGPIPE, so the failure surfaces as an 'error' event on the
// stream instead of a signal. An unhandled 'error' on process.stdout throws,
// becomes an uncaughtException, and exits the process — which under fly.toml's
// `restart.policy = "always"` would restart the bot in the middle of a pipeline
// run. A logging sidecar must never be able to do that, so we swallow it: the
// durable copy and even `fly logs` are worth strictly less than the in-flight
// work, and losing log output is the correct degradation.

'use strict';

function installStdoutEpipeGuard(streams) {
  const targets = streams || [process.stdout, process.stderr];
  for (const stream of targets) {
    if (!stream || typeof stream.on !== 'function') continue;
    // Deliberately swallows every error, not just EPIPE. There is no useful
    // recovery for a dead output stream, and re-throwing anything here would
    // reintroduce exactly the process-killing path this exists to close.
    stream.on('error', () => {});
  }
}

module.exports = { installStdoutEpipeGuard };
