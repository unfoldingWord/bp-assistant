// test-skill.js — Test a single cSkillBP skill via SDK or CLI
// Usage:
//   node src/test-skill.js --mode sdk --skill chapter-intro --prompt "PSA 117"
//   node src/test-skill.js --mode cli --skill chapter-intro --prompt "PSA 117"

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const CSKILLBP_DIR = path.resolve(__dirname, '../../cSkillBP');

// --- Parse CLI args ---
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { mode: 'cli', skill: null, prompt: null, model: 'haiku' };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--mode':  opts.mode = args[++i]; break;
      case '--skill': opts.skill = args[++i]; break;
      case '--prompt': opts.prompt = args[++i]; break;
      case '--model': opts.model = args[++i]; break;
    }
  }

  if (!opts.skill || !opts.prompt) {
    console.error('Usage: node src/test-skill.js --mode <sdk|cli> --skill <name> --prompt "<prompt>"');
    console.error('  --mode   sdk or cli (default: cli)');
    console.error('  --skill  skill name (e.g. chapter-intro, post-edit-review, tn-writer, repo-insert)');
    console.error('  --prompt prompt text (e.g. "PSA 117")');
    console.error('  --model  model name (default: haiku)');
    process.exit(1);
  }

  return opts;
}

// --- Expected output files for each skill ---
function getExpectedOutputs(skill, prompt) {
  const match = prompt.match(/(\w+)\s+(\d+)/);
  if (!match) return [];

  const book = match[1].toUpperCase();
  const ch = match[2];

  const outputs = {
    'post-edit-review': [`output/issues/${book}-${ch}.tsv`],
    'chapter-intro':    [`output/issues/${book}-${ch}.tsv`],
    'tn-writer':        [`output/notes/${book}-${ch}.tsv`],
    'repo-insert':      [],  // side-effect: git push
  };

  return (outputs[skill] || []).map(f => path.join(CSKILLBP_DIR, f));
}

// --- System prompt appendage for post-edit-review ---
const POST_EDIT_REVIEW_HINT =
  'Use Agent teams (TeamCreate + SendMessage) for the Diff Analyzer and Issue Reconciler if available. ' +
  'If Agent teams are not available, fall back to Task subagents and poll with TaskGet until all complete. ' +
  'Do NOT output text without a tool call or the session will end prematurely.';

// --- SDK mode ---
async function runSDK(opts) {
  const { runClaude } = require('./claude-runner');

  const options = {
    prompt: opts.prompt,
    cwd: CSKILLBP_DIR,
    model: opts.model,
    skill: opts.skill,
    timeoutMs: 5 * 60 * 1000,
  };

  if (opts.skill === 'post-edit-review') {
    options.appendSystemPrompt = POST_EDIT_REVIEW_HINT;
  }

  const result = await runClaude(options);
  return {
    exitCode: result?.subtype === 'success' ? 0 : 1,
    turns: result?.num_turns || 0,
    cost: result?.total_cost_usd || 0,
  };
}

// --- CLI mode ---
function runCLI(opts) {
  return new Promise((resolve) => {
    const fullPrompt = `/${opts.skill} ${opts.prompt}`;
    const args = [
      '-p', fullPrompt,
      '--model', opts.model,
      '--dangerously-skip-permissions',
    ];

    if (opts.skill === 'post-edit-review') {
      args.push('--append-system-prompt', POST_EDIT_REVIEW_HINT);
    }

    console.log(`[test-skill] Running: claude ${args.join(' ')}`);
    console.log(`[test-skill] cwd: ${CSKILLBP_DIR}`);

    const child = spawn('claude', args, {
      cwd: CSKILLBP_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => {
      const text = d.toString();
      stdout += text;
      process.stdout.write(text);
    });

    child.stderr.on('data', (d) => {
      const text = d.toString();
      stderr += text;
      process.stderr.write(text);
    });

    child.on('close', (code) => {
      resolve({ exitCode: code || 0, stdout, stderr });
    });

    child.on('error', (err) => {
      console.error(`[test-skill] Failed to start claude: ${err.message}`);
      resolve({ exitCode: 1, stdout, stderr });
    });
  });
}

// --- Main ---
async function main() {
  const opts = parseArgs();
  const expectedFiles = getExpectedOutputs(opts.skill, opts.prompt);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  test-skill: ${opts.skill}`);
  console.log(`  mode: ${opts.mode}`);
  console.log(`  prompt: ${opts.prompt}`);
  console.log(`  model: ${opts.model}`);
  console.log(`  cwd: ${CSKILLBP_DIR}`);
  if (expectedFiles.length) {
    console.log(`  expected outputs:`);
    expectedFiles.forEach(f => console.log(`    - ${path.relative(CSKILLBP_DIR, f)}`));
  }
  console.log(`${'='.repeat(60)}\n`);

  const startTime = Date.now();
  let result;

  if (opts.mode === 'sdk') {
    result = await runSDK(opts);
  } else if (opts.mode === 'cli') {
    result = await runCLI(opts);
  } else {
    console.error(`Unknown mode: ${opts.mode}. Use 'sdk' or 'cli'.`);
    process.exit(1);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // Check expected output files
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  RESULTS`);
  console.log(`  elapsed: ${elapsed}s`);
  console.log(`  exit code: ${result.exitCode}`);
  if (result.turns != null) console.log(`  turns: ${result.turns}`);
  if (result.cost != null) console.log(`  cost: $${Number(result.cost).toFixed(4)}`);

  if (expectedFiles.length) {
    console.log(`  output files:`);
    let allExist = true;
    for (const f of expectedFiles) {
      const exists = fs.existsSync(f);
      if (!exists) allExist = false;
      const rel = path.relative(CSKILLBP_DIR, f);
      console.log(`    ${exists ? '✓' : '✗'} ${rel}`);
    }
    console.log(`  all expected outputs exist: ${allExist}`);
  }
  console.log(`${'='.repeat(60)}\n`);
}

main().catch((err) => {
  console.error(`[test-skill] Fatal error: ${err.message}`);
  process.exit(1);
});
