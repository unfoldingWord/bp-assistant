#!/usr/bin/env node
// workspace-tools-cli.js — Bash CLI over the workspace-tools registry
//
// The primary invocation path for pipeline agents (the in-process MCP server
// remains registered as a fallback). Dispatches to the SAME handler functions
// the MCP server calls, so results and on-disk artifacts (tmp/alignments
// batch naming, output/ paths, TSV formats) are byte-identical to the MCP
// path — the pipeline's Node-side salvage/coverage machinery keeps working
// unchanged.
//
// Usage:
//   node /app/src/workspace-tools-cli.js <tool_name> '<json-args>'
//   node /app/src/workspace-tools-cli.js <tool_name> -      # JSON args on stdin (heredoc)
//   node /app/src/workspace-tools-cli.js <tool_name>        # no args -> {}
//   node /app/src/workspace-tools-cli.js --list             # enumerate CLI-exposed tools
//
// stdout: exactly the text the MCP tool would return (strings verbatim,
//         objects JSON.stringify'd) — mirrors asTextToolResult in
//         workspace-tools/index.js. Tools that report failures as normal
//         "Error: ..." result strings keep exit code 0, same as MCP.
// stderr: thrown-error messages prefixed "ERROR:".
// Exit codes (door43-push-cli.js convention): 0 = handler returned,
//         1 = handler threw, 2 = usage error (unknown tool / bad JSON).
//
// Workspace root comes from CSKILLBP_DIR (set in the Fly image / fly.toml and
// inherited by Bash children of the SDK subprocess). For local testing:
//   CSKILLBP_DIR=$PWD node src/workspace-tools-cli.js --list

const { TOOLS, cliToolNames } = require('./workspace-tools/registry');

// Mirrors asTextToolResult in workspace-tools/index.js.
function formatResult(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return JSON.stringify(value, null, 2);
}

function printUsage(stream) {
  stream.write(`Usage: node workspace-tools-cli.js <tool_name> ['<json-args>' | -]
       node workspace-tools-cli.js --list

Pass tool arguments as a single JSON object. Use "-" to read the JSON from
stdin (heredoc) when args contain quotes. Omit for tools that take no args.

Available tools:
  ${cliToolNames().join('\n  ')}
`);
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

async function main() {
  const [, , toolName, rawArgs, ...extra] = process.argv;

  if (!toolName || toolName === '--help' || toolName === '-h') {
    printUsage(toolName ? process.stdout : process.stderr);
    process.exit(toolName ? 0 : 2);
  }
  if (toolName === '--list') {
    process.stdout.write(`${cliToolNames().join('\n')}\n`);
    process.exit(0);
  }
  if (extra.length) {
    process.stderr.write(`ERROR: unexpected extra arguments: ${extra.join(' ')}\n`);
    printUsage(process.stderr);
    process.exit(2);
  }

  const entry = TOOLS[toolName];
  if (!entry || entry.cli === false) {
    process.stderr.write(`ERROR: ${entry ? `tool not CLI-exposed: ${toolName}` : `unknown tool: ${toolName}`}\n`);
    printUsage(process.stderr);
    process.exit(2);
  }

  let json = rawArgs;
  if (json === '-') json = await readStdin();
  let args = {};
  if (json != null && json.trim() !== '') {
    try {
      args = JSON.parse(json);
    } catch (err) {
      process.stderr.write(`ERROR: malformed JSON args: ${err.message}\n`);
      process.exit(2);
    }
    if (args === null || typeof args !== 'object' || Array.isArray(args)) {
      process.stderr.write('ERROR: JSON args must be an object, e.g. \'{"lookup":"H4869"}\'\n');
      process.exit(2);
    }
  }

  try {
    const result = await entry.handler(args);
    process.stdout.write(`${formatResult(result)}\n`);
    process.exit(0);
  } catch (err) {
    process.stderr.write(`ERROR: ${err && err.message ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`ERROR: ${err && err.message ? err.message : String(err)}\n`);
  process.exit(1);
});
