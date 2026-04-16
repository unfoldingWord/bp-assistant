#!/usr/bin/env node
// scripts/test-providers-zec3.js
//
// Multi-provider API pipeline test for Zechariah 3.
//
// Mirrors the non-Zulip portion of `src/api-runner/api-pipeline.js`:
//   1. `api generate zec 3` equivalent  -> initial-pipeline + align-all-parallel
//   2. `api write notes zec 3 --skip-per` equivalent -> preprocess + tn-writer + tn-quality-check
// and snapshots the resulting artifacts into /srv/bot/workspace/test/zec-03/<provider>-api/.
//
// Does NOT touch Zulip and does NOT push to Door43.

const fs = require('fs');
const path = require('path');

if (!process.env.CSKILLBP_DIR) {
  process.env.CSKILLBP_DIR = '/srv/bot/workspace';
}

const APP_ROOT = '/srv/bot/app';
const SRC = path.join(APP_ROOT, 'src');
const WORKSPACE = '/srv/bot/workspace';
const TEST_ROOT = path.join(WORKSPACE, 'test/zec-03');
const STEP_ORDER = ['initial', 'align', 'prep', 'tn-writer', 'tn-qc', 'snapshot'];
const SUPPORTED_PROVIDERS = ['claude', 'openai', 'gemini', 'xai'];
const REQUIRED_ARTIFACT_KEYS = ['ult', 'ultAligned', 'ust', 'ustAligned', 'issues', 'notes'];

const { runCustom, runSkill } = require(path.join(SRC, 'api-runner/runner'));
const { getProviderConfig, resolveProviderModel } = require(path.join(SRC, 'api-runner/provider-config'));
const { getProviderSystemAppend } = require(path.join(SRC, 'api-runner/provider-nudges'));
const { DEFAULT_RUNTIME, resolveRuntime } = require(path.join(SRC, 'api-runner/runtime-config'));
const { buildNotesContext, readContext, writeContext } = require(path.join(SRC, 'pipeline-context'));
const {
  extractAlignmentData,
  prepareNotes,
  fillOrigQuotes,
  resolveGlQuotes,
  flagNarrowQuotes,
  generateIds,
} = require(path.join(SRC, 'workspace-tools/tn-tools'));
const { checkPrerequisites, CSKILLBP_DIR } = require(path.join(SRC, 'pipeline-utils'));

function patchConsoleWithTimestamps() {
  const ts = () => new Date().toISOString().slice(11, 19);
  for (const level of ['log', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => original(`[${ts()}]`, ...args);
  }
}

function parseArgs(argv) {
  const out = {
    provider: null,
    runtime: DEFAULT_RUNTIME,
    opusModel: null,
    sonnetModel: null,
    resumeFrom: null,
    keepOutput: false,
    book: 'ZEC',
    chapter: 3,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--provider': out.provider = argv[++i]; break;
      case '--runtime': out.runtime = argv[++i]; break;
      case '--opus-model': out.opusModel = argv[++i]; break;
      case '--sonnet-model': out.sonnetModel = argv[++i]; break;
      case '--resume-from': out.resumeFrom = argv[++i]; break;
      case '--keep-output': out.keepOutput = true; break;
      case '--book': out.book = String(argv[++i] || '').toUpperCase(); break;
      case '--chapter': out.chapter = parseInt(argv[++i], 10); break;
      default: throw new Error(`Unknown arg: ${arg}`);
    }
  }

  if (!out.provider) throw new Error('--provider is required');
  if (!SUPPORTED_PROVIDERS.includes(out.provider)) {
    throw new Error(`Unknown provider: ${out.provider}`);
  }
  out.runtime = resolveRuntime(out.provider, out.runtime);
  if (out.resumeFrom && !STEP_ORDER.includes(out.resumeFrom)) {
    throw new Error(`--resume-from must be one of: ${STEP_ORDER.join(', ')}`);
  }
  if (!Number.isInteger(out.chapter) || out.chapter <= 0) {
    throw new Error('--chapter must be a positive integer');
  }
  return out;
}

function classifyError(err) {
  const message = String(err && err.message ? err.message : err || '').toLowerCase();
  if (/401|unauthor|api[ _-]?key|invalid_api_key|forbidden|permission/.test(message)) return 'auth';
  if (/429|rate.?limit|quota|too many requests/.test(message)) return 'rate-limit';
  if (/503|overloaded|high demand|service unavailable|temporarily unavailable/.test(message)) return 'overload';
  if (/fetch failed|network|socket hang up|econnreset|etimedout|enotfound|eai_again/.test(message)) return 'transport';
  if (/timeout|timed out|deadline/.test(message)) return 'timeout';
  if (/model.*(not[ _-]?found|does not exist|invalid)|unknown model|404/.test(message)) return 'model-not-found';
  if (/no .*usfm|0 items|empty|missing/.test(message)) return 'bad-output';
  return 'unknown';
}

function chapterTag(book, chapter) {
  const width = book.toUpperCase() === 'PSA' ? 3 : 2;
  return `${book.toUpperCase()}-${String(chapter).padStart(width, '0')}`;
}

function outputPaths(book, chapter) {
  const tag = chapterTag(book, chapter);
  return {
    ult: path.join(WORKSPACE, `output/AI-ULT/${book}/${tag}.usfm`),
    ultAligned: path.join(WORKSPACE, `output/AI-ULT/${book}/${tag}-aligned.usfm`),
    ust: path.join(WORKSPACE, `output/AI-UST/${book}/${tag}.usfm`),
    ustAligned: path.join(WORKSPACE, `output/AI-UST/${book}/${tag}-aligned.usfm`),
    issues: path.join(WORKSPACE, `output/issues/${book}/${tag}.tsv`),
    notes: path.join(WORKSPACE, `output/notes/${book}/${tag}.tsv`),
  };
}

function destDirName(provider, runtime = DEFAULT_RUNTIME) {
  if (provider === 'openai' && runtime === 'openai-native') return 'openai-native';
  return `${provider}-api`;
}

function destPaths(provider, book, chapter, runtime = DEFAULT_RUNTIME) {
  const tag = chapterTag(book, chapter);
  const dir = path.join(TEST_ROOT, destDirName(provider, runtime));
  return {
    dir,
    ult: path.join(dir, `${tag}.usfm`),
    ultAligned: path.join(dir, `${tag}-aligned.usfm`),
    ust: path.join(dir, `${tag}-UST.usfm`),
    ustAligned: path.join(dir, `${tag}-UST-aligned.usfm`),
    issues: path.join(dir, `${tag}-issues.tsv`),
    notes: path.join(dir, `${tag}-notes.tsv`),
    models: path.join(dir, 'MODELS.md'),
  };
}

function getHarnessModels(provider, overrides = {}) {
  const cfg = getProviderConfig(provider);
  return {
    opus: overrides.opusModel || resolveProviderModel(provider, 'opus') || cfg.defaultModel,
    sonnet: overrides.sonnetModel || resolveProviderModel(provider, 'sonnet') || cfg.defaultModel,
  };
}

function getCleanupTargets(book, chapter, provider, runtime = DEFAULT_RUNTIME) {
  const tag = chapterTag(book, chapter);
  const dst = destPaths(provider, book, chapter, runtime);
  return [
    path.join(WORKSPACE, `output/AI-ULT/${book}/${tag}.usfm`),
    path.join(WORKSPACE, `output/AI-ULT/${book}/${tag}-aligned.usfm`),
    path.join(WORKSPACE, `output/AI-UST/${book}/${tag}.usfm`),
    path.join(WORKSPACE, `output/AI-UST/${book}/${tag}-aligned.usfm`),
    path.join(WORKSPACE, `output/AI-UST/${book}/${tag}-alignment.json`),
    path.join(WORKSPACE, `output/AI-UST/hints/${book}/${tag}.json`),
    path.join(WORKSPACE, `output/issues/${book}/${tag}.tsv`),
    path.join(WORKSPACE, `output/notes/${book}/${tag}.tsv`),
    path.join(WORKSPACE, `output/quality/${book}/${tag}.json`),
    path.join(WORKSPACE, `output/quality/${book}/${tag}-quality.md`),
    path.join(WORKSPACE, `tmp/alignments/${book}/${tag}-mapping.json`),
    path.join(WORKSPACE, `tmp/alignments/${book}/${tag}-ult-fixed.json`),
    path.join(WORKSPACE, `tmp/alignments/${book}/${tag}-ult.json`),
    path.join(WORKSPACE, `tmp/alignments/${book}/${tag}-ust.json`),
    path.join(WORKSPACE, `tmp/${tag}-alignment-mapping.json`),
    path.join(WORKSPACE, `tmp/pipeline/${tag}`),
    path.join(WORKSPACE, `tmp/pipeline-${tag}`),
    dst.dir,
  ];
}

function clearOutput(book, chapter, provider, runtime = DEFAULT_RUNTIME) {
  for (const target of getCleanupTargets(book, chapter, provider, runtime)) {
    if (!fs.existsSync(target)) continue;
    const stat = fs.statSync(target);
    if (stat.isDirectory()) {
      fs.rmSync(target, { recursive: true, force: true });
    } else {
      fs.rmSync(target, { force: true });
    }
  }
}

function copyIfExists(src, dst) {
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  return true;
}

function validateRequiredArtifacts(paths) {
  const missing = [];
  const empty = [];
  for (const key of REQUIRED_ARTIFACT_KEYS) {
    const artifactPath = paths[key];
    if (!artifactPath || !fs.existsSync(artifactPath)) {
      missing.push({ key, path: artifactPath || null });
      continue;
    }
    if (fs.statSync(artifactPath).size === 0) {
      empty.push({ key, path: artifactPath });
    }
  }
  return {
    ok: missing.length === 0 && empty.length === 0,
    missing,
    empty,
  };
}

async function runGeminiSmokeGate({ provider, runtime = DEFAULT_RUNTIME, model, thinking = 'medium' }) {
  if (provider !== 'gemini') return [];

  const observations = [];

  console.log(`\n[gemini-smoke] plain prompt model=${model}`);
  const plainResult = await runCustom(
    'You are a smoke-test assistant. Respond with exactly OK.',
    'Return OK only.',
    {
      provider,
      runtime,
      model,
      thinking,
      cwd: APP_ROOT,
      maxTurns: 3,
      timeout: 5,
      toolChoice: 'none',
      lockProvider: true,
      verbose: false,
    }
  );
  if (!plainResult.finalText || !/\bok\b/i.test(plainResult.finalText.trim())) {
    throw new Error(`Gemini smoke plain prompt returned unexpected text: ${plainResult.finalText || '(empty)'}`);
  }
  observations.push(`Gemini smoke plain prompt OK on ${model}`);

  console.log(`\n[gemini-smoke] tool round-trip model=${model}`);
  const toolResult = await runCustom(
    [
      'You are running a Gemini tool smoke test.',
      'Before answering, call the Read tool exactly once on package.json with offset 1 and limit 1.',
      'After the tool result, reply with one line that begins with "tool-ok:".',
    ].join(' '),
    'Use the required tool call, then reply in the requested format.',
    {
      provider,
      runtime,
      model,
      thinking,
      cwd: APP_ROOT,
      maxTurns: 6,
      timeout: 5,
      toolChoice: 'auto',
      lockProvider: true,
      verbose: false,
    }
  );
  const usedTool = (toolResult._messages || []).some((message) => (
    message.role === 'assistant'
      && Array.isArray(message.toolCalls)
      && message.toolCalls.length > 0
  ));
  const receivedToolResult = (toolResult._messages || []).some((message) => (
    message.role === 'tool'
      && Array.isArray(message.results)
      && message.results.length > 0
  ));
  if (!usedTool || !receivedToolResult) {
    throw new Error('Gemini smoke tool prompt did not complete a tool round-trip');
  }
  if (!toolResult.finalText || !/^tool-ok:/i.test(toolResult.finalText.trim())) {
    throw new Error(`Gemini smoke tool prompt returned unexpected text: ${toolResult.finalText || '(empty)'}`);
  }
  observations.push(`Gemini smoke tool round-trip OK on ${model}`);

  return observations;
}

function snapshotPartials(out, dst) {
  copyIfExists(out.ult, dst.ult);
  copyIfExists(out.ultAligned, dst.ultAligned);
  copyIfExists(out.ust, dst.ust);
  copyIfExists(out.ustAligned, dst.ustAligned);
  copyIfExists(out.issues, dst.issues);
  copyIfExists(out.notes, dst.notes);
}

function writeModelsMd({ provider, runtime = DEFAULT_RUNTIME, opusModel, sonnetModel, book, chapter, steps, observations, failed, durationMs, dstDir, dst }) {
  const lines = [];
  const runtimeLabel = runtime === 'openai-native' ? 'native' : 'API';
  lines.push(`# ${provider.toUpperCase()} ${runtimeLabel} run — ${book} ${chapter}`);
  lines.push('');
  lines.push(`Run timestamp: ${new Date().toISOString()}`);
  lines.push(`Wall-clock: ${(durationMs / 60000).toFixed(2)} min`);
  lines.push(`Status: **${failed ? 'FAILED' : 'completed'}**`);
  if (failed) {
    lines.push(`Failed step: \`${failed.step}\``);
    lines.push(`Error class: \`${failed.klass}\``);
    lines.push(`Error message: ${failed.message.slice(0, 500)}`);
  }
  lines.push('');
  lines.push('## Provider & models');
  lines.push('');
  lines.push(`- Provider: \`${provider}\``);
  lines.push(`- Runtime: \`${runtime}\``);
  lines.push(`- Opus-tier model (initial-pipeline, tn-writer): \`${opusModel}\``);
  lines.push(`- Sonnet-tier model (alignment, tn-quality-check): \`${sonnetModel}\``);
  lines.push('- Thinking level: medium');
  lines.push('');
  lines.push('## Per-step results');
  lines.push('');
  lines.push('| Step | Model | OK | Turns | Input tok | Output tok | Cost | Duration | Error |');
  lines.push('|---|---|---|---|---|---|---|---|---|');

  for (const step of steps) {
    const cost = step.cost == null ? '—' : `$${step.cost.toFixed(4)}`;
    const duration = step.durationMs == null ? '—' : `${(step.durationMs / 1000).toFixed(1)}s`;
    lines.push(
      `| ${step.step} | ${step.model || '—'} | ${step.ok ? 'yes' : 'NO'} | `
      + `${step.turns ?? '—'} | ${step.inputTokens ?? '—'} | ${step.outputTokens ?? '—'} | `
      + `${cost} | ${duration} | ${step.error ? step.error.slice(0, 80) : ''} |`
    );
  }

  const totalCost = steps.reduce((sum, step) => sum + (step.cost || 0), 0);
  const totalInput = steps.reduce((sum, step) => sum + (step.inputTokens || 0), 0);
  const totalOutput = steps.reduce((sum, step) => sum + (step.outputTokens || 0), 0);
  lines.push('');
  lines.push(`**Totals**: input ${totalInput}, output ${totalOutput}, est. cost $${totalCost.toFixed(4)}`);
  lines.push('');
  lines.push('## Run observations');
  lines.push('');
  if (observations.length === 0) lines.push('- (none)');
  else for (const observation of observations) lines.push(`- ${observation}`);
  lines.push('');

  fs.mkdirSync(dstDir, { recursive: true });
  fs.writeFileSync(dst.models, lines.join('\n'));
}

async function runProvider(opts) {
  const { provider, runtime, book, chapter } = opts;
  const { opus: opusModel, sonnet: sonnetModel } = getHarnessModels(provider, opts);
  const startWall = Date.now();
  const steps = [];
  const observations = [];
  const dst = destPaths(provider, book, chapter, runtime);
  const out = outputPaths(book, chapter);
  const resumeIdx = opts.resumeFrom ? STEP_ORDER.indexOf(opts.resumeFrom) : 0;
  fs.mkdirSync(dst.dir, { recursive: true });

  function shouldRun(step) {
    return STEP_ORDER.indexOf(step) >= resumeIdx;
  }

  function recordStep(name, model, result, errorMessage) {
    const entry = {
      step: name,
      model,
      ok: !errorMessage,
      error: errorMessage || null,
      turns: result?.turns ?? null,
      inputTokens: result?.inputTokens ?? null,
      outputTokens: result?.outputTokens ?? null,
      cost: typeof result?.cost === 'number' ? result.cost : null,
      durationMs: result?.durationMs ?? null,
    };
    steps.push(entry);
    return entry;
  }

  function fail(step, model, error) {
    const message = String(error && error.message ? error.message : error);
    const klass = classifyError(error);
    recordStep(step, model, null, message);
    writeModelsMd({
      provider,
      runtime,
      opusModel,
      sonnetModel,
      book,
      chapter,
      steps,
      observations,
      failed: { step, klass, message },
      durationMs: Date.now() - startWall,
      dstDir: dst.dir,
      dst,
    });
    snapshotPartials(out, dst);
    console.error(`\n[FAILURE] ${JSON.stringify({
      provider,
      failedStep: step,
      errorClass: klass,
      message: message.slice(0, 500),
    })}\n`);
    if (error && error.stack) console.error(error.stack);
    process.exitCode = 2;
    throw error;
  }

  if (!opts.keepOutput && resumeIdx === 0) {
    clearOutput(book, chapter, provider, runtime);
    console.log(`[clear] removed prior output and snapshot for ${chapterTag(book, chapter)}`);
  }

  const baseOpts = {
    runtime,
    thinking: 'medium',
    cwd: WORKSPACE,
    verbose: false,
    lockProvider: true,
  };

  if (provider === 'gemini') {
    try {
      observations.push(...await runGeminiSmokeGate({
        provider,
        runtime,
        model: opusModel,
        thinking: baseOpts.thinking,
      }));
    } catch (error) {
      fail('gemini-smoke', opusModel, error);
    }
  }

  if (shouldRun('initial')) {
    console.log(`\n[initial-pipeline] provider=${provider} model=${opusModel}`);
    let result;
    try {
      result = await runSkill('initial-pipeline', `${book} ${chapter} user TEST`, {
        ...baseOpts,
        provider,
        model: opusModel,
        maxTurns: 100,
        timeout: 30,
        systemAppend: getProviderSystemAppend(provider, 'initial-pipeline', { book, chapter }),
      });
    } catch (error) {
      fail('initial-pipeline', opusModel, error);
    }
    const entry = recordStep('initial-pipeline', opusModel, result);
    if (entry.turns >= 100) observations.push('initial-pipeline hit maxTurns (100) — model may have been struggling');
    if (!fs.existsSync(out.ult)) observations.push(`MISSING after initial-pipeline: ${out.ult}`);
    if (!fs.existsSync(out.ust)) observations.push(`MISSING after initial-pipeline: ${out.ust}`);
    if (!fs.existsSync(out.issues)) observations.push(`MISSING after initial-pipeline: ${out.issues}`);
  }

  if (shouldRun('align')) {
    console.log(`\n[align-all-parallel] provider=${provider} model=${sonnetModel}`);
    let result;
    try {
      result = await runSkill('align-all-parallel', `${book} ${chapter} --ult --ust`, {
        ...baseOpts,
        provider,
        model: sonnetModel,
        maxTurns: 50,
        timeout: 30,
        systemAppend: getProviderSystemAppend(provider, 'align-all-parallel', { book, chapter }),
      });
    } catch (error) {
      fail('align-all-parallel', sonnetModel, error);
    }
    const entry = recordStep('align-all-parallel', sonnetModel, result);
    if (entry.turns >= 50) observations.push('align-all-parallel hit maxTurns (50)');
    const missingAligned = [out.ultAligned, out.ustAligned].filter((artifactPath) => !fs.existsSync(artifactPath));
    for (const artifactPath of missingAligned) observations.push(`MISSING after alignment: ${artifactPath}`);
    if (missingAligned.length > 0) {
      fail('align-all-parallel', sonnetModel, new Error(`Alignment phase failed: missing aligned output(s): ${missingAligned.join(', ')}`));
    }
  }

  let contextPath;
  if (shouldRun('prep')) {
    console.log('\n[notes-context] building');
    if (!fs.existsSync(out.issues)) {
      fail('notes-prep', null, new Error(`issues TSV missing for --skip-per: ${out.issues}`));
    }

    const prereqs = checkPrerequisites(book, chapter);
    const issuesRel = prereqs.resolved['issues TSV'];
    const ultPlainRel = prereqs.resolved['AI-ULT'];
    const alignedUltRel = ultPlainRel ? ultPlainRel.replace(/\.usfm$/, '-aligned.usfm') : null;
    const ctxResult = await buildNotesContext({ book, chapter, issuesPath: issuesRel });
    contextPath = ctxResult.contextPath;

    if (alignedUltRel && fs.existsSync(path.resolve(CSKILLBP_DIR, alignedUltRel))) {
      const context = readContext(ctxResult.dirPath);
      context.sources.ultAligned = alignedUltRel;
      writeContext(ctxResult.dirPath, context);
    }

    const context = readContext(ctxResult.dirPath);
    const hasAligned = !!(
      context.sources
      && context.sources.ultAligned
      && fs.existsSync(path.resolve(CSKILLBP_DIR, context.sources.ultAligned))
    );
    if (hasAligned) {
      extractAlignmentData({ alignedUsfm: context.sources.ultAligned, output: context.runtime.alignmentData });
    } else {
      observations.push('preprocessing ran without aligned ULT — orig_quote / gl_quote resolution will be skipped');
    }

    const prepResult = prepareNotes({
      inputTsv: issuesRel,
      ultUsfm: context.sources.ultPlain || context.sources.ult,
      ustUsfm: context.sources.ustPlain || context.sources.ust,
      alignedUsfm: context.sources.ultAligned,
      output: context.runtime.preparedNotes,
      alignmentJson: context.runtime.alignmentData,
    });
    const match = prepResult.match(/^Prepared (\d+) items/);
    const prepCount = match ? parseInt(match[1], 10) : 0;
    if (prepCount === 0) {
      fail('notes-prep', null, new Error('prepareNotes produced 0 items — issues TSV may be malformed'));
    }
    observations.push(`preprocessing: ${prepCount} items`);

    if (hasAligned) {
      fillOrigQuotes({ preparedJson: context.runtime.preparedNotes, alignmentJson: context.runtime.alignmentData });
      resolveGlQuotes({ preparedJson: context.runtime.preparedNotes, alignmentJson: context.runtime.alignmentData });
    }
    flagNarrowQuotes({ preparedJson: context.runtime.preparedNotes });

    const preparedPath = path.resolve(CSKILLBP_DIR, context.runtime.preparedNotes);
    const preparedData = JSON.parse(fs.readFileSync(preparedPath, 'utf8'));
    const missingIds = (preparedData.items || []).filter((item) => !item.id);
    if (missingIds.length > 0) {
      const idBlock = await generateIds({ book: preparedData.book || book, count: missingIds.length });
      const newIds = idBlock.split('\n').filter(Boolean);
      let index = 0;
      for (const item of preparedData.items || []) {
        if (!item.id) item.id = newIds[index++] || '';
      }
      fs.writeFileSync(preparedPath, JSON.stringify(preparedData, null, 2));
    }

    recordStep('notes-prep', null, {
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      durationMs: 0,
    });
  } else {
    const tag = chapterTag(book, chapter);
    const pipelineRoot = path.join(WORKSPACE, 'tmp/pipeline');
    if (fs.existsSync(pipelineRoot)) {
      const candidates = fs.readdirSync(pipelineRoot).filter((name) => name === tag).sort().reverse();
      if (candidates[0]) contextPath = `tmp/pipeline/${candidates[0]}/context.json`;
    }
    if (!contextPath) {
      throw new Error(`Cannot resume after prep — no pipeline dir found for ${tag}`);
    }
  }

  if (shouldRun('tn-writer')) {
    console.log(`\n[tn-writer] provider=${provider} model=${opusModel}`);
    let result;
    try {
      result = await runSkill('tn-writer', `${book} ${chapter} --context ${contextPath}`, {
        ...baseOpts,
        provider,
        model: opusModel,
        maxTurns: 150,
        timeout: 45,
      });
    } catch (error) {
      fail('tn-writer', opusModel, error);
    }
    const entry = recordStep('tn-writer', opusModel, result);
    if (entry.turns >= 150) observations.push('tn-writer hit maxTurns (150)');
    if (!fs.existsSync(out.notes)) observations.push(`MISSING after tn-writer: ${out.notes}`);
  }

  if (shouldRun('tn-qc')) {
    console.log(`\n[tn-quality-check] provider=${provider} model=${sonnetModel}`);
    let result;
    try {
      result = await runSkill('tn-quality-check', `${book} ${chapter} --context ${contextPath}`, {
        ...baseOpts,
        provider,
        model: sonnetModel,
        maxTurns: 60,
        timeout: 20,
      });
    } catch (error) {
      fail('tn-quality-check', sonnetModel, error);
    }
    recordStep('tn-quality-check', sonnetModel, result);
  }

  if (shouldRun('snapshot')) {
    console.log(`\n[snapshot] copying output -> ${dst.dir}`);
    copyIfExists(out.ult, dst.ult);
    copyIfExists(out.ultAligned, dst.ultAligned);
    copyIfExists(out.ust, dst.ust);
    copyIfExists(out.ustAligned, dst.ustAligned);
    copyIfExists(out.issues, dst.issues);
    copyIfExists(out.notes, dst.notes);

    for (const [label, artifactPath] of Object.entries({
      'ULT plain': dst.ult,
      'ULT aligned': dst.ultAligned,
      'UST plain': dst.ust,
      'UST aligned': dst.ustAligned,
      issues: dst.issues,
      notes: dst.notes,
    })) {
      if (!fs.existsSync(artifactPath)) {
        observations.push(`MISSING in snapshot: ${label}`);
        continue;
      }
      const size = fs.statSync(artifactPath).size;
      if (size === 0) observations.push(`EMPTY in snapshot: ${label}`);
      else if (label === 'notes' && size < 1000) observations.push(`SHORT notes file (${size} bytes) — likely truncated`);
    }

    const artifactCheck = validateRequiredArtifacts(dst);
    if (!artifactCheck.ok) {
      const problems = [
        ...artifactCheck.missing.map(({ key, path: artifactPath }) => `${key}:missing:${artifactPath || '(unset)'}`),
        ...artifactCheck.empty.map(({ key, path: artifactPath }) => `${key}:empty:${artifactPath}`),
      ];
      fail('snapshot', null, new Error(`Required snapshot artifacts missing or empty: ${problems.join(', ')}`));
    }
  }

  writeModelsMd({
    provider,
    runtime,
    opusModel,
    sonnetModel,
    book,
    chapter,
    steps,
    observations,
    durationMs: Date.now() - startWall,
    dstDir: dst.dir,
    dst,
  });

  console.log(`\n[done] ${provider} run finished in ${((Date.now() - startWall) / 60000).toFixed(1)} min`);
  console.log(`[done] artifacts: ${dst.dir}`);
}

async function main() {
  patchConsoleWithTimestamps();
  const opts = parseArgs(process.argv);
  if (!process.env.BOT_SECRETS_DIR) {
    process.env.BOT_SECRETS_DIR = '/srv/bot/config/secrets';
  }
  await runProvider(opts);
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[fatal]', error.message);
    if (process.exitCode === undefined || process.exitCode === 0) process.exitCode = 1;
  });
}

module.exports = {
  REQUIRED_ARTIFACT_KEYS,
  classifyError,
  chapterTag,
  clearOutput,
  destDirName,
  destPaths,
  getCleanupTargets,
  getHarnessModels,
  outputPaths,
  parseArgs,
  runGeminiSmokeGate,
  runProvider,
  validateRequiredArtifacts,
};
