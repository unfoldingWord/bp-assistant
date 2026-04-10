#!/usr/bin/env node
// cli.js — Entry point for the multi-provider API runner
// Usage:
//   node src/api-runner/cli.js --provider gemini --skill ULT-gen --prompt "PSA 133"
//   node src/api-runner/cli.js --provider gemini --pipeline initial-pipeline --prompt "PSA 133"

const path = require('path');
const { readSecret } = require('../secrets');
const { getProviderNames, getProviderConfig } = require('./provider-config');

// Load env from bot config
try {
  require('dotenv').config({ path: path.resolve(__dirname, '../../../config/.env') });
} catch {
  // dotenv not critical if env vars are set in shell
}

const { runSkill, runCustom } = require('./runner');
let orchestrations = {};
try {
  ({ orchestrations } = require('./orchestrations/index'));
} catch {
  orchestrations = {};
}

// --- Argument Parsing ---

function parseArgs(argv) {
  const args = {
    provider: 'gemini',
    model: null,
    thinking: 'medium',
    skill: null,
    pipeline: null,
    prompt: null,
    toolChoice: null,
    maxTurns: 100,
    timeout: 30,
    cwd: '/srv/bot/workspace',
    dryRun: false,
    verbose: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--provider': args.provider = argv[++i]; break;
      case '--model': args.model = argv[++i]; break;
      case '--thinking': args.thinking = argv[++i]; break;
      case '--skill': args.skill = argv[++i]; break;
      case '--pipeline': args.pipeline = argv[++i]; break;
      case '--prompt': args.prompt = argv[++i]; break;
      case '--tool-choice': args.toolChoice = argv[++i]; break;
      case '--max-turns': args.maxTurns = parseInt(argv[++i], 10); break;
      case '--timeout': args.timeout = parseInt(argv[++i], 10); break;
      case '--cwd': args.cwd = argv[++i]; break;
      case '--dry-run': args.dryRun = true; break;
      case '--verbose': args.verbose = true; break;
      default:
        // If no flag prefix, treat as prompt if prompt not yet set
        if (!arg.startsWith('--') && !args.prompt) {
          args.prompt = arg;
        } else if (!arg.startsWith('--')) {
          console.error(`Unknown argument: ${arg}`);
          process.exit(1);
        } else {
          console.error(`Unknown flag: ${arg}`);
          process.exit(1);
        }
    }
  }

  return args;
}

function printUsage() {
  const providerList = getProviderNames().join(', ');
  console.log(`
Multi-Provider API Runner for Workspace Skills

Usage:
  node src/api-runner/cli.js [options]

Options:
  --provider <name>     Provider: ${providerList} (default: gemini)
  --model <id>          Model ID (provider-specific, default: provider flagship)
  --thinking <level>    Thinking level: low, medium, high, max (default: medium)
  --skill <name>        Single skill name from workspace
  --pipeline <name>     Orchestration name
  --prompt <text>       User message / book+chapter (required)
  --tool-choice <mode>  Tool choice: auto, required, none (default: provider default)
  --max-turns <n>       Max agentic loop iterations per skill (default: 100)
  --timeout <min>       Minutes per skill run before abort (default: 30)
  --cwd <path>          Working directory for tools (default: /srv/bot/workspace)
  --dry-run             Print system prompt + first request, don't call API
  --verbose             Show full tool call/result details

Examples:
  node src/api-runner/cli.js --provider gemini --skill ULT-gen --prompt "PSA 133"
  node src/api-runner/cli.js --provider openai --pipeline initial-pipeline --prompt "PSA 133"
  node src/api-runner/cli.js --provider xai --skill issue-identification --prompt "PSA 133" --thinking high

Pipelines:
  initial-pipeline      ULT → issues (adversarial) → UST
  deep-issue-id         Adversarial issue ID against human ULT/UST
  parallel-batch        Chunk long chapters → parallel tn-writer → merge
  align-all-parallel    ULT + UST alignment in parallel
  makeBP                Full book package: 4 phases with dependency graph
`);
}

// --- Main ---

async function main() {
  const args = parseArgs(process.argv);

  if (!args.prompt) {
    printUsage();
    console.error('\nError: --prompt is required');
    process.exit(1);
  }

  if (!args.skill && !args.pipeline) {
    printUsage();
    console.error('\nError: Either --skill or --pipeline is required');
    process.exit(1);
  }

  if (args.skill && args.pipeline) {
    console.error('Error: Specify either --skill or --pipeline, not both');
    process.exit(1);
  }

  // Validate provider
  const validProviders = getProviderNames();
  if (!validProviders.includes(args.provider)) {
    console.error(`Error: Unknown provider "${args.provider}". Valid: ${validProviders.join(', ')}`);
    process.exit(1);
  }

  // Check API key
  const providerConfig = getProviderConfig(args.provider);
  const apiKey = readSecret(providerConfig.secretName, providerConfig.envName);
  if (!apiKey && !args.dryRun) {
    console.error(`Error: API key for provider "${args.provider}" is not configured in env or Docker secrets.`);
    process.exit(1);
  }

  const opts = {
    provider: args.provider,
    model: args.model,
    thinking: args.thinking,
    toolChoice: args.toolChoice,
    maxTurns: args.maxTurns,
    timeout: args.timeout,
    cwd: args.cwd,
    verbose: args.verbose,
    dryRun: args.dryRun,
  };

  console.log(`[cli] Provider: ${args.provider}, Model: ${args.model || '(default)'}, Thinking: ${args.thinking}`);
  console.log(`[cli] ${args.skill ? `Skill: ${args.skill}` : `Pipeline: ${args.pipeline}`}`);
  console.log(`[cli] Prompt: ${args.prompt}`);
  console.log('');

  const startTime = Date.now();

  try {
    let result;

    if (args.skill) {
      result = await runSkill(args.skill, args.prompt, opts);
    } else {
      const orch = orchestrations[args.pipeline];
      if (!orch) {
        console.error(`Error: Unknown pipeline "${args.pipeline}". Available: ${Object.keys(orchestrations).join(', ')}`);
        process.exit(1);
      }

      const runner = { runSkill, runCustom };
      result = await orch(runner, { prompt: args.prompt, opts });
    }

    const totalMs = Date.now() - startTime;
    console.log('');
    console.log('=== Summary ===');
    if (result.turns !== undefined) {
      console.log(`Turns: ${result.turns}`);
      console.log(`Input tokens: ${result.inputTokens}`);
      console.log(`Output tokens: ${result.outputTokens}`);
      console.log(`Estimated cost: $${result.cost?.toFixed(4) || '?'}`);
    }
    if (result.steps) {
      // Pipeline result with step summaries
      let totalCost = 0;
      let totalInput = 0;
      let totalOutput = 0;
      for (const step of result.steps) {
        totalCost += step.cost || 0;
        totalInput += step.inputTokens || 0;
        totalOutput += step.outputTokens || 0;
      }
      console.log(`Steps completed: ${result.steps.length}`);
      console.log(`Total input tokens: ${totalInput}`);
      console.log(`Total output tokens: ${totalOutput}`);
      console.log(`Total estimated cost: $${totalCost.toFixed(4)}`);
    }
    console.log(`Total duration: ${(totalMs / 1000).toFixed(1)}s`);

  } catch (err) {
    console.error(`\n[cli] Fatal error: ${err.message}`);
    if (args.verbose) console.error(err.stack);
    process.exit(1);
  }
}

// Only run when invoked directly (not when require'd for testing)
if (require.main === module) {
  main();
}

module.exports = { parseArgs, main };
