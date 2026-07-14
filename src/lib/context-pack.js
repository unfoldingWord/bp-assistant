// context-pack.js — load a per-language translation context pack.
//
// The pack is a DCS repo per gateway-language org (CONTEXT-REPO-CONTRACT.md),
// pinned by contextRef for reproducible runs:
//   "org/repo@ref"    → fetched from git.door43.org raw endpoints
//   a local directory → used as-is (dev fixtures, dry runs, tests)
//
// Human-authority layout (prompt input; bot never writes these):
//   manifest.yaml                 format, language, direction, provenance
//   brief.md  instructions.md     (+ optional leftover standards.md)
//   templates/templates.tsv       support_reference → target_template (status=active)
//   terminology/terms.csv         concept-oriented 7-col schema
//   examples/validated.jsonl      with tombstones (last-line-wins)
//
// Bot namespace (runs/, candidates/) is never loaded here.

'use strict';

const fs = require('fs');
const path = require('path');

const DCS_BASE = 'https://git.door43.org';
const SUPPORTED_MANIFEST_FORMAT = 1;

const PACK_FILES = {
  manifest: 'manifest.yaml',
  brief: 'brief.md',
  instructions: 'instructions.md',
  standards: 'standards.md', // optional leftover; additive / ignore-unknown
  templates: 'templates/templates.tsv',
  terminology: 'terminology/terms.csv',
  examples: 'examples/validated.jsonl',
};

const TERM_STATUSES = new Set([
  'preferred', 'admitted', 'deprecated', 'forbidden', 'do_not_translate',
]);

function nfc(s) {
  return s == null ? s : String(s).normalize('NFC');
}

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

/** Minimal YAML subset for manifest.yaml (key: value scalars). */
function parseManifestYaml(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^([A-Za-z_][\w]*)\s*:\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  if (out.format != null && out.format !== '') {
    const n = Number(out.format);
    out.format = Number.isFinite(n) ? n : out.format;
  } else {
    out.format = 1;
  }
  return out;
}

function parseRegisterFromBrief(brief) {
  if (!brief) return null;
  const m = /\*\*Register:\*\*\s*(\w+)/i.exec(brief);
  if (!m) return null;
  const v = m[1].toLowerCase();
  if (v === 'default' || v === 'formal' || v === 'informal') return v;
  return null;
}

/**
 * RFC-4180 CSV row parser (quoted fields, escaped "").
 * Returns array of string fields for one line (or null if line is empty).
 */
function parseCsvLine(line) {
  const s = String(line);
  if (!s.trim()) return null;
  const fields = [];
  let i = 0;
  while (i <= s.length) {
    if (i === s.length) {
      fields.push('');
      break;
    }
    if (s[i] === '"') {
      let out = '';
      i += 1;
      while (i < s.length) {
        if (s[i] === '"') {
          if (s[i + 1] === '"') { out += '"'; i += 2; continue; }
          i += 1;
          break;
        }
        out += s[i];
        i += 1;
      }
      fields.push(out);
      if (s[i] === ',') { i += 1; continue; }
      break;
    }
    let j = i;
    while (j < s.length && s[j] !== ',') j += 1;
    fields.push(s.slice(i, j));
    i = j + 1;
    if (j === s.length) break;
  }
  return fields;
}

// templates.tsv: support_reference \t target_template \t status \t comment
// Keyed by bare slug (figs-metaphor). Only status=active rows are retained
function parseTemplatesTsv(text) {
  const templates = new Map();
  const lines = String(text).replace(/\r\n/g, '\n').split('\n').filter(Boolean);
  for (const line of lines) {
    if (/^support[_]?reference\t/i.test(line)) continue;
    const [slug, template, status, comment] = line.split('\t');
    if (!slug || !template) continue;
    const st = (status || '').trim().toLowerCase();
    if (st !== 'active') continue;
    templates.set(slug.trim(), {
      template,
      status: 'active',
      comment: comment || '',
      notes: comment || '',
    });
  }
  return templates;
}

// terms.csv: concept_id,source_term,target_term,status,replacement,comment,tw_link
function parseTermsCsv(text) {
  const terms = [];
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  let header = null;
  for (const line of lines) {
    const fields = parseCsvLine(line);
    if (!fields) continue;
    if (!header) {
      header = fields.map((h) => h.trim().toLowerCase());
      continue;
    }
    const row = {};
    header.forEach((h, idx) => { row[h] = fields[idx] != null ? fields[idx] : ''; });

    const source = nfc((row.source_term || '').trim());
    if (!source) continue;
    let status = (row.status || '').trim().toLowerCase() || 'preferred';
    if (status === 'approved') status = 'preferred';
    if (status === 'candidate') status = 'admitted';
    if (!TERM_STATUSES.has(status)) continue;

    const target = nfc((row.target_term || '').trim());
    if (status !== 'do_not_translate' && status !== 'forbidden' && !target) continue;

    terms.push({
      conceptId: (row.concept_id || '').trim(),
      source,
      target,
      status,
      replacement: nfc((row.replacement || '').trim()),
      comment: (row.comment || row.notes || '').trim(),
      notes: (row.comment || row.notes || '').trim(),
      twLink: (row.tw_link || '').trim(),
    });
  }
  return terms;
}

/**
 * Parse validated.jsonl with tombstone last-line-wins on (resource, rowId).
 */
function parseExamplesJsonl(text) {
  const byKey = new Map();
  let seq = 0;
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== 'object') continue;
    seq += 1;
    const resource = obj.resource || 'tn';
    const rowId = obj.rowId != null ? String(obj.rowId) : `anon-${seq}`;
    const key = `${resource}\0${rowId}`;
    if (obj.tombstone) {
      byKey.delete(key);
      continue;
    }
    if (!obj.source || !obj.target) continue;
    byKey.set(key, {
      resource,
      rowId,
      book: obj.book || null,
      ref: obj.ref || null,
      supportReference: obj.supportReference || null,
      source: nfc(obj.source),
      target: nfc(obj.target),
      validated_at: obj.validated_at != null ? Number(obj.validated_at) : seq,
      _seq: seq,
    });
  }
  return [...byKey.values()].sort((a, b) => (a.validated_at - b.validated_at) || (a._seq - b._seq));
}

/**
 * Load and parse a context pack.
 * @param {string} contextRef - "org/repo@ref" or a local directory path
 * @param {object} [opts]
 * @param {boolean} [opts.allowEmpty=false] - if false, throw when the pack has
 *   no prompt-affecting content files (misconfig guard for an EXPLICIT ref).
 */
async function loadContextPack(contextRef, { fetchImpl, allowEmpty = false } = {}) {
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

  let manifest = null;
  if (raw.manifest != null) {
    manifest = parseManifestYaml(raw.manifest);
    if (typeof manifest.format === 'number' && manifest.format > SUPPORTED_MANIFEST_FORMAT) {
      throw new Error(
        `context pack manifest format ${manifest.format} is not supported `
        + `(max supported: ${SUPPORTED_MANIFEST_FORMAT}) at "${contextRef}"`);
    }
  }

  // Exact empty-pack error string is contractual (CONTEXT-REPO-CONTRACT.md §1) —
  // keep stable so the editor can surface it.
  const contentPresent = ['brief', 'instructions', 'standards', 'templates', 'terminology', 'examples']
    .some((k) => raw[k] != null);
  if (!contentPresent && !allowEmpty) {
    throw new Error(
      `context pack has no content files at "${contextRef}" — every prompt-affecting file is missing `
      + `(present: ${entries.filter(([, rel]) => !missing.includes(rel)).map(([, rel]) => rel).join(', ') || 'none'}). `
      + `Check the org/repo/ref exists and is populated. Translating with an empty pack is refused.`);
  }

  const brief = raw.brief;
  return {
    ref: String(contextRef),
    sha,
    manifest,
    brief,
    instructions: raw.instructions,
    standards: raw.standards,
    register: parseRegisterFromBrief(brief),
    templates: raw.templates ? parseTemplatesTsv(raw.templates) : new Map(),
    terms: raw.terminology ? parseTermsCsv(raw.terminology) : [],
    examples: raw.examples ? parseExamplesJsonl(raw.examples) : [],
    missing,
    hasContent: contentPresent,
  };
}

module.exports = {
  loadContextPack,
  parseContextRef,
  parseTemplatesTsv,
  parseTermsCsv,
  parseExamplesJsonl,
  parseManifestYaml,
  parseRegisterFromBrief,
  parseCsvLine,
  PACK_FILES,
  SUPPORTED_MANIFEST_FORMAT,
};
