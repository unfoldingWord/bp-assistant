#!/usr/bin/env node
// rewrite.mjs — rewrite one book's candidate notes, gate them, record results.
//
//   node scripts/tn-modernize/rewrite.mjs --skill <bp-assistant-skills>/.claude/skills/tn-modernize \
//     [--limits ~/.claude/rate-limits.<uuid8>.json] [--stop-pct 60] [--judge haiku|jev|both] [--primary haiku|jev] \
//     [--threshold 0.8] [--batch 20] [--limit N] [--model claude-sonnet-5-5] [--edits edits.jsonl] [--dry] BOOK [BOOK...]
//
// --edits: lines of {"ID", "template_id", "note"} with the exact text a reviewer
// wants (a "ship, but tweak" verdict). Those rows replace any earlier result and
// skip the model, but still pass every gate and the claim check.
//
// Per book: reads output/modernize/<BOOK>/candidates.jsonl, appends one Result
// per row (shape in rows.js) to results.jsonl and one line per model call to
// calls.jsonl. Resumable: rows already in results.jsonl are skipped; a batch
// whose model reply cannot be used, and any row the reply leaves out, is not
// recorded, so a rerun retries it.
//
// A row is 'changed' only when the model rewrote it, every mechanical gate
// (gates.js) passed, and the primary claim judge found every claim of the old
// note in the new one. Everything else stays 'unchanged' with its reasons.

import { createRequire } from 'module';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const lib = require('./lib.js');
const { checkRewrite } = require('./gates.js');
const { claude, parseJson, makeGuard } = require('./models.js');
const { extractClaims, judgeHaiku, judgeJev, claimVerdict } = require('./claims.js');

const argv = process.argv.slice(2);
const valueFlags = ['--edits', '--skill', '--limits', '--stop-pct', '--judge', '--primary', '--threshold', '--batch', '--limit', '--model', '--haiku'];
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const skipIdx = new Set(valueFlags.flatMap((f) => { const i = argv.indexOf(f); return i >= 0 ? [i, i + 1] : []; }));
const books = argv.filter((a, i) => !skipIdx.has(i) && /^[0-9A-Z]{3}$/.test(a));
const SKILL = flag('--skill');
const DRY = argv.includes('--dry');
const MODEL = flag('--model', 'claude-sonnet-5-5');
const HAIKU = flag('--haiku', 'claude-haiku-5-5');
const JUDGE = flag('--judge', 'both');
// D6 (2026-10-16 pilot, judge-eval.mjs): jev caught 79% of seeded losses at 0.8, Haiku 49%.
const PRIMARY = flag('--primary', JUDGE === 'haiku' ? 'haiku' : 'jev');
const REVERDICT = argv.includes('--reverdict');
const THRESHOLD = Number(flag('--threshold', '0.8'));
// The advisory judge, when both run: a claim is held back only when both doubt it.
const SECOND = JUDGE === 'both' ? (PRIMARY === 'jev' ? 'haiku' : 'jev') : null;
function splitFlag(r, split) {
  r.claim_split = split;
  r.warnings = r.warnings || []; r.tags_add = r.tags_add || [];
  if (!r.warnings.includes('judges_split')) r.warnings.push('judges_split');
  if (!r.tags_add.includes(lib.REVIEW_TAGS.human)) r.tags_add.push(lib.REVIEW_TAGS.human);
}
const BATCH = Number(flag('--batch', '20'));
const LIMIT = Number(flag('--limit', '0'));
const guard = makeGuard({ limitsFile: flag('--limits'), stopPct: Number(flag('--stop-pct', '60')) });
const judgeOk = ['haiku', 'jev', 'both'].includes(JUDGE) && ['haiku', 'jev'].includes(PRIMARY) && (JUDGE === 'both' || JUDGE === PRIMARY);
if (!SKILL || !books.length || !judgeOk) {
  console.error('usage: rewrite.mjs --skill <skill dir> [--limits file] [--judge haiku|jev|both] [--dry] BOOK [BOOK...]');
  process.exit(2);
}
if (!flag('--limits') && !DRY) console.warn('warning: no --limits file, so no weekly budget guard');

const prompt = (f) => fs.readFileSync(path.join(SKILL, f), 'utf8');
const PROMPTS = { rewrite: prompt('rewrite-prompt.md'), claims: prompt('claims-prompt.md'), judge: prompt('judge-prompt.md') };
const promptHash = crypto.createHash('sha256').update(Object.values(PROMPTS).join('\0')).digest('hex').slice(0, 12);
const ts = () => new Date().toISOString();
const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const append = (f, recs) => recs.length && fs.appendFileSync(f, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
const EDITS = new Map(readJsonl(flag('--edits', '') || '/nonexistent').map((e) => [e.ID, { action: 'rewrite', ...e }]));

function result(c, fields) {
  return {
    ID: c.ID, Reference: c.Reference, slug: c.slug, old: c.Note, new: null, template_id: null,
    status: 'unchanged', reasons: [], warnings: [], dropped_links: [], claims: null, judges: {}, tags_add: [], review: null,
    model: MODEL, prompts: promptHash, templates_snapshot: lib.templatesSnapshotDate(), ...fields,
  };
}

async function runBatch(book, batch, files) {
  // Each issue's template variants go once per batch, not once per row.
  const ask = batch.filter((c) => !EDITS.has(c.ID));
  const input = {
    templates: Object.fromEntries(ask.map((c) => [c.slug, c.templates])),
    rows: ask.map((c) => ({ ID: c.ID, Reference: c.Reference, issue: c.slug, old_note: c.prose, ult: c.ult })),
  };
  if (DRY) {
    console.log(`--- DRY ${book}: would send ${batch.length} rows to ${MODEL}; system ${PROMPTS.rewrite.length} chars, user ${JSON.stringify(input).length} chars`);
    console.log(JSON.stringify(input.rows.slice(0, 2), null, 1).slice(0, 1500));
    return false;
  }
  const byId = new Map(batch.filter((c) => EDITS.has(c.ID)).map((c) => [c.ID, EDITS.get(c.ID)]));
  if (ask.length) {
    const res = await claude({ model: MODEL, system: PROMPTS.rewrite, prompt: JSON.stringify(input), effort: 'medium', guard });
    append(files.calls, [{ at: ts(), step: 'rewrite', model: MODEL, rows: ask.length, ms: res.ms, usage: res.usage, costUsd: res.costUsd, subtype: res.subtype }]);
    try {
      for (const r of parseJson(res.text).results || []) if (!EDITS.has(r.ID)) byId.set(r.ID, r);
    } catch (e) {
      console.error(`[${ts()}] ${book}: unusable rewrite reply (${e.message}); batch not recorded`);
      fs.appendFileSync(files.raw, `=== ${ts()} unusable ===\n${res.text}\n`);
      return false;
    }
  }

  const out = [];
  const passed = [];
  for (const c of batch) {
    const p = byId.get(c.ID);
    const dropped = c.links.map((l) => ({ kind: l.kind, targets: l.targets, covered: l.covered }));
    if (!p) continue; // not recorded, so a rerun retries it
    // The model may ask for a person to look ("review"), with or without a rewrite.
    const review = p.review ? String(p.review).slice(0, 300) : null;
    if (p.action !== 'rewrite') {
      out.push(result(c, { reasons: [`model_declined: ${String(p.reason || '').slice(0, 200)}`], review, tags_add: review ? [lib.REVIEW_TAGS.human] : [] }));
      continue;
    }
    const g = checkRewrite(c, p, { names: files.names });
    // Benjamin, 2026-10-19: no invented alternate translations; tag the row instead.
    const tags = [...(review ? [lib.REVIEW_TAGS.human] : []), ...(g.warnings.includes('template_at_omitted') ? [lib.REVIEW_TAGS.at] : [])];
    const r = result(c, { ...(EDITS.has(c.ID) ? { model: 'reviewer edit' } : {}), new: p.note, template_id: p.template_id, reasons: g.failures, warnings: g.warnings, gate_detail: g.detail, dropped_links: dropped, review, tags_add: tags });
    out.push(r);
    if (!g.failures.length) passed.push({ c, r });
  }

  // Gate 5: claim check on the rows every mechanical gate passed. A failure in
  // this step keeps those rows unchanged (recorded with the reason) instead of
  // ending the run; an advisory judge's failure only loses its scores.
  if (passed.length) {
    try { await claimCheck(passed, files); } catch (e) {
      console.error(`[${ts()}] ${book}: claim check failed (${e.message}); ${passed.length} rows kept unchanged`);
      for (const { r } of passed) { r.reasons.push('claim_check_error'); r.status = 'unchanged'; }
    }
  }
  for (const r of out) {
    if (r.status === 'changed' || !r.new) continue;
    r.new_rejected = r.new; r.new = null;
    // The AT tag belongs to the rewrite that did not ship; a request for review still stands.
    r.tags_add = r.tags_add.filter((t) => t !== lib.REVIEW_TAGS.at);
  }
  append(files.results, out);
  return true;
}

async function claimCheck(passed, files) {
  const ex = await extractClaims(passed.map((x) => x.c), { model: HAIKU, system: PROMPTS.claims, guard });
  append(files.calls, [{ at: ts(), step: 'claims', ...ex.call, rows: passed.length }]);
  const items = passed.map(({ c, r }) => ({ ID: c.ID, note: r.new, ult: c.ult, claims: ex.claims[c.ID] }));
  for (const { r } of passed) r.claims = ex.claims[r.ID];
  const advisory = (name, fn) => (PRIMARY === name ? fn() : fn().catch((e) => console.error(`[${ts()}] advisory ${name} judge failed: ${e.message}`)));
  if (JUDGE !== 'jev') {
    await advisory('haiku', async () => {
      const h = await judgeHaiku(items, { model: HAIKU, system: PROMPTS.judge, guard });
      append(files.calls, [{ at: ts(), step: 'judge-haiku', ...h.call, rows: items.length }]);
      for (const { r } of passed) r.judges.haiku = h.p[r.ID];
    });
  }
  if (JUDGE !== 'haiku') {
    await advisory('jev', async () => {
      for (const item of items) {
        const j = await judgeJev(item);
        if (j.call) append(files.calls, [{ at: ts(), step: 'judge-jev', ...j.call, rows: 1 }]);
        passed.find((x) => x.r.ID === item.ID).r.judges.jev = j.p;
      }
    });
  }
  for (const { r } of passed) {
    const v = claimVerdict(r.claims, r.judges[PRIMARY], THRESHOLD, r.judges[SECOND]);
    r.claim_missing = v.missing;
    if (v.pass) r.status = 'changed'; else r.reasons.push('claim_missing');
    if (v.pass && v.split.length) splitFlag(r, v.split);
    // No claims means nothing was checked: ship it, but at the top of the review.
    if (v.pass && !r.claims.length) r.warnings.push('no_claims_checked');
  }
}

// --reverdict: recompute claim verdicts in results.jsonl from the judge scores
// already stored (e.g. after switching --primary), without any model call.
// Only rows that passed every mechanical gate are touched.
if (REVERDICT) {
  for (const book of books) {
    const f = path.join(lib.WORK_DIR, 'output/modernize', book, 'results.jsonl');
    let moved = 0;
    const rows = readJsonl(f).map((r) => {
      if (!r.claims || !r.judges || !(PRIMARY in r.judges)) return r;
      const mech = r.reasons.filter((x) => x !== 'claim_missing');
      if (mech.length) return r;
      const v = claimVerdict(r.claims, r.judges[PRIMARY], THRESHOLD, r.judges[SECOND]);
      const note = r.new || r.new_rejected;
      const was = r.status;
      Object.assign(r, { status: v.pass ? 'changed' : 'unchanged', claim_missing: v.missing, reasons: v.pass ? [] : ['claim_missing'],
        new: v.pass ? note : null, new_rejected: v.pass ? undefined : note, primary_judge: PRIMARY, threshold: THRESHOLD });
      if (v.pass && v.split.length) splitFlag(r, v.split);
      if (was !== r.status) moved++;
      return r;
    });
    fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    console.log(`${book}: re-verdicted with ${PRIMARY} at ${THRESHOLD}; ${moved} rows changed status`);
  }
  process.exit(0);
}

for (const book of books) {
  const dir = path.join(lib.WORK_DIR, 'output/modernize', book);
  const files = { results: path.join(dir, 'results.jsonl'), calls: path.join(dir, 'calls.jsonl'), raw: path.join(dir, 'unusable-replies.txt') };
  const candidates = readJsonl(path.join(dir, 'candidates.jsonl'));
  files.names = new Set(JSON.parse(fs.readFileSync(path.join(dir, 'extract.json'), 'utf8')).names || []);
  // Reviewer edits replace the rows' earlier results.
  if (EDITS.size && !DRY) {
    const kept = readJsonl(files.results).filter((r) => !EDITS.has(r.ID));
    fs.writeFileSync(files.results, kept.map((r) => JSON.stringify(r)).join('\n') + (kept.length ? '\n' : ''));
  }
  const done = new Set(readJsonl(files.results).map((r) => r.ID));
  // Rows extract.mjs already skipped become unchanged results once.
  const skips = candidates.filter((c) => c.status === 'skip' && !done.has(c.ID));
  if (!DRY) append(files.results, skips.map((c) => result(c, { reasons: [c.reason], model: null, tags_add: c.tags_add || [] })));
  let todo = candidates.filter((c) => c.status === 'candidate' && !done.has(c.ID));
  const doneCandidates = candidates.filter((c) => c.status === 'candidate' && done.has(c.ID)).length;
  if (LIMIT) todo = todo.slice(0, Math.max(0, LIMIT - doneCandidates));
  console.log(`[${ts()}] ${book}: ${todo.length} rows to rewrite (${done.size} done, ${skips.length} skipped by extract); model ${MODEL}, judge ${JUDGE} (primary ${PRIMARY}) at ${THRESHOLD}`);
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    const ok = await runBatch(book, batch, files);
    if (DRY) break;
    const g = await guard();
    console.log(`[${ts()}] ${book}: batch ${i / BATCH + 1}/${Math.ceil(todo.length / BATCH)} ${ok ? 'recorded' : 'NOT recorded'}; weekly ${g.used ?? '?'}%`);
  }
}
