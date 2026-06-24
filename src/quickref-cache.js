// quickref-cache.js — Phase 3 memory PILOT (opt-in, default OFF).
//
// Builds a DERIVED, read-only "memory" index from the git-versioned decision
// stores (data/quick-ref/*_decisions.csv + data/glossary/project_glossary.md).
// The CSVs/glossary remain the single source of truth and the only writable
// path (via the append_quickref MCP tool); this is a downstream, regenerated
// read replica — a compact index of the human rulings an agent can load instead
// of grepping the full CSVs. It is content-hash keyed so it only rebuilds when
// the sources change, and it is never written by the model.
//
// Nothing calls this automatically. Enable it per environment by running the CLI
// (e.g. after append_quickref, or at pipeline start) and pointing a run at the
// derived index. Keeping it opt-in avoids making a derived artifact load-bearing.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { loadHumanDecisions, resolveSkillsRoot } = require('./human-decision-conflicts');

const DERIVED_HEADER = [
  '# Quick-Ref Memory Index (DERIVED — do not edit)',
  '',
  '> Regenerated from `data/quick-ref/*_decisions.csv` + `data/glossary/project_glossary.md`',
  '> (the source of truth). Edits here are overwritten on the next rebuild. The',
  '> canonical write path is the `append_quickref` MCP tool → the CSVs.',
  '',
].join('\n');

// Stable hash of the decision set — drives rebuild-only-when-changed.
function hashDecisions(decisions) {
  const stable = decisions
    .map((d) => `${d.type}|${d.resource}|${d.strong}|${d.hebrew}|${d.rendering}|${d.book}|${d.context}|${d.notes}`)
    .sort();
  return crypto.createHash('sha256').update(stable.join('\n')).digest('hex').slice(0, 16);
}

// Render the human-friendly index grouped by resource. Pure (testable).
function renderIndex(decisions, { hash } = {}) {
  const groups = new Map();
  for (const d of decisions) {
    const g = d.resource || d.type || 'other';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(d);
  }
  const lines = [DERIVED_HEADER, `_${decisions.length} human ruling(s); index hash \`${hash || hashDecisions(decisions)}\`._`, ''];
  for (const g of [...groups.keys()].sort()) {
    lines.push(`## ${g}`, '');
    for (const d of groups.get(g).sort((a, b) => String(a.strong).localeCompare(String(b.strong)))) {
      const id = [d.strong, d.hebrew].filter(Boolean).join(' ');
      const scope = d.book && d.book !== 'ALL' ? ` [${d.book}]` : '';
      const detail = [d.context, d.notes].filter(Boolean).join(' — ');
      lines.push(`- ${id || '(no key)'} → "${d.rendering}"${scope}${detail ? ` — ${detail}` : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function defaultOutDir() {
  return process.env.QUICKREF_CACHE_DIR || path.resolve(__dirname, '../data/quick-ref-cache');
}

// Build (or refresh) the derived index. Returns { built, path, hash, entries, reason? }.
function buildQuickRefCache({ skillsRoot, outDir = defaultOutDir(), deps = {} } = {}) {
  const read = deps.loadHumanDecisions || loadHumanDecisions;
  const writeFile = deps.writeFileSync || fs.writeFileSync;
  const readFile = deps.readFileSync || fs.readFileSync;
  const mkdir = deps.mkdirSync || ((p) => fs.mkdirSync(p, { recursive: true }));
  const exists = deps.existsSync || fs.existsSync;

  const root = resolveSkillsRoot(skillsRoot);
  const decisions = read(root);
  const hash = hashDecisions(decisions);
  const indexPath = path.join(outDir, 'quick-ref-index.md');
  const hashPath = path.join(outDir, '.cache-hash');

  if (exists(hashPath)) {
    let prev = '';
    try { prev = String(readFile(hashPath, 'utf8')).trim(); } catch { /* ignore */ }
    if (prev === hash && exists(indexPath)) {
      return { built: false, reason: 'unchanged', path: indexPath, hash, entries: decisions.length };
    }
  }
  mkdir(outDir);
  writeFile(indexPath, renderIndex(decisions, { hash }) + '\n');
  writeFile(hashPath, hash + '\n');
  return { built: true, path: indexPath, hash, entries: decisions.length };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--skills-root') out.skillsRoot = argv[++i];
    else if (argv[i] === '--out-dir') out.outDir = argv[++i];
  }
  return out;
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const res = buildQuickRefCache({ skillsRoot: args.skillsRoot, outDir: args.outDir });
  process.stdout.write(`${res.built ? 'built' : 'unchanged'} ${res.path} (${res.entries} rulings, hash ${res.hash})\n`);
}

module.exports = {
  buildQuickRefCache,
  renderIndex,
  hashDecisions,
  defaultOutDir,
  DERIVED_HEADER,
};
