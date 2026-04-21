#!/usr/bin/env node
// Claude Code SDK fallback runner for the nightly cron fix.
// Reads the full prompt from stdin, runs query() with claude-sonnet-4-6,
// streams text output to stdout. Exit 0 on success, 1 on failure.
'use strict';

const path = require('path');

const MODEL = process.env.CRON_CLAUDE_MODEL || 'claude-sonnet-4-6';
const CWD = process.env.BP_CODEX_CWD || path.resolve(__dirname, '../../..');
const MAX_TURNS = Number(process.env.CRON_MAX_TURNS || 200);
const TIMEOUT_MS = Number(process.env.CRON_TIMEOUT_MS || 60 * 60 * 1000); // 1h default

async function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

async function main() {
  const prompt = await readStdin();
  if (!prompt.trim()) {
    process.stderr.write('[cron-sdk-run] No prompt received on stdin\n');
    process.exit(1);
  }

  const { query } = await import('@anthropic-ai/claude-agent-sdk');

  const abortController = new AbortController();
  const timer = setTimeout(() => {
    process.stderr.write(`[cron-sdk-run] Timeout after ${TIMEOUT_MS / 1000}s — aborting\n`);
    abortController.abort();
  }, TIMEOUT_MS);

  const options = {
    cwd: CWD,
    model: MODEL,
    maxTurns: MAX_TURNS,
    permissionMode: 'bypassPermissions',
    abortController,
  };

  let turnCount = 0;
  try {
    for await (const message of query({ prompt, options })) {
      if (message.type === 'assistant' && message.message?.content) {
        for (const block of message.message.content) {
          if ('text' in block && block.text) {
            process.stdout.write(block.text + '\n');
          } else if ('name' in block) {
            turnCount++;
            process.stderr.write(`[cron-sdk-run] Tool: ${block.name} (turn ${turnCount})\n`);
          }
        }
      } else if (message.type === 'result') {
        const cost = message.total_cost_usd != null ? ` cost=$${message.total_cost_usd.toFixed(4)}` : '';
        process.stderr.write(`[cron-sdk-run] Done — ${turnCount} turns${cost}\n`);
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

main().catch((err) => {
  process.stderr.write(`[cron-sdk-run] Fatal: ${err.stack || err.message}\n`);
  process.exit(1);
});
