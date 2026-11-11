#!/usr/bin/env node
// judge-eval.mjs — D6: which claim judge catches lost information, Haiku or jev?
//
//   node scripts/tn-modernize/judge-eval.mjs --skill <skill dir> [--limits file] [--threshold 0.8] [--judges haiku,jev] BOOK [BOOK...]
//
// For every row the rewrite proposed (applied or held back by the claim check)
// that has claims: take the proposed note as it is, and a seeded copy with
// the one prose sentence that best matches one claim deleted. Each judge rates
// every claim on both. A good judge keeps the unseeded note's claims above the
// threshold and drops the targeted claim below it on the seeded copy.
// Writes output/modernize/judge-eval.{json,md}. Results files are not changed.

import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const lib = require('./lib.js');
const { makeGuard } = require('./models.js');
const { judgeHaiku, judgeJev } = require('./claims.js');

const argv = process.argv.slice(2);
const valueFlags = ['--skill', '--limits', '--threshold', '--judges', '--haiku', '--stop-pct'];
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const skipIdx = new Set(valueFlags.flatMap((f) => { const i = argv.indexOf(f); return i >= 0 ? [i, i + 1] : []; }));
const books = argv.filter((a, i) => !skipIdx.has(i) && /^[0-9A-Z]{3}$/.test(a));
const SKILL = flag('--skill');
const THRESHOLD = Number(flag('--threshold', '0.8'));
const JUDGES = flag('--judges', 'haiku,jev').split(',');
const HAIKU = flag('--haiku', 'claude-haiku-5-5');
const guard = makeGuard({ limitsFile: flag('--limits'), stopPct: Number(flag('--stop-pct', '60')) });
if (!SKILL || !books.length) { console.error('usage: judge-eval.mjs --skill <dir> BOOK...'); process.exit(2); }
const judgePrompt = fs.readFileSync(path.join(SKILL, 'judge-prompt.md'), 'utf8');

const words = (s) => new Set(String(s).toLowerCase().replace(/\*\*/g, '').match(/[a-z’']{3,}/g) || []);
// Prose sentences only: AT lines and the template's own sentences are not candidates for deletion.
function seed(note, claims, templateText) {
  const prose = note.replace(/\s*Alternate translation:.*$/, '');
  const at = note.slice(prose.length);
  const sentences = prose.match(/[^.!?]+[.!?]+(?:[”’])?\s*/g) || [prose];
  const tplWords = words(templateText);
  let best = null;
  claims.forEach((c, k) => {
    const cw = words(c);
    sentences.forEach((s, i) => {
      const sw = words(s);
      const novel = [...sw].filter((w) => !tplWords.has(w));
      const overlap = novel.filter((w) => cw.has(w)).length;
      if (overlap >= 2 && (!best || overlap > best.overlap)) best = { overlap, k, i };
    });
  });
  if (!best || sentences.length < 2) return null;
  const seeded = sentences.filter((_, i) => i !== best.i).join('').trim() + at;
  return { seeded, target: best.k, removed: sentences[best.i].trim() };
}

const items = [];
for (const book of books) {
  const dir = path.join(lib.WORK_DIR, 'output/modernize', book);
  const cands = new Map(fs.readFileSync(path.join(dir, 'candidates.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((c) => [c.ID, c]));
  for (const l of fs.readFileSync(path.join(dir, 'results.jsonl'), 'utf8').split('\n').filter(Boolean)) {
    const r = JSON.parse(l);
    const note = r.new || r.new_rejected;
    if (!note || !r.claims || !r.claims.length) continue;
    const c = cands.get(r.ID);
    if (!c) continue; // re-extracted since this result was written
    const tpl = (c.templates.find((t) => t.id === r.template_id) || {}).template || '';
    const s = seed(note, r.claims, tpl);
    items.push({ book, ID: `${book}-${r.ID}`, claims: r.claims, ult: c.ult, note, seed: s });
  }
}
console.log(`${items.length} notes with claims; ${items.filter((i) => i.seed).length} seedable`);

const scores = {};
for (const j of JUDGES) {
  scores[j] = { unseeded: {}, seeded: {}, ms: 0, costUsd: 0 };
  const variants = [
    ...items.map((i) => ({ key: `${i.ID}:u`, ID: `${i.ID}u`, note: i.note, claims: i.claims, ult: i.ult })),
    ...items.filter((i) => i.seed).map((i) => ({ key: `${i.ID}:s`, ID: `${i.ID}s`, note: i.seed.seeded, claims: i.claims, ult: i.ult })),
  ];
  for (let k = 0; k < variants.length; k += 20) {
    const batch = variants.slice(k, k + 20);
    if (j === 'haiku') {
      const h = await judgeHaiku(batch, { model: HAIKU, system: judgePrompt, guard });
      scores[j].ms += h.call.ms; scores[j].costUsd += h.call.costUsd || 0;
      for (const v of batch) scores[j][v.key.endsWith(':u') ? 'unseeded' : 'seeded'][v.key.slice(0, -2)] = h.p[v.ID];
    } else {
      for (const v of batch) {
        const r = await judgeJev(v);
        if (r.call) { scores[j].ms += r.call.ms; scores[j].costUsd += r.call.costUsd || 0; }
        scores[j][v.key.endsWith(':u') ? 'unseeded' : 'seeded'][v.key.slice(0, -2)] = r.p;
      }
    }
    console.log(`${j}: ${Math.min(k + 20, variants.length)}/${variants.length}`);
  }
}

// A judge that returned no score for an item is left out of its counts, not counted as a catch.
const scored = (p, n) => Array.isArray(p) && p.length === n && p.every((x) => x != null);
const below = (p, k) => Number(p[k]) < THRESHOLD;
const lines = [`# Claim judge comparison (D6)`, '', `Books: ${books.join(', ')} · threshold ${THRESHOLD} · ${items.length} rewritten notes with claims, ${items.filter((i) => i.seed).length} with a seeded deletion`, '',
  '| Judge | Seeded losses caught | Unseeded notes flagged | Time | Cost |', '| --- | --- | --- | --- | --- |'];
for (const j of JUDGES) {
  const seeded = items.filter((i) => i.seed && scored(scores[j].seeded[i.ID], i.claims.length));
  const unseeded = items.filter((i) => scored(scores[j].unseeded[i.ID], i.claims.length));
  const caught = seeded.filter((i) => below(scores[j].seeded[i.ID], i.seed.target)).length;
  const flagged = unseeded.filter((i) => i.claims.some((_, k) => below(scores[j].unseeded[i.ID], k))).length;
  lines.push(`| ${j} | ${caught}/${seeded.length} | ${flagged}/${unseeded.length} | ${(scores[j].ms / 1000).toFixed(0)} s | $${scores[j].costUsd.toFixed(4)} |`);
}
lines.push('', 'Unseeded flags are not all errors: some rewrites really did lose information. Compare the rows in judge-eval.json.');
const out = path.join(lib.WORK_DIR, 'output/modernize');
fs.writeFileSync(path.join(out, 'judge-eval.json'), JSON.stringify({ threshold: THRESHOLD, items, scores }, null, 1));
fs.writeFileSync(path.join(out, 'judge-eval.md'), lines.join('\n') + '\n');
console.log(lines.join('\n'));
