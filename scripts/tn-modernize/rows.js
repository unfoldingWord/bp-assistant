// rows.js — the record shapes tn-modernize passes between steps, and the two
// pure transforms on them: link splitting (extract) and Note splicing (apply).
//
// Candidate (extract -> rewrite), one JSON line per en_tn row worth a look:
//   { book, ID, Reference, SupportReference, slug, Quote, Occurrence,
//     Note,            // the row's Note exactly as in the TSV
//     prose,           // Note with the D5 link parentheticals removed (what the model sees)
//     links: [{ kind: 'see-also-ta' | 'see-tw', raw, targets: [rc...] }],
//     ult,             // ULT text of the verse(s) the Reference covers
//     templates: [{ id, type, template }],
//     status: 'candidate' | 'skip', reason? }
//
// Result (rewrite -> apply/report), one per candidate:
//   { ID, Reference, slug, old, new, template_id,
//     status: 'changed' | 'unchanged', reasons: [], warnings: [],
//     dropped_links, claims, judges, model }
//   `new` is null unless status is 'changed'. Only 'changed' rows are applied.

'use strict';

// "(See also: [[rc://*/ta/man/translate/x]])" and "(See: [[rc://*/tw/dict/bible/kt/y]])",
// with one or more links joined by commas, "and" or ";".
const LINK_GROUP_RE = /\s*\((See(?: also)?):\s*((?:\[\[rc:\/\/[^\]]+\]\][\s,;]*(?:and\s+)?)+)\)\s*\.?/g;
const RC_LINK_RE = /\[\[(rc:\/\/[^\]]+)\]\]/g;

/**
 * Split an old note into the prose the model rewrites and the link groups the
 * D5 policy drops (and logs). Returns { prose, links, otherLinks } where
 * otherLinks counts rc:// or [[ ]] links outside those groups: a row with any
 * is skipped, because their information has no policy yet.
 */
function splitLinks(note) {
  const links = [];
  const prose = String(note).replace(LINK_GROUP_RE, (raw, label, body) => {
    const targets = [...body.matchAll(RC_LINK_RE)].map((m) => m[1]);
    const ta = targets.every((t) => /\/ta\/man\//.test(t));
    const tw = targets.every((t) => /\/tw\/dict\//.test(t));
    if (!(ta || tw)) return raw; // mixed group: leave it, counted below
    links.push({ kind: tw ? 'see-tw' : 'see-also-ta', raw: raw.trim(), targets });
    return ' ';
  }).replace(/ {2,}/g, ' ').replace(/ +(\\n|$)/g, '$1').trim();
  const otherLinks = (prose.match(/rc:\/\/|\[\[/g) || []).length;
  return { prose, links, otherLinks };
}

/** Tags a result adds, merged into a row's existing Tags cell ("; " between tags, none repeated). */
function mergeTags(cell, add) {
  const have = String(cell || '').split(';').map((t) => t.trim()).filter(Boolean);
  for (const t of add || []) if (!have.includes(t)) have.push(t);
  return have.join('; ');
}

/** Results that write to the TSV: a new Note, and/or review tags on an unchanged Note. */
const writes = (r) => r.status === 'changed' || (r.tags_add && r.tags_add.length > 0);

/**
 * Splice new Note cells, and the Tags a result adds, into an en_tn TSV text,
 * touching nothing else.
 *
 * Works line by line on the original bytes (two en_tn books have no trailing
 * newline, so a parse/serialize round trip would change them elsewhere).
 * A result applies only when its row (matched by ID) still holds exactly the
 * old Note; otherwise it is reported stale, never forced.
 *
 * @returns {{ text, applied: string[], tagged: string[], stale: string[], missing: string[] }}
 */
function applyResults(tsvText, results) {
  const changed = new Map(results.filter(writes).map((r) => [r.ID, r]));
  const lines = String(tsvText).split('\n');
  const applied = [];
  const tagged = [];
  const stale = [];
  for (let i = 1; i < lines.length; i++) {
    const cr = lines[i].endsWith('\r') ? '\r' : '';
    const cells = (cr ? lines[i].slice(0, -1) : lines[i]).split('\t');
    if (cells.length !== 7) continue;
    const r = changed.get(cells[1]);
    if (!r) continue;
    changed.delete(cells[1]);
    if (cells[6] !== r.old) { stale.push(r.ID); continue; }
    if (r.status === 'changed') {
      if (/[\t\r\n]/.test(r.new)) throw new Error(`${r.ID}: new note contains a raw tab or newline`);
      cells[6] = r.new;
      applied.push(r.ID);
    }
    if (r.tags_add && r.tags_add.length) { cells[2] = mergeTags(cells[2], r.tags_add); tagged.push(r.ID); }
    lines[i] = cells.join('\t') + cr;
  }
  return { text: lines.join('\n'), applied, tagged, stale, missing: [...changed.keys()] };
}

/**
 * Prove a before/after pair differs only in the Note cells of `ids` and the
 * Tags cells of `tagIds`. Returns a list of problems; empty means the change
 * is exactly what was intended.
 */
function diffOnlyNotes(beforeText, afterText, ids, parse, tagIds = []) {
  const problems = [];
  const a = parse(beforeText);
  const b = parse(afterText);
  if (a.length !== b.length) return [`row count ${a.length} -> ${b.length}`];
  const want = new Set(ids);
  const tagWant = new Set(tagIds);
  const seen = new Set();
  for (let i = 0; i < a.length; i++) {
    for (const col of ['Reference', 'ID', 'Tags', 'SupportReference', 'Quote', 'Occurrence']) {
      if (col === 'Tags' && tagWant.has(a[i].ID)) continue;
      if (a[i][col] !== b[i][col]) problems.push(`row ${i + 2} ${col} changed`);
    }
    if (a[i].Note !== b[i].Note) {
      if (!want.has(a[i].ID)) problems.push(`row ${i + 2} (${a[i].ID}) Note changed but was not applied`);
      seen.add(a[i].ID);
    }
  }
  for (const id of want) if (!seen.has(id)) problems.push(`${id} applied but Note unchanged`);
  // Outside the changed rows the bytes must be identical, line endings included.
  const la = beforeText.split('\n');
  const lb = afterText.split('\n');
  if (la.length !== lb.length) problems.push(`line count ${la.length} -> ${lb.length}`);
  for (let i = 0; i < Math.min(la.length, lb.length); i++) {
    if (la[i] !== lb[i] && !want.has(la[i].split('\t')[1]) && !tagWant.has(la[i].split('\t')[1])) problems.push(`line ${i + 1} bytes changed`);
  }
  return problems;
}

module.exports = { splitLinks, applyResults, diffOnlyNotes, mergeTags, writes };
