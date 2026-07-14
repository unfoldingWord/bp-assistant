// translate-suggestions.js — build ≤4 panel-ready suggestion cards for the
// context-repo candidates inbox (CONTEXT-REPO-CONTRACT.md §4.3).
// Deterministic heuristics only — no second LLM call in v1.

'use strict';

const { slugFromSupportReference } = require('./translate-core');

const MAX_SUGGESTIONS = 4;

function padId(n) {
  return `sug_${String(n).padStart(2, '0')}`;
}

/**
 * Rank SupportReference slugs that had no active template, by hit count.
 */
function collectTemplateNeeded(sourceRows, pack) {
  const hits = new Map();
  const samples = new Map();
  for (const row of sourceRows || []) {
    const slug = slugFromSupportReference(row.SupportReference);
    if (!slug) continue;
    if (pack && pack.templates && pack.templates.has(slug)) continue;
    hits.set(slug, (hits.get(slug) || 0) + 1);
    if (!samples.has(slug)) samples.set(slug, []);
    const list = samples.get(slug);
    if (list.length < 3 && row.ID) list.push(row.ID);
  }
  return [...hits.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([slug, hitCount]) => ({ slug, hitCount, sampleRowIds: samples.get(slug) || [] }));
}

function freeText(row) {
  return String(row.Note || row.Question || row.Response || '');
}

/**
 * Harvest bold-span source→target pairs when source/target notes share the
 * same number of **bold** markers. Skip pairs already preferred/admitted.
 */
function collectTermObservations(sourceRows, targetRows, pack) {
  const known = new Map(); // lower source -> Set of lower targets
  for (const t of (pack && pack.terms) || []) {
    if (t.status !== 'preferred' && t.status !== 'admitted') continue;
    const key = String(t.source || '').toLowerCase();
    if (!key) continue;
    if (!known.has(key)) known.set(key, new Set());
    if (t.target) known.get(key).add(String(t.target).toLowerCase());
  }

  const byId = new Map((targetRows || []).map((r) => [r.ID, r]));
  const observed = new Map();

  for (const src of sourceRows || []) {
    const tgt = byId.get(src.ID);
    if (!tgt) continue;
    const srcText = freeText(src);
    const tgtText = freeText(tgt);
    const boldSrc = [...srcText.matchAll(/\*\*([^*]+)\*\*/g)].map((m) => m[1].trim().normalize('NFC'));
    const boldTgt = [...tgtText.matchAll(/\*\*([^*]+)\*\*/g)].map((m) => m[1].trim().normalize('NFC'));
    if (!boldSrc.length || boldSrc.length !== boldTgt.length) continue;

    for (let i = 0; i < boldSrc.length; i++) {
      const s = boldSrc[i];
      const t = boldTgt[i];
      if (!s || !t || s === t) continue;
      const existing = known.get(s.toLowerCase());
      if (existing && existing.size) continue; // already in human vocabulary
      const key = `${s}\0${t}`;
      if (!observed.has(key)) {
        observed.set(key, { source: s, target: t, count: 0, sampleRowIds: [] });
      }
      const o = observed.get(key);
      o.count += 1;
      if (o.sampleRowIds.length < 3 && src.ID) o.sampleRowIds.push(src.ID);
    }
  }

  return [...observed.values()].sort((a, b) => b.count - a.count || a.source.localeCompare(b.source));
}

/**
 * Build an inbox payload with ≤ MAX_SUGGESTIONS cards.
 * @returns {{ version, suggestions, ...meta }}
 */
function buildSuggestionInbox({
  runId,
  jobId = null,
  generatedAt = null,
  contextRef,
  contextSha = null,
  sourceRef = null,
  targetOrg = null,
  targetRepo = null,
  branch = null,
  resourceType = 'tn',
  scope = null,
  pack,
  sourceRows = [],
  targetRows = [],
  maxSuggestions = MAX_SUGGESTIONS,
} = {}) {
  const suggestions = [];

  for (const item of collectTemplateNeeded(sourceRows, pack)) {
    if (suggestions.length >= maxSuggestions) break;
    suggestions.push({
      id: padId(suggestions.length + 1),
      kind: 'template_needed',
      action: 'promote',
      promoteTo: 'templates/templates.tsv',
      summary: `Missing template for ${item.slug} (${item.hitCount} hit${item.hitCount === 1 ? '' : 's'})`,
      fields: {
        support_reference: item.slug,
        target_template: '',
        status: 'active',
        comment: '',
      },
      evidence: { hitCount: item.hitCount, sampleRowIds: item.sampleRowIds },
    });
  }

  for (const item of collectTermObservations(sourceRows, targetRows, pack)) {
    if (suggestions.length >= maxSuggestions) break;
    suggestions.push({
      id: padId(suggestions.length + 1),
      kind: 'term',
      action: 'promote',
      promoteTo: 'terminology/terms.csv',
      summary: `Observed rendering: ${item.source} → ${item.target}`,
      fields: {
        concept_id: '',
        source_term: item.source,
        target_term: item.target,
        status: 'preferred',
        replacement: '',
        comment: '',
        tw_link: '',
      },
      evidence: { occurrences: item.count, sampleRowIds: item.sampleRowIds },
    });
  }

  return {
    version: 1,
    runId,
    jobId,
    generatedAt: generatedAt || new Date().toISOString(),
    contextRef,
    contextSha,
    sourceRef,
    targetOrg,
    targetRepo,
    branch,
    resourceType,
    scope: scope || null,
    suggestions,
  };
}

/**
 * Write-back is allowed only with explicit assisted context + non-empty pack,
 * or an explicit writeContextBack flag — never on a defaulted contextRef alone.
 */
function shouldWriteContextBack(params, pack) {
  if (params && params.writeContextBack === true) return true;
  if (params && params.writeContextBack === false) return false;
  return !!(params && params.contextRefExplicit && pack && pack.hasContent);
}

module.exports = {
  MAX_SUGGESTIONS,
  buildSuggestionInbox,
  collectTemplateNeeded,
  collectTermObservations,
  shouldWriteContextBack,
};
