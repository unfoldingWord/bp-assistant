'use strict';

const crypto = require('crypto');
const { runClaude } = require('./claude-runner');
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

You may use Read and Grep to inspect:
- bp-assistant source files (src/*.js) to understand the failure path
- Skill files in bp-assistant-skills (.claude/skills/) when the failure points at a skill
- The admin-status.jsonl tail for related events
- Output files referenced in the error (e.g. cSkillBP/output/...) to see what was actually produced

Constraints:
- You CANNOT modify files. Read-only investigation.
- Spend at most a few tool calls — do not exhaustively read every file.
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

function buildContextSummary(event, contextEvents, checkpoint, errorText) {
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

function extractDiagnosisJson(raw) {
  if (!raw || typeof raw !== 'string') {
    throw new Error('Diagnosis agent returned no text');
  }
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenceMatch ? fenceMatch[1].trim() : raw.trim();
  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    const startIdx = candidate.indexOf('{');
    const endIdx = candidate.lastIndexOf('}');
    if (startIdx >= 0 && endIdx > startIdx) {
      parsed = JSON.parse(candidate.slice(startIdx, endIdx + 1));
    } else {
      throw new Error(`Diagnosis agent returned invalid JSON: ${candidate.slice(0, 200)}`);
    }
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
    cwd: process.cwd(),
    model: 'sonnet',
    allowedTools: ['Read', 'Grep'],
    mcpToolSet: 'workspace',
    disableLocalSettings: true,
    appendSystemPrompt: SYSTEM_PROMPT,
    maxTurns: 30,
    timeoutMs: 3 * 60 * 1000,
    guardrails: { maxToolCalls: 25, tokenBudget: 200000 },
  });
  if (result?.subtype && result.subtype !== 'success') {
    throw new Error(`Diagnosis agent did not complete cleanly: subtype=${result.subtype}`);
  }
  return extractResultText(result);
}

function appendFingerprintMarker(body, fingerprint) {
  const marker = `<!-- ${FINGERPRINT_PREFIX} ${fingerprint} -->`;
  return `${body.trimEnd()}\n\n${marker}\n`;
}

async function dispatchSelfDiagnosis({
  event,
  checkpoint = null,
  errorText = null,
  runClaudeImpl,
  fetchImpl,
  readSecretImpl,
  readAdminStatusImpl,
} = {}) {
  if (!event || typeof event !== 'object' || !event.message) {
    return { ok: false, reason: 'invalid-event' };
  }

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
      return { ok: true, action: 'reused', issue: existing, fingerprint };
    }

    const readEvents = readAdminStatusImpl || readAdminStatus;
    const recent = readEvents({ scope: event.scope || undefined, limit: 20 });
    const recentEvents = Array.isArray(recent) ? [...recent].reverse() : [];

    const contextSummary = buildContextSummary(event, recentEvents, checkpoint, errorText);
    const rawText = await runDiagnosisAgent({ contextSummary, runClaudeImpl });
    const diagnosis = extractDiagnosisJson(rawText);

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

    return { ok: true, action: 'created', issue: created, fingerprint, classification: diagnosis.classification };
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
    return { ok: false, reason };
  }
}

module.exports = {
  dispatchSelfDiagnosis,
  buildFingerprint,
  classifyRepo,
  normalizeSignature,
  extractDiagnosisJson,
  buildContextSummary,
  appendFingerprintMarker,
  FINGERPRINT_PREFIX,
};
