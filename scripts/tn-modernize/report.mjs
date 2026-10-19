#!/usr/bin/env node
// report.mjs — the review page for a modernize run.
//
//   node scripts/tn-modernize/report.mjs [--out <file.html>] [--prev results-v2.jsonl] BOOK [BOOK...]
//
// Reads output/modernize/<BOOK>/{extract.json,candidates.jsonl,results.jsonl,calls.jsonl}
// and writes one self-contained HTML page (default output/modernize/report.html):
//   - the open decisions (D#) this run shows evidence for, each with a filter
//     to the rows that show it
//   - per-book counts and cost
//   - every row: what to check (or why it stayed), old/new word diff, the
//     template used, the claim check, and a feedback form
// Feedback is saved through the artifact `db` capability (collection
// "feedback", one doc per row per reviewer) when the page is published with
// capabilities {db: {}, user: {}}; elsewhere the form says it cannot save.
// Each saved doc records the hash of the note it judged (h). --prev names an
// archived results file in each book's folder: feedback saved before hashes
// existed is matched against that run's notes, so a review of a note that has
// since been rewritten shows as "earlier version", with the old verdict.

import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const lib = require('./lib.js');

const argv = process.argv.slice(2);
const flagAt = (n) => argv.indexOf(n);
const outIdx = flagAt('--out'), prevIdx = flagAt('--prev');
const OUT = outIdx >= 0 ? argv[outIdx + 1] : path.join(lib.WORK_DIR, 'output/modernize/report.html');
const PREV = prevIdx >= 0 ? argv[prevIdx + 1] : null;
const books = argv.filter((a, i) => /^[0-9A-Z]{3}$/.test(a) && !(outIdx >= 0 && i === outIdx + 1) && !(prevIdx >= 0 && i === prevIdx + 1));
if (!books.length) { console.error('usage: report.mjs [--out file.html] BOOK [BOOK...]'); process.exit(2); }

const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const THRESHOLD = 0.8;
// Short stable hash of the note a reviewer judged (the proposal, or the old note when there is none).
const hash = (s) => { let h = 5381; for (const ch of String(s)) h = ((h * 33) ^ ch.codePointAt(0)) >>> 0; return h.toString(36); };
const judged = (r) => (r ? r.new || r.new_rejected || r.old : '');

// ---------------------------------------------------------------------------
// Note rendering and word diff. Tokens carry their own bold flag, so a diff
// span never cuts across a <b> element.
// ---------------------------------------------------------------------------

function tokens(note) {
  const out = [];
  let bold = false;
  for (const part of String(note).split(/(\*\*)/)) {
    if (part === '**') { bold = !bold; continue; }
    for (const t of part.split(/(\s+)/)) if (t) out.push({ t, bold });
  }
  return out;
}

function renderTokens(list) {
  return list.map(({ t, bold, cls }) => {
    let h = esc(t).replace(/\\n/g, '<span class="br" title="paragraph break">¶</span><br>');
    if (bold && !/^\s+$/.test(t)) h = `<b>${h}</b>`;
    return cls && !/^\s+$/.test(t) ? `<span class="${cls}">${h}</span>` : h;
  }).join('');
}

function diff(a, b) {
  const x = tokens(a), y = tokens(b);
  const same = (p, q) => p.t === q.t && p.bold === q.bold;
  const n = x.length, m = y.length;
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = same(x[i], y[j]) ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const oa = [], ob = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (same(x[i], y[j])) { oa.push(x[i++]); ob.push(y[j++]); }
    else if (L[i + 1][j] >= L[i][j + 1]) oa.push({ ...x[i++], cls: 'del' });
    else ob.push({ ...y[j++], cls: 'ins' });
  }
  while (i < n) oa.push({ ...x[i++], cls: 'del' });
  while (j < m) ob.push({ ...y[j++], cls: 'ins' });
  return [renderTokens(oa), renderTokens(ob)];
}
const md = (s) => renderTokens(tokens(s));

// ---------------------------------------------------------------------------
// Plain-language explanations. Each says what happened and what to look at.
// `d` ties a check to an open decision so the page can show its evidence.
// ---------------------------------------------------------------------------

const list = (v) => [].concat(v || []).map((x) => `<q>${esc(x)}</q>`).join(', ');

const CHECKS = {
  template_at_omitted: () => ({ text: `The template ends with an alternate translation, but the old note had none. The rewrite leaves it out (the tool never writes one) and the row gets the Tags value <q>${lib.REVIEW_TAGS.at}</q> so an editor can add one later.` }),
  review: (reason) => ({ text: `The model asked for a person to look: <q>${esc(reason)}</q> The row gets the Tags value <q>${lib.REVIEW_TAGS.human}</q>.` }),
  name_from_verse: (d) => ({ d: 'D8', text: `The new note names ${list(d.name_from_verse)}, which the old note did not. The name is in the verse text. <strong>Check:</strong> is that really who is speaking or acting here?` }),
  name_from_template: (d) => ({ d: 'D8', text: `${list(d.name_from_template)} comes from the template's fixed wording, not from the old note. <strong>Check:</strong> is it right for this verse, or example text the model should have replaced?` }),
  old_span_dropped: (d) => ({ text: `The old note pointed at ${list(d.old_span_dropped)} in the verse. The new note no longer mentions those words. <strong>Check:</strong> nothing the old note said about them was lost.` }),
  no_claims_checked: () => ({ d: 'D6', text: 'The information check found nothing specific in the old note to test, so only the mechanical checks ran. <strong>Check:</strong> read old and new side by side.' }),
  at_quote_pair: () => ({ text: 'An alternate translation carries one quotation mark of a pair that the verse has both of. <strong>Check:</strong> the quotation marks in the alternate translation.' }),
  generic_speaker: (d) => ({ d: 'D8', text: `The new note says ${list(d)} where the old note named no speaker. The template needed one, and the tool may not take a name from outside the old note or the verse. <strong>Check:</strong> does the wording read naturally, or should an editor name the speaker?` }),
};

const WHY = {
  bold_not_in_ult: (d) => `The rewrite put ${list(d.bold_not_in_ult)} in bold, but that is not exact ULT text for this verse.`,
  at_lost_or_changed: (d) => `An alternate translation was lost or reworded: ${list(d.at_lost_or_changed)}.`,
  at_invented: (d) => `The rewrite added an alternate translation the old note did not have: ${list(d.at_invented)}.`,
  at_not_bracketed: () => 'An alternate translation in the rewrite is not in [brackets].',
  old_at_unbracketed: () => 'The old note has an alternate translation that is not in [brackets], so the tool cannot check it was kept.',
  link_in_note: () => 'The rewrite still contains a link.',
  link_not_covered: (d) => `The old note links to ${list(d.link_not_covered)}, and nothing else in the book carries that information. The row waits for D5.`,
  proper_noun_dropped: (d) => `The rewrite dropped ${list(d.proper_noun_dropped)}.`,
  reference_dropped: (d) => `The rewrite dropped the reference ${list(d.reference_dropped)}.`,
  name_added: (d) => `The rewrite names ${list(d.name_added)}, which neither the old note nor the verse names. The model worked it out on its own.`,
  template_phrase_missing: (d) => `The rewrite does not contain the template's fixed wording: <q>${esc(d.template_phrase || '')}</q>. This is often a template with example words in it (issue #480).`,
  template_untestable: () => 'The chosen template has no fixed wording long enough to check against.',
  placeholder_left: (d) => `A template placeholder was left unfilled: ${list(d.placeholder_left)}.`,
  unknown_template: () => 'The model named a template that does not exist for this issue.',
  self_talk: () => 'The model left its own reasoning in the note.',
  raw_newline_or_tab: () => 'The rewrite contains a raw line break or tab.',
  no_change: () => 'The rewrite was identical to the old note.',
  claim_missing: (d, r) => `The information check found ${r.claim_missing && r.claim_missing.length === 1 ? 'one piece' : 'pieces'} of the old note missing from the rewrite: ${list(r.claim_missing)}.`,
  claim_check_error: () => 'The information check failed to run for this row.',
  other_link: () => 'The note has a kind of link with no policy yet.',
  no_ult_text: () => 'No ULT text was found for this reference.',
  empty_note: () => 'The note is empty.',
  see_how: (d, r) => `A "See how you translated…" note. These are never rewritten.${(r.tags_add || []).length ? ` It also carries information of its own, so the row gets the Tags value <q>${lib.REVIEW_TAGS.human}</q> and the note stays as it is.` : ''}`,
};

// Declines in the model's own words, grouped so patterns show.
function declineGroup(reason) {
  if (/needs? (a|the) speaker|neither the old note nor the ULT|whom the blessing|does not name|names? no |placeholder cannot be filled|would require inventing/i.test(reason)) return { d: 'D8', label: 'Missing information the template needs' };
  if (/possible meanings|two (possible|different)|options/i.test(reason)) return { label: 'Several meanings, no room in the template' };
  if (/no choice/i.test(reason)) return { label: 'No fitting choice in the template list' };
  return { label: 'Template does not fit the note' };
}

const GENERIC = /\b(the (speaker|author|writer|narrator))\b/gi;
function genericSpeakerAdded(r) {
  if (!r.new) return [];
  const old = r.old.toLowerCase();
  return [...new Set((r.new.replace(/Alternate translation:.*$/, '').match(GENERIC) || []).map((s) => s.toLowerCase()))].filter((s) => !old.includes(s));
}

function bucket(r) {
  if (r.status === 'changed') return r.checks.length ? 'flagged' : 'changed';
  if (r.reasons.some((x) => x.startsWith('model_declined'))) return 'declined';
  return r.model ? 'held' : 'skipped';
}
const BUCKETS = [
  ['flagged', 'Changed, check these', 'Every gate passed and the new note will ship, but something needs a human look. The yellow box says what.'],
  ['held', 'Held back', 'The model rewrote the note but a gate failed, so the current note stays. The box says which gate.'],
  ['declined', 'Declined by the model', 'The model judged the note unfit for the templates. The current note stays.'],
  ['changed', 'Changed', 'Every gate passed and nothing needs a special look.'],
  ['skipped', 'Not attempted', 'Extract set these aside before any model saw them.'],
];

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

const all = [];
const summaryRows = [];
let totalCost = 0, totalCalls = 0, totalRewritten = 0, snapshot = '', model = '';
const dEvidence = { D5: 0, D6: 0, D8: 0 };
const declineGroups = {};
for (const book of books) {
  const dir = path.join(lib.WORK_DIR, 'output/modernize', book);
  const ex = JSON.parse(fs.readFileSync(path.join(dir, 'extract.json'), 'utf8'));
  snapshot = ex.templates_snapshot;
  const cands = new Map(readJsonl(path.join(dir, 'candidates.jsonl')).map((c) => [c.ID, c]));
  const results = readJsonl(path.join(dir, 'results.jsonl'));
  const prev = new Map(PREV ? readJsonl(path.join(dir, PREV)).map((r) => [r.ID, r]) : []);
  const calls = readJsonl(path.join(dir, 'calls.jsonl'));
  const cost = calls.reduce((s, c) => s + (c.costUsd || 0), 0);
  totalCost += cost; totalCalls += calls.length;
  const counts = Object.fromEntries(BUCKETS.map(([k]) => [k, 0]));
  for (const r of results) {
    const c = cands.get(r.ID) || {};
    model = r.model || model;
    const det = r.gate_detail || {};
    r.checks = [];
    r.tags_add = r.tags_add || [];
    if (r.status === 'changed') {
      if (r.review) r.checks.push({ code: 'review', ...CHECKS.review(r.review) });
      for (const w of r.warnings) if (CHECKS[w]) r.checks.push({ code: w, ...CHECKS[w](det) });
      const g = genericSpeakerAdded(r);
      if (g.length) r.checks.push({ code: 'generic_speaker', ...CHECKS.generic_speaker(g) });
    }
    r.h = hash(judged(r));
    const p = prev.get(r.ID);
    if (p) { r.ph = hash(judged(p)); r.prevText = judged(p) !== judged(r) ? judged(p) : null; }
    r.book = book;
    r.key = `${book}-${r.ID}`;
    r.bucket = bucket(r);
    r.tpl = (c.templates || []).find((t) => t.id === r.template_id);
    r.ult = c.ult || '';
    r.why = r.reasons.filter((x) => !x.startsWith('model_declined')).map((x) => (WHY[x] ? WHY[x](det, r) : esc(x)));
    const decline = r.reasons.find((x) => x.startsWith('model_declined'));
    if (decline) {
      r.decline = decline.replace(/^model_declined:\s*/, '');
      r.declineGroup = declineGroup(r.decline);
      declineGroups[r.declineGroup.label] = (declineGroups[r.declineGroup.label] || 0) + 1;
    }
    // Judges: a row where jev and Haiku disagree on any claim is D6 evidence.
    const j = r.judges || {};
    r.judgeSplit = !!(r.claims && j.jev && j.haiku && r.claims.some((_, k) => (j.jev[k] >= THRESHOLD) !== (j.haiku[k] >= THRESHOLD)));
    r.ds = [...new Set([...r.checks.map((x) => x.d), r.declineGroup && r.declineGroup.d, r.judgeSplit && 'D6',
      r.reasons.includes('link_not_covered') && 'D5', r.reasons.includes('name_added') && 'D8'].filter(Boolean))];
    for (const d of r.ds) dEvidence[d] = (dEvidence[d] || 0) + 1;
    counts[r.bucket]++;
    if (r.model) totalRewritten++;
    all.push(r);
  }
  const c = ex.counts;
  summaryRows.push(`<tr><th scope="row">${book}</th><td>${c.rows}</td><td>${c.conforms || 0}</td><td>${(c.no_template || 0) + (c.no_phrase || 0) + (c.no_sref || 0) + (c.intro || 0)}</td><td>${results.length}</td>` +
    BUCKETS.map(([k]) => `<td class="n-${k}">${counts[k]}</td>`).join('') + `<td>$${cost.toFixed(2)}</td></tr>`);
}
const order = Object.fromEntries(BUCKETS.map(([k], i) => [k, i]));
all.sort((a, b) => order[a.bucket] - order[b.bucket]);

const fmtP = (p) => (p == null ? '–' : Number(p).toFixed(2));
function claimTable(r) {
  if (!r.claims) return '';
  if (!r.claims.length) return '<p class="claims-none">Information check: the old note had no specific claims to test.</p>';
  const j = r.judges || {};
  const primary = r.primary_judge || 'jev';
  const rows = r.claims.map((cl, k) => {
    const pj = j.jev && j.jev[k], ph = j.haiku && j.haiku[k];
    const pass = (p) => (p == null ? '' : p >= THRESHOLD ? 'ok' : 'miss');
    const split = pj != null && ph != null && (pj >= THRESHOLD) !== (ph >= THRESHOLD);
    return `<tr${split ? ' class="split"' : ''}><td>${esc(cl)}</td><td class="${pass(pj)}">${fmtP(pj)}</td><td class="${pass(ph)}">${fmtP(ph)}</td></tr>`;
  }).join('');
  return `<details class="claims"${r.judgeSplit || r.reasons.includes('claim_missing') ? ' open' : ''}><summary>Information check: ${r.claims.length} claim${r.claims.length === 1 ? '' : 's'} from the old note${r.judgeSplit ? ' <span class="chip d">D6: judges disagree</span>' : ''}</summary>
<p class="help">Probability that the new note still says each claim. ${THRESHOLD} or higher counts as kept. ${primary === 'jev' ? 'jev' : 'Haiku'} decides; the other is shown for comparison.</p>
<div class="scroll"><table><thead><tr><th>Claim</th><th>jev</th><th>Haiku</th></tr></thead><tbody>${rows}</tbody></table></div></details>`;
}

const VERDICTS = {
  ship: [['good', 'Good, ship it'], ['tweak', 'Ship, but the wording needs a tweak'], ['wrong', 'Wrong, keep the old note']],
  stay: [['agree', 'Right to leave it'], ['should', 'Should have been rewritten'], ['other', 'Something else']],
};
const TAGS = [['lost', 'Lost information'], ['added', 'Added information'], ['template', 'Wrong template'], ['wording', 'Awkward wording'],
  ['bold', 'Bold or quotes wrong'], ['at', 'Alternate translation'], ['speaker', 'Speaker or author (D8)'], ['gate', 'Gate too strict']];

function card(r) {
  const proposed = r.new || r.new_rejected;
  const [o, nw] = proposed ? diff(r.old, proposed) : [md(r.old), ''];
  const pill = { flagged: 'Changed, check', held: 'Held back', declined: 'Declined', changed: 'Changed', skipped: 'Not attempted' }[r.bucket];
  const box = r.bucket === 'flagged'
    ? `<div class="box check"><h4>What to check</h4><ul>${r.checks.map((x) => `<li>${x.d ? `<span class="chip d">${x.d}</span> ` : ''}${x.text}</li>`).join('')}</ul></div>`
    : r.bucket === 'declined'
      ? `<div class="box why"><h4>Why it stayed</h4><p>${r.declineGroup.d ? `<span class="chip d">${r.declineGroup.d}</span> ` : ''}<strong>${esc(r.declineGroup.label)}.</strong> The model said: <q>${esc(r.decline)}</q>${r.review ? ` It asked for a person: <q>${esc(r.review)}</q>, so the row gets the Tags value <q>${lib.REVIEW_TAGS.human}</q>.` : ''}</p></div>`
      : (r.bucket === 'held' || r.bucket === 'skipped') && r.why.length
        ? `<div class="box why"><h4>Why it stayed</h4><ul>${r.why.map((w) => `<li>${w}</li>`).join('')}</ul></div>` : '';
  const kind = r.bucket === 'flagged' || r.bucket === 'changed' ? 'ship' : 'stay';
  const fb = `<form class="fb" data-key="${esc(r.key)}" data-kind="${kind}"><fieldset><legend>Your feedback</legend>
<div class="verdicts">${VERDICTS[kind].map(([v, l]) => `<label><input type="radio" name="v-${esc(r.key)}" id="v-${esc(r.key)}-${v}" value="${v}"> ${l}</label>`).join('')}</div>
<div class="tags">${TAGS.map(([t, l]) => `<label><input type="checkbox" id="t-${esc(r.key)}-${t}" value="${t}"> ${l}</label>`).join('')}</div>
<label class="cm" for="c-${esc(r.key)}">Comment (what should change, or a rule we should learn)</label>
<textarea id="c-${esc(r.key)}" rows="2"></textarea>
<div class="act"><button type="submit">Save</button><span class="st" aria-live="polite"></span></div></fieldset></form>`;
  const tagLine = r.tags_add.length ? `<p class="tagline">Tags column gets: ${r.tags_add.map((t) => `<span class="chip t">${esc(t)}</span>`).join(' ')}</p>` : '';
  const prevBox = `<div class="box prev" hidden><h4>Your review was of an earlier version</h4><p class="pv"></p>${r.prevText ? `<p class="pt"><span class="lbl">Earlier proposal</span> ${md(r.prevText)}</p>` : ''}</div>`;
  return `<article class="row k-${r.bucket}" data-k="${r.bucket}" data-d="${r.ds.join(' ')}" data-h="${r.h}"${r.ph ? ` data-ph="${r.ph}"` : ''} id="${esc(r.key)}">
<header><span class="pill p-${r.bucket}">${pill}</span><span class="ref">${esc(r.book)} ${esc(r.Reference)}</span><span class="slug">${esc(r.slug)}</span><span class="id">${esc(r.ID)}</span>${r.ds.map((d) => `<span class="chip d">${d}</span>`).join('')}<span class="mine" hidden></span></header>
${prevBox}
${box}
${tagLine}
<div class="pair"><div><h4>Current note</h4><p>${o}</p></div>${proposed ? `<div><h4>${r.status === 'changed' ? 'New note (will ship)' : 'Proposed, not applied'}</h4><p>${nw}</p></div>` : ''}</div>
<details class="ctx"><summary>Verse and template</summary><p><span class="lbl">ULT</span> ${esc(r.ult)}</p>${r.tpl ? `<p><span class="lbl">${esc(r.tpl.id)}${r.tpl.type ? ` (${esc(r.tpl.type)})` : ''}</span> ${md(r.tpl.template)}</p>` : ''}</details>
${claimTable(r)}
${fb}
</article>`;
}

const perNote = totalRewritten ? totalCost / totalRewritten : 0;
const count = (k) => all.filter((r) => r.bucket === k).length;
const genericN = all.filter((r) => r.checks.some((x) => x.code === 'generic_speaker')).length;
const nameN = all.filter((r) => r.checks.some((x) => x.code === 'name_from_verse' || x.code === 'name_from_template')).length;
const d8Declines = all.filter((r) => r.declineGroup && r.declineGroup.d === 'D8').length;
const splitN = all.filter((r) => r.judgeSplit).length;
const linkN = all.filter((r) => r.reasons.includes('link_not_covered')).length;

const decisions = `<section class="decisions" aria-labelledby="dh"><h2 id="dh">Decisions this page lets you judge</h2>
<div class="dgrid">
<article class="dcard"><h3><span class="chip d">D8</span> Who is speaking</h3>
<p>Current rule: a speaker, author or other name goes into a note only when the old note or the verse names it. When neither does, the model either declines or writes a generic phrase such as "the speaker".</p>
<p class="ev"><strong>${d8Declines}</strong> declined for missing information · <strong>${genericN}</strong> shipped with a generic speaker · <strong>${nameN}</strong> shipped with a name taken from the verse or template</p>
<p><strong>To decide:</strong> keep this rule, or let the model fill the speaker from the surrounding passage, which would turn many declines into rewrites for review.</p>
<button type="button" class="dbtn" data-fd="D8" id="fd-D8">Show the ${dEvidence.D8 || 0} D8 rows</button></article>
<article class="dcard"><h3><span class="chip d">D6</span> Information check judge</h3>
<p>Decided by the agreed rule: jev decides whether each claim of the old note survived. On planted deletions it caught 79%, against 49% for Haiku. Haiku still runs, for comparison.</p>
<p class="ev"><strong>${splitN}</strong> rows where the two judges disagree on at least one claim</p>
<p><strong>To check:</strong> in those rows, see whether jev's call matches yours.</p>
<button type="button" class="dbtn" data-fd="D6" id="fd-D6">Show the ${dEvidence.D6 || 0} D6 rows</button></article>
<article class="dcard"><h3><span class="chip d">D5</span> See and See also links</h3>
<p>Current rule: a "(See also: …)" or "(See: …)" link is dropped only when a sibling note or the twl file already carries it; otherwise the note stays as it is.</p>
<p class="ev">${linkN ? `<strong>${linkN}</strong> rows wait for this decision` : `No rows in ${books.join(', ')} have such links, so this page cannot inform D5. 2CH (151 rows) and EZK (90) are where it matters.`}</p>
${linkN ? `<button type="button" class="dbtn" data-fd="D5" id="fd-D5">Show the ${linkN} D5 rows</button>` : ''}</article>
<article class="dcard"><h3><span class="chip d">D4</span> Rewrite model and cost</h3>
<p>${esc(model || 'claude-sonnet-5-5')} wrote every rewrite: ${totalRewritten} notes, about $${perNote.toFixed(3)} per note at API prices.</p>
<p class="ev">At that rate the 72,751 old rows in en_tn come to about $${Math.round(perNote * 72751).toLocaleString('en-US')}, or several weeks of subscription use under the 60% weekly guard.</p>
<p><strong>To decide:</strong> whether the quality you see here justifies that cost, or a cheaper model should be tried on one book.</p></article>
</div></section>`;

const declineSummary = Object.entries(declineGroups).sort((a, b) => b[1] - a[1]).map(([l, n]) => `<li><strong>${n}</strong> ${esc(l.toLowerCase())}</li>`).join('');

const html = `<title>en_tn Modernize Review</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Literata:opsz,wght@7..72,400;7..72,600&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono&display=swap">
<style>
/* Layout: one reading column; decisions first, then counts, then review cards (current | new) with a feedback form each. */
:root {
  --bg: #f6f7f8; --surface: #ffffff; --ink: #1d2733; --muted: #5b6878; --rule: #d9dee4; --accent: #1f5f73;
  --ins: #d9efe1; --ins-ink: #14532d; --del: #f6dcdc; --del-ink: #7f1d1d;
  --flag: #8a4f00; --flag-bg: #fff4dc; --held: #9b2c2c; --held-bg: #fbeaea; --ok: #2f6b3f; --decl: #4f5a73; --decl-bg: #eef0f5;
  --d: #5a3e8c; --d-bg: #efe9f8; --rev-bg: #f1f8f3;
  --serif: "Literata", Georgia, "Times New Roman", serif; --sans: "IBM Plex Sans", system-ui, sans-serif; --mono: "IBM Plex Mono", ui-monospace, monospace;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg: #12171d; --surface: #1a2129; --ink: #e3e8ee; --muted: #9aa7b6; --rule: #2c3540; --accent: #7cc0d4;
  --ins: #183a26; --ins-ink: #b7ebc8; --del: #47201f; --del-ink: #f5c2c2; --flag: #f0b45c; --flag-bg: #3a2c12; --held: #f08b8b; --held-bg: #3a1c1c;
  --ok: #8fd19e; --decl: #aab4cc; --decl-bg: #232a38; --d: #c7b2ef; --d-bg: #2d2540; --rev-bg: #18241c; color-scheme: dark } }
:root[data-theme="dark"] {
  --bg: #12171d; --surface: #1a2129; --ink: #e3e8ee; --muted: #9aa7b6; --rule: #2c3540; --accent: #7cc0d4;
  --ins: #183a26; --ins-ink: #b7ebc8; --del: #47201f; --del-ink: #f5c2c2; --flag: #f0b45c; --flag-bg: #3a2c12; --held: #f08b8b; --held-bg: #3a1c1c;
  --ok: #8fd19e; --decl: #aab4cc; --decl-bg: #232a38; --d: #c7b2ef; --d-bg: #2d2540; --rev-bg: #18241c; color-scheme: dark }
body { background: var(--bg); color: var(--ink); font: 15px/1.55 var(--sans); padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); padding-block: 24px 64px; }
main { max-width: 72rem; margin: 0 auto; display: grid; gap: 28px; }
h1, h2, h3 { text-wrap: balance; line-height: 1.2; margin: 0; }
h1 { font: 600 1.9rem/1.15 var(--serif); }
h2 { font: 600 1.35rem var(--serif); border-bottom: 1px solid var(--rule); padding-bottom: 6px; margin-bottom: 12px; }
h3 { font-size: 1rem; display: flex; gap: 8px; align-items: baseline; }
h4 { margin: 0 0 4px; font: 600 .74rem var(--sans); letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
.meta, .help, .dim { color: var(--muted); }
.meta { margin: 6px 0 0; max-width: 68ch; }
.help { margin: 2px 0 8px; font-size: .88rem; }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; font-variant-numeric: tabular-nums; font-size: .9rem; min-width: 100%; }
th, td { text-align: right; padding: 6px 10px; border-bottom: 1px solid var(--rule); }
th:first-child, td:first-child { text-align: left; }
thead th { font-weight: 500; color: var(--muted); font-size: .76rem; letter-spacing: .03em; text-transform: uppercase; }
.n-flagged { color: var(--flag); } .n-held { color: var(--held); } .n-changed { color: var(--ok); }
.chip { display: inline-block; font: 600 .72rem var(--mono); padding: 1px 6px; border-radius: 4px; }
.chip.d { background: var(--d-bg); color: var(--d); }
.dgrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 20rem), 1fr)); gap: 14px; }
.dcard { background: var(--surface); border: 1px solid var(--rule); border-radius: 8px; padding: 14px 16px; display: grid; gap: 8px; align-content: start; min-width: 0; }
.dcard p { margin: 0; }
.dcard .ev { font-size: .92rem; }
.dbtn, .filters button, .fb button { font: 500 .85rem var(--sans); border: 1px solid var(--rule); background: var(--surface); color: var(--ink); border-radius: 999px; padding: 4px 12px; cursor: pointer; justify-self: start; }
.dbtn { border-color: var(--d); color: var(--d); }
.filters { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.filters button[aria-pressed="true"], .dbtn[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: var(--bg); }
button:focus-visible, input:focus-visible, textarea:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.progress { font-size: .9rem; color: var(--muted); }
.row { background: var(--surface); border: 1px solid var(--rule); border-left: 4px solid var(--rule); border-radius: 6px; padding: 14px 16px; margin: 12px 0; display: grid; gap: 10px; }
.k-flagged { border-left-color: var(--flag); } .k-held { border-left-color: var(--held); } .k-changed { border-left-color: var(--ok); } .k-declined { border-left-color: var(--decl); }
.row header { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: baseline; font-size: .84rem; color: var(--muted); }
.row .ref { font-weight: 600; color: var(--ink); font-size: .95rem; }
.row .id { font-family: var(--mono); }
.pill { font: 600 .74rem var(--sans); padding: 2px 8px; border-radius: 999px; }
.p-flagged { background: var(--flag-bg); color: var(--flag); } .p-held { background: var(--held-bg); color: var(--held); }
.p-declined, .p-skipped { background: var(--decl-bg); color: var(--decl); } .p-changed { background: var(--ins); color: var(--ins-ink); }
.mine { font: 600 .78rem var(--sans); padding: 2px 8px; border-radius: 999px; background: var(--ok); color: var(--surface); }
.row.reviewed { border-left: 10px solid var(--ok); background: var(--rev-bg); }
.row.stale { border-left: 10px dashed var(--flag); }
.row.stale .mine { background: var(--flag); }
.prev { background: var(--flag-bg); } .prev h4 { color: var(--flag); } .prev p + p { margin-top: 6px; }
.prev .pt { font: .95rem/1.55 var(--serif); }
.chip.t { background: var(--flag-bg); color: var(--flag); }
.tagline { margin: 0; font-size: .86rem; color: var(--muted); }
.box { border-radius: 6px; padding: 10px 12px; }
.box ul { margin: 0; padding-left: 18px; display: grid; gap: 4px; }
.box p { margin: 0; }
.check { background: var(--flag-bg); } .check h4 { color: var(--flag); }
.why { background: var(--decl-bg); } .why h4 { color: var(--decl); }
.k-held .why { background: var(--held-bg); } .k-held .why h4 { color: var(--held); }
q { font-family: var(--serif); }
.pair { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 22rem), 1fr)); gap: 16px; }
.pair > div { min-width: 0; }
.pair p { margin: 0; font: 1rem/1.6 var(--serif); overflow-wrap: anywhere; }
.ins { background: var(--ins); color: var(--ins-ink); border-radius: 2px; }
.del { background: var(--del); color: var(--del-ink); text-decoration: line-through; border-radius: 2px; }
.br { color: var(--muted); }
details summary { cursor: pointer; font-size: .88rem; color: var(--accent); }
.ctx p { margin: 6px 0 0; font: .95rem/1.55 var(--serif); overflow-wrap: anywhere; }
.lbl { font: 600 .72rem var(--mono); color: var(--muted); margin-right: 6px; }
.claims table td:first-child { white-space: normal; }
.claims td.ok { color: var(--ok); } .claims td.miss { color: var(--held); font-weight: 600; }
.claims tr.split td { background: var(--d-bg); }
.claims-none { margin: 0; font-size: .88rem; color: var(--muted); }
.fb fieldset { border: 1px dashed var(--rule); border-radius: 6px; margin: 0; padding: 10px 12px; display: grid; gap: 8px; min-width: 0; }
.fb legend { font: 600 .74rem var(--sans); letter-spacing: .06em; text-transform: uppercase; color: var(--muted); padding: 0 4px; }
.verdicts, .tags { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: .9rem; }
.tags { font-size: .84rem; color: var(--muted); }
.cm { font-size: .84rem; color: var(--muted); }
.fb textarea { width: 100%; box-sizing: border-box; font: .95rem/1.4 var(--sans); background: var(--bg); color: var(--ink); border: 1px solid var(--rule); border-radius: 4px; padding: 6px 8px; }
.act { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.st { font-size: .85rem; color: var(--muted); }
.fb[data-off] button { opacity: .5; cursor: not-allowed; }
</style>
<main>
<header>
<h1>en_tn Modernize Review</h1>
<p class="meta">${books.join(', ')}: old-style translation notes rewritten into the current templates (snapshot ${esc(snapshot)}). Only the Note column changes, plus a review tag in the Tags column where a person must look. A new note ships only when every check passes; otherwise the current note stays. Leave feedback on any row: it is saved for the next tuning pass and does not change the notes by itself.</p>
</header>
${decisions}
<section><h2>Counts</h2>
<div class="scroll"><table>
<thead><tr><th>Book</th><th>Rows</th><th>Already conform</th><th>Not testable</th><th>Looked at</th>${BUCKETS.map(([, l]) => `<th>${l}</th>`).join('')}<th>Cost</th></tr></thead>
<tbody>${summaryRows.join('')}</tbody></table></div>
${declineSummary ? `<p class="help">Why the model declined: </p><ul class="help">${declineSummary}</ul>` : ''}
</section>
<section aria-labelledby="rh"><h2 id="rh">Rows</h2>
<nav class="filters" aria-label="Show rows">
<button type="button" id="f-all" data-f="all" aria-pressed="true">All ${all.length}</button>
${BUCKETS.filter(([k]) => count(k)).map(([k, l]) => `<button type="button" id="f-${k}" data-f="${k}" aria-pressed="false">${l} ${count(k)}</button>`).join('\n')}
<button type="button" id="f-todo" data-f="todo" aria-pressed="false">No feedback yet</button>
<button type="button" id="f-stale" data-f="stale" aria-pressed="false">Changed since your review</button>
<span class="progress" id="progress"></span>
</nav>
${all.map(card).join('\n')}
</section>
</main>
<script>
const rows = [...document.querySelectorAll('.row')];
const filterButtons = [...document.querySelectorAll('.filters button, .dbtn')];
const mine = new Map(); // row key -> this viewer's saved feedback
function show(kind, value) {
  filterButtons.forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.f || b.dataset.fd) === value)));
  rows.forEach((r) => {
    let on = true;
    if (kind === 'f' && value === 'todo') on = !mine.has(r.id);
    else if (kind === 'f' && value === 'stale') on = r.classList.contains('stale');
    else if (kind === 'f' && value !== 'all') on = r.dataset.k === value;
    else if (kind === 'd') on = r.dataset.d.split(' ').includes(value);
    r.hidden = !on;
  });
  if (kind === 'd') document.getElementById('rh').scrollIntoView({ behavior: 'smooth' });
}
document.querySelectorAll('.filters button').forEach((b) => b.addEventListener('click', () => show('f', b.dataset.f)));
document.querySelectorAll('.dbtn').forEach((b) => b.addEventListener('click', () => show('d', b.dataset.fd)));

function progress() {
  const el = document.getElementById('progress');
  const stale = rows.filter((r) => r.classList.contains('stale')).length;
  el.textContent = mine.size ? mine.size + ' of ' + rows.length + ' rows have your feedback' + (stale ? ', ' + stale + ' of them on an earlier version' : '') : '';
}
const VERDICT_LABEL = { good: 'Good, ship it', tweak: 'Ship, but tweak', wrong: 'Wrong, keep the old note', agree: 'Right to leave it', should: 'Should have been rewritten', other: 'Something else' };
function fill(form, fb) {
  const row = form.closest('.row');
  // Feedback saved before hashes existed judged the previous run's note.
  const fresh = (fb.h || row.dataset.ph || row.dataset.h) === row.dataset.h;
  row.classList.toggle('reviewed', fresh);
  row.classList.toggle('stale', !fresh);
  const tag = row.querySelector('.mine');
  tag.hidden = false; tag.textContent = fresh ? 'Reviewed' : 'Reviewed earlier version';
  const pb = row.querySelector('.prev');
  pb.hidden = fresh;
  if (!fresh) pb.querySelector('.pv').textContent = 'You said: ' + (VERDICT_LABEL[fb.verdict] || 'no verdict') + ((fb.tags || []).length ? ' [' + fb.tags.join(', ') + ']' : '') + (fb.comment ? '. "' + fb.comment + '"' : '') + '. The note has been rewritten since. Save again to review this version.';
  if (form.dataset.dirty || !fresh) return;
  form.querySelectorAll('input[type=radio]').forEach((i) => { i.checked = i.value === fb.verdict; });
  form.querySelectorAll('input[type=checkbox]').forEach((i) => { i.checked = (fb.tags || []).includes(i.value); });
  form.querySelector('textarea').value = fb.comment || '';
}
const forms = [...document.querySelectorAll('form.fb')];
forms.forEach((f) => {
  f.addEventListener('input', () => { f.dataset.dirty = '1'; f.querySelector('.st').textContent = 'Not saved yet'; });
  f.addEventListener('submit', (e) => e.preventDefault());
});

(async () => {
  const off = (msg) => forms.forEach((f) => { f.dataset.off = '1'; f.querySelector('.st').textContent = msg; });
  let db = null, user = null;
  try { [db, user] = await Promise.all([window.claude?.use?.('db'), window.claude?.use?.('user')]); } catch (e) {}
  if (!db || !user) { off('Feedback saves only when this page is open on claude.ai while signed in.'); return; }
  let uid = '';
  try { uid = String(await user.id() || ''); } catch (e) {}
  if (!uid) { off('Sign in to save feedback.'); return; }
  const safe = uid.replace(/[^A-Za-z0-9_-]/g, '_');
  const col = db.collection('feedback');
  col.where('uid', '==', uid).onSnapshot((snap) => {
    mine.clear();
    snap.docs.forEach((d) => { const v = d.data(); if (v && v.row) mine.set(v.row, v); });
    forms.forEach((f) => { const v = mine.get(f.dataset.key); if (v) fill(f, v); });
    progress();
  }, () => off('Feedback could not be loaded. Reload the page to try again.'));
  forms.forEach((f) => f.addEventListener('submit', async () => {
    const st = f.querySelector('.st');
    const verdict = (f.querySelector('input[type=radio]:checked') || {}).value || '';
    const tags = [...f.querySelectorAll('input[type=checkbox]:checked')].map((i) => i.value);
    const comment = f.querySelector('textarea').value.trim();
    if (!verdict && !tags.length && !comment) { st.textContent = 'Pick a verdict, a tag or write a comment first.'; return; }
    const row = f.closest('.row');
    st.textContent = 'Saving…';
    try {
      await col.doc(f.dataset.key + '__' + safe).set({ row: f.dataset.key, uid, verdict, tags, comment, h: row.dataset.h, bucket: row.dataset.k, decisions: row.dataset.d, at: new Date().toISOString() });
      delete f.dataset.dirty;
      st.textContent = 'Saved';
    } catch (e) {
      st.textContent = e && e.code === 'not_granted' ? 'You can view this page but not leave feedback. Ask the owner for access.' : 'Not saved: ' + ((e && e.message) || 'unknown error') + '. Try Save again.';
    }
  }));
})();
</script>
`;
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html);
console.log(`wrote ${OUT} (${books.join(' ')}; ${all.length} rows; D8 ${dEvidence.D8 || 0}, D6 ${dEvidence.D6 || 0}, D5 ${dEvidence.D5 || 0}; $${totalCost.toFixed(2)} over ${totalCalls} calls)`);
