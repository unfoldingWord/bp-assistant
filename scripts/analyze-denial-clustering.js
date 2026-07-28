#!/usr/bin/env node
// analyze-denial-clustering.js — answer issue #292's "suggested first step"
// from the durable run logs, instead of by hand.
//
//   node scripts/analyze-denial-clustering.js [runLogDir] [--pad-min N] [--json]
//
// Defaults to $BP_RUN_LOG_DIR, then /data/run-logs (the Fly volume mount).
//
// #292 asks: "pull the denial timestamps for every affected run and check
// whether they cluster into windows that also contain healthy runs of OTHER
// skills. If the refusals are time-clustered rather than skill-correlated,
// close this and put the effort into survivability instead."
//
// That is a control-group question, and doing it by eye is how the issue's own
// evidence table ended up perfectly collinear (every deep-issue-id run inside a
// denial window, every other-skill run outside one) — a sample that cannot
// distinguish the two hypotheses no matter how carefully it is read. This
// prints the verdict AND the controls it rests on, and says INCONCLUSIVE rather
// than guessing when no control overlapped.
//
// Read-only: opens run logs, touches no running pipeline.

'use strict';

const { loadRunLogs, assessClustering, formatReport, DEFAULT_PAD_MS } = require('../src/denial-clustering');

function main(argv) {
  const args = argv.slice(2);
  let dir = null;
  let padMs = DEFAULT_PAD_MS;
  let asJson = false;

  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--json') asJson = true;
    else if (a === '--pad-min') {
      const n = Number(args[i + 1]);
      if (!Number.isFinite(n) || n < 0) {
        console.error(`--pad-min needs a non-negative number, got: ${args[i + 1]}`);
        return 2;
      }
      padMs = n * 60 * 1000;
      i += 1;
    } else if (a === '-h' || a === '--help') {
      console.log('usage: analyze-denial-clustering.js [runLogDir] [--pad-min N] [--json]');
      return 0;
    } else if (a.startsWith('-')) {
      console.error(`unknown flag: ${a}`);
      return 2;
    } else dir = a;
  }

  dir = dir || process.env.BP_RUN_LOG_DIR || '/data/run-logs';
  const runs = loadRunLogs(dir);
  if (runs.length === 0) {
    console.error(`no run logs found under ${dir}`);
    return 1;
  }
  const assessment = assessClustering(runs, { padMs });
  console.log(asJson ? JSON.stringify(assessment, null, 2) : formatReport(assessment));
  return 0;
}

if (require.main === module) process.exit(main(process.argv));

module.exports = { main };
