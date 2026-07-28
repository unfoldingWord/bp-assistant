'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { runClaude, isGuardrailStop } = require('./claude-runner');
const { createGuardHooks } = require('./guard-hooks');
const { publishAdminStatus, readAdminStatus } = require('./admin-status');
const { readSecret } = require('./secrets');
const {
  searchExistingIssueByMarkers,
  createGithubIssue,
} = require('./github-issues');

const DEFAULT_REPO = 'bp-assistant';
const SKILLS_REPO = 'bp-assistant-skills';
const VALID_REPOS = new Set([DEFAULT_REPO, SKILLS_REPO]);
const FINGERPRINT_PREFIX = 'pipeline-failure-fingerprint:';
const RAW_DIR = process.env.SELF_DIAGNOSIS_RAW_DIR
  || path.resolve(__dirname, '../data/self-diagnosis-raw');
const MAX_FALLBACK_BODY_CHARS = 50000;

// Vendored from bp-assistant-auto-issue-handler/src/pipeline-failure-handler.js
// Source-of-truth: keep these three functions byte-identical so the
// fingerprint-marker dedup works whether the issue was filed by this in-process
// path or by the host-side cron script.
function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeMessage(value) {
  return normalizeText(String(value || '').replace(/\*\*/g, '').replace(/`/g, ''));
}

function normalizeSignature(message) {
  return normalizeMessage(message)
    .toLowerCase()
    .replace(/\b[1-3]?[a-z]{2,3}\s+\d+(?::\d+(?:-\d+)?)?/g, '<scope>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/[^\w\s:-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220);
}

function classifyRepo(event) {
  const blob = `${event.pipelineType || ''} ${event.phase || ''} ${event.message || ''}`.toLowerCase();
  if (
    /\btn-writer\b/.test(blob)
    || /\bissue-identification\b/.test(blob)
    || /\btn-quality-check\b/.test(blob)
    || /\balternate translation\b/.test(blob)
    || /\btranslation note\b/.test(blob)
  ) {
    return SKILLS_REPO;
  }
  return DEFAULT_REPO;
}

function buildFingerprint(event) {
  const payload = [
    String(event.pipelineType || 'unknown'),
    String(event.scope || 'unknown'),
    normalizeSignature(event.message),
    String(event.phase || 'status'),
    `unfoldingWord/${classifyRepo(event)}`,
  ].join('|');
  return crypto.createHash('sha1').update(payload).digest('hex').slice(0, 16);
}

const SYSTEM_PROMPT = `You are an investigation agent for the unfoldingWord bp-assistant Bible-translation bot.

A pipeline run just failed. Your job is to investigate the failure, determine the most likely root cause, and produce a structured GitHub issue draft so the auto-issue-handler can attempt a fix.

The user provides:
- The failure event (severity, scope, phase, message)
- Recent admin-status events for the same scope (lead-up timeline)
- Checkpoint state for the failed run, when available
- Any error text captured at the failure site

You may use Read, Grep, and Glob to inspect:
- bp-assistant source files (src/*.js) to understand the failure path
- Skill files in bp-assistant-skills (.claude/skills/) when the failure points at a skill
- The admin-status.jsonl tail for related events
- Output files referenced in the error (e.g. cSkillBP/output/...) to see what was actually produced

Constraints:
- You CANNOT modify files. Read-only investigation.
- You have ONLY the Read, Grep, and Glob tools. Bash/shell is NOT available — any
  Bash call is denied and only wastes your turn budget. Never call Bash; locate
  files with Grep or Glob and read them by path with Read.
- You have a HARD time budget of ~5 minutes. After at most ~8 tool calls, STOP
  investigating and output the JSON, even if your analysis is incomplete. A
  partial-but-valid JSON answer is far more useful than running out of time with
  no output at all.
- Spend at most a few tool calls — do not exhaustively read every file. Large
  source/USFM files: Grep for the relevant lines instead of reading them whole.
- Bias toward filing the issue against bp-assistant unless the evidence clearly points to a skill prompt or skill code.

After investigation, output a single fenced JSON block (no prose before or after) with this exact shape:

\`\`\`json
{
  "repo": "bp-assistant" | "bp-assistant-skills",
  "title": "Pipeline failure: <pipelineType> <scope> — <short cause>",
  "body": "<markdown body — see structure below>",
  "labels": ["bug", "pipeline-failure"],
  "classification": "transient" | "data" | "skills" | "code" | "infra"
}
\`\`\`

The body must contain these sections in this order:
## Summary
One paragraph: what failed, where, what was the user doing.

## Failure signal
The exact error message and the scope/phase from the event.

## Investigation
What you read and what you found. Cite specific files (with paths) and line numbers when relevant.

## Likely root cause
Your best hypothesis for why this happened.

## Suggested fix
A concrete, minimal change. If the cause is unclear, list the next debugging steps instead.

The fingerprint marker will be appended automatically — do not include it.`;

// Durable-evidence pointers for the failing skill run: the volume-backed run
// log and the SDK transcript (parent + sub-agents). Before these were recorded,
// triage had only admin-status timings and an already-rolled-off fly.io stream
// to go on — which is how the AMO 8 align lockout (#264/#265) got closed as an
// "intermittent LLM flake" when the transcripts showed every sub-agent tool call
// being auto-denied.
function buildEvidenceSection(evidence) {
  if (!evidence || typeof evidence !== 'object') return [];
  const { runLogPath, transcriptPath, subagentTranscriptDir, sessionId } = evidence;
  if (!runLogPath && !transcriptPath) return [];
  const lines = ['## Evidence (durable, on the volume)'];
  if (sessionId) lines.push(`- SDK session id: \`${sessionId}\``);
  if (runLogPath) lines.push(`- Run log (JSONL, one event per line): \`${runLogPath}\``);
  if (transcriptPath) lines.push(`- Full SDK transcript: \`${transcriptPath}\``);
  if (subagentTranscriptDir) lines.push(`- Sub-agent transcripts: \`${subagentTranscriptDir}\``);
  lines.push('- Read these before reasoning from timings alone. In the run log, '
    + '`"type":"tool_use"` lines carry the full tool input and `"denied":true` marks '
    + 'an auto-denied call — a run of those means a permission lockout, not a model flake.');
  // The issue body this agent produces is posted to a PUBLIC repo. Run logs are
  // scrubbed on write (see redact() in src/run-logs.js), but the SDK transcripts
  // are written by the CLI and are not — so bound what may be quoted from them.
  lines.push('- The issue you write is PUBLIC. Summarize from these files — report tool '
    + 'names, counts, timings and denial patterns. Do not paste raw file contents, '
    + 'environment values, headers, or any token/key/password-shaped string into the issue body.');
  lines.push('');
  return lines;
}

function buildContextSummary(event, contextEvents, checkpoint, errorText, workdir, evidence) {
  const lines = [];
  lines.push('## Failure event');
  lines.push(`- timestamp: ${event.timestamp}`);
  lines.push(`- source: ${event.source}`);
  lines.push(`- pipelineType: ${event.pipelineType}`);
  lines.push(`- scope: ${event.scope || '(none)'}`);
  lines.push(`- phase: ${event.phase || '(none)'}`);
  lines.push(`- severity: ${event.severity}`);
  lines.push(`- message: ${event.message}`);
  lines.push('');
  lines.push('## Recent admin-status events (most-recent last)');
  if (Array.isArray(contextEvents) && contextEvents.length > 0) {
    for (const e of contextEvents) {
      lines.push(`- [${e.timestamp}] [${e.severity}] ${e.message}`);
    }
  } else {
    lines.push('(none)');
  }
  lines.push('');
  if (checkpoint) {
    lines.push('## Checkpoint state');
    lines.push('```json');
    lines.push(JSON.stringify(checkpoint, null, 2));
    lines.push('```');
    lines.push('');
  }
  for (const line of buildEvidenceSection(evidence)) lines.push(line);
  {
    const wd = workdir || process.env.CSKILLBP_DIR || '';
    const outputs = (checkpoint && checkpoint.skillOutputs) || {};
    let notesRel = null;
    for (const ch of Object.keys(outputs)) {
      const bySkill = outputs[ch] || {};
      if (bySkill['tn-writer']) { notesRel = bySkill['tn-writer']; break; }
    }
    if (wd || notesRel) {
      lines.push('## Working directory');
      if (wd) lines.push(`- Pipeline working dir (CSKILLBP_DIR): ${wd}`);
      if (notesRel) {
        lines.push(`- Notes TSV (relative): ${notesRel}`);
        if (wd) lines.push(`- Notes TSV (absolute): ${path.resolve(wd, notesRel)}`);
      }
      lines.push('- Read files by absolute path; do not run `find` to locate them.');
      lines.push('');
    }
  }
  if (errorText) {
    lines.push('## Error text from failure site');
    lines.push('```');
    lines.push(String(errorText).slice(0, 4000));
    lines.push('```');
    lines.push('');
  }
  lines.push('Please investigate (Read/Grep only) and produce the JSON output described in the system prompt.');
  return lines.join('\n');
}

// Most common diagnosis-agent failure: literal newlines / tabs / CRs sit
// unescaped inside a JSON string value (typically the markdown body), making
// JSON.parse choke. Walk the candidate, escape control chars while inside a
// string, and also strip a few other common offenders (trailing commas).
function repairAgentJson(candidate) {
  let out = '';
  let inString = false;
  let escape = false;
  for (let i = 0; i < candidate.length; i++) {
    const ch = candidate[i];
    if (escape) { out += ch; escape = false; continue; }
    if (ch === '\\') { out += ch; escape = true; continue; }
    if (ch === '"') { inString = !inString; out += ch; continue; }
    if (inString) {
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') { out += '\\r'; continue; }
      if (ch === '\t') { out += '\\t'; continue; }
    }
    out += ch;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function tryParseDiagnosisJson(candidate) {
  try { return JSON.parse(candidate); } catch { /* fall through */ }
  const startIdx = candidate.indexOf('{');
  const endIdx = candidate.lastIndexOf('}');
  if (startIdx >= 0 && endIdx > startIdx) {
    const sliced = candidate.slice(startIdx, endIdx + 1);
    try { return JSON.parse(sliced); } catch { /* fall through */ }
    try { return JSON.parse(repairAgentJson(sliced)); } catch { /* fall through */ }
  }
  try { return JSON.parse(repairAgentJson(candidate)); } catch { /* fall through */ }
  return null;
}

// Lower-bar check: does this raw text look like an attempt at the diagnosis
// JSON shape? Used to decide whether to file a fallback issue with the raw
// text vs. just logging the failure.
function looksLikeDiagnosisAttempt(raw) {
  if (!raw || typeof raw !== 'string') return false;
  if (!raw.includes('{')) return false;
  return /"\s*(repo|title|body|classification)\s*"\s*:/i.test(raw);
}

function extractDiagnosisJson(raw) {
  if (!raw || typeof raw !== 'string') {
    throw new Error('Diagnosis agent returned no text');
  }
  // Strip outermost code fence using greedy matching (first open, last close).
  // A non-greedy regex would stop at the first ``` it encounters, truncating
  // valid JSON when the body field contains nested markdown code fences.
  let candidate = raw.trim();
  const openFenceMatch = candidate.match(/^```(?:json)?\s*\n/);
  if (openFenceMatch) {
    const afterOpen = openFenceMatch[0].length;
    const lastFenceIdx = candidate.lastIndexOf('\n```');
    if (lastFenceIdx > afterOpen) {
      candidate = candidate.slice(afterOpen, lastFenceIdx).trim();
    }
  }
  const parsed = tryParseDiagnosisJson(candidate);
  if (parsed === null) {
    throw new Error(`Diagnosis agent returned invalid JSON: ${candidate.slice(0, 1000)}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Diagnosis agent returned non-object JSON');
  }
  if (!VALID_REPOS.has(parsed.repo)) {
    throw new Error(`Diagnosis agent returned invalid repo: ${parsed.repo}`);
  }
  if (typeof parsed.title !== 'string' || !parsed.title.trim()) {
    throw new Error('Diagnosis agent returned empty title');
  }
  if (typeof parsed.body !== 'string' || !parsed.body.trim()) {
    throw new Error('Diagnosis agent returned empty body');
  }
  const labels = Array.isArray(parsed.labels)
    ? parsed.labels.filter((l) => typeof l === 'string' && l.trim()).map((l) => l.trim())
    : ['bug', 'pipeline-failure'];
  return {
    repo: parsed.repo,
    title: parsed.title.trim().slice(0, 120),
    body: parsed.body,
    labels: labels.length > 0 ? labels : ['bug', 'pipeline-failure'],
    classification: typeof parsed.classification === 'string' ? parsed.classification : 'unknown',
  };
}

function extractResultText(result) {
  if (!result) return '';
  if (typeof result.result === 'string') return result.result;
  if (result.result && typeof result.result.text === 'string') return result.result.text;
  return '';
}

async function runDiagnosisAgent({ contextSummary, runClaudeImpl }) {
  const runner = runClaudeImpl || runClaude;
  const result = await runner({
    prompt: contextSummary,
    label: 'self-diagnosis',
    cwd: process.cwd(),
    model: 'sonnet',
    allowedTools: ['Read', 'Grep', 'Glob'],
    // Explicitly deny Bash so a stray shell attempt is rejected fast instead of
    // burning turns against the time budget (observed timeouts had lastTool=Bash).
    disallowedTools: ['Bash'],
    mcpToolSet: 'workspace',
    disableLocalSettings: true,
    appendSystemPrompt: SYSTEM_PROMPT,
    maxTurns: 40,
    timeoutMs: 5 * 60 * 1000,
    guardrails: { maxToolCalls: 40, tokenBudget: 200000 },
    // Declarative defense-in-depth (opt-in, BP_GUARD_HOOKS=1): the diagnosis
    // sub-agent is read-only, so a PreToolUse guard denies anything outside
    // the read-only trio (Read/Grep/Glob) and publishes any anomalous attempt
    // to admin-status. Glob is included because the agent routinely globs to
    // locate output/log files while diagnosing a failure; omitting it made the
    // guard block Glob mid-diagnosis and degraded the investigation. Default
    // OFF so options stay byte-identical until the hook layer is validated.
    hooks: process.env.BP_GUARD_HOOKS === '1'
      ? createGuardHooks({ allowedTools: ['Read', 'Grep', 'Glob'], pipelineType: 'system', publish: true })
      : undefined,
  });
  return {
    subtype: result?.subtype || 'unknown',
    rawText: extractResultText(result),
    error: result?.error || '',
    resultHead: typeof result?.result === 'string'
      ? result.result.slice(0, 500)
      : '',
  };
}

function appendFingerprintMarker(body, fingerprint) {
  const marker = `<!-- ${FINGERPRINT_PREFIX} ${fingerprint} -->`;
  return `${body.trimEnd()}\n\n${marker}\n`;
}

function persistRawDiagnosisOutput(fingerprint, raw) {
  try {
    fs.mkdirSync(RAW_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(RAW_DIR, `${fingerprint}-${ts}.txt`);
    fs.writeFileSync(file, String(raw || ''), 'utf8');
    return file;
  } catch (err) {
    console.error(`[self-diagnosis] Failed to persist raw output: ${err.message}`);
    return null;
  }
}

function buildFallbackDiagnosis(event, rawText, parseError, contextSummary) {
  const targetRepo = classifyRepo(event);
  const scopeLabel = event.scope || event.pipelineType || 'event';
  const title = `Pipeline failure: ${event.pipelineType || 'unknown'} ${scopeLabel} — diagnosis JSON parse failed`
    .slice(0, 120);
  const truncatedRaw = String(rawText || '').slice(0, MAX_FALLBACK_BODY_CHARS);
  const truncationNote = String(rawText || '').length > MAX_FALLBACK_BODY_CHARS
    ? `\n\n_(raw output truncated to ${MAX_FALLBACK_BODY_CHARS} chars)_`
    : '';
  const body = [
    '## Summary',
    'The self-diagnosis agent ran but returned output that could not be parsed as JSON.',
    'Filing this issue with the raw agent output so a human (or the auto-issue-handler) can triage.',
    '',
    '## Failure event',
    `- pipelineType: ${event.pipelineType || '(unknown)'}`,
    `- scope: ${event.scope || '(none)'}`,
    `- phase: ${event.phase || '(none)'}`,
    `- severity: ${event.severity || '(unknown)'}`,
    `- message: ${event.message || '(none)'}`,
    '',
    '## Parse error',
    '```',
    String(parseError && parseError.message ? parseError.message : parseError).slice(0, 2000),
    '```',
    '',
    '## Raw diagnosis agent output',
    '```',
    truncatedRaw + truncationNote,
    '```',
    '',
    '## Diagnosis context (what the agent was given)',
    '<details><summary>Click to expand</summary>',
    '',
    '```',
    String(contextSummary || '').slice(0, 8000),
    '```',
    '</details>',
  ].join('\n');
  return {
    repo: targetRepo,
    title,
    body,
    labels: ['bug', 'pipeline-failure', 'self-diagnosis-parse-failure'],
    classification: 'self-diagnosis-parse-failure',
  };
}

// errorKinds the align step records when a chapter has no usable aligned USFM:
// `missing_output` (coordinator returned success but left nothing, or salvage
// found no mapping JSON) and `incomplete_coverage` (salvage recovered only part
// of the chapter). Both leave the deterministic Node-side salvage as the
// canonical fix, and both were observed to time out the LLM diagnosis agent
// (issue #174) — so both short-circuit.
const ALIGN_SHORT_CIRCUIT_ERROR_KINDS = new Set(['missing_output', 'incomplete_coverage']);

// True for the well-understood "align-all-parallel produced no (or only partial)
// aligned output" signature. `assessAlignedChapterCoverage` emits "no aligned
// output found" when the coordinator returns success but leaves no aligned USFM;
// partial salvage rewrites the summary to "covers N/M verses, missing …". The
// deterministic Node-side salvage (see `salvageAlignedFromMappingJson` in
// `src/workspace-tools/usfm-tools.js`) is the canonical fix; the LLM diagnosis
// agent adds nothing and, on chapters with lots of leftover mapping JSON, tends
// to exhaust its 5-min time budget before producing usable JSON (issue #174).
//
// Prefers the checkpoint's structured `errorKind` (which also catches the
// partial-salvage `incomplete_coverage` case, whose message text does NOT
// contain "no aligned output found"), guarded on the align phase because
// `missing_output` is also used by the notes/generate phase. Falls back to the
// message text when no checkpoint errorKind is available.
function isAlignMissingOutput(text, checkpoint) {
  const current = checkpoint && checkpoint.current;
  const errorKind = current && current.errorKind;
  if (errorKind && ALIGN_SHORT_CIRCUIT_ERROR_KINDS.has(errorKind)) {
    const skill = String((current && current.skill) || '');
    // Only align-phase failures — `missing_output` is not align-exclusive.
    if (!skill || /align/i.test(skill)) return true;
  }
  const msg = typeof text === 'string' ? text : String((text && text.message) || text || '');
  if (!msg) return false;
  return /no aligned output found/i.test(msg);
}

// True when the align failure is the in-process workspace-tools MCP transport being
// torn down mid-run ("Stream closed"), typically an align sub-agent outliving the
// parent query's message stream (JER 33, 2026-07-02). The runner now bails fast
// (`mcp_transport_closed`) and the pipeline salvages from banked mapping JSON; when
// salvage can't close the gap this signature reaches diagnosis. A fresh LLM agent
// would hit the same dead transport, so short-circuit to a templated issue.
function isAlignTransportClosed(text) {
  const msg = typeof text === 'string' ? text : String((text && text.message) || text || '');
  if (!msg) return false;
  return /(stream closed|mcp transport closed)/i.test(msg) && /align/i.test(msg);
}

// True when the align failure is a permission-denial stall: in a headless run
// (permissionMode:'auto', no approval callback) the align sub-agents' out-of-
// allowlist tool calls are auto-denied with "STOP what you are doing and wait" and
// they halt, producing no aligned USFM (EZK 16, 2026-07-21 — issue #235). The runner
// now bails fast (`permission_stall`) and the pipeline records errorKind
// `permission_stall`. A fresh LLM diagnosis agent would hit the same auto-denial
// wall, so short-circuit to a templated issue.
// #294: this predicate's name is a historical artifact — `permission_stall` is no
// longer align-exclusive. `classifyPermissionFailure` in `src/notes-pipeline.js`
// (added by #288) records the identical structured errorKind for ANY skill (e.g.
// `deep-issue-id` in the notes pipeline), not just `align-all-parallel`. DAN 4
// (2026-07-27T23:19:16Z) and DAN 5 (2026-07-28T11:30:53Z) both walled/stalled on a
// notes skill, fell through the old align-only gate, and paid for a diagnosis
// agent that hit the identical auto-denial and failed. So the errorKind check below
// no longer restricts on skill — any `permission_stall` errorKind short-circuits.
// The text-only fallback (used when no checkpoint errorKind is available) stays
// align-scoped: without a structured errorKind it's a much fuzzier heuristic, and
// every known non-align case already carries the errorKind, so widening the text
// match isn't needed to fix the reported bug and would only add false-positive risk.
function isAlignPermissionStall(text, checkpoint) {
  const current = checkpoint && checkpoint.current;
  const errorKind = current && current.errorKind;
  if (errorKind === 'permission_stall') return true;
  const msg = typeof text === 'string' ? text : String((text && text.message) || text || '');
  if (!msg) return false;
  return /(permission[- ]?stall|auto-denied|doesn't want to take this action|stop what you are doing and wait)/i.test(msg)
    && /align/i.test(msg);
}

// #294: `permission_wall` is a NEW errorKind (added alongside `permission_stall` by
// #288's `classifyPermissionFailure` in `src/notes-pipeline.js`) that this file never
// referenced before. A wall is EXTERNAL and transient — every tool call was refused
// from outside this process's own permission config (see
// `resultIndicatesPermissionWall` in `src/claude-runner.js`, #271) — so it is
// pipeline-agnostic from the start: no align-only gate, on any skill. A fresh
// diagnosis agent hits the identical external refusal, which is exactly what
// DAN 4 and DAN 5 paid for before filing a worse issue than a template would.
function isPermissionWall(text, checkpoint) {
  const current = checkpoint && checkpoint.current;
  const errorKind = current && current.errorKind;
  if (errorKind === 'permission_wall') return true;
  const msg = typeof text === 'string' ? text : String((text && text.message) || text || '');
  if (!msg) return false;
  return /external permission wall/i.test(msg);
}

// Templated diagnosis for the "align-all-parallel: no (or only partial) aligned
// output" signature. Skips the LLM investigation (which was timing out on real
// runs — AMO 5, 2026-07-01) and files a concise, actionable issue that points at
// the deterministic salvage path and the leftover mapping JSON to inspect.
// `errorKind` (from the checkpoint) is `missing_output` for a total miss or
// `incomplete_coverage` when salvage recovered only part of the chapter.
function buildAlignMissingOutputDiagnosis(event, contextSummary, errorKind) {
  const targetRepo = classifyRepo(event);
  const scopeLabel = event.scope || event.pipelineType || 'event';
  const partial = errorKind === 'incomplete_coverage';
  const titleSuffix = partial ? 'align: incomplete aligned output' : 'align: no aligned output found';
  const summaryLine = partial
    ? '`align-all-parallel` recovered only partial verse coverage for one or both of ULT/UST.'
    : '`align-all-parallel` reported "no aligned output found" for one or both of ULT/UST.';
  const title = `Pipeline failure: ${event.pipelineType || 'generate'} ${scopeLabel} — ${titleSuffix}`
    .slice(0, 120);
  const body = [
    '## Summary',
    summaryLine,
    'This is a well-understood failure mode: the alignment coordinator returned success',
    'but produced no merged aligned USFM (typically leaving only per-verse mapping JSON',
    'in `tmp/alignments`). The deterministic Node-side salvage',
    '(`salvageAlignedFromMappingJson` in `src/workspace-tools/usfm-tools.js`, wired',
    'terminally into the align step in `src/generate-pipeline.js`) recovers the chapter',
    'when mapping JSON is present. This templated issue was filed instead of running the',
    'LLM diagnosis agent because the signature is known and the diagnosis agent has been',
    'observed to exceed its 5-minute time budget on this failure mode (see #174).',
    '',
    '## Failure event',
    `- pipelineType: ${event.pipelineType || '(unknown)'}`,
    `- scope: ${event.scope || '(none)'}`,
    `- phase: ${event.phase || '(none)'}`,
    `- severity: ${event.severity || '(unknown)'}`,
    `- message: ${event.message || '(none)'}`,
    '',
    '## Next steps',
    '- Check `tmp/alignments/` under the workspace for leftover per-verse mapping JSON',
    '  for this chapter (naming: `<BOOK>-<NN>-vNN.json` or `<BOOK>-<NNN>-vNN.json`).',
    '- If mapping JSON is present, salvage should have produced partial (or full) recovery —',
    '  inspect `output/AI-ULT/<BOOK>/<TAG>-aligned.usfm` and',
    '  `output/AI-UST/<BOOK>/<TAG>-aligned.usfm` for verse coverage before re-running.',
    '- If no mapping JSON exists, the coordinator failed before creating any batches;',
    '  investigate the coordinator prompt / model or simply re-run `align-all-parallel`.',
    '',
    '## Diagnosis context',
    '<details><summary>Click to expand</summary>',
    '',
    '```',
    String(contextSummary || '').slice(0, 8000),
    '```',
    '</details>',
  ].join('\n');
  return {
    repo: targetRepo,
    title,
    body,
    labels: ['bug', 'pipeline-failure', 'align-missing-output'],
    classification: 'align-missing-output',
  };
}

// Templated diagnosis for the "align-all-parallel: MCP transport closed" signature.
// Skips the LLM investigation (which would hit the same dead in-process transport)
// and files a concise, actionable issue pointing at the runner bail, the salvage
// path, and the sub-agent lifecycle as the root cause to chase if it recurs.
function buildAlignTransportClosedDiagnosis(event, contextSummary) {
  const targetRepo = classifyRepo(event);
  const scopeLabel = event.scope || event.pipelineType || 'event';
  const title = `Pipeline failure: ${event.pipelineType || 'generate'} ${scopeLabel} — align: MCP transport closed (Stream closed)`
    .slice(0, 120);
  const body = [
    '## Summary',
    'The in-process `workspace-tools` MCP transport was torn down mid-alignment: every',
    '`create_aligned_usfm` call returned `Stream closed` (a transport-level error, not a',
    "tool error). The typical cause is an align sub-agent outliving the parent query's",
    'message stream (observed: JER 33, 2026-07-02). The transport does not recover within',
    'a session, so the runner now bails after a few consecutive `Stream closed` results',
    '(`mcp_transport_closed`) instead of looping to the skill timeout, and the pipeline',
    'attempts deterministic Node-side salvage (`salvageAlignedFromMappingJson`) from any',
    'banked mapping JSON. This issue was filed because salvage could not fully recover the',
    'chapter; the LLM diagnosis agent was skipped because it would hit the same dead transport.',
    '',
    '## Failure event',
    `- pipelineType: ${event.pipelineType || '(unknown)'}`,
    `- scope: ${event.scope || '(none)'}`,
    `- phase: ${event.phase || '(none)'}`,
    `- severity: ${event.severity || '(unknown)'}`,
    `- message: ${event.message || '(none)'}`,
    '',
    '## Next steps',
    '- Re-run the chapter — a fresh query spawns a fresh in-process MCP transport, and the',
    '  banked mapping JSON in `tmp/alignments/` makes the conversion fast on the retry.',
    '- If it recurs on the same chapter, chase the root cause: the align skill leaving a',
    '  `general-purpose` batch sub-agent still calling MCP tools after the parent query',
    "  stream has closed (sub-agent lifecycle vs. the coordinator's message stream).",
    '- Confirm salvage ran: inspect `output/AI-ULT/<BOOK>/<TAG>-aligned.usfm` and',
    '  `output/AI-UST/<BOOK>/<TAG>-aligned.usfm` for partial verse coverage.',
    '',
    '## Diagnosis context',
    '<details><summary>Click to expand</summary>',
    '',
    '```',
    String(contextSummary || '').slice(0, 8000),
    '```',
    '</details>',
  ].join('\n');
  return {
    repo: targetRepo,
    title,
    body,
    labels: ['bug', 'pipeline-failure', 'align-transport-closed'],
    classification: 'align-transport-closed',
  };
}

// Templated diagnosis for the "align-all-parallel: permission-denial stall" signature.
// Skips the LLM investigation (a fresh agent in the same headless auto mode would hit
// the same auto-denial wall) and files a concise, actionable issue pointing at the
// runner bail, the skill body/allow-list mismatch as the root cause, and the tool
// equivalents the sub-agents should use instead of raw shell.
function buildAlignPermissionStallDiagnosis(event, contextSummary) {
  const targetRepo = classifyRepo(event);
  const scopeLabel = event.scope || event.pipelineType || 'event';
  const title = `Pipeline failure: ${event.pipelineType || 'generate'} ${scopeLabel} — align: permission-denial stall`
    .slice(0, 120);
  const body = [
    '## Summary',
    'The `align-all-parallel` sub-agents issued tool calls outside their narrow Bash',
    'allow-rules (e.g. raw `mkdir -p`/`ls`/`grep`/`sed` pipelines). The pipeline runs',
    "headless with `permissionMode:'auto'` and NO approval callback, so the SDK auto-denies",
    'those calls with "The user doesn\'t want to take this action right now. STOP what you',
    'are doing and wait for the user...". The sub-agents obeyed that text literally and',
    'halted, producing no aligned USFM (observed: EZK 16, 2026-07-21 — issue #235). The',
    'runner now detects a run of these auto-denials and bails fast (`permission_stall`)',
    'instead of looping to the skill timeout and banking garbage JSON.',
    '',
    '## Failure event',
    `- pipelineType: ${event.pipelineType || '(unknown)'}`,
    `- scope: ${event.scope || '(none)'}`,
    `- phase: ${event.phase || '(none)'}`,
    `- severity: ${event.severity || '(unknown)'}`,
    `- message: ${event.message || '(none)'}`,
    '',
    '## Next steps',
    '- Root cause is a skill body vs. `allowed-tools` mismatch: the ULT/UST-alignment',
    '  `SKILL.md` bodies teach raw shell the frontmatter allow-list forbids. Ensure every',
    '  step uses the workspace-tools (`node /app/src/workspace-tools-cli.js <tool>` first,',
    '  `mcp__workspace-tools__<tool>` alternate) instead of raw `grep`/`sed`/`mkdir` shell.',
    '- The skill should instruct sub-agents: if a tool call is denied, switch to the',
    '  workspace-tools equivalent and continue — never stop and wait.',
    '- Re-run the chapter once the skill body no longer reaches for out-of-allowlist shell.',
    '',
    '## Diagnosis context',
    '<details><summary>Click to expand</summary>',
    '',
    '```',
    String(contextSummary || '').slice(0, 8000),
    '```',
    '</details>',
  ].join('\n');
  return {
    repo: targetRepo,
    title,
    body,
    labels: ['bug', 'pipeline-failure', 'align-permission-stall'],
    classification: 'align-permission-stall',
  };
}

// Templated diagnosis for `errorKind === 'permission_wall'` on any skill/pipeline
// (issue #294). A wall means every tool call was refused from OUTSIDE this
// process's own permission config and the refusal outlasted the runner's retry
// window (`resultIndicatesPermissionWall` in `src/claude-runner.js`, #271;
// recorded as a structured errorKind by `classifyPermissionFailure` in
// `src/notes-pipeline.js` as of #288). This is EXTERNAL and TRANSIENT — nothing in
// our skills, prompts, or allowlists caused it — so unlike the stall template the
// advice here is simply "re-run", not "fix the allowlist". Filed directly instead
// of running the LLM diagnosis agent because a fresh agent hits the identical
// external refusal (DAN 4 2026-07-27T23:19:16Z, DAN 5 2026-07-28T11:30:53Z).
function buildPermissionWallDiagnosis(event, contextSummary, checkpoint, evidence) {
  const targetRepo = classifyRepo(event);
  const scopeLabel = event.scope || event.pipelineType || 'event';
  const skill = (checkpoint && checkpoint.current && checkpoint.current.skill) || '(unknown)';
  const title = `Pipeline failure: ${event.pipelineType || 'unknown'} ${scopeLabel} — external permission wall`
    .slice(0, 120);
  const body = [
    '## Summary',
    `The \`${skill}\` step hit an external permission wall: every tool call was refused from`,
    "outside this process's own permission config, and the refusal outlasted the runner's",
    'retry window. This is NOT a skill, prompt, or allowlist problem — nothing in our code',
    'caused it, and walls clear on their own. This templated issue was filed instead of',
    'running the LLM diagnosis agent because a fresh agent in the same process would hit',
    'the identical external refusal (see DAN 4 and DAN 5, 2026-07-27/28 — issue #294).',
    '',
    '## Failure event',
    `- pipelineType: ${event.pipelineType || '(unknown)'}`,
    `- scope: ${event.scope || '(none)'}`,
    `- phase: ${event.phase || '(none)'}`,
    `- severity: ${event.severity || '(unknown)'}`,
    `- message: ${event.message || '(none)'}`,
    '',
  ];
  if (evidence && (evidence.runLogPath || evidence.transcriptPath)) {
    body.push('## Evidence');
    if (evidence.runLogPath) body.push(`- Run log (JSONL): \`${evidence.runLogPath}\``);
    if (evidence.transcriptPath) body.push(`- SDK transcript: \`${evidence.transcriptPath}\``);
    body.push('');
  }
  body.push(
    '## Next steps',
    '- Re-run the affected chapter/scope. The wall is external and transient, so a retry',
    '  with no code changes is the expected fix — do not chase a local allowlist change.',
    '- If the same scope walls repeatedly across retries, escalate: a wall that never',
    '  clears is no longer "transient" and warrants investigating the upstream permission',
    '  layer (see #292).',
    '',
    '## Diagnosis context',
    '<details><summary>Click to expand</summary>',
    '',
    '```',
    String(contextSummary || '').slice(0, 8000),
    '```',
    '</details>',
  );
  return {
    repo: targetRepo,
    title,
    body: body.join('\n'),
    labels: ['bug', 'pipeline-failure', 'permission-wall'],
    classification: 'permission-wall',
  };
}

// Templated diagnosis for a `permission_stall` errorKind on a NON-align skill
// (issue #294). Structurally the same failure as `buildAlignPermissionStallDiagnosis`
// — a headless `permissionMode:'auto'` run auto-denied an out-of-allowlist tool call
// and the sub-agent obeyed "STOP what you are doing and wait" literally instead of
// switching tools — but the align template's advice (SKILL.md body vs. align's
// specific workspace-tools allow-list) doesn't generalize to an arbitrary skill, so
// this stays generic and points at the run log / skill name instead.
function buildPermissionStallDiagnosis(event, contextSummary, checkpoint, evidence) {
  const targetRepo = classifyRepo(event);
  const scopeLabel = event.scope || event.pipelineType || 'event';
  const skill = (checkpoint && checkpoint.current && checkpoint.current.skill) || '(unknown)';
  const title = `Pipeline failure: ${event.pipelineType || 'unknown'} ${scopeLabel} — permission-denial stall (${skill})`
    .slice(0, 120);
  const body = [
    '## Summary',
    `The \`${skill}\` step issued a tool call outside its allow-list. The pipeline runs`,
    "headless with `permissionMode:'auto'` and no approval callback, so the SDK auto-denied",
    'the call with "The user doesn\'t want to take this action right now. STOP what you are',
    'doing and wait for the user...". The sub-agent obeyed that text literally and halted,',
    'producing no usable output. This templated issue was filed instead of running the LLM',
    'diagnosis agent because a fresh agent in the same headless auto mode would hit the',
    'identical auto-denial wall (see DAN 4 and DAN 5, 2026-07-27/28 — issue #294).',
    '',
    '## Failure event',
    `- pipelineType: ${event.pipelineType || '(unknown)'}`,
    `- scope: ${event.scope || '(none)'}`,
    `- phase: ${event.phase || '(none)'}`,
    `- severity: ${event.severity || '(unknown)'}`,
    `- message: ${event.message || '(none)'}`,
    '',
  ];
  if (evidence && (evidence.runLogPath || evidence.transcriptPath)) {
    body.push('## Evidence');
    if (evidence.runLogPath) body.push(`- Run log (JSONL): \`${evidence.runLogPath}\``);
    if (evidence.transcriptPath) body.push(`- SDK transcript: \`${evidence.transcriptPath}\``);
    body.push('- Look for `"denied":true` tool_use entries in the run log — a run of these is the');
    body.push('  auto-denial wall, not a model flake.');
    body.push('');
  }
  body.push(
    '## Next steps',
    `- Root cause is very likely a skill body vs. \`allowed-tools\` mismatch: check the`,
    `  \`${skill}\` SKILL.md against the tools it actually invokes.`,
    '- The skill should instruct sub-agents: if a tool call is denied, switch to an',
    '  allowed equivalent and continue — never stop and wait, since no human approval',
    '  callback exists in this headless run.',
    '- Re-run once the skill body no longer reaches for an out-of-allowlist tool.',
    '',
    '## Diagnosis context',
    '<details><summary>Click to expand</summary>',
    '',
    '```',
    String(contextSummary || '').slice(0, 8000),
    '```',
    '</details>',
  );
  return {
    repo: targetRepo,
    title,
    body: body.join('\n'),
    labels: ['bug', 'pipeline-failure', 'permission-stall'],
    classification: 'permission-stall',
  };
}

// Templated diagnosis for a recognized runner guardrail stop (looping tool errors
// or budget exhaustion). No LLM investigation is run — the signature is well
// understood — so we file a concise, actionable issue directly.
function buildGuardrailStopDiagnosis(event, contextSummary) {
  const targetRepo = classifyRepo(event);
  const scopeLabel = event.scope || event.pipelineType || 'event';
  const title = `Pipeline guardrail stop: ${event.pipelineType || 'unknown'} ${scopeLabel}`.slice(0, 120);
  const body = [
    '## Summary',
    'A pipeline step was stopped by a runner guardrail (repeated tool errors, max tool calls,',
    'or token budget). This is a known signature, so no agent investigation was run — it was',
    'filed directly. The usual cause is a skill looping on `Edit` "string to replace not found"',
    'against a TSV/JSON source; see the structured by-id tools (update_note_text /',
    'update_prepared_quote / remove_note) and the per-skill repeated-error guardrails.',
    '',
    '## Failure event',
    `- pipelineType: ${event.pipelineType || '(unknown)'}`,
    `- scope: ${event.scope || '(none)'}`,
    `- phase: ${event.phase || '(none)'}`,
    `- severity: ${event.severity || '(unknown)'}`,
    `- message: ${event.message || '(none)'}`,
    '',
    '## Diagnosis context',
    '<details><summary>Click to expand</summary>',
    '',
    '```',
    String(contextSummary || '').slice(0, 8000),
    '```',
    '</details>',
  ].join('\n');
  return {
    repo: targetRepo,
    title,
    body,
    labels: ['bug', 'pipeline-failure', 'guardrail-stop'],
    classification: 'guardrail-stop',
  };
}

// Templated diagnosis for a diagnosis agent that did NOT finish (timeout, max
// turns, or token budget) and produced no parseable output. No investigation
// findings are available, so this captures the originating failure event +
// context so the auto-issue-handler still sees it. Previously this path threw,
// which silently dropped the pipeline failure entirely.
function buildIncompleteDiagnosis(event, contextSummary, agentInfo = {}) {
  const targetRepo = classifyRepo(event);
  const scopeLabel = event.scope || event.pipelineType || 'event';
  const subtype = agentInfo.subtype || 'unknown';
  const title = `Pipeline failure: ${event.pipelineType || 'unknown'} ${scopeLabel} — self-diagnosis incomplete (${subtype})`
    .slice(0, 120);
  const body = [
    '## Summary',
    `The self-diagnosis agent did not complete (subtype=\`${subtype}\`) and produced no parseable`,
    'output, so no automated root-cause analysis is available. Filing this issue from the failure',
    'event + context so the originating pipeline failure is captured for triage rather than dropped.',
    '',
    '## Failure event',
    `- pipelineType: ${event.pipelineType || '(unknown)'}`,
    `- scope: ${event.scope || '(none)'}`,
    `- phase: ${event.phase || '(none)'}`,
    `- severity: ${event.severity || '(unknown)'}`,
    `- message: ${event.message || '(none)'}`,
    '',
    '## Diagnosis agent outcome',
    `- subtype: ${subtype}`,
    `- error: ${String(agentInfo.error || '').slice(0, 500) || '(none)'}`,
    `- result_head: ${String(agentInfo.resultHead || '').slice(0, 500) || '(none)'}`,
    '',
    'A `timeout` subtype usually means the read-only investigation exceeded its time budget',
    '(see `runDiagnosisAgent` timeoutMs). Investigate the failure event manually using the context below.',
    '',
    '## Diagnosis context',
    '<details><summary>Click to expand</summary>',
    '',
    '```',
    String(contextSummary || '').slice(0, 8000),
    '```',
    '</details>',
  ].join('\n');
  return {
    repo: targetRepo,
    title,
    body,
    labels: ['bug', 'pipeline-failure', 'self-diagnosis-incomplete'],
    classification: 'self-diagnosis-incomplete',
  };
}

async function dispatchSelfDiagnosis({
  event,
  checkpoint = null,
  errorText = null,
  evidence = null,
  runClaudeImpl,
  fetchImpl,
  readSecretImpl,
  readAdminStatusImpl,
} = {}) {
  if (!event || typeof event !== 'object' || !event.message) {
    return { ok: false, reason: 'invalid-event' };
  }

  // Boundary log markers so the restart-safety check in CLAUDE.md can
  // distinguish a diagnosis sub-agent's [claude-runner] lines from a real
  // in-progress pipeline session. Any [claude-runner] activity that falls
  // between [self-diagnosis] Starting and [self-diagnosis] Done belongs to
  // the diagnosis run, not to a user-initiated pipeline.
  const scopeLabel = event.scope || '(no-scope)';
  console.log(`[self-diagnosis] Starting (pipelineType=${event.pipelineType || 'unknown'} scope=${scopeLabel})`);

  try {
    const fingerprint = buildFingerprint(event);
    const targetRepo = classifyRepo(event);
    const marker = `${FINGERPRINT_PREFIX} ${fingerprint}`;

    const githubToken = (readSecretImpl || readSecret)('github_token', 'GITHUB_TOKEN');
    if (!githubToken) {
      throw new Error('github_token secret not configured');
    }

    const fetcher = fetchImpl || fetch;
    const existing = await searchExistingIssueByMarkers(
      fetcher,
      githubToken,
      targetRepo,
      [marker]
    );
    if (existing) {
      console.log(`[self-diagnosis] Existing issue ${existing.html_url} matches fingerprint ${fingerprint}; skipping`);
      console.log(`[self-diagnosis] Done (action=reused issue=${targetRepo}#${existing.number})`);
      return { ok: true, action: 'reused', issue: existing, fingerprint };
    }

    const readEvents = readAdminStatusImpl || readAdminStatus;
    const recent = readEvents({ scope: event.scope || undefined, limit: 20 });
    const recentEvents = Array.isArray(recent) ? [...recent].reverse() : [];

    const workdir = process.env.CSKILLBP_DIR || process.cwd();
    const contextSummary = buildContextSummary(event, recentEvents, checkpoint, errorText, workdir, evidence);

    let diagnosis;
    let usedFallback = false;
    let parseError = null;
    let shortCircuited = false;
    let shortCircuitTag = null;

    if (isGuardrailStop(errorText) || isGuardrailStop(event.message)) {
      // Known signature — skip the LLM investigation and file a templated issue.
      console.log('[self-diagnosis] Guardrail-stop signature recognized; filing templated issue without running the agent.');
      diagnosis = buildGuardrailStopDiagnosis(event, contextSummary);
      shortCircuited = true;
      shortCircuitTag = 'guardrail';
    } else if (isPermissionWall(errorText, checkpoint) || isPermissionWall(event.message, checkpoint)) {
      // Known signature (#294, widened off align-only) — every tool call was refused
      // from OUTSIDE this process's own permission config (external + transient). A
      // fresh diagnosis agent would hit the identical external refusal, so
      // short-circuit to a templated issue on any skill/pipeline, not just align.
      console.log('[self-diagnosis] External permission-wall signature recognized; filing templated issue without running the agent.');
      diagnosis = buildPermissionWallDiagnosis(event, contextSummary, checkpoint, evidence);
      shortCircuited = true;
      shortCircuitTag = 'permission-wall';
    } else if (isAlignTransportClosed(errorText) || isAlignTransportClosed(event.message)) {
      // Known signature — the in-process workspace-tools MCP transport was torn down
      // mid-align ("Stream closed"). A fresh diagnosis agent would hit the same dead
      // transport, so short-circuit to a templated issue.
      console.log('[self-diagnosis] Align "Stream closed" MCP-transport signature recognized; filing templated issue without running the agent.');
      diagnosis = buildAlignTransportClosedDiagnosis(event, contextSummary);
      shortCircuited = true;
      shortCircuitTag = 'align-transport-closed';
    } else if (isAlignPermissionStall(errorText, checkpoint) || isAlignPermissionStall(event.message, checkpoint)) {
      // Known signature — a sub-agent's out-of-allowlist tool calls were auto-denied
      // in headless auto mode ("STOP and wait") and it halted. A fresh diagnosis agent
      // would hit the same wall, so short-circuit to a templated issue. #294 widened
      // this off align-only: pick the align-specific template (which carries genuinely
      // align-specific advice about its SKILL.md/allow-list) only when the failing
      // skill actually is align; any other skill gets the generic stall template.
      const stallSkill = String((checkpoint && checkpoint.current && checkpoint.current.skill) || '');
      const isAlignStall = !stallSkill || /align/i.test(stallSkill);
      console.log(`[self-diagnosis] Permission-denial-stall signature recognized (skill=${stallSkill || 'unknown'}); filing templated issue without running the agent.`);
      diagnosis = isAlignStall
        ? buildAlignPermissionStallDiagnosis(event, contextSummary)
        : buildPermissionStallDiagnosis(event, contextSummary, checkpoint, evidence);
      shortCircuited = true;
      shortCircuitTag = isAlignStall ? 'align-permission-stall' : 'permission-stall';
    } else if (isAlignMissingOutput(errorText, checkpoint) || isAlignMissingOutput(event.message, checkpoint)) {
      // Known signature — align-all-parallel produced no (or only partial) aligned
      // output. The LLM diagnosis agent times out on this signature (issue #174),
      // so short-circuit for both missing_output and incomplete_coverage.
      const alignErrorKind = checkpoint && checkpoint.current && checkpoint.current.errorKind;
      console.log(`[self-diagnosis] Align missing/partial-output signature recognized (errorKind=${alignErrorKind || 'text-match'}); filing templated issue without running the agent.`);
      diagnosis = buildAlignMissingOutputDiagnosis(event, contextSummary, alignErrorKind);
      shortCircuited = true;
      shortCircuitTag = 'align-missing-output';
    } else {
      const agentResult = await runDiagnosisAgent({ contextSummary, runClaudeImpl });
      const rawText = agentResult.rawText;
      const cleanSubtype = agentResult.subtype || 'unknown';
      const nonSuccess = cleanSubtype !== 'success';
      if (nonSuccess) {
        const flavor = rawText ? 'agent_non_success_with_text' : 'agent_non_success_no_text';
        try {
          await publishAdminStatus({
            source: 'self-diagnosis',
            pipelineType: event.pipelineType || 'system',
            scope: event.scope || null,
            phase: 'self-diagnosis',
            severity: 'warn',
            message: `Diagnosis agent non-success (${flavor}): subtype=${cleanSubtype}`,
          });
        } catch (_) { /* non-fatal */ }
      }

      try {
        diagnosis = extractDiagnosisJson(rawText);
      } catch (err) {
        parseError = err;
        const rawPath = persistRawDiagnosisOutput(fingerprint, rawText);
        if (rawPath) {
          console.error(`[self-diagnosis] Persisted unparseable raw output to ${rawPath}`);
        }
        if (!looksLikeDiagnosisAttempt(rawText)) {
          if (nonSuccess) {
            // Agent ran out of time/turns/budget and produced nothing usable.
            // Don't drop the originating failure — file a concise templated
            // issue so the auto-issue-handler still sees it.
            console.error(
              `[self-diagnosis] Agent non-success (subtype=${cleanSubtype}) with no usable output; filing templated incomplete-diagnosis issue.`
            );
            diagnosis = buildIncompleteDiagnosis(event, contextSummary, {
              subtype: cleanSubtype,
              error: agentResult.error,
              resultHead: agentResult.resultHead,
            });
            usedFallback = true;
          } else {
            throw err;
          }
        } else {
          console.error(`[self-diagnosis] JSON parse failed (${err.message.slice(0, 200)}); filing fallback issue with raw output`);
          diagnosis = buildFallbackDiagnosis(event, rawText, err, contextSummary);
          usedFallback = true;
        }
      }
    }

    const finalRepo = VALID_REPOS.has(diagnosis.repo) ? diagnosis.repo : targetRepo;
    const finalBody = appendFingerprintMarker(diagnosis.body, fingerprint);
    const created = await createGithubIssue(fetcher, githubToken, finalRepo, {
      title: diagnosis.title,
      body: finalBody,
      labels: diagnosis.labels,
    });

    try {
      await publishAdminStatus({
        source: 'self-diagnosis',
        pipelineType: event.pipelineType || 'system',
        scope: event.scope || null,
        phase: 'self-diagnosis',
        severity: 'info',
        message: `Filed diagnosis issue ${finalRepo}#${created.number}: ${created.html_url}`,
      });
    } catch (_) { /* non-fatal */ }

    const action = shortCircuited
      ? (shortCircuitTag === 'guardrail' ? 'created-guardrail' : `created-${shortCircuitTag}`)
      : (usedFallback ? 'created-fallback' : 'created');
    console.log(`[self-diagnosis] Done (action=${action} issue=${finalRepo}#${created.number}${usedFallback ? ' parse-error=' + (parseError && parseError.message ? parseError.message.slice(0, 120) : 'unknown') : ''})`);
    return { ok: true, action, issue: created, fingerprint, classification: diagnosis.classification };
  } catch (err) {
    const reason = err && err.message ? err.message : String(err);
    console.error(`[self-diagnosis] Failed: ${reason}`);
    try {
      await publishAdminStatus({
        source: 'self-diagnosis',
        pipelineType: event.pipelineType || 'system',
        scope: event.scope || null,
        phase: 'self-diagnosis',
        severity: 'warn',
        message: `Self-diagnosis failed for ${event.scope || 'event'}: ${reason.slice(0, 200)}`,
      });
    } catch (_) { /* non-fatal */ }
    console.log(`[self-diagnosis] Done (action=failed reason=${reason.slice(0, 80)})`);
    return { ok: false, reason };
  }
}

module.exports = {
  dispatchSelfDiagnosis,
  buildFingerprint,
  classifyRepo,
  normalizeSignature,
  extractDiagnosisJson,
  repairAgentJson,
  looksLikeDiagnosisAttempt,
  buildFallbackDiagnosis,
  buildGuardrailStopDiagnosis,
  buildAlignMissingOutputDiagnosis,
  isAlignMissingOutput,
  buildAlignTransportClosedDiagnosis,
  isAlignTransportClosed,
  buildAlignPermissionStallDiagnosis,
  isAlignPermissionStall,
  buildPermissionWallDiagnosis,
  isPermissionWall,
  buildPermissionStallDiagnosis,
  buildIncompleteDiagnosis,
  buildContextSummary,
  appendFingerprintMarker,
  FINGERPRINT_PREFIX,
};
