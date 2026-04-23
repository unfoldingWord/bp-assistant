#!/usr/bin/env node
// door43-push-cli.js — CLI wrapper around door43Push() for use by Claude skills
//
// Usage:
//   node door43-push-cli.js --type tn --book PSA --chapter 30 \
//     --username deferredreward --branch AI-PSA-030 \
//     --source output/notes/PSA/PSA-030.tsv [--verses 1-20]
//
// Outputs JSON to stdout. Exit codes: 0 = success, 1 = push failed, 2 = bad args.

const { door43Push } = require('./door43-push');

function printUsage() {
  console.error(`Usage: node door43-push-cli.js [options]

Required:
  --type <tn|tq|ult|ust> Content type
  --book <BOOK>          3-letter book code (e.g. PSA)
  --chapter <N>          Chapter number
  --username <name>      Door43 username
  --branch <name>        Staging branch name (e.g. AI-PSA-030)
  --source <path>        Path to source file (relative to workspace)

Optional:
  --verses <range>       Verse range (e.g. 1-20). Auto-computed if omitted.
  --help                 Show this help message`);
}

function parseArgs(argv) {
  const args = {};
  const tokens = argv.slice(2);

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '--help' || token === '-h') {
      printUsage();
      process.exit(0);
    }
    if (token.startsWith('--') && i + 1 < tokens.length) {
      const key = token.slice(2);
      args[key] = tokens[++i];
    }
  }

  const required = ['type', 'book', 'chapter', 'username', 'branch', 'source'];
  const missing = required.filter(k => !args[k]);
  if (missing.length > 0) {
    console.error(`Error: missing required arguments: ${missing.join(', ')}`);
    printUsage();
    process.exit(2);
  }

  return {
    type: args.type,
    book: args.book.toUpperCase(),
    chapter: parseInt(args.chapter, 10),
    username: args.username,
    branch: args.branch,
    source: args.source,
    verses: args.verses || undefined,
  };
}

async function main() {
  const opts = parseArgs(process.argv);

  // Suppress console.log/warn/error from door43Push — capture only JSON output
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const logs = [];

  console.log = (...args) => logs.push(['log', args.join(' ')]);
  console.warn = (...args) => logs.push(['warn', args.join(' ')]);
  console.error = (...args) => logs.push(['error', args.join(' ')]);

  try {
    const result = await door43Push(opts);

    // Restore console for final output
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;

    // Write logs to stderr so they don't pollute JSON stdout
    for (const [level, msg] of logs) {
      process.stderr.write(`[${level}] ${msg}\n`);
    }

    // Write JSON result to stdout
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(result.success ? 0 : 1);
  } catch (err) {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;

    for (const [level, msg] of logs) {
      process.stderr.write(`[${level}] ${msg}\n`);
    }

    const result = { success: false, details: err.message };
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(1);
  }
}

main();
