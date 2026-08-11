// Audit a Door43 TSV resource repo book-by-book: which books hold finished
// translation vs the source-language placeholder they started as.
//
// Why this exists: config/translate-targets.json pins a source ref per language,
// and a repo that was wholly placeholder when that ref was chosen can be partly
// translated later. A stale premise there silently feeds the model finished
// target-language text as its SOURCE — which is exactly what happened to
// BSOJ/ar_tn (see that file's ar note, verified 2026-08-11). Re-run this before
// trusting any translate-in-place configuration.
//
//   node scripts/audit-resource-script.mjs [org/repo@ref] [targetLang]
//   node scripts/audit-resource-script.mjs BSOJ/ar_tn@master ar
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
// Same detector the runtime guard uses, so the audit and the pipeline can never
// disagree about what counts as "already in the target script".
const { hasScript, scriptOf } = require('../src/lib/script-guard.js');

const BASE = 'https://git.door43.org';
const REF = process.argv[2] || 'BSOJ/ar_tn@master';
const TARGET_LANG = process.argv[3] || 'ar';
const m = REF.match(/^([^/@\s]+)\/([^/@\s]+)@(.+)$/);
if (!m) throw new Error(`bad ref (want org/repo@branch): ${REF}`);
const [, org, repo, branch] = m;

const targetScript = scriptOf(TARGET_LANG);
if (!targetScript) throw new Error(`unknown target language: ${TARGET_LANG}`);

const tree = await (await fetch(`${BASE}/api/v1/repos/${org}/${repo}/git/trees/${branch}?recursive=1&per_page=1000`)).json();
const files = tree.tree.filter(e => /^tn_[A-Z0-9]{3}\.tsv$/.test(e.path)).map(e => e.path);

async function audit(file) {
  const res = await fetch(`${BASE}/${org}/${repo}/raw/branch/${encodeURIComponent(branch)}/${file}`);
  if (!res.ok) return { file, error: res.status };
  const text = await res.text();
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  const header = lines.shift().split('\t');
  const noteIdx = header.indexOf('Note');
  if (noteIdx < 0) return { file, error: 'no Note column: ' + header.join('|') };
  let total = 0, inTarget = 0, latinOnly = 0, empty = 0;
  for (const line of lines) {
    const note = (line.split('\t')[noteIdx] || '').trim();
    if (!note) { empty++; continue; }
    total++;
    if (hasScript(note, targetScript)) inTarget++;
    else if (hasScript(note, 'latin')) latinOnly++;
  }
  return { file, book: file.slice(3, 6), rows: total, empty, inTarget, latinOnly, pct: total ? Math.round((inTarget / total) * 1000) / 10 : 0 };
}

const out = [];
const queue = [...files];
await Promise.all(Array.from({ length: 6 }, async () => {
  for (let f = queue.shift(); f; f = queue.shift()) out.push(await audit(f));
}));

// TRANSLATED / PLACEHOLDER are the two ends; anything between is PARTIAL and is
// the interesting case — a book being actively worked on right now.
const verdictOf = (pct) => (pct >= 95 ? 'TRANSLATED' : pct <= 5 ? 'PLACEHOLDER' : 'PARTIAL');

out.sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1));
console.log(`${REF} — target ${TARGET_LANG} (${targetScript})\n`);
console.log('book\trows\tinTarget\tlatinOnly\tpct\tverdict');
for (const r of out) {
  if (r.error) { console.log(`${r.file}\tERROR ${r.error}`); continue; }
  console.log(`${r.book}\t${r.rows}\t${r.inTarget}\t${r.latinOnly}\t${r.pct}\t${verdictOf(r.pct)}`);
}
const c = { TRANSLATED: 0, PARTIAL: 0, PLACEHOLDER: 0 };
for (const r of out) if (!r.error) c[verdictOf(r.pct)]++;
console.log(`\nTOTALS: ${JSON.stringify(c)} of ${out.length} books`);
const translated = out.filter((r) => !r.error && verdictOf(r.pct) === 'TRANSLATED').map((r) => r.book);
if (translated.length) {
  console.log(`\nAlready translated (do NOT use as a translation SOURCE): ${translated.join(' ')}`);
}
