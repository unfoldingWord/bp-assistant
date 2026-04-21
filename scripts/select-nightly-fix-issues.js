#!/usr/bin/env node

const {
  fetchNightlyFixIssues,
  selectNightlyFixIssues,
} = require('../src/nightly-fix-issues');

function parseLimit(argv) {
  const index = argv.indexOf('--limit');
  if (index === -1) return null;
  const raw = argv[index + 1];
  if (raw == null || raw === '' || raw.toLowerCase() === 'all') return null;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Invalid --limit value: ${raw}`);
  }
  return value;
}

async function main() {
  const limit = parseLimit(process.argv.slice(2));
  const issuesByRepo = fetchNightlyFixIssues();
  const selection = selectNightlyFixIssues(issuesByRepo, { limit });
  process.stdout.write(`${JSON.stringify(selection, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
