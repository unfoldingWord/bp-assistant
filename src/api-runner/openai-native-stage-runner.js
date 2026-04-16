const fs = require('fs');
const path = require('path');

const { runAgentLoop } = require('./agent-loop');
const { buildSkillPrompt } = require('./prompt-builder');
const { getProviderConfig, resolveProviderModel } = require('./provider-config');
const { getToolSchemas } = require('./tools');
const { normalizeBookName, resolveOutputFile, discoverFreshOutput } = require('../pipeline-utils');
const { buildGenerateContext } = require('../pipeline-context');
const { getProviderSystemAppend } = require('./provider-nudges');
const { createAlignedUsfm, mergeAlignedUsfm } = require('../workspace-tools/usfm-tools');

const OPENAI_TOOL_SCHEMAS = getToolSchemas({ excludeAgentTools: true });
const OPENAI_DEFAULT_MODEL = getProviderConfig('openai').defaultModel;

const STAGE_PRESETS = {
  'ULT-gen': { model: 'opus', thinking: 'medium', maxTurns: 60, timeout: 20, toolChoice: 'auto' },
  'deep-issue-id': { model: 'opus', thinking: 'medium', maxTurns: 80, timeout: 20, toolChoice: 'auto' },
  'UST-gen': { model: 'opus', thinking: 'medium', maxTurns: 70, timeout: 25, toolChoice: 'auto' },
  'ULT-alignment': { model: 'sonnet', thinking: 'medium', maxTurns: 40, timeout: 20, toolChoice: 'auto' },
  'UST-alignment': { model: 'sonnet', thinking: 'medium', maxTurns: 50, timeout: 20, toolChoice: 'auto' },
  'tn-writer': { model: 'opus', thinking: 'medium', maxTurns: 150, timeout: 45, toolChoice: 'auto' },
  'tn-quality-check': { model: 'sonnet', thinking: 'medium', maxTurns: 60, timeout: 20, toolChoice: 'auto' },
};

function chapterTag(book, chapter) {
  const width = String(book).toUpperCase() === 'PSA' ? 3 : 2;
  return `${String(book).toUpperCase()}-${String(chapter).padStart(width, '0')}`;
}

function parseBookChapter(prompt) {
  const match = String(prompt || '').match(/^([a-z0-9]{2,5}|[a-z]+)\s+(\d+)/i);
  if (!match) {
    throw new Error(`Could not parse book/chapter from prompt: "${prompt}"`);
  }

  const book = normalizeBookName(match[1]);
  const chapter = parseInt(match[2], 10);
  if (!book || !Number.isInteger(chapter)) {
    throw new Error(`Invalid book/chapter in prompt: "${prompt}"`);
  }

  return { book, chapter };
}

function buildCanonicalPaths(cwd, book, chapter) {
  const tag = chapterTag(book, chapter);
  return {
    ult: path.join(cwd, `output/AI-ULT/${book}/${tag}.usfm`),
    ultAligned: path.join(cwd, `output/AI-ULT/${book}/${tag}-aligned.usfm`),
    ust: path.join(cwd, `output/AI-UST/${book}/${tag}.usfm`),
    ustAligned: path.join(cwd, `output/AI-UST/${book}/${tag}-aligned.usfm`),
    issues: path.join(cwd, `output/issues/${book}/${tag}.tsv`),
    notes: path.join(cwd, `output/notes/${book}/${tag}.tsv`),
    qualityJson: path.join(cwd, `output/quality/${book}/${tag}.json`),
    qualityMd: path.join(cwd, `output/quality/${book}/${tag}-quality.md`),
  };
}

function toWorkspaceRel(cwd, absPath) {
  return path.relative(cwd, absPath).split(path.sep).join('/');
}

function resolveWorkspaceOutput(cwd, canonicalPath, book, pattern, afterMs = null) {
  const relPath = toWorkspaceRel(cwd, canonicalPath);
  const dirRel = path.posix.dirname(relPath);
  const found = pattern
    ? discoverFreshOutput(dirRel, book, pattern, afterMs)
    : resolveOutputFile(relPath, book);
  if (!found) return null;
  return path.join(cwd, found);
}

function verifyOutputFile(filePath, label, book, pattern, afterMs = null, cwd = '/srv/bot/workspace') {
  const resolvedPath = resolveWorkspaceOutput(cwd, filePath, book, pattern, afterMs) || filePath;
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`${label} missing: ${path.relative('/srv/bot/workspace', filePath)}`);
  }
  const stat = fs.statSync(resolvedPath);
  if (stat.size === 0) {
    throw new Error(`${label} empty: ${path.relative('/srv/bot/workspace', resolvedPath)}`);
  }
  return resolvedPath;
}

function countVersesInUsfm(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const matches = content.match(/^\\v\s+\d+/gm);
  return matches ? matches.length : 0;
}

function findHebrewSourceRelPath(cwd, book) {
  const hebrewDir = path.join(cwd, 'data/hebrew_bible');
  const match = fs.readdirSync(hebrewDir).find((name) => name.endsWith(`-${book}.usfm`));
  if (!match) {
    throw new Error(`Hebrew source file not found for ${book}`);
  }
  return path.join('data/hebrew_bible', match);
}

function finalizeAlignmentOutputs({ cwd, book, chapter, sourceRelPath, outputRelPath, ust = false }) {
  const tag = chapterTag(book, chapter);
  const mappingDirRel = path.join('tmp', 'zec03_alignments');
  const mappingDirAbs = path.join(cwd, mappingDirRel);
  if (!fs.existsSync(mappingDirAbs)) {
    throw new Error(`Alignment mapping directory missing: ${mappingDirRel}`);
  }

  const mappingFiles = fs.readdirSync(mappingDirAbs)
    .filter((name) => name.startsWith(`${tag}-v`) && name.endsWith('.json'))
    .sort();

  if (mappingFiles.length === 0) {
    throw new Error(`No alignment mapping JSON files found for ${tag}`);
  }

  const hebrewRelPath = findHebrewSourceRelPath(cwd, book);
  const partials = [];

  for (const fileName of mappingFiles) {
    const verseMatch = fileName.match(/-v(\d+)-v\d+\.json$/);
    const verse = verseMatch ? parseInt(verseMatch[1], 10) : null;
    const mappingRelPath = path.join(mappingDirRel, fileName);
    const partialRelPath = path.join(mappingDirRel, fileName.replace(/\.json$/, ust ? '.ust.aligned.usfm' : '.ult.aligned.usfm'));
    const result = createAlignedUsfm({
      hebrew: hebrewRelPath,
      mapping: mappingRelPath,
      source: sourceRelPath,
      output: partialRelPath,
      chapter,
      verse,
      ust,
    });

    if (String(result).startsWith('Error')) {
      throw new Error(result);
    }
    partials.push(partialRelPath);
  }

  const mergeResult = mergeAlignedUsfm({
    parts: partials,
    output: outputRelPath,
  });

  if (String(mergeResult).startsWith('Error')) {
    throw new Error(mergeResult);
  }
}

function summarizeStageResults(label, results) {
  const totals = results.reduce((sum, result) => {
    sum.turns += result.turns || 0;
    sum.inputTokens += result.inputTokens || 0;
    sum.outputTokens += result.outputTokens || 0;
    sum.cost += result.cost || 0;
    sum.durationMs += result.durationMs || 0;
    return sum;
  }, {
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    durationMs: 0,
  });

  return {
    ...totals,
    finalText: `${label} complete.`,
    steps: results.map((result) => ({
      skill: result.skill,
      turns: result.turns,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      cost: result.cost,
      durationMs: result.durationMs,
    })),
  };
}

function seedIssueStageArtifacts(cwd, dirPath) {
  const alignmentPath = path.join(cwd, dirPath, 'alignment_data.json');
  fs.mkdirSync(path.dirname(alignmentPath), { recursive: true });
  if (!fs.existsSync(alignmentPath)) {
    fs.writeFileSync(alignmentPath, JSON.stringify({ alignments: [] }, null, 2));
  }
}

function resolveStagePreset(skillName, opts = {}) {
  const preset = STAGE_PRESETS[skillName] || {};
  return {
    model: opts.model || preset.model || OPENAI_DEFAULT_MODEL,
    thinking: opts.thinking || preset.thinking || 'medium',
    maxTurns: opts.maxTurns || preset.maxTurns || 100,
    timeout: opts.timeout || preset.timeout || 30,
    toolChoice: opts.toolChoice || preset.toolChoice || 'auto',
  };
}

async function executeNativeStage(skillName, prompt, opts = {}) {
  const cwd = opts.cwd || '/srv/bot/workspace';
  const preset = resolveStagePreset(skillName, opts);
  const system = buildSkillPrompt(skillName, {
    cwd,
    toolSchemas: OPENAI_TOOL_SCHEMAS,
  }) + buildSystemAppend(skillName, prompt, opts);

  if (opts.dryRun) {
    return {
      skill: skillName,
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      durationMs: 0,
      finalText: `(dry run) ${skillName}`,
    };
  }

  const result = await runAgentLoop({
    provider: 'openai',
    model: preset.model,
    system,
    userMessage: prompt,
    maxTurns: preset.maxTurns,
    timeoutMs: preset.timeout * 60 * 1000,
    cwd,
    thinking: preset.thinking,
    apiKey: opts.apiKey,
    apiKeyResolver: opts.apiKeyResolver,
    toolChoice: preset.toolChoice,
    lockProvider: true,
    toolSchemas: OPENAI_TOOL_SCHEMAS,
  });

  return {
    ...result,
    skill: skillName,
    model: resolveProviderModel('openai', preset.model),
  };
}

function buildSystemAppend(skillName, prompt, opts) {
  let extra = '';
  try {
    const { book, chapter } = parseBookChapter(prompt);
    extra = getProviderSystemAppend('openai', skillName, { book, chapter });
  } catch {
    extra = '';
  }

  const bounded = [
    'CRITICAL: Agent/team delegation tools are unavailable in this run.',
    'Do not attempt TeamCreate, Agent, SendMessage, TaskCreate, or TaskGet.',
    'Complete the task directly using the available file, verse-data, and workspace tools.',
  ].join('\n');

  const appended = opts.systemAppend ? `\n\n${opts.systemAppend}` : '';
  return `\n\n${bounded}${extra ? `\n\n${extra}` : ''}${appended}`;
}

async function runInitialPipeline(prompt, opts = {}) {
  const { book, chapter } = parseBookChapter(prompt);
  const cwd = opts.cwd || '/srv/bot/workspace';
  const outputs = buildCanonicalPaths(cwd, book, chapter);
  const stageResults = [];
  const tag = chapterTag(book, chapter);

  const ultPrompt = `${book} ${chapter}`;
  const ultResult = await executeNativeStage('ULT-gen', ultPrompt, opts);
  const ultPath = verifyOutputFile(outputs.ult, 'ULT output', book, new RegExp(`^${tag}(-(?!.*aligned).*)?\\.usfm$`), null, cwd);
  stageResults.push(ultResult);

  const { dirPath, contextPath } = buildGenerateContext({
    book,
    chapter,
    ultPath: toWorkspaceRel(cwd, ultPath),
    issuesPath: null,
    ultFullPath: toWorkspaceRel(cwd, ultPath),
  });
  seedIssueStageArtifacts(cwd, dirPath);

  const issuePrompt = `${book} ${chapter} --context ${contextPath}`;
  const issueResult = await executeNativeStage('deep-issue-id', issuePrompt, {
    ...opts,
    systemAppend: [
      'Use the context file as authoritative for current generated sources.',
      'If sources.ultFull points to a chapter-level generated file, read that file directly instead of expecting a full-book fetch.',
      'Perform the issue-identification work yourself in one pass and write the canonical TSV to output/issues.',
    ].join('\n'),
  });
  const issuesPath = verifyOutputFile(outputs.issues, 'Issues TSV', book, new RegExp(`^${tag}(-.*)?\\.tsv$`), null, cwd);
  stageResults.push(issueResult);

  buildGenerateContext({
    book,
    chapter,
    ultPath: toWorkspaceRel(cwd, ultPath),
    ustPath: null,
    issuesPath: toWorkspaceRel(cwd, issuesPath),
    ultFullPath: toWorkspaceRel(cwd, ultPath),
    dirPath,
  });

  const ustPrompt = `${book} ${chapter} --context ${contextPath}`;
  const ustResult = await executeNativeStage('UST-gen', ustPrompt, opts);
  verifyOutputFile(outputs.ust, 'UST output', book, new RegExp(`^${tag}(-(?!.*aligned).*)?\\.usfm$`), null, cwd);
  stageResults.push(ustResult);

  return summarizeStageResults('initial-pipeline', stageResults);
}

async function runAlignmentPipeline(prompt, opts = {}) {
  const { book, chapter } = parseBookChapter(prompt);
  const cwd = opts.cwd || '/srv/bot/workspace';
  const outputs = buildCanonicalPaths(cwd, book, chapter);
  const stageResults = [];
  const tag = chapterTag(book, chapter);
  const ultSourcePath = verifyOutputFile(outputs.ult, 'ULT output', book, new RegExp(`^${tag}(-(?!.*aligned).*)?\\.usfm$`), null, cwd);
  const ustSourcePath = verifyOutputFile(outputs.ust, 'UST output', book, new RegExp(`^${tag}(-(?!.*aligned).*)?\\.usfm$`), null, cwd);
  const verseCount = countVersesInUsfm(ultSourcePath);
  const versesArg = verseCount > 0 ? ` --verses 1-${verseCount}` : '';

  const ultPrompt = `${book} ${chapter} --ult ${toWorkspaceRel(cwd, ultSourcePath)}${versesArg}`;
  const ultResult = await executeNativeStage('ULT-alignment', ultPrompt, opts);
  finalizeAlignmentOutputs({
    cwd,
    book,
    chapter,
    sourceRelPath: toWorkspaceRel(cwd, ultSourcePath),
    outputRelPath: path.relative(cwd, outputs.ultAligned),
    ust: false,
  });
  verifyOutputFile(outputs.ultAligned, 'Aligned ULT output', book, new RegExp(`^${tag}(-.*)?-aligned\\.usfm$`), null, cwd);
  stageResults.push(ultResult);

  const ustPrompt = `${book} ${chapter} --ust ${toWorkspaceRel(cwd, ustSourcePath)}${versesArg}`;
  const ustResult = await executeNativeStage('UST-alignment', ustPrompt, opts);
  finalizeAlignmentOutputs({
    cwd,
    book,
    chapter,
    sourceRelPath: toWorkspaceRel(cwd, ustSourcePath),
    outputRelPath: path.relative(cwd, outputs.ustAligned),
    ust: true,
  });
  verifyOutputFile(outputs.ustAligned, 'Aligned UST output', book, new RegExp(`^${tag}(-.*)?-aligned\\.usfm$`), null, cwd);
  stageResults.push(ustResult);

  return summarizeStageResults('align-all-parallel', stageResults);
}

async function runOpenAiNativeSkill(skillName, prompt, opts = {}) {
  if ((opts.provider || 'openai') !== 'openai') {
    throw new Error('OpenAI native stage runner only supports provider "openai"');
  }

  switch (skillName) {
    case 'initial-pipeline':
      return runInitialPipeline(prompt, opts);
    case 'align-all-parallel':
      return runAlignmentPipeline(prompt, opts);
    case 'ULT-gen':
    case 'deep-issue-id':
    case 'UST-gen':
    case 'ULT-alignment':
    case 'UST-alignment':
    case 'tn-writer':
    case 'tn-quality-check':
      return executeNativeStage(skillName, prompt, opts);
    default:
      return executeNativeStage(skillName, prompt, opts);
  }
}

module.exports = {
  OPENAI_TOOL_SCHEMAS,
  STAGE_PRESETS,
  buildCanonicalPaths,
  parseBookChapter,
  verifyOutputFile,
  runOpenAiNativeSkill,
  runInitialPipeline,
  runAlignmentPipeline,
};
