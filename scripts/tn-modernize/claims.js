// claims.js — gate 5, "is every claim of the old note still in the new one?"
//
// Two steps, run separately from the rewrite so the rewriting model never
// grades itself:
//   extractClaims  Haiku lists the atomic claims of each OLD note (prompt:
//                  skill claims-prompt.md). Not cached: a rerun extracts again.
//   judge*         for each claim, the probability the NEW note still makes it:
//                  judgeHaiku (prompt: judge-prompt.md, one call per batch) or
//                  judgeJev (one typed call per row, one yes/no per claim).
// claimVerdict turns probabilities into pass/fail at a threshold.

'use strict';

const { claude, jev, parseJson } = require('./models');

// Haiku occasionally returns malformed JSON here (2 of ~30 pilot calls);
// one retry is cheaper than holding back a whole batch of good rewrites.
async function claudeJson(opts, tries = 2) {
  for (let i = 1; ; i++) {
    const res = await claude(opts);
    try { return { res, json: parseJson(res.text) }; } catch (e) { if (i >= tries) throw e; }
  }
}

/** The note with its "Alternate translation: [...]" spans removed. */
function withoutAts(note) {
  return String(note).replace(/Alternate translation:\s*(?:\([^)]*\)\s*)?\[[^\]]*\](?:\s*,?\s*or\s+(?:\([^)]*\)\s*)?\[[^\]]*\])*/g, ' ').replace(/\s+/g, ' ').trim();
}

async function extractClaims(rows, { model, system, guard }) {
  // The alternate translations are checked word for word by gate 2; left in,
  // the extractor turns them into claims the new note's prose cannot carry
  // (8 of 9 claim holds in the Ruth pilot).
  const input = rows.map((r) => ({ ID: r.ID, issue: r.slug, note: withoutAts(r.prose) }));
  const { res, json } = await claudeJson({ model, system, prompt: JSON.stringify(input), effort: 'low', guard });
  const claims = json.claims || {};
  for (const r of rows) {
    if (!Array.isArray(claims[r.ID])) throw new Error(`claims: no list for ${r.ID}`);
  }
  return { claims, call: { model, ms: res.ms, usage: res.usage, costUsd: res.costUsd } };
}

async function judgeHaiku(items, { model, system, guard }) {
  const input = items.map((i) => ({ ID: i.ID, note: i.note, claims: i.claims }));
  const { res, json } = await claudeJson({ model, system, prompt: JSON.stringify(input), effort: 'low', guard });
  const present = json.present || {};
  const out = {};
  for (const i of items) {
    const p = present[i.ID];
    out[i.ID] = Array.isArray(p) && p.length === i.claims.length ? p.map(Number) : null;
  }
  return { p: out, call: { model, ms: res.ms, usage: res.usage, costUsd: res.costUsd } };
}

async function judgeJev(item) {
  if (!item.claims.length) return { p: [], call: null };
  const questions = {};
  item.claims.forEach((c, k) => {
    questions[`claim_${k + 1}`] = {
      type: 'noul',
      instructions: `Does the translation note in new_note still state or clearly imply this information: "${c}"? Different wording is fine; the information must be the same. Information found only inside the "Alternate translation: [...]" brackets does not count.`,
      criteria: {
        true: 'The note states this information or clearly implies it.',
        false: 'The note leaves this information out or says something different.',
      },
    };
  });
  const r = await jev({ state: { new_note: item.note, verse_text: item.ult }, questions });
  return {
    p: item.claims.map((_, k) => r.p[`claim_${k + 1}`] ?? null),
    call: { model: r.model, ms: r.ms, inputTokens: r.inputTokens, costUsd: r.costUsd },
  };
}

/** { pass, missing: [claim...] }; a missing probability counts as a failure. */
function claimVerdict(claims, p, threshold, second) {
  if (!Array.isArray(p)) return { pass: false, missing: claims, error: 'no judgement' };
  const missing = claims.filter((_, k) => !(Number(p[k]) >= threshold));
  // With a second judge, a claim is missing only when both say so; a claim only
  // one judge doubts ships for a person to check (Benjamin, 2026-10-19: RUT-f9ha, RUT-n9zc).
  if (!missing.length || !Array.isArray(second)) return { pass: missing.length === 0, missing, split: [] };
  const both = claims.filter((c, k) => missing.includes(c) && !(Number(second[k]) >= threshold));
  return { pass: both.length === 0, missing: both, split: missing.filter((c) => !both.includes(c)) };
}

module.exports = { withoutAts, extractClaims, judgeHaiku, judgeJev, claimVerdict };
