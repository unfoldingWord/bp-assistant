#!/usr/bin/env node
// extract.mjs — candidate rows for one or more books. Read-only on the clones.
//
//   node scripts/tn-modernize/extract.mjs --tn <en_tn> --ult <en_ult> [--twl <en_twl>] BOOK [BOOK...]
//
// Writes $TN_MODERNIZE_DIR/output/modernize/<BOOK>/candidates.jsonl (shape in
// rows.js) and extract.json (counts, source commits, template snapshot date).
// Only rows lib.classifyRow calls "old" become candidates; the rest are counted.

import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const lib = require('./lib.js');
const { splitLinks } = require('./rows.js');
const { BOOK_NUMBERS } = require('../../src/door43-push.js');

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const TN = flag('--tn'), ULT = flag('--ult'), TWL = flag('--twl');
const flagVals = new Set([TN, ULT, TWL]);
const books = argv.filter((a) => /^[0-9A-Z]{3}$/.test(a) && !flagVals.has(a));
if (!TN || !ULT || !books.length) {
  console.error('usage: extract.mjs --tn <en_tn> --ult <en_ult> [--twl <en_twl>] BOOK [BOOK...]');
  process.exit(2);
}
const head = (dir) => execFileSync('git', ['-C', dir, 'log', '-1', '--format=%H %cI'], { encoding: 'utf8' }).trim();

for (const book of books) {
  const num = BOOK_NUMBERS[book];
  if (!num) throw new Error(`unknown book ${book}`);
  const usfm = fs.readFileSync(path.join(ULT, `${num}-${book}.usfm`), 'utf8');
  const rows = lib.parseTnTsv(fs.readFileSync(path.join(TN, `tn_${book}.tsv`), 'utf8'));

  // tW links per Reference, to tell whether a dropped (See: [[tw]]) link is covered by the twl file.
  let twlByRef = null;
  const twlPath = TWL && path.join(TWL, `twl_${book}.tsv`);
  if (twlPath && fs.existsSync(twlPath)) {
    twlByRef = new Map();
    for (const line of fs.readFileSync(twlPath, 'utf8').split('\n').slice(1)) {
      const c = line.split('\t');
      if (c.length < 6) continue;
      if (!twlByRef.has(c[0])) twlByRef.set(c[0], new Set());
      twlByRef.get(c[0]).add(c[5].trim());
    }
  }

  const counts = { rows: rows.length, candidate: 0 };
  const out = [];
  for (const r of rows) {
    const cls = lib.classifyRow(r);
    if (cls.status !== 'old') { counts[cls.status] = (counts[cls.status] || 0) + 1; continue; }
    const { prose, links, otherLinks } = splitLinks(r.Note);
    const ult = lib.ultTextForRow(usfm, r.Reference);
    const rec = {
      book, ID: r.ID, Reference: r.Reference, SupportReference: r.SupportReference, slug: cls.slug,
      Quote: r.Quote, Occurrence: r.Occurrence, Note: r.Note, prose, links, ult,
      templates: lib.templatesFor(cls.slug).map((t) => ({ id: t.id, type: t.type, template: t.template })),
      status: 'candidate',
    };
    // D5: does the dropped link's information already live somewhere else?
    for (const l of links) {
      if (l.kind === 'see-also-ta') {
        const want = l.targets.map((t) => t.split('/').pop());
        l.covered = want.every((slug) => rows.some((o) => o !== r && o.Reference === r.Reference && o.Quote === r.Quote && lib.srefSlug(o.SupportReference) === slug));
      } else {
        l.covered = twlByRef ? l.targets.every((t) => (twlByRef.get(r.Reference) || new Set()).has(t)) : null;
      }
    }
    if (otherLinks) Object.assign(rec, { status: 'skip', reason: 'other_link' });
    else if (!ult) Object.assign(rec, { status: 'skip', reason: 'no_ult_text' });
    else if (!prose) Object.assign(rec, { status: 'skip', reason: 'empty_note' });
    counts[rec.status === 'skip' ? `skip_${rec.reason}` : 'candidate']++;
    out.push(rec);
  }

  const dir = path.join(lib.WORK_DIR, 'output/modernize', book);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'candidates.jsonl'), out.map((o) => JSON.stringify(o)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'extract.json'), JSON.stringify({
    book, counts, templates_snapshot: lib.templatesSnapshotDate(),
    sources: { en_tn: head(TN), en_ult: head(ULT), en_twl: TWL ? head(TWL) : null },
    extracted_at: new Date().toISOString(),
  }, null, 1) + '\n');
  console.log(`${book}: ${JSON.stringify(counts)}`);
}
