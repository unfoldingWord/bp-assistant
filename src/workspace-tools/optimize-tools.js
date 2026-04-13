// optimize-tools.js — Post-fetch optimization of reference files for AI consumption
//
// Uses the Anthropic Messages API directly (not the Agent SDK) for one-shot transforms.

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { resolveProviderModel } = require('../api-runner/provider-config');

const CSKILLBP_DIR = process.env.CSKILLBP_DIR || '/srv/bot/workspace';

/**
 * Optimize issues_resolved.txt by reorganizing chronological entries into
 * topically-organized, deduplicated, actionable rules for AI consumption.
 *
 * Reads:  data/issues_resolved.txt (raw, preserved as-is)
 * Writes: data/issues_resolved_optimized.txt (AI-reorganized)
 */
async function optimizeIssuesResolved() {
  const rawPath = path.join(CSKILLBP_DIR, 'data/issues_resolved.txt');
  const outPath = path.join(CSKILLBP_DIR, 'data/issues_resolved_optimized.txt');

  if (!fs.existsSync(rawPath)) {
    return 'Skipped: data/issues_resolved.txt not found';
  }

  const raw = fs.readFileSync(rawPath, 'utf8');
  const fetchedDate = raw.match(/^# Fetched: (\S+)/)?.[1] || 'unknown';

  // Check if optimized version is already current
  if (fs.existsSync(outPath)) {
    const existing = fs.readFileSync(outPath, 'utf8');
    const existingSource = existing.match(/from source fetched (\S+)/)?.[1];
    if (existingSource === fetchedDate) {
      return `Optimized version already current (source: ${fetchedDate})`;
    }
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return 'Skipped: ANTHROPIC_API_KEY not set';
  }

  const client = new Anthropic({ apiKey });
  const today = new Date().toISOString().slice(0, 10);

  const response = await client.messages.create({
    model: resolveProviderModel('claude', 'sonnet'),
    max_tokens: 32000,
    messages: [{
      role: 'user',
      content: `You are reorganizing a Bible translation team's "Issues Resolved" document for AI consumption. The source is organized chronologically by meeting date. Your job is to reorganize it by TOPIC so an AI translator can quickly find relevant decisions.

## Rules
1. Organize into these sections (in order): UST Decisions, ULT Decisions, TN (Translation Notes) Decisions, Alignment Decisions, General/Vocabulary Decisions
2. Within each section, group related decisions together (e.g., all decisions about divine names together)
3. If a later decision supersedes an earlier one on the same topic, keep ONLY the later one
4. Each entry should be a concise, actionable rule — one line or short paragraph
5. Preserve the date of each decision in parentheses at the end for traceability, e.g., "(Mar 4, 2026)"
6. Remove any meta-content (links to agendas, section headers like "Issues Resolved:", blank formatting)
7. Do NOT add commentary or interpretation — just reorganize and deduplicate
8. Preserve technical terms exactly (Hebrew words, USFM markers, Strong's numbers, etc.)

## Source document

${raw}

## Output

Return ONLY the reorganized content. No preamble, no explanation.`,
    }],
  });

  const optimized = response.content[0]?.text;
  if (!optimized) {
    return 'Error: empty response from optimization API';
  }

  const header = `# Optimized: ${today} from source fetched ${fetchedDate}\n# This file is auto-generated — do not edit. Edit the Google Doc source instead.\n\n`;
  fs.writeFileSync(outPath, header + optimized);

  const rawSize = Buffer.byteLength(raw);
  const optSize = Buffer.byteLength(header + optimized);
  const pct = ((1 - optSize / rawSize) * 100).toFixed(1);
  return `Optimized issues_resolved: ${rawSize} → ${optSize} bytes (${pct}% smaller), source: ${fetchedDate}`;
}

module.exports = { optimizeIssuesResolved };
