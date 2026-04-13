'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { sendMessage, sendDM, addReaction, removeReaction } = require('./zulip-client');
const { readSecret } = require('./secrets');
const { resolveProviderModel } = require('./api-runner/provider-config');

const GITHUB_ORG = 'unfoldingWord';
const VALID_REPOS = new Set(['bp-assistant', 'bp-assistant-skills']);

const SYSTEM_PROMPT = `You are an issue classifier for a Bible translation AI pipeline with two GitHub repositories:

1. **bp-assistant** (app repo): The Zulip bot infrastructure — message routing, route config, pipeline dispatch, Docker setup, Zulip client, Door43/Gitea git push, usage tracking, session state, authentication, timeout logic. Choose this repo when the issue is about bot behavior, message handling, or infrastructure.

2. **bp-assistant-skills** (skills repo): AI behavior and prompts — translation note writing (tn-writer skill), quality checks (tn-quality-check), template compliance, AT (Alternate Translation) matching, note formatting, split snippets, issue identification, parallel batch processing, alignment, UST/ULT generation. Choose this repo when the issue is about what the AI writes, how it formats notes, or how it follows templates.

Analyze the user feedback and respond with ONLY valid JSON (no prose, no markdown code fences):
{
  "repo": "bp-assistant" or "bp-assistant-skills",
  "title": "concise issue title (under 72 chars)",
  "body": "well-formatted GitHub issue body in markdown with sections: ## Summary, ## Steps to Reproduce (if applicable), ## Expected Behavior, ## Actual Behavior, ## Reporter",
  "labels": array of 1-3 strings chosen from: ["bug", "enhancement", "ai-quality", "template-compliance"]
}`;

async function sendReply(message, text) {
  if (message.type === 'stream') {
    return sendMessage(message.display_recipient, message.subject, text);
  }
  return sendDM(message.sender_id, text);
}

async function issueReportPipeline(route, message) {
  // Extract feedback text by stripping @mention and trigger keyword
  const cleanContent = message.content.replace(/^@\*\*[^*]+\*\*\s*/, '').trim();
  const feedbackMatch = cleanContent.match(/^(?:report|feedback|issue|bug)[:\s]\s*([\s\S]+)/i);
  const feedbackText = feedbackMatch ? feedbackMatch[1].trim() : null;

  if (!feedbackText) {
    await sendReply(message,
      'Please include feedback text after the trigger word. Example: `report: The AI is doing X instead of Y`');
    return;
  }

  console.log(`[issue-report] Received from ${message.sender_full_name}: ${feedbackText.slice(0, 80)}...`);

  try { await addReaction(message.id, 'eyes'); } catch (_) {}

  try {
    // Classify issue with Sonnet
    const apiKey = process.env.ANTHROPIC_API_KEY || readSecret('anthropic_api_key', 'ANTHROPIC_API_KEY');
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: resolveProviderModel('claude', 'sonnet'),
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: `Feedback from ${message.sender_full_name}:\n\n${feedbackText}`,
      }],
    });

    const raw = response.content[0]?.text?.trim();
    if (!raw) throw new Error('Empty response from classifier');

    let classified;
    try {
      classified = JSON.parse(raw);
    } catch {
      throw new Error(`Classifier returned invalid JSON: ${raw.slice(0, 200)}`);
    }

    const { repo, title, body, labels } = classified;
    if (!VALID_REPOS.has(repo)) throw new Error(`Unknown repo from classifier: ${repo}`);

    // Create GitHub issue
    const githubToken = readSecret('github_token', 'GITHUB_TOKEN');
    if (!githubToken) throw new Error('github_token secret not configured');

    const ghRes = await fetch(`https://api.github.com/repos/${GITHUB_ORG}/${repo}/issues`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${githubToken}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ title, body, labels }),
    });

    if (!ghRes.ok) {
      const err = await ghRes.text();
      throw new Error(`GitHub API error ${ghRes.status}: ${err.slice(0, 200)}`);
    }

    const issue = await ghRes.json();
    console.log(`[issue-report] Created ${repo}#${issue.number}: ${title}`);

    await sendReply(message, `Filed [**${repo}#${issue.number}**](${issue.html_url}): ${title}`);

    try { await removeReaction(message.id, 'eyes'); } catch (_) {}
    try { await addReaction(message.id, 'check'); } catch (_) {}

  } catch (err) {
    console.error(`[issue-report] Error:`, err.message);
    await sendReply(message, `Failed to file issue: ${err.message}`);
    try { await removeReaction(message.id, 'eyes'); } catch (_) {}
    try { await addReaction(message.id, 'warning'); } catch (_) {}
  }
}

module.exports = { issueReportPipeline };
