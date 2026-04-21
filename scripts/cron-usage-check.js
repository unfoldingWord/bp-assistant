#!/usr/bin/env node
// Check Codex CLI 5h usage (via codex-cli-usage) and Anthropic API rate limit
// headers to decide which provider to use for the next cron issue run.
// Prints one JSON line to stdout, always exits 0.
'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

const HEADROOM_MIN_PCT = Number(process.env.CRON_HEADROOM_MIN_PCT ?? 20);

// codex-cli-usage is installed to ~/.local/bin by pip --user
const CODEX_USAGE_BIN = process.env.CODEX_CLI_USAGE_BIN
  || path.join(process.env.HOME || '/home/ubuntu', '.local/bin/codex-cli-usage');


// Check Codex CLI 5h window usage via codex-cli-usage json.
// Returns { maxed, pct (remaining), resetsAt, reason? }
function checkCodex() {
  try {
    const raw = execFileSync(CODEX_USAGE_BIN, ['json'], { timeout: 10000, encoding: 'utf8' });
    const data = JSON.parse(raw);
    const used5h = data?.['5h']?.pct ?? 0;   // % of window consumed
    const remaining = 100 - used5h;           // % still available
    const resetsAt = data?.['5h']?.resets_at ?? null;
    return { maxed: remaining < HEADROOM_MIN_PCT, pct: remaining, resetsAt };
  } catch (err) {
    process.stderr.write(`[cron-usage-check] codex-cli-usage error: ${err.message}\n`);
    return { maxed: true, reason: err.message };
  }
}

// Check Claude Code 5h headroom via the same ccusage data the desktop app shows.
// Returns { maxed, pct (remaining), headroom, budget, reason? }
async function checkClaude() {
  try {
    const { getHeadroom } = require('../src/usage-tracker');
    const room = await getHeadroom();
    const pct = room.budget > 0 ? Math.round((room.headroom / room.budget) * 100) : 0;
    return { maxed: pct < HEADROOM_MIN_PCT, pct, headroom: room.headroom, budget: room.budget };
  } catch (err) {
    process.stderr.write(`[cron-usage-check] Claude headroom check error: ${err.message}\n`);
    return { maxed: true, reason: err.message };
  }
}

async function main() {
  // Run both checks concurrently
  const [codex, claude] = await Promise.all([
    Promise.resolve(checkCodex()),
    checkClaude(),
  ]);

  let result;
  if (!codex.maxed) {
    result = {
      provider: 'openai',
      model: 'gpt-5.4-mini',
      codexPct: codex.pct,
      codexResetsAt: codex.resetsAt,
    };
  } else if (!claude.maxed) {
    result = {
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      claudePct: claude.pct,
      claudeHeadroom: claude.headroom,
      codexReason: codex.reason || `${codex.pct}% remaining (below ${HEADROOM_MIN_PCT}% threshold)`,
      codexResetsAt: codex.resetsAt,
    };
  } else {
    result = {
      provider: 'skip',
      reason: `Both near limit: Codex ${codex.pct ?? '?'}% remaining, Claude ${claude.pct ?? '?'}% remaining`,
      codexPct: codex.pct,
      claudePct: claude.pct,
      codexResetsAt: codex.resetsAt,
    };
  }

  process.stdout.write(JSON.stringify(result) + '\n');
}

main().catch((err) => {
  process.stderr.write(`[cron-usage-check] Fatal: ${err.message}\n`);
  // On unexpected failure, skip rather than burn quota on a broken check
  process.stdout.write(JSON.stringify({ provider: 'skip', reason: `check failed: ${err.message}` }) + '\n');
});
