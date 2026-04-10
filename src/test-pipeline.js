#!/usr/bin/env node
// test-pipeline.js — Simulate a full pipeline run locally without Zulip
//
// Usage:
//   node src/test-pipeline.js "write notes LAM 2:4-5"              # real Opus run
//   node src/test-pipeline.js "write notes LAM 2:4-5" --fast       # Haiku instead of Opus
//   node src/test-pipeline.js "write notes LAM 2:4-5" --dry-run    # no Claude calls, stub files
//   node src/test-pipeline.js "write notes LAM 2:4-5" --fast --dry-run
//   node src/test-pipeline.js "api generate LAM 2:4-5" --provider openai --dry-run

// --- Parse CLI args before any requires ---
const messageText = process.argv.find((a, i) => i >= 2 && !a.startsWith('--'));
const flags = new Set(process.argv.slice(2).filter(a => a.startsWith('--')));
const providerFlagIndex = process.argv.findIndex((a) => a === '--provider');
const providerOverride = providerFlagIndex >= 0 ? process.argv[providerFlagIndex + 1] : null;

if (!messageText) {
  console.error('Usage: node src/test-pipeline.js "<message text>" [--fast] [--dry-run] [--provider <name>]');
  console.error('  --fast      Use Haiku instead of Opus (sets TEST_FAST=1)');
  console.error('  --dry-run   Skip all Claude calls, create stub files (sets DRY_RUN=1)');
  console.error('  --provider  Run through api-runner for the given provider');
  process.exit(1);
}

if (flags.has('--dry-run')) process.env.DRY_RUN = '1';
if (flags.has('--fast'))    process.env.TEST_FAST = '1';

// --- Stub zulip-client before anything imports it ---
const zulipStub = {
  getClient:      async () => ({}),
  sendMessage:    async (stream, topic, content) => console.log(`[ZULIP] sendMessage(${stream}, ${topic}): ${content}`),
  sendDM:         async (userId, content) => console.log(`[ZULIP] sendDM(${userId}): ${content}`),
  getStreamId:    async () => 1,
  addReaction:    async (msgId, emoji) => console.log(`[ZULIP] addReaction(${msgId}, ${emoji})`),
  removeReaction: async (msgId, emoji) => console.log(`[ZULIP] removeReaction(${msgId}, ${emoji})`),
  uploadFile:     async () => '/user_uploads/stub.txt',
};

const Module = require('module');
const path = require('path');
const zulipPath = require.resolve('./zulip-client');
require.cache[zulipPath] = {
  id: zulipPath,
  filename: zulipPath,
  loaded: true,
  exports: zulipStub,
  parent: null,
  children: [],
  paths: Module._nodeModulePaths(path.dirname(zulipPath)),
};

// --- Now load config and router ---
const config = require('./config');
const { routeMessage } = require('./router');
const { runSkill } = require('./api-runner/runner');

// --- Build fake message ---
const fakeMessage = {
  id: 99999,
  sender_id: config.adminUserId,
  sender_email: 'user249849@unfoldingword.zulipchat.com',
  sender_full_name: 'Local Test',
  display_recipient: config.channel,
  subject: 'Bot testing',
  content: messageText,
  type: 'stream',
};

console.log(`\n${'='.repeat(60)}`);
console.log(`  test-pipeline`);
console.log(`  message: "${messageText}"`);
console.log(`  DRY_RUN: ${process.env.DRY_RUN || '0'}`);
console.log(`  TEST_FAST: ${process.env.TEST_FAST || '0'}`);
console.log(`  PROVIDER: ${providerOverride || '(default route)'}`);
console.log(`${'='.repeat(60)}\n`);

// --- Run: send message, then auto-confirm after brief delay ---
(async () => {
  if (providerOverride) {
    const apiRoute = config.routes.find((route) => route.type === 'api');
    const apiSkillSpec = apiRoute?.skill || 'initial-pipeline';
    const [skillName, ...skillArgs] = apiSkillSpec.trim().split(/\s+/);
    const routeRegex = apiRoute?.match ? new RegExp(apiRoute.match.slice(1, apiRoute.match.lastIndexOf('/')), apiRoute.match.slice(apiRoute.match.lastIndexOf('/') + 1)) : null;
    const capture = routeRegex ? messageText.match(routeRegex)?.[1] : null;
    const prompt = `${skillArgs.join(' ')} ${capture || messageText}`.trim();
    const result = await runSkill(skillName || 'initial-pipeline', prompt, {
      provider: providerOverride,
      dryRun: process.env.DRY_RUN === '1',
      cwd: '/srv/bot/workspace',
      verbose: true,
    });
    console.log('\n[test-pipeline] API runner result:\n');
    console.log(result.finalText || '(no final text)');
    return;
  }

  // Step 1: send the command — triggers confirmation prompt
  await routeMessage(fakeMessage);

  // Step 2: auto-confirm after 500ms
  await new Promise(r => setTimeout(r, 500));
  const yesMessage = {
    ...fakeMessage,
    id: 100000,
    content: 'yes',
  };
  console.log('\n[test-pipeline] Auto-confirming with "yes"...\n');
  await routeMessage(yesMessage);
})();
