'use strict';

const { sendMessage, sendDM, addReaction, removeReaction } = require('./zulip-client');
const { readSecret } = require('./secrets');
const { ensureFreshToken } = require('./auth-refresh');
const {
  buildGithubHeaders,
  searchExistingIssue,
  searchExistingIssueByMarkers,
  createGithubIssue,
  updateGithubIssue,
} = require('./github-issues');

let _query = null;
async function getQuery() {
  if (!_query) {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    _query = sdk.query;
  }
  return _query;
}

const GITHUB_ORG = 'unfoldingWord';
const VALID_REPOS = new Set(['bp-assistant', 'bp-assistant-skills']);
const VALID_LABELS = new Set(['bug', 'enhancement', 'ai-quality', 'template-compliance']);
const TRIGGER_RE = /^(?:report|feedback|issue|bug)[:\s]\s*([\s\S]+)/i;
const CLASSIFIER_MAX_TOKENS = [2048, 8192];

const SYSTEM_PROMPT = `You are an issue classifier for a Bible translation AI pipeline with two GitHub repositories:

1. **bp-assistant** (app repo): The Zulip bot infrastructure — message routing, route config, pipeline dispatch, Docker setup, Zulip client, Door43/Gitea git push, usage tracking, session state, authentication, timeout logic. Choose this repo when the issue is about bot behavior, message handling, context packaging, tool/MCP exposure, preprocessing, post-processing, chunking, merging, or infrastructure.

2. **bp-assistant-skills** (skills repo): AI behavior and prompts — translation note writing (tn-writer skill), quality checks (tn-quality-check), template compliance, AT (Alternate Translation) matching, note formatting, split snippets, issue identification, and TN-writing guidance. Choose this repo when the issue is about what the AI writes, how it formats notes, or how it follows skill instructions.

Analyze the report and respond with ONLY valid JSON (no prose, no markdown code fences) in this shape:
{
  "complaints": [
    {
      "id": "c1",
      "summary": "one atomic complaint from the report",
      "evidence": ["short direct quote or paraphrase from the report"],
      "likely_layers": ["bp-assistant"] or ["bp-assistant-skills"] or ["bp-assistant", "bp-assistant-skills"]
    }
  ],
  "ownership": {
    "repositories": ["bp-assistant"] or ["bp-assistant-skills"] or ["bp-assistant", "bp-assistant-skills"],
    "primary_repo": "bp-assistant" or "bp-assistant-skills",
    "secondary_repo": "bp-assistant" or "bp-assistant-skills" or null,
    "rationale": "short explanation of why these repo assignments fit"
  },
  "issues": [
    {
      "id": "i1",
      "repo": "bp-assistant" or "bp-assistant-skills",
      "complaint_ids": ["c1"],
      "title": "concise issue title (under 72 chars)",
      "body": "well-formatted GitHub issue body in markdown with sections: ## Summary, ## Steps to Reproduce (if applicable), ## Expected Behavior, ## Actual Behavior, ## Reporter",
      "labels": ["bug"]
    }
  ]
}

Rules:
- First decompose the report into atomic complaints. Do not skip this step.
- Complaints stay atomic, but issue creation stays repo-scoped: return at most one issue per repo.
- When multiple complaints belong to the same repo, combine them into a single well-structured issue and include all relevant complaint_ids.
- Every issue must reference one or more complaint_ids from the complaints array.
- Use repository ownership based on root cause, not shallow keyword matching.
- Open issues in both repos only when the report plausibly spans both layers.
- Keep repo targets limited to bp-assistant and bp-assistant-skills.
- When both repos are implicated, choose a primary_repo and secondary_repo.
- Each repo listed in ownership.repositories must appear in exactly one issue.`;

function stripLeadingMention(content) {
  return String(content || '').replace(/^@\*\*[^*]+\*\*\s*/, '').trim();
}

function extractFeedbackText(content) {
  const cleanContent = stripLeadingMention(content);
  const feedbackMatch = cleanContent.match(TRIGGER_RE);
  return feedbackMatch ? feedbackMatch[1].trim() : null;
}

function extractImageUrls(text) {
  const matches = String(text || '').match(/https?:\/\/\S+\.(?:png|jpe?g|gif|webp)(?:\?\S*)?/gi);
  return matches || [];
}

function buildClassifierInput(message, feedbackText) {
  const lines = [
    `Reporter: ${message.sender_full_name || 'Unknown reporter'}`,
    `Message ID: ${message.id ?? 'unknown'}`,
    `Message type: ${message.type || 'unknown'}`,
  ];

  if (message.type === 'stream') {
    lines.push(`Stream: ${message.display_recipient || 'unknown'}`);
    lines.push(`Topic: ${message.subject || 'unknown'}`);
  }

  if (Array.isArray(message.attachments) && message.attachments.length > 0) {
    lines.push('Attachments:');
    for (const attachment of message.attachments) {
      const parts = [];
      if (attachment.name) parts.push(`name=${attachment.name}`);
      if (attachment.title) parts.push(`title=${attachment.title}`);
      if (attachment.content_type) parts.push(`content_type=${attachment.content_type}`);
      if (attachment.url) parts.push(`url=${attachment.url}`);
      lines.push(`- ${parts.join(', ')}`);
    }
  }

  const imageUrls = extractImageUrls(feedbackText);
  if (imageUrls.length > 0) {
    lines.push('Image URLs:');
    for (const url of imageUrls) lines.push(`- ${url}`);
  }

  lines.push('', 'Feedback:', feedbackText);
  return lines.join('\n');
}

function normalizeLabels(labels) {
  if (!Array.isArray(labels)) return [];
  const normalized = [];
  for (const label of labels) {
    if (typeof label !== 'string') continue;
    const trimmed = label.trim();
    if (!VALID_LABELS.has(trimmed) || normalized.includes(trimmed)) continue;
    normalized.push(trimmed);
    if (normalized.length >= 3) break;
  }
  return normalized;
}

function normalizeClassifierJson(raw) {
  const text = String(raw || '').trim();
  if (!text.startsWith('```')) return text;

  const fenceMatch = text.match(/^```(?:json)?\r?\n([\s\S]*?)(?:\r?\n```)?$/i);
  if (!fenceMatch) return text;
  return fenceMatch[1];
}

function shouldRetryClassifierJson(raw, stopReason) {
  const text = normalizeClassifierJson(raw);
  if (stopReason === 'max_tokens') return true;
  if (!text) return false;
  return text.startsWith('{') && !text.endsWith('}');
}

async function runAgentSdkClassifierQuery({ classifierInput, getClaudeQuery = getQuery }) {
  await ensureFreshToken();
  const queryFn = await getClaudeQuery();
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), 300000);
  const options = {
    cwd: process.cwd(),
    abortController,
    maxTurns: 1,
    allowedTools: [],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    persistSession: false,
    model: 'sonnet',
    systemPrompt: SYSTEM_PROMPT,
  };

  const conversation = queryFn({
    prompt: `Classify this issue report and respond with JSON only:\n\n${classifierInput}`,
    options,
  });
  let raw = '';
  let stopReason = 'unknown';

  try {
    for await (const event of conversation) {
      if (abortController.signal.aborted) break;
      if (event.type === 'assistant' && event.message?.content) {
        for (const block of event.message.content) {
          if (block && typeof block.text === 'string') raw += block.text;
        }
      } else if (event.type === 'result') {
        stopReason = event.stop_reason || event.subtype || stopReason;
        if (!raw && typeof event.result === 'string') raw = event.result;
      }
    }
  } catch (err) {
    if (abortController.signal.aborted) {
      throw new Error('Classifier timed out');
    }
    throw err;
  } finally {
    clearTimeout(timer);
    try { conversation.close(); } catch (_) {}
  }

  if (abortController.signal.aborted) {
    throw new Error('Classifier timed out');
  }

  return { raw: raw.trim(), stopReason };
}

async function classifyIssueReport(deps, classifierInput) {
  let lastRaw = '';
  let lastStopReason = 'unknown';

  for (let index = 0; index < CLASSIFIER_MAX_TOKENS.length; index++) {
    const maxTokens = CLASSIFIER_MAX_TOKENS[index];
    const response = await deps.runClassifierQuery({
      classifierInput,
      maxTokens,
      attempt: index + 1,
    });

    const raw = response?.raw?.trim() || '';
    const stopReason = response?.stopReason || 'unknown';
    lastRaw = raw;
    lastStopReason = stopReason;

    if (!raw) {
      throw new Error('Empty response from classifier');
    }

    try {
      return parseClassifierOutput(raw);
    } catch (error) {
      const canRetry = index < CLASSIFIER_MAX_TOKENS.length - 1
        && error.message.startsWith('Classifier returned invalid JSON')
        && shouldRetryClassifierJson(raw, stopReason);
      if (!canRetry) throw error;
      console.warn(`[issue-report] Retrying classifier after ${stopReason} with max_tokens=${CLASSIFIER_MAX_TOKENS[index + 1]}`);
    }
  }

  throw new Error(`Classifier returned invalid JSON: ${String(lastRaw).slice(0, 200)} (stop_reason=${lastStopReason})`);
}

function parseClassifierOutput(raw) {
  const normalizedRaw = normalizeClassifierJson(raw);
  let parsed;
  try {
    parsed = JSON.parse(normalizedRaw);
  } catch {
    throw new Error(`Classifier returned invalid JSON: ${String(raw).slice(0, 200)}`);
  }

  const complaints = parsed?.complaints;
  if (!Array.isArray(complaints) || complaints.length < 1) {
    throw new Error('Classifier returned malformed complaints array');
  }

  const normalizedComplaints = complaints.map((complaint) => {
    if (!complaint || typeof complaint !== 'object') throw new Error('Classifier returned malformed complaint entry');
    const id = typeof complaint.id === 'string' ? complaint.id.trim() : '';
    const summary = typeof complaint.summary === 'string' ? complaint.summary.trim() : '';
    const evidence = Array.isArray(complaint.evidence)
      ? complaint.evidence.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
      : [];
    const likelyLayers = Array.isArray(complaint.likely_layers)
      ? [...new Set(complaint.likely_layers.filter((item) => typeof item === 'string').map((item) => item.trim()))]
      : [];

    if (!id) throw new Error('Classifier returned complaint with empty id');
    if (!summary) throw new Error(`Classifier returned complaint ${id} with empty summary`);
    if (evidence.length < 1) throw new Error(`Classifier returned complaint ${id} without evidence`);
    if (likelyLayers.length < 1 || likelyLayers.some((repo) => !VALID_REPOS.has(repo))) {
      throw new Error(`Classifier returned complaint ${id} with invalid likely_layers`);
    }

    return { id, summary, evidence, likely_layers: likelyLayers };
  });

  const complaintIds = normalizedComplaints.map((complaint) => complaint.id);
  if (new Set(complaintIds).size !== complaintIds.length) {
    throw new Error('Classifier returned duplicate complaint ids');
  }

  const complaintIdSet = new Set(complaintIds);

  const repositories = parsed?.ownership?.repositories;
  if (!Array.isArray(repositories) || repositories.length < 1 || repositories.length > 2) {
    throw new Error('Classifier returned malformed ownership.repositories');
  }

  const uniqueRepos = [...new Set(repositories)];
  if (uniqueRepos.length !== repositories.length || uniqueRepos.some((repo) => !VALID_REPOS.has(repo))) {
    throw new Error('Classifier returned invalid repositories');
  }

  const primaryRepo = parsed?.ownership?.primary_repo;
  const secondaryRepo = parsed?.ownership?.secondary_repo ?? null;
  if (!VALID_REPOS.has(primaryRepo) || !uniqueRepos.includes(primaryRepo)) {
    throw new Error('Classifier returned invalid ownership.primary_repo');
  }
  if (secondaryRepo != null && (!VALID_REPOS.has(secondaryRepo) || !uniqueRepos.includes(secondaryRepo) || secondaryRepo === primaryRepo)) {
    throw new Error('Classifier returned invalid ownership.secondary_repo');
  }
  if (uniqueRepos.length === 2 && secondaryRepo == null) {
    throw new Error('Classifier must set ownership.secondary_repo for dual-repo routing');
  }

  const issues = parsed?.issues;
  if (!Array.isArray(issues) || issues.length < 1) {
    throw new Error('Classifier returned malformed issues array');
  }

  const normalizedIssues = issues.map((issue) => {
    if (!issue || typeof issue !== 'object') throw new Error('Classifier returned malformed issue entry');
    const id = typeof issue.id === 'string' ? issue.id.trim() : '';
    const repo = typeof issue.repo === 'string' ? issue.repo.trim() : '';
    const complaintIds = Array.isArray(issue.complaint_ids)
      ? [...new Set(issue.complaint_ids.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean))]
      : [];
    const title = typeof issue.title === 'string' ? issue.title.trim() : '';
    const body = typeof issue.body === 'string' ? issue.body.trim() : '';
    if (!id) throw new Error('Classifier returned issue with empty id');
    if (!VALID_REPOS.has(repo) || !uniqueRepos.includes(repo)) throw new Error(`Classifier returned unknown repo: ${repo}`);
    if (complaintIds.length < 1) throw new Error(`Classifier returned issue ${id} without complaint_ids`);
    if (complaintIds.some((complaintId) => !complaintIdSet.has(complaintId))) {
      throw new Error(`Classifier returned issue ${id} with unknown complaint_ids`);
    }
    if (!title) throw new Error(`Classifier returned empty title for ${repo}`);
    if (!body) throw new Error(`Classifier returned empty body for ${repo}`);
    return { id, repo, complaint_ids: complaintIds, title, body, labels: normalizeLabels(issue.labels) };
  });

  const issueIds = normalizedIssues.map((issue) => issue.id);
  if (new Set(issueIds).size !== normalizedIssues.length) {
    throw new Error('Classifier returned duplicate issue ids');
  }

  const issuesByRepo = new Map();
  for (const issue of normalizedIssues) {
    const repoIssues = issuesByRepo.get(issue.repo) || [];
    repoIssues.push(issue);
    issuesByRepo.set(issue.repo, repoIssues);
  }

  for (const repo of uniqueRepos) {
    const repoIssues = issuesByRepo.get(repo) || [];
    if (repoIssues.length === 0) {
      throw new Error('Classifier ownership.repositories does not match issue repos');
    }
    if (repoIssues.length > 1) {
      throw new Error(`Classifier returned multiple issues for repo ${repo}`);
    }
  }

  if (issuesByRepo.size !== uniqueRepos.length) {
    throw new Error('Classifier ownership.repositories does not match issue repos');
  }

  return {
    complaints: normalizedComplaints,
    ownership: {
      repositories: uniqueRepos,
      primary_repo: primaryRepo,
      secondary_repo: secondaryRepo,
      rationale: typeof parsed?.ownership?.rationale === 'string' ? parsed.ownership.rationale.trim() : '',
    },
    issues: normalizedIssues,
  };
}

function buildIssueMarker(messageId, issueId) {
  return `issue-report:${messageId}:${issueId}`;
}

function buildIssueDedupeMarker(messageId, repo, complaintIds) {
  const stableComplaintIds = [...new Set((Array.isArray(complaintIds) ? complaintIds : [])
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean))]
    .sort();
  return `issue-report:${messageId}:${repo}:${stableComplaintIds.join('+')}`;
}

function injectMetadata(body, markers) {
  const trimmed = String(body || '').trim();
  const uniqueMarkers = [...new Set((Array.isArray(markers) ? markers : [markers]).filter(Boolean))];
  const metadata = uniqueMarkers.map((marker) => `<!-- ${marker} -->`).join('\n');
  return `${trimmed}\n\n${metadata}`;
}

function addOrReplaceRelatedIssueSection(body, repo, allIssues, ownership) {
  const others = allIssues.filter((issue) => issue.repo !== repo);
  const baseBody = String(body || '').replace(/\n+## Related issue[\s\S]*$/m, '').trim();
  if (others.length === 0) return baseBody;

  const roleLine = ownership.primary_repo === repo
    ? 'This is the primary locus for the report.'
    : `Primary locus is \`${ownership.primary_repo}\`; this issue tracks the linked secondary work.`;
  const lines = ['## Related issue', roleLine];
  for (const other of others) {
    lines.push(`- [${other.repo}#${other.number}](${other.html_url})`);
  }
  return `${baseBody}\n\n${lines.join('\n')}`;
}

async function sendReplyWith(message, text, deps) {
  if (message.type === 'stream') {
    return deps.sendMessage(message.display_recipient, message.subject, text);
  }
  return deps.sendDM(message.sender_id, text);
}

function summarizeIssues(issues) {
  return issues
    .map((issue) => `[**${issue.repo}#${issue.number}**](${issue.html_url})`)
    .join(' and ');
}

function getRuntimeDeps(overrides = {}) {
  return {
    runClassifierQuery: overrides.runClassifierQuery || ((args) => runAgentSdkClassifierQuery({
      ...args,
      getClaudeQuery: overrides.getClaudeQuery || getQuery,
    })),
    sendMessage: overrides.sendMessage || sendMessage,
    sendDM: overrides.sendDM || sendDM,
    addReaction: overrides.addReaction || addReaction,
    removeReaction: overrides.removeReaction || removeReaction,
    readSecret: overrides.readSecret || readSecret,
    fetchImpl: overrides.fetchImpl || fetch,
  };
}

async function issueReportPipeline(route, message, overrides = {}) {
  const deps = getRuntimeDeps(overrides);
  const feedbackText = extractFeedbackText(message.content);

  if (!feedbackText) {
    await sendReplyWith(
      message,
      'Please include feedback text after the trigger word. Example: `report: The AI is doing X instead of Y`',
      deps
    );
    return;
  }

  console.log(`[issue-report] Received from ${message.sender_full_name}: ${feedbackText.slice(0, 80)}...`);

  try { await deps.addReaction(message.id, 'eyes'); } catch (_) {}

  try {
    const classified = await classifyIssueReport(deps, buildClassifierInput(message, feedbackText));
    const githubToken = deps.readSecret('github_token', 'GITHUB_TOKEN');
    if (!githubToken) throw new Error('github_token secret not configured');

    const issueRecords = [];
    for (const issuePlan of classified.issues) {
      const marker = buildIssueMarker(message.id, issuePlan.id);
      const dedupeMarker = buildIssueDedupeMarker(message.id, issuePlan.repo, issuePlan.complaint_ids);
      const existing = await searchExistingIssueByMarkers(
        deps.fetchImpl,
        githubToken,
        issuePlan.repo,
        [dedupeMarker, marker]
      );
      if (existing) {
        issueRecords.push({ ...existing, issue_id: issuePlan.id, complaint_ids: issuePlan.complaint_ids });
        continue;
      }

      const created = await createGithubIssue(deps.fetchImpl, githubToken, issuePlan.repo, {
        title: issuePlan.title,
        body: injectMetadata(issuePlan.body, [dedupeMarker, marker]),
        labels: issuePlan.labels,
      });
      console.log(`[issue-report] Created ${issuePlan.repo}#${created.number}: ${issuePlan.title}`);
      issueRecords.push({ ...created, issue_id: issuePlan.id, complaint_ids: issuePlan.complaint_ids });
    }

    if (issueRecords.length > 1) {
      const bodyById = new Map(classified.issues.map((issue) => [issue.id, issue.body]));
      for (const issueRecord of issueRecords) {
        const issuePlan = classified.issues.find((issue) => issue.id === issueRecord.issue_id);
        if (!issuePlan) {
          throw new Error(`Classifier returned issue ${issueRecord.issue_id} without a matching plan`);
        }
        const desiredBody = addOrReplaceRelatedIssueSection(
          injectMetadata(bodyById.get(issueRecord.issue_id), [
            buildIssueDedupeMarker(message.id, issueRecord.repo, issuePlan.complaint_ids),
            buildIssueMarker(message.id, issueRecord.issue_id),
          ]),
          issueRecord.repo,
          issueRecords.filter((candidate) => candidate.issue_id !== issueRecord.issue_id),
          classified.ownership
        );
        if (desiredBody !== issueRecord.body) {
          const updated = await updateGithubIssue(
            deps.fetchImpl,
            githubToken,
            issueRecord.repo,
            issueRecord.number,
            { body: desiredBody }
          );
          issueRecord.body = updated.body;
        }
      }
    }

    await sendReplyWith(message, `Filed ${summarizeIssues(issueRecords)}.`, deps);

    try { await deps.removeReaction(message.id, 'eyes'); } catch (_) {}
    try { await deps.addReaction(message.id, 'check'); } catch (_) {}
  } catch (err) {
    console.error('[issue-report] Error:', err.message);
    await sendReplyWith(message, `Failed to file issue: ${err.message}`, deps);
    try { await deps.removeReaction(message.id, 'eyes'); } catch (_) {}
    try { await deps.addReaction(message.id, 'warning'); } catch (_) {}
  }
}

module.exports = {
  issueReportPipeline,
  _extractFeedbackText: extractFeedbackText,
  _buildClassifierInput: buildClassifierInput,
  _parseClassifierOutput: parseClassifierOutput,
  _buildIssueMarker: buildIssueMarker,
  _buildIssueDedupeMarker: buildIssueDedupeMarker,
  _addOrReplaceRelatedIssueSection: addOrReplaceRelatedIssueSection,
};
