#!/usr/bin/env node
// report.mjs — the review page for a modernize run: per-book counts, then
// every rewritten note old/new with a word diff, rows needing a human first.
//
//   node scripts/tn-modernize/report.mjs [--out <file.html>] BOOK [BOOK...]
//
// Reads output/modernize/<BOOK>/{extract.json,results.jsonl,calls.jsonl}.
// Writes one self-contained HTML page (default output/modernize/report.html).

import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const lib = require('./lib.js');

const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
const OUT = outIdx >= 0 ? argv[outIdx + 1] : path.join(lib.WORK_DIR, 'output/modernize/report.html');
const books = argv.filter((a, i) => /^[0-9A-Z]{3}$/.test(a) && (outIdx < 0 || i !== outIdx + 1));
if (!books.length) { console.error('usage: report.mjs [--out file.html] BOOK [BOOK...]'); process.exit(2); }

const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Note markdown to HTML: **bold**, and the literal two-character \n as a break.
const md = (s) => esc(s).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\\n/g, '<span class="br" title="paragraph break">¶</span><br>');

/** Word diff (LCS over whitespace tokens). Returns [oldHtml, newHtml]. */
function diff(a, b) {
  const x = String(a).split(/(\s+)/).filter((t) => t !== '');
  const y = String(b).split(/(\s+)/).filter((t) => t !== '');
  const n = x.length, m = y.length;
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const oa = [], ob = [];
  let i = 0, j = 0;
  const push = (arr, t, cls) => { if (cls && /^\s+$/.test(t)) cls = ''; arr.push(cls ? `\u0001${cls}\u0002${t}\u0003` : t); };
  while (i < n && j < m) {
    if (x[i] === y[j]) { push(oa, x[i++], ''); push(ob, y[j++], ''); }
    else if (L[i + 1][j] >= L[i][j + 1]) push(oa, x[i++], 'del');
    else push(ob, y[j++], 'ins');
  }
  while (i < n) push(oa, x[i++], 'del');
  while (j < m) push(ob, y[j++], 'ins');
  const render = (arr) => md(arr.join(''))
    .replace(/\u0001(del|ins)\u0002/g, '<span class="$1">').replace(/\u0003/g, '</span>');
  return [render(oa), render(ob)];
}

const REASON_TEXT = {
  bold_not_in_ult: 'bold text is not in the ULT verse', at_lost_or_changed: 'an alternate translation was lost or reworded',
  at_invented: 'an alternate translation was invented', at_not_bracketed: 'an alternate translation is not in [brackets]',
  link_in_note: 'a link was left in the note', name_added: 'a name the old note and the verse do not have (the model inferred it)', name_from_verse: 'a name the old note lacks, taken from the verse text', name_from_template: 'a name the old note lacks, taken from the template wording (check it is not example text)', no_claims_checked: 'the claim list was empty, so the information check had nothing to test', link_not_covered: 'a dropped link whose information is not carried anywhere else (D5)', proper_noun_dropped: 'a name was dropped', reference_dropped: 'a scripture reference was dropped',
  template_phrase_missing: 'the note does not follow its template', placeholder_left: 'a template placeholder was left unfilled',
  unknown_template: 'the model named a template that does not exist', self_talk: 'the model left its own reasoning in the note',
  raw_newline_or_tab: 'a raw line break or tab', claim_missing: 'the claim check found information missing', model_no_result: 'the model returned nothing for this row',
  other_link: 'a link with no policy yet', no_ult_text: 'no ULT text for this reference', empty_note: 'the note is empty',
  old_span_dropped: 'ULT words the old note pointed at are no longer mentioned', template_at_omitted: 'the template has an alternate translation the old note lacks',
  at_quote_pair: 'an alternate translation carries one quotation mark of a pair the verse has both of',
};
const say = (code) => esc(code.startsWith('model_declined') ? `declined: ${code.replace(/^model_declined:\s*/, '')}` : (REASON_TEXT[code] || code));

function bucket(r) {
  if (r.status === 'changed') return r.warnings.length ? 'flagged' : 'changed';
  if (r.reasons.some((x) => x.startsWith('model_declined'))) return 'declined';
  if (r.new_rejected) return 'held';
  return r.model ? 'held' : 'skipped';
}
const BUCKETS = [
  ['flagged', 'Changed, check these', 'Every gate passed, but something needs a human look.'],
  ['held', 'Held back', 'The model rewrote the note but a gate failed, so the original stays.'],
  ['declined', 'Declined by the model', 'The model judged the note unfit for any template. The original stays.'],
  ['changed', 'Changed', 'Every gate passed.'],
  ['skipped', 'Not attempted', 'Extract set these aside before any model saw them.'],
];

const sections = [];
const summaryRows = [];
const linkRows = [];
let totalCost = 0, totalCalls = 0;
let snapshot = '';
for (const book of books) {
  const dir = path.join(lib.WORK_DIR, 'output/modernize', book);
  const ex = JSON.parse(fs.readFileSync(path.join(dir, 'extract.json'), 'utf8'));
  snapshot = ex.templates_snapshot;
  const results = readJsonl(path.join(dir, 'results.jsonl'));
  const calls = readJsonl(path.join(dir, 'calls.jsonl'));
  const cost = calls.reduce((s, c) => s + (c.costUsd || 0), 0);
  totalCost += cost; totalCalls += calls.length;
  const by = Object.fromEntries(BUCKETS.map(([k]) => [k, []]));
  for (const r of results) by[bucket(r)].push(r);
  const c = ex.counts;
  const rewritten = results.filter((r) => r.model).length;
  summaryRows.push(`<tr><th scope="row">${book}</th><td>${c.rows}</td><td>${(c.conforms || 0)}</td><td>${(c.no_template || 0) + (c.no_phrase || 0) + (c.no_sref || 0) + (c.intro || 0)}</td><td>${results.length}</td>` +
    BUCKETS.map(([k]) => `<td class="n-${k}">${by[k].length}</td>`).join('') +
    `<td>$${cost.toFixed(2)}${rewritten ? ` <span class="dim">($${(cost / rewritten).toFixed(3)}/note)</span>` : ''}</td></tr>`);

  for (const r of results) for (const l of r.dropped_links || []) {
    if (l.covered) continue;
    linkRows.push(`<tr><td>${book} ${esc(r.Reference)}</td><td>${esc(r.ID)}</td><td>${l.kind === 'see-tw' ? 'tW link not in the twl file' : 'second issue with no note of its own'}</td><td><code>${l.targets.map((t) => esc(t.replace(/^rc:\/\/\*\//, ''))).join('<br>')}</code></td></tr>`);
  }

  const cards = [];
  for (const [k, label, help] of BUCKETS) {
    if (!by[k].length) continue;
    cards.push(`<h3 class="bucket b-${k}" id="${book}-${k}">${label} <span class="count">${by[k].length}</span></h3><p class="help">${help}</p>`);
    for (const r of by[k]) {
      const proposed = r.new || r.new_rejected;
      const [o, nw] = proposed ? diff(r.old, proposed) : [md(r.old), ''];
      const notes = [...r.reasons, ...r.warnings].map((x) => `<li>${say(x)}${r.gate_detail && r.gate_detail[x] ? `: <code>${esc([].concat(r.gate_detail[x]).join(' | '))}</code>` : ''}</li>`);
      if (r.claim_missing && r.claim_missing.length) notes.push(`<li>missing: ${r.claim_missing.map(esc).join('; ')}</li>`);
      const judge = r.judges && Object.keys(r.judges).length
        ? `<p class="judges">claims: ${(r.claims || []).map((cl, i) => `${esc(cl)} <span class="p">${Object.entries(r.judges).map(([jn, ps]) => `${jn} ${ps && ps[i] != null ? Number(ps[i]).toFixed(2) : '?'}`).join(', ')}</span>`).join(' · ') || 'none'}</p>` : '';
      cards.push(`<article class="row k-${k}" data-k="${k}"><header><span class="ref">${book} ${esc(r.Reference)}</span><span class="id">${esc(r.ID)}</span><span class="slug">${esc(r.slug)}</span>${r.template_id ? `<span class="tpl">${esc(r.template_id)}</span>` : ''}</header>` +
        (notes.length ? `<ul class="why">${notes.join('')}</ul>` : '') +
        `<div class="pair"><div><h4>Current</h4><p>${o}</p></div>${proposed ? `<div><h4>${r.status === 'changed' ? 'New' : 'Proposed, not applied'}</h4><p>${nw}</p></div>` : ''}</div>${judge}</article>`);
    }
  }
  sections.push(`<section class="book" id="${book}"><h2>${book}</h2>${cards.join('\n')}</section>`);
}

const html = `<title>en_tn Modernize Review</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Literata:opsz,wght@7..72,400;7..72,600&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono&display=swap">
<style>
/* Layout: one reading column; a counts table, then per-book review cards (current | new) sorted by what needs a human. */
:root {
  --bg: #f6f7f8; --surface: #ffffff; --ink: #1d2733; --muted: #5b6878; --rule: #d9dee4; --accent: #1f5f73;
  --ins: #d9efe1; --ins-ink: #14532d; --del: #f6dcdc; --del-ink: #7f1d1d;
  --flag: #a15c00; --held: #9b2c2c; --ok: #2f6b3f; --decl: #55607a;
  --serif: "Literata", Georgia, "Times New Roman", serif; --sans: "IBM Plex Sans", system-ui, sans-serif; --mono: "IBM Plex Mono", ui-monospace, monospace;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg: #12171d; --surface: #1a2129; --ink: #e3e8ee; --muted: #9aa7b6; --rule: #2c3540; --accent: #7cc0d4;
  --ins: #183a26; --ins-ink: #b7ebc8; --del: #47201f; --del-ink: #f5c2c2; --flag: #f0b45c; --held: #f08b8b; --ok: #8fd19e; --decl: #aab4cc; color-scheme: dark } }
:root[data-theme="dark"] {
  --bg: #12171d; --surface: #1a2129; --ink: #e3e8ee; --muted: #9aa7b6; --rule: #2c3540; --accent: #7cc0d4;
  --ins: #183a26; --ins-ink: #b7ebc8; --del: #47201f; --del-ink: #f5c2c2; --flag: #f0b45c; --held: #f08b8b; --ok: #8fd19e; --decl: #aab4cc; color-scheme: dark }
body { background: var(--bg); color: var(--ink); font: 15px/1.55 var(--sans); padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); padding-block: 24px 64px; }
main { max-width: 72rem; margin: 0 auto; display: grid; gap: 24px; }
h1, h2, h3 { text-wrap: balance; line-height: 1.2; }
h1 { font: 600 1.9rem/1.15 var(--serif); margin: 0; }
h2 { font: 600 1.4rem var(--serif); margin: 8px 0 0; border-bottom: 1px solid var(--rule); padding-bottom: 6px; }
h3 { font-size: 1rem; margin: 20px 0 0; display: flex; gap: 8px; align-items: baseline; }
h3 .count { font: 500 .8rem var(--mono); color: var(--muted); }
.b-flagged { color: var(--flag); } .b-held { color: var(--held); } .b-declined { color: var(--decl); } .b-changed { color: var(--ok); } .b-skipped { color: var(--muted); }
.help, .dim, .meta { color: var(--muted); }
.help { margin: 2px 0 8px; font-size: .9rem; }
.meta { margin: 6px 0 0; font-size: .9rem; max-width: 65ch; }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; font-variant-numeric: tabular-nums; font-size: .9rem; min-width: 100%; }
th, td { text-align: right; padding: 6px 10px; border-bottom: 1px solid var(--rule); white-space: nowrap; }
th:first-child, td:first-child { text-align: left; }
thead th { font-weight: 500; color: var(--muted); font-size: .78rem; letter-spacing: .03em; text-transform: uppercase; }
.n-flagged { color: var(--flag); } .n-held { color: var(--held); } .n-changed { color: var(--ok); }
.filters { display: flex; flex-wrap: wrap; gap: 8px; }
.filters button { font: 500 .85rem var(--sans); border: 1px solid var(--rule); background: var(--surface); color: var(--ink); border-radius: 999px; padding: 4px 12px; cursor: pointer; }
.filters button[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); }
.filters button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.row { background: var(--surface); border: 1px solid var(--rule); border-left: 4px solid var(--rule); border-radius: 6px; padding: 12px 14px; margin: 10px 0; }
.k-flagged { border-left-color: var(--flag); } .k-held { border-left-color: var(--held); } .k-changed { border-left-color: var(--ok); } .k-declined { border-left-color: var(--decl); }
.row header { display: flex; flex-wrap: wrap; gap: 6px 12px; font-size: .82rem; color: var(--muted); }
.row .ref { font-weight: 600; color: var(--ink); }
.row .id, .row .tpl { font-family: var(--mono); }
.why { margin: 8px 0 0; padding-left: 18px; font-size: .88rem; }
.why code, .judges, td code { font: .8rem var(--mono); overflow-wrap: anywhere; }
.pair { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 22rem), 1fr)); gap: 16px; margin-top: 10px; }
.pair > div { min-width: 0; }
.pair h4 { margin: 0 0 4px; font: 500 .72rem var(--sans); letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
.pair p { margin: 0; font: 1rem/1.6 var(--serif); overflow-wrap: anywhere; }
.ins { background: var(--ins); color: var(--ins-ink); border-radius: 2px; }
.del { background: var(--del); color: var(--del-ink); text-decoration: line-through; border-radius: 2px; }
.br { color: var(--muted); }
.judges { color: var(--muted); margin: 10px 0 0; }
.judges .p { color: var(--accent); }
</style>
<main>
<header>
<h1>en_tn Modernize Review</h1>
<p class="meta">Old-style translation notes rewritten into the current templates (snapshot ${esc(snapshot)}). Only the Note column changes. A note is applied only when every information gate passes; anything else keeps its current text. Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC from ${totalCalls} model calls, about $${totalCost.toFixed(2)} at API prices.</p>
</header>
<section>
<div class="scroll"><table>
<thead><tr><th>Book</th><th>Rows</th><th>Already conform</th><th>Not testable</th><th>Looked at</th>${BUCKETS.map(([, l]) => `<th>${l}</th>`).join('')}<th>Cost</th></tr></thead>
<tbody>${summaryRows.join('')}</tbody></table></div>
</section>
${linkRows.length ? `<section><h2>Dropped links to decide</h2><p class="help">These notes have a See or See also link whose information nothing else in the book carries. They keep their current text until D5 is decided.</p><div class="scroll"><table><thead><tr><th>Where</th><th>ID</th><th>Gap</th><th>Link</th></tr></thead><tbody>${linkRows.join('')}</tbody></table></div></section>` : ''}
<nav class="filters" aria-label="Show rows">
<button type="button" id="f-all" data-f="all" aria-pressed="true">All</button>
${BUCKETS.map(([k, l]) => `<button type="button" id="f-${k}" data-f="${k}" aria-pressed="false">${l}</button>`).join('\n')}
</nav>
${sections.join('\n')}
</main>
<script>
const buttons = document.querySelectorAll('.filters button');
function show(f) {
  buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.f === f)));
  document.querySelectorAll('.row').forEach((r) => { r.hidden = f !== 'all' && r.dataset.k !== f; });
  document.querySelectorAll('h3.bucket, p.help').forEach((h) => { if (h.closest('.book')) h.hidden = f !== 'all' && !h.classList.contains('b-' + f) && !(h.previousElementSibling && h.previousElementSibling.classList.contains('b-' + f)); });
}
buttons.forEach((b) => b.addEventListener('click', () => show(b.dataset.f)));
</script>
`;
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html);
console.log(`wrote ${OUT} (${books.join(' ')}; $${totalCost.toFixed(2)} over ${totalCalls} calls)`);
