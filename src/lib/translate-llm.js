// translate-llm.js — direct (non-agentic) LLM path for the translate pipeline.
//
// The default translate path drives the Claude Agent SDK (runClaude): the skill
// reads its task JSON, pack and source off disk with Read and writes the output
// file with Write. This module is the alternative: ONE completion call per batch
// or article against a caller-supplied API key, with every input inlined in the
// prompt and the output file written here from the model's reply. The output
// file contract is identical, so core.readBatchOutput / readArticleOutput and
// the deterministic checks in translate-checks.js validate it unchanged.
//
// Deliberately not built on src/api-runner/providers/* — those are message-loop
// shaped (tool calls, transcript replay, cache points). One-shot completion
// needs none of it, so the adapters below are minimal and independent.
'use strict';

const fs = require('fs');
const path = require('path');

const { assertProviderModel, getProviderConfig, resolveProviderModel } = require('../api-runner/provider-config');
const { redact } = require('../run-logs');

const BEGIN_OUTPUT = '-----BEGIN OUTPUT-----';
const END_OUTPUT = '-----END OUTPUT-----';

const MAX_OUTPUT_TOKENS = 32000;
// The pipeline passes a 20-minute agentic budget; a single completion that has
// not returned in 10 minutes is hung, not slow.
const MAX_TIMEOUT_MS = 10 * 60 * 1000;

// Test seams. Adapters never construct an SDK client directly and never sleep
// directly, so the whole module is drivable without network or wall-clock.
const _hooks = { transport: null, clients: null, sleep: null };

function _setTestHooks(hooks) {
  Object.assign(_hooks, hooks);
}

function _resetTestHooks() {
  _hooks.transport = null;
  _hooks.clients = null;
  _hooks.sleep = null;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

class TranslateProviderError extends Error {
  constructor(code, provider, message, { status, retryAfterSeconds, cause } = {}) {
    super(message);
    this.name = 'TranslateProviderError';
    this.code = code;
    // errorKind is the field the pipeline/job records surface; keep it equal to
    // code so callers can read either.
    this.errorKind = code;
    this.provider = provider;
    if (status != null) this.status = status;
    if (retryAfterSeconds != null) this.retryAfterSeconds = retryAfterSeconds;
    if (cause) this.cause = cause;
  }
}

/**
 * Pattern-based secret scrubbing (shared with the run logs) plus literal
 * removal of any extra secrets the caller knows about — the API key is passed
 * in explicitly because it comes from a request body, not the environment, so
 * run-logs' env-value pass cannot see it.
 */
function scrubSecrets(text, extraSecrets = []) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  for (const secret of extraSecrets) {
    if (typeof secret === 'string' && secret.length >= 8 && out.includes(secret)) {
      out = out.split(secret).join('[redacted]');
    }
  }
  return redact(out);
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

// Appended to every skill body. The skill's own Input/Output sections describe
// Read/Write mechanics that do not exist here, so this section must override
// them explicitly rather than merely add to them.
const API_MODE_OVERRIDE = `## API mode override (supersedes the Input/Output mechanics above)

You are running as a single API completion. There are no tools: no Read, no
Write, no filesystem, no shell. Every instruction above that tells you to read
or write a file is superseded by this section.

- The task JSON, the context pack, and the source content are inlined in the
  user message. Those are the complete inputs; there is nothing else to read.
- Do not write a file. Emit the COMPLETE content of the output file in your
  reply, between these two exact marker lines:

${BEGIN_OUTPUT}
(the complete output file content)
${END_OUTPUT}

- Emit nothing after the ${END_OUTPUT} line — no commentary, no summary, no
  "done:" line. Anything before the ${BEGIN_OUTPUT} line is discarded.
- The text between the markers is written to the output file verbatim, so it
  must be the whole file: the full TSV header and every row, or the full
  article body. Never abbreviate and never elide with "...".
- In repair mode the user message includes your previous output and the list of
  validation violations. Apply exactly those fixes and re-emit the complete
  corrected file between the same markers.`;

/** Skills root, read at call time so tests (and deploys) can point elsewhere. */
function skillsRoot() {
  if (process.env.CSKILLBP_DIR) return process.env.CSKILLBP_DIR;
  return require('../pipeline-utils').CSKILLBP_DIR;
}

function skillPath(skill) {
  return path.join(skillsRoot(), '.claude', 'skills', skill, 'SKILL.md');
}

/** Strip the YAML frontmatter block delimited by the first two --- lines. */
function stripFrontmatter(text) {
  const normalized = text.replace(/^﻿/, '');
  if (!/^---\r?\n/.test(normalized)) return normalized.trim();
  const end = normalized.indexOf('\n---', 3);
  if (end === -1) return normalized.trim();
  const after = normalized.indexOf('\n', end + 1);
  return (after === -1 ? '' : normalized.slice(after + 1)).trim();
}

function readSkillBody(skill) {
  if (!skill) throw new Error('translate-llm: no skill name supplied');
  const file = skillPath(skill);
  if (!fs.existsSync(file)) {
    throw new Error(`translate-llm: skill not found: ${file} (set CSKILLBP_DIR to the skills checkout)`);
  }
  return stripFrontmatter(fs.readFileSync(file, 'utf8'));
}

function block(title, body) {
  return `# ${title}\n\n-----BEGIN ${title.toUpperCase()}-----\n${body}\n-----END ${title.toUpperCase()}-----`;
}

/**
 * Build the {system, user} pair for one batch/article. `taskJson` is the
 * verbatim task-file text (an object is stringified). `repairNote` set means
 * repair mode: `previousOutput` is inlined so the model can fix it in place.
 */
function buildTranslatePrompt({ skill, taskJson, packMarkdown, sourceText, previousOutput, repairNote }) {
  const system = `${readSkillBody(skill)}\n\n${API_MODE_OVERRIDE}\n`;

  const taskText = typeof taskJson === 'string' ? taskJson : JSON.stringify(taskJson, null, 2);
  const parts = [
    block('Task JSON', taskText.trim()),
    block('Context pack', String(packMarkdown || '').replace(/\s+$/, '')),
    block('Source content', String(sourceText || '').replace(/\s+$/, '')),
  ];

  if (repairNote) {
    if (previousOutput) parts.push(block('Previous output', String(previousOutput).replace(/\s+$/, '')));
    parts.push(`# Repair note\n\n${String(repairNote).trim()}`);
  }

  parts.push(`Now emit the complete output file between ${BEGIN_OUTPUT} and ${END_OUTPUT}.`);
  return { system, user: parts.join('\n\n') };
}

// ---------------------------------------------------------------------------
// Output extraction
// ---------------------------------------------------------------------------

/**
 * Pull the output-file content out of a reply. Sentinel markers are used rather
 * than a code fence because tA articles legitimately contain fenced blocks. The
 * LAST marker pair wins — the system prompt echoes the markers, and a model that
 * restates them before its real answer must not defeat extraction.
 */
function extractOutput(text) {
  const raw = String(text || '');
  const begin = raw.lastIndexOf(BEGIN_OUTPUT);
  if (begin !== -1) {
    const bodyStart = begin + BEGIN_OUTPUT.length;
    const end = raw.indexOf(END_OUTPUT, bodyStart);
    const body = end === -1 ? raw.slice(bodyStart) : raw.slice(bodyStart, end);
    return body.replace(/^\r?\n/, '').replace(/\s+$/, '');
  }

  const trimmed = raw.trim();
  const fenced = /^```[^\n]*\r?\n([\s\S]*?)\r?\n?```$/.exec(trimmed);
  if (fenced) return fenced[1].replace(/\s+$/, '');
  return trimmed;
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

function errorText(err) {
  if (!err) return '';
  const parts = [
    err.message,
    err.error?.message,
    err.error?.error?.message,
    err.response?.data?.error?.message,
  ];
  return parts.filter(Boolean).join(' | ');
}

function errorType(err) {
  return String(err?.error?.error?.type || err?.error?.type || err?.code || err?.error?.code || '');
}

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return null;
}

function parseRetryAfter(err) {
  const header = headerValue(err?.headers, 'retry-after') || headerValue(err?.response?.headers, 'retry-after');
  const fromHeader = Number(header);
  if (Number.isFinite(fromHeader) && fromHeader > 0) return Math.ceil(fromHeader);

  // Gemini reports a RetryInfo detail as "retryDelay": "17s"; several providers
  // put "retry after N seconds" in the body message.
  const text = errorText(err);
  const m = /retry[-_ ]?(?:after|delay)"?\s*[:=]?\s*"?(\d+(?:\.\d+)?)s?/i.exec(text);
  if (m) return Math.ceil(Number(m[1]));
  return null;
}

function classifyProviderError(err) {
  const status = Number(err?.status || err?.statusCode || err?.response?.status) || null;
  const text = errorText(err);
  const type = errorType(err);
  const tag = `${type} ${text}`;

  if (err?.name === 'AbortError' || err?.name === 'TimeoutError'
      || err?.code === 'ETIMEDOUT' || err?.code === 'ECONNABORTED'
      || /\btimed?[ -]?out\b|\baborted\b/i.test(tag)) {
    return { code: 'timeout', status };
  }
  if (status === 401 || status === 403
      || /authentication_error|permission_denied|invalid_api_key|api key not valid|incorrect api key|unauthorized/i.test(tag)) {
    return { code: 'invalid_key', status };
  }
  if (status === 404
      || /not_found|model_not_found|does not exist|unknown .{0,20}model/i.test(tag)) {
    return { code: 'model_not_found', status };
  }
  if (status === 429 || /rate_limit|resource_exhausted|too many requests|quota/i.test(tag)) {
    return { code: 'rate_limited', status, retryAfterSeconds: parseRetryAfter(err) };
  }
  if (status === 500 || status === 502 || status === 503 || status === 504 || status === 529
      || /overloaded|unavailable|internal server error|server_error/i.test(tag)) {
    return { code: 'provider_overloaded', status, retryAfterSeconds: parseRetryAfter(err) };
  }
  if (status === 400 && /context|token limit|too long|too many tokens|maximum.{0,20}tokens|exceeds/i.test(tag)) {
    return { code: 'context_too_long', status };
  }
  return { code: 'provider_error', status };
}

const RETRY_LIMITS = { rate_limited: 2, provider_overloaded: 2, timeout: 1 };

function backoffSeconds(code, attempt, retryAfterSeconds) {
  if (code === 'timeout') return 5;
  return Math.max(retryAfterSeconds || 0, 15 * attempt);
}

function sleep(seconds) {
  if (_hooks.sleep) return _hooks.sleep(seconds);
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

function providerError(provider, code, message, apiKey, extra = {}) {
  const scrubbed = scrubSecrets(String(message == null ? '' : message), apiKey ? [apiKey] : []);
  return new TranslateProviderError(code, provider, `${provider} ${code}: ${scrubbed.slice(0, 200)}`, extra);
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

const THINKING_EFFORT = { none: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' };
const GEMINI_25_BUDGET = { low: 1024, medium: 4096, high: 8192, xhigh: 32768, max: 32768 };

function effort(thinking) {
  if (!thinking || thinking === 'none') return null;
  return THINKING_EFFORT[thinking] || 'medium';
}

function getClient(provider, factory) {
  if (_hooks.clients && _hooks.clients[provider]) return _hooks.clients[provider];
  return factory();
}

async function callClaude({ model, system, user, thinking, apiKey, timeoutMs, signal }) {
  const client = getClient('claude', () => {
    const Anthropic = require('@anthropic-ai/sdk');
    const Ctor = Anthropic.default || Anthropic.Anthropic || Anthropic;
    return new Ctor({ apiKey, timeout: timeoutMs, maxRetries: 0 });
  });

  const params = {
    model,
    max_tokens: MAX_OUTPUT_TOKENS,
    system,
    messages: [{ role: 'user', content: user }],
  };
  const eff = effort(thinking);
  if (eff) {
    params.thinking = { type: 'adaptive' };
    params.output_config = { effort: eff };
  }

  // Streaming, not a plain create: the non-streaming endpoint rejects long
  // max_tokens outright, and whole-batch TSV output is exactly that shape.
  const stream = await client.messages.stream(params, { signal });
  const resp = await stream.finalMessage();
  const text = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return {
    text,
    usage: { inputTokens: resp.usage?.input_tokens || 0, outputTokens: resp.usage?.output_tokens || 0 },
    stopReason: resp.stop_reason || 'unknown',
  };
}

function openaiClient(apiKey, timeoutMs, baseURL) {
  const OpenAI = require('openai');
  const Ctor = OpenAI.default || OpenAI.OpenAI || OpenAI;
  return new Ctor({ apiKey, timeout: timeoutMs, maxRetries: 0, ...(baseURL ? { baseURL } : {}) });
}

function responseText(resp) {
  if (typeof resp.output_text === 'string' && resp.output_text) return resp.output_text;
  const chunks = [];
  for (const item of resp.output || []) {
    for (const part of item.content || []) {
      if (typeof part.text === 'string') chunks.push(part.text);
    }
  }
  return chunks.join('');
}

async function callOpenai({ model, system, user, thinking, apiKey, timeoutMs, signal }) {
  const client = getClient('openai', () => openaiClient(apiKey, timeoutMs));
  const body = {
    model,
    instructions: system,
    input: user,
    max_output_tokens: MAX_OUTPUT_TOKENS,
  };
  const eff = effort(thinking);
  if (eff) body.reasoning = { effort: eff };

  let resp;
  try {
    resp = await client.responses.create(body, { signal });
  } catch (err) {
    // Non-reasoning models reject the reasoning param. That is a prompt-shape
    // problem, not a batch failure — drop the param and try once more.
    if (body.reasoning && /reasoning/i.test(errorText(err))) {
      console.warn(`[translate-llm] openai ${model} rejected the reasoning param — retrying without it`);
      delete body.reasoning;
      resp = await client.responses.create(body, { signal });
    } else {
      throw err;
    }
  }

  const incomplete = resp.status === 'incomplete' ? (resp.incomplete_details?.reason || 'incomplete') : null;
  return {
    text: responseText(resp),
    usage: { inputTokens: resp.usage?.input_tokens || 0, outputTokens: resp.usage?.output_tokens || 0 },
    stopReason: incomplete || resp.status || 'completed',
  };
}

async function callXai({ model, system, user, thinking, apiKey, timeoutMs, signal }) {
  const cfg = getProviderConfig('xai');
  const client = getClient('xai', () => openaiClient(apiKey, timeoutMs, cfg.baseUrl));
  const body = {
    model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    max_completion_tokens: MAX_OUTPUT_TOKENS,
  };
  const eff = effort(thinking);
  // Only the models xAI documents as effort-capable accept reasoning_effort;
  // the rest 400 on it.
  if (eff && cfg.reasoningEffortModels?.includes(model)) body.reasoning_effort = eff;

  const resp = await client.chat.completions.create(body, { signal });
  const choice = resp.choices?.[0];
  return {
    text: choice?.message?.content || '',
    usage: { inputTokens: resp.usage?.prompt_tokens || 0, outputTokens: resp.usage?.completion_tokens || 0 },
    stopReason: choice?.finish_reason || 'unknown',
  };
}

async function callGemini({ model, system, user, thinking, apiKey, timeoutMs, signal }) {
  const client = getClient('gemini', () => {
    const { GoogleGenAI } = require('@google/genai');
    return new GoogleGenAI({ apiKey });
  });

  const config = { maxOutputTokens: MAX_OUTPUT_TOKENS, systemInstruction: { parts: [{ text: system }] } };
  if (thinking && thinking !== 'none') {
    // 3.x takes a thinkingLevel; 2.5 takes a token budget and rejects zero.
    config.thinkingConfig = model.startsWith('gemini-3')
      ? { thinkingLevel: effort(thinking) }
      : { thinkingBudget: GEMINI_25_BUDGET[thinking] ?? 4096 };
  }
  if (signal) config.abortSignal = signal;

  const resp = await client.models.generateContent({ model, contents: user, config });
  const candidate = resp.candidates?.[0];
  const text = (candidate?.content?.parts || []).map((p) => p.text).filter(Boolean).join('');
  return {
    text,
    usage: {
      inputTokens: resp.usageMetadata?.promptTokenCount || 0,
      outputTokens: resp.usageMetadata?.candidatesTokenCount || 0,
    },
    stopReason: candidate?.finishReason || 'unknown',
  };
}

const ADAPTERS = { claude: callClaude, openai: callOpenai, xai: callXai, gemini: callGemini };

// Per-provider stop reasons that mean "the model ran out of output budget".
const TRUNCATED_STOP_REASONS = {
  claude: ['max_tokens'],
  openai: ['max_output_tokens'],
  xai: ['length'],
  gemini: ['MAX_TOKENS'],
};

// ---------------------------------------------------------------------------
// Call + retry
// ---------------------------------------------------------------------------

function resolveModel(provider, model, apiKey) {
  try {
    return assertProviderModel(provider, model);
  } catch (err) {
    throw providerError(provider, 'model_not_found', err.message, apiKey);
  }
}

async function callProvider({ provider, model, system, user, thinking, apiKey, timeoutMs }) {
  const transport = _hooks.transport || ADAPTERS[provider];
  if (!transport) throw providerError(provider, 'provider_error', `no adapter for provider "${provider}"`, apiKey);

  const budget = Math.min(Number(timeoutMs) || MAX_TIMEOUT_MS, MAX_TIMEOUT_MS);

  for (let attempt = 1; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budget);
    let result;
    try {
      result = await transport({
        provider, model, system, user, thinking, apiKey,
        timeoutMs: budget,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const aborted = controller.signal.aborted;
      const { code, status, retryAfterSeconds } = aborted ? { code: 'timeout' } : classifyProviderError(err);
      const limit = RETRY_LIMITS[code] || 0;
      if (attempt <= limit) {
        const wait = backoffSeconds(code, attempt, retryAfterSeconds);
        console.warn(`[translate-llm] ${provider} ${code} (attempt ${attempt}/${limit + 1}) — retrying in ${wait}s`);
        await sleep(wait);
        continue;
      }
      const message = aborted ? `no response within ${Math.round(budget / 1000)}s` : errorText(err) || String(err);
      throw providerError(provider, code, message, apiKey, { status, retryAfterSeconds });
    }
    clearTimeout(timer);

    if ((TRUNCATED_STOP_REASONS[provider] || []).includes(result.stopReason)) {
      throw providerError(provider, 'output_too_long', `output truncated at ${MAX_OUTPUT_TOKENS} tokens (stop reason ${result.stopReason})`, apiKey);
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

/** Catalog-priced cost for one call. Null when the model has no pricing entry. */
function estimateCost(provider, model, usage) {
  let cfg;
  try {
    cfg = getProviderConfig(provider);
  } catch {
    return null;
  }
  const resolved = resolveProviderModel(provider, model);
  const m = cfg.models?.[resolved];
  if (!m || m.inputPer1M == null || m.outputPer1M == null) return null;
  return ((usage?.inputTokens || 0) / 1e6) * m.inputPer1M + ((usage?.outputTokens || 0) / 1e6) * m.outputPer1M;
}

// ---------------------------------------------------------------------------
// Runners
// ---------------------------------------------------------------------------

function readIfExists(file) {
  return file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

async function runOne({ files, params, sourceText, taskJson, packMarkdown, repairNote }) {
  const provider = params.provider;
  const apiKey = params.apiKey;
  const model = resolveModel(provider, params.model, apiKey);

  const { system, user } = buildTranslatePrompt({
    skill: params.skill,
    taskJson,
    packMarkdown,
    sourceText,
    previousOutput: repairNote ? readIfExists(files.outputFile) : null,
    repairNote,
  });

  const result = await callProvider({
    provider, model, system, user,
    thinking: params.thinking,
    apiKey,
    timeoutMs: params.timeoutMs,
  });

  const output = extractOutput(result.text);
  if (!output) {
    throw providerError(provider, 'empty_output', 'model returned no output between the sentinel markers', apiKey);
  }
  fs.writeFileSync(files.outputFile, output.endsWith('\n') ? output : `${output}\n`, 'utf8');

  return { usage: result.usage, costUsd: estimateCost(provider, model, result.usage), model };
}

/** One TSV batch (tn/tq). Writes files.outputFile; caller runs the checks. */
async function runTsvBatch({ files, params, repairNote }) {
  const taskJson = fs.readFileSync(files.taskFile, 'utf8');
  const sourceFile = files.batchFile || JSON.parse(taskJson).batchFile;
  return runOne({
    files,
    params,
    taskJson,
    packMarkdown: fs.readFileSync(files.packFile, 'utf8'),
    sourceText: fs.readFileSync(sourceFile, 'utf8'),
    repairNote,
  });
}

/** One article file (tw/ta). Writes files.outputFile; caller runs the checks. */
async function runArticleFile({ files, params, repairNote }) {
  const taskJson = fs.readFileSync(files.taskFile, 'utf8');
  const sourceFile = files.srcFile || files.sourceFile || JSON.parse(taskJson).sourceFile;
  return runOne({
    files,
    params,
    taskJson,
    packMarkdown: fs.readFileSync(files.packFile, 'utf8'),
    sourceText: fs.readFileSync(sourceFile, 'utf8'),
    repairNote,
  });
}

module.exports = {
  runTsvBatch,
  runArticleFile,
  buildTranslatePrompt,
  extractOutput,
  classifyProviderError,
  estimateCost,
  scrubSecrets,
  TranslateProviderError,
  BEGIN_OUTPUT,
  END_OUTPUT,
  _setTestHooks,
  _resetTestHooks,
};
