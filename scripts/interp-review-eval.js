#!/usr/bin/env node
// interp-review-eval.js — score interpretive-review proposals against editor work.
//
// The interpretive review stage (src/interp-review.js, issue #382) writes one
// markdown file per chapter under output/review/<BOOK>/<BOOK>-<CH>-interp-fable.md
// listing the rows it would change (report mode) or changed (apply mode).
// Editors later correct the same chapters through bible-editor pull requests on
// Door43 (en_tn, titled "bible-editor: <BOOK> tn → master"). This script pulls
// those PR diffs, pairs each proposal with the editor's change on the same
// verse, and reports an acceptance rate per verdict type — the measure agreed
// in #384 for deciding whether apply mode earns its tokens.
//
// Usage:
//   node scripts/interp-review-eval.js --books ISA,JER,EZK --since 2026-09-10 \
//     --reviews <dir containing *-interp-fable.md, flat or <BOOK>/ subdirs> [--out report.md]
//
// No dependencies beyond Node 18+ (global fetch). Read-only against Door43.

const fs = require('fs');
const path = require('path');

const API = 'https://git.door43.org/api/v1/repos/unfoldingWord/en_tn';

function parseArgs(argv) {
  const args = { books: ['ISA', 'JER', 'EZK'], since: null, reviews: null, out: null, pages: 8 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--books') args.books = next().split(',').map((b) => b.trim().toUpperCase()).filter(Boolean);
    else if (a === '--since') args.since = next();
    else if (a === '--reviews') args.reviews = next();
    else if (a === '--out') args.out = next();
    else if (a === '--pages') args.pages = Number(next());
    else if (a === '--help' || a === '-h') { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 17).join('\n')); process.exit(0); }
  }
  if (!args.reviews) throw new Error('--reviews <dir> is required');
  if (!args.since) throw new Error('--since YYYY-MM-DD is required');
  return args;
}

// --- review markdown ----------------------------------------------------------------

function splitMdRow(line) {
  // Split a markdown table row on unescaped pipes; unescape \| in cells.
  const cells = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\' && line[i + 1] === '|') { cur += '|'; i++; continue; }
    if (ch === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells.slice(1, -1); // leading/trailing empties from the outer pipes
}

function loadReviews(dir) {
  const files = [];
  (function walk(d) {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/^([A-Z0-9]{3})-(\d+)-interp-fable\.md$/i.test(ent.name)) files.push(p);
    }
  })(dir);

  const proposals = [];
  const chapters = new Set();
  for (const file of files) {
    const m = path.basename(file).match(/^([A-Z0-9]{3})-(\d+)-interp-fable\.md$/i);
    const book = m[1].toUpperCase();
    const chapter = Number(m[2]);
    chapters.add(`${book} ${chapter}`);
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    const mode = (lines[0].match(/\((report|apply|off)\)\s*$/) || [])[1] || '?';
    let inTable = false;
    for (const line of lines) {
      if (/^\| Ref \| Type \| Verdict/.test(line)) { inTable = true; continue; }
      if (inTable && /^\|---/.test(line)) continue;
      if (inTable && !line.startsWith('|')) { inTable = false; continue; }
      if (!inTable) continue;
      const [ref, type, verdict, before, after, reason] = splitMdRow(line);
      if (!ref || !verdict) continue;
      proposals.push({ book, chapter, ref, type, verdict, before, after, reason, mode, file });
    }
  }
  return { proposals, chapters };
}

// --- Door43 editor diffs -----------------------------------------------------------

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

async function listEditorPrs({ books, since, pages }) {
  const wanted = [];
  const sinceMs = Date.parse(since);
  for (let page = 1; page <= pages; page++) {
    const list = await getJson(`${API}/pulls?state=closed&sort=recentupdate&limit=50&page=${page}`);
    if (!Array.isArray(list) || list.length === 0) break;
    let anyRecent = false;
    for (const pr of list) {
      const when = Date.parse(pr.merged_at || pr.closed_at || pr.updated_at || 0);
      if (when >= sinceMs) anyRecent = true;
      const m = String(pr.title || '').match(/^bible-editor:\s*([A-Z0-9]{3})\s+tn/i);
      if (!m) continue;
      const book = m[1].toUpperCase();
      if (!books.includes(book)) continue;
      if (when < sinceMs) continue;
      wanted.push({ number: pr.number, book, when: new Date(when).toISOString().slice(0, 10), merged: !!pr.merged });
    }
    if (!anyRecent) break; // sorted by recent update; older pages cannot qualify
  }
  return wanted;
}

function parseDiff(diffText, prNumber) {
  const changes = [];
  let book = null;
  const removed = new Map();
  const added = new Map();
  for (const line of diffText.split('\n')) {
    if (line.startsWith('+++ b/tn_')) { book = line.trim().slice('+++ b/tn_'.length, -4); continue; }
    if (/^(---|\+\+\+|@@|diff |index )/.test(line)) continue;
    if (line[0] !== '+' && line[0] !== '-') continue;
    const cols = line.slice(1).replace(/\r$/, '').split('\t');
    if (cols.length < 7) continue;
    const [ref, id, , sref, quote, , note] = cols;
    if (ref.endsWith(':intro')) continue;
    (line[0] === '-' ? removed : added).set(id, { ref, sref, quote, note });
  }
  for (const [id, old] of removed) {
    const cur = added.get(id);
    if (!cur) { changes.push({ pr: prNumber, book, ref: old.ref, id, type: 'dropped', oldSref: old.sref, sref: old.sref, oldNote: old.note, newNote: '' }); continue; }
    if (old.note !== cur.note || old.sref !== cur.sref) changes.push({ pr: prNumber, book, ref: cur.ref, id, type: 'reworded', oldSref: old.sref, sref: cur.sref, oldNote: old.note, newNote: cur.note });
    else if (old.quote !== cur.quote) changes.push({ pr: prNumber, book, ref: cur.ref, id, type: 'quote-changed', oldSref: old.sref, sref: cur.sref, oldNote: old.note, newNote: cur.note });
  }
  for (const [id, cur] of added) {
    if (!removed.has(id)) changes.push({ pr: prNumber, book, ref: cur.ref, id, type: 'added', oldSref: '', sref: cur.sref, oldNote: '', newNote: cur.note });
  }
  return changes;
}

async function fetchEditorChanges(prs) {
  const all = [];
  for (const pr of prs) {
    const res = await fetch(`${API}/pulls/${pr.number}.diff`);
    if (!res.ok) { console.warn(`PR ${pr.number}: HTTP ${res.status}, skipped`); continue; }
    const changes = parseDiff(await res.text(), pr.number).filter((c) => c.book === pr.book);
    all.push(...changes);
    console.error(`PR ${pr.number} (${pr.book}, ${pr.when}): ${changes.length} row changes`);
  }
  return all;
}

// --- matching -----------------------------------------------------------------------

const slug = (s) => String(s || '').split('/').pop().trim().toLowerCase();
const chapterOf = (ref) => Number(String(ref).split(':')[0]);
const isTcm = (note) => /could (mean|refer)/i.test(note || '');

function scoreProposals(proposals, changes) {
  const byKey = new Map();
  for (const c of changes) {
    const k = `${c.book} ${c.ref}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(c);
  }
  const editedChapters = new Set(changes.map((c) => `${c.book} ${chapterOf(c.ref)}`));

  const scored = proposals.map((p) => {
    const here = byKey.get(`${p.book} ${p.ref}`) || [];
    const chapterEdited = editedChapters.has(`${p.book} ${p.chapter}`);
    let confirmed = false;
    if (p.verdict === 'retype') confirmed = here.some((c) => c.type === 'reworded' && slug(c.sref) === slug(p.type) && slug(c.oldSref) !== slug(c.sref));
    else if (p.verdict === 'tcm') confirmed = here.some((c) => c.type === 'reworded' && isTcm(c.newNote) && (!isTcm(c.oldNote) || c.oldNote !== c.newNote));
    else if (p.verdict === 'revise') confirmed = here.some((c) => c.type === 'reworded' && slug(c.sref) === slug(p.type));
    else if (p.verdict === 'drop') confirmed = here.some((c) => c.type === 'dropped' && slug(c.sref) === slug(p.type));
    const touched = here.length > 0;
    return { ...p, chapterEdited, confirmed, touched };
  });

  // Editor interpretive changes in reviewed chapters that the review did not propose.
  const proposedRefs = new Set(proposals.map((p) => `${p.book} ${p.ref}`));
  const reviewedChapters = new Set(proposals.map((p) => `${p.book} ${p.chapter}`));
  const missed = changes.filter((c) => {
    if (!reviewedChapters.has(`${c.book} ${chapterOf(c.ref)}`)) return false;
    if (proposedRefs.has(`${c.book} ${c.ref}`)) return false;
    const srefChanged = c.type === 'reworded' && slug(c.oldSref) !== slug(c.sref);
    const tcmChanged = c.type === 'reworded' && isTcm(c.newNote) !== isTcm(c.oldNote);
    return srefChanged || tcmChanged || c.type === 'dropped';
  });

  return { scored, missed, editedChapters };
}

function renderReport({ args, prs, changes, chapters, scored, missed, editedChapters }) {
  const L = [];
  L.push(`# Interpretive review vs editor work — ${args.books.join(', ')} since ${args.since}`);
  L.push('');
  L.push(`Review files: ${chapters.size} chapter(s) (${[...chapters].sort().join(', ') || 'none'})`);
  L.push(`Editor PRs since ${args.since}: ${prs.length} (${prs.map((p) => `#${p.number} ${p.book}`).join(', ') || 'none'}), ${changes.length} row changes`);
  const notYet = [...chapters].filter((c) => !editedChapters.has(c));
  if (notYet.length) L.push(`Reviewed but not yet edited (excluded from rates): ${notYet.join(', ')}`);
  L.push('');

  const inScope = scored.filter((p) => p.chapterEdited);
  L.push('## Acceptance by verdict (chapters the editor has worked on)');
  L.push('');
  L.push('| Verdict | Proposed | Confirmed (editor made that change) | Touched (editor changed the row somehow) |');
  L.push('|---|---|---|---|');
  let totP = 0, totC = 0, totT = 0;
  for (const v of ['retype', 'tcm', 'revise', 'drop']) {
    const rows = inScope.filter((p) => p.verdict === v);
    const c = rows.filter((p) => p.confirmed).length;
    const t = rows.filter((p) => p.touched).length;
    totP += rows.length; totC += c; totT += t;
    L.push(`| ${v} | ${rows.length} | ${c} | ${t} |`);
  }
  const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : 'n/a');
  L.push(`| **all** | **${totP}** | **${totC}** (${pct(totC, totP)}) | **${totT}** (${pct(totT, totP)}) |`);
  L.push('');
  L.push(`Decision rule from #384: confirmed rate at or above 50% → propose enabling apply mode for these books; below → stay in report mode or remove the stage.`);
  L.push('');

  L.push('## Proposals the editor did not make (candidates for "noise", or catches the editor missed)');
  L.push('');
  const unconfirmed = inScope.filter((p) => !p.confirmed);
  if (!unconfirmed.length) L.push('(none)');
  for (const p of unconfirmed) L.push(`- ${p.book} ${p.ref} ${p.type} (${p.verdict}${p.touched ? ', row touched' : ''}): ${p.reason}`);
  L.push('');

  L.push('## Editor interpretive changes in reviewed chapters that the review did not propose');
  L.push('');
  if (!missed.length) L.push('(none)');
  for (const c of missed) {
    const what = c.type === 'dropped' ? 'dropped' : slug(c.oldSref) !== slug(c.sref) ? `${slug(c.oldSref)} → ${slug(c.sref)}` : 'TCM shape changed';
    L.push(`- ${c.book} ${c.ref} [${c.id}] ${what}`);
  }
  L.push('');
  return L.join('\n');
}

(async () => {
  const args = parseArgs(process.argv);
  const { proposals, chapters } = loadReviews(args.reviews);
  console.error(`loaded ${proposals.length} proposals from ${chapters.size} review file(s)`);
  const prs = await listEditorPrs(args);
  const changes = await fetchEditorChanges(prs);
  const { scored, missed, editedChapters } = scoreProposals(proposals, changes);
  const report = renderReport({ args, prs, changes, chapters, scored, missed, editedChapters });
  if (args.out) { fs.writeFileSync(args.out, report); console.error(`wrote ${args.out}`); }
  else process.stdout.write(report + '\n');
})().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
