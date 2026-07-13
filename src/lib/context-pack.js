// context-pack.js — load a per-language translation context pack.
//
// The pack is a DCS repo per gateway-language org (PIPELINE-SPEC.md §3),
// pinned by contextRef for reproducible runs:
//   "org/repo@ref"    → fetched from git.door43.org raw endpoints
//   a local directory → used as-is (dev fixtures, dry runs, tests)
//
// Layout inside the pack (all content files optional; missing ones are
// reported in `missing` and the skill degrades — English-template fallback):
//   manifest.yaml
//   brief.md  instructions.md  standards.md
//   templates/templates.tsv      supportReference<TAB>target_template<TAB>status<TAB>notes
//   terminology/terms.csv        source_term,target_term,status,notes
//   examples/validated.jsonl     {"supportReference","source","target",...} per line

'use strict';

const fs = require('fs');
const path = require('path');

const DCS_BASE = 'https://git.door43.org';

const PACK_FILES = {
  manifest: 'manifest.yaml',
  brief: 'brief.md',
  instructions: 'instructions.md',
  standards: 'standards.md',
  templates: 'templates/templates.tsv',
  terminology: 'terminology/terms.csv',
  examples: 'examples/validated.jsonl',
};

function parseContextRef(contextRef) {
  const m = /^([^/@\s]+)\/([^/@\s]+)@(.+)$/.exec(String(contextRef || '').trim());
  if (!m) return null;
  return { org: m[1], repo: m[2], ref: m[3] };
}

function rawUrl({ org, repo, ref }, filePath) {
  const kind = /^[0-9a-f]{40}$/i.test(ref) ? 'commit' : 'branch';
  return `${DCS_BASE}/${org}/${repo}/raw/${kind}/${encodeURIComponent(ref)}/${filePath}`;
}

async function fetchText(url, fetchImpl) {
  const res = await (fetchImpl || fetch)(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`fetch ${url} → HTTP ${res.status}`);
  return await res.text();
}

/** Resolve a branch contextRef to its current commit SHA (best effort). */
async function resolveContextSha(parsed, fetchImpl) {
  if (/^[0-9a-f]{40}$/i.test(parsed.ref)) return parsed.ref;
  try {
    const url = `${DCS_BASE}/api/v1/repos/${parsed.org}/${parsed.repo}/branches/${encodeURIComponent(parsed.ref)}`;
    const res = await (fetchImpl || fetch)(url);
    if (!res.ok) return null;
    const body = await res.json();
    return body && body.commit && body.commit.id ? body.commit.id : null;
  } catch {
    return null;
  }
}

// templates.tsv: supportReference \t target_template \t status \t notes
// Keyed by the bare slug (figs-metaphor), which is how tN SupportReference
// values end: rc://*/ta/man/translate/figs-metaphor.
function parseTemplatesTsv(text) {
  const templates = new Map();
  const lines = String(text).replace(/\r\n/g, '\n').split('\n').filter(Boolean);
  for (const line of lines) {
    if (/^supportReference\t/i.test(line)) continue; // header
    const [slug, template, status, notes] = line.split('\t');
    if (!slug || !template) continue;
    templates.set(slug.trim(), { template, status: (status || '').trim() || 'draft', notes: notes || '' });
  }
  return templates;
}

// terms.csv: source_term,target_term,status,notes — naive CSV, no quoted
// commas supported in v1 (terminology entries are short phrases; revisit if
// a real pack needs embedded commas).
function parseTermsCsv(text) {
  const terms = [];
  const lines = String(text).replace(/\r\n/g, '\n').split('\n').filter(Boolean);
  for (const line of lines) {
    if (/^source_term,/i.test(line)) continue; // header
    const [source, target, status, ...rest] = line.split(',');
    if (!source || !target) continue;
    terms.push({
      source: source.trim(),
      target: target.trim(),
      status: (status || '').trim() || 'candidate',
      notes: rest.join(',').trim(),
    });
  }
  return terms;
}

function parseExamplesJsonl(text) {
  const examples = [];
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && obj.source && obj.target) examples.push(obj);
    } catch {
      // Skip malformed lines rather than failing the run; the pack is
      // team-edited data, and one bad line must not block translation.
    }
  }
  return examples;
}

/**
 * Load and parse a context pack.
 * @param {string} contextRef - "org/repo@ref" or a local directory path
 * @returns {Promise<{ref, sha, manifest, brief, instructions, standards,
 *   templates: Map, terms: Array, examples: Array, missing: string[]}>}
 */
async function loadContextPack(contextRef, { fetchImpl } = {}) {
  const parsed = parseContextRef(contextRef);
  const isLocal = !parsed && fs.existsSync(contextRef) && fs.statSync(contextRef).isDirectory();
  if (!parsed && !isLocal) {
    throw new Error(`contextRef must be "org/repo@ref" or an existing local directory, got: ${contextRef}`);
  }

  async function readPackFile(rel) {
    if (isLocal) {
      const p = path.join(contextRef, rel);
      return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
    }
    return fetchText(rawUrl(parsed, rel), fetchImpl);
  }

  // Pack files are independent; fetch them (and the SHA) in one parallel wave
  // rather than ~8 serial round-trips to DCS.
  const entries = Object.entries(PACK_FILES);
  const raw = {};
  const missing = [];
  const [contents, sha] = await Promise.all([
    Promise.all(entries.map(([, rel]) => readPackFile(rel))),
    isLocal ? Promise.resolve(null) : resolveContextSha(parsed, fetchImpl),
  ]);
  entries.forEach(([key, rel], i) => {
    raw[key] = contents[i];
    if (raw[key] == null) missing.push(rel);
  });

  // A pack with no CONTENT files is almost always a misconfiguration (wrong
  // org, repo not created/populated, bad ref) rather than an intentional
  // empty pack. Fail loudly instead of silently translating with zero context.
  // manifest.yaml is metadata only (not injected into prompts), so a repo
  // holding just a manifest still counts as empty. Partial packs (some
  // templates/examples present) are legitimate and degrade.
  const contentPresent = ['brief', 'instructions', 'standards', 'templates', 'terminology', 'examples']
    .some((k) => raw[k] != null);
  if (!contentPresent) {
    throw new Error(
      `context pack has no content files at "${contextRef}" — every prompt-affecting file is missing `
      + `(present: ${entries.filter(([, rel]) => !missing.includes(rel)).map(([, rel]) => rel).join(', ') || 'none'}). `
      + `Check the org/repo/ref exists and is populated. Translating with an empty pack is refused.`);
  }

  return {
    ref: String(contextRef),
    sha,
    manifest: raw.manifest,
    brief: raw.brief,
    instructions: raw.instructions,
    standards: raw.standards,
    templates: raw.templates ? parseTemplatesTsv(raw.templates) : new Map(),
    terms: raw.terminology ? parseTermsCsv(raw.terminology) : [],
    examples: raw.examples ? parseExamplesJsonl(raw.examples) : [],
    missing,
  };
}

module.exports = { loadContextPack, parseContextRef, parseTemplatesTsv, parseTermsCsv, parseExamplesJsonl, PACK_FILES };
