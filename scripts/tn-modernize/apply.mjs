#!/usr/bin/env node
// apply.mjs — write the 'changed' results of a book into a copy of its TSV.
//
//   node scripts/tn-modernize/apply.mjs --tn <en_tn> [--out <dir>] BOOK [BOOK...]
//
// Reads $TN_MODERNIZE_DIR/output/modernize/<BOOK>/results.jsonl, splices the
// new Notes into <en_tn>/tn_<BOOK>.tsv (rows.applyResults), proves with
// rows.diffOnlyNotes that nothing but those Note cells changed, and writes the
// file to --out (default .../<BOOK>/tn_<BOOK>.tsv). The clone is not touched;
// publish.mjs does the same splice on a fresh branch.

import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const lib = require('./lib.js');
const { applyResults, diffOnlyNotes } = require('./rows.js');

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const TN = flag('--tn'), OUT = flag('--out');
const books = argv.filter((a) => /^[0-9A-Z]{3}$/.test(a) && a !== TN && a !== OUT);
if (!TN || !books.length) {
  console.error('usage: apply.mjs --tn <en_tn> [--out dir] BOOK [BOOK...]');
  process.exit(2);
}

let failed = false;
for (const book of books) {
  const dir = path.join(lib.WORK_DIR, 'output/modernize', book);
  const results = fs.readFileSync(path.join(dir, 'results.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const before = fs.readFileSync(path.join(TN, `tn_${book}.tsv`), 'utf8');
  const { text, applied, stale, missing } = applyResults(before, results);
  const problems = diffOnlyNotes(before, text, applied, lib.parseTnTsv);
  const changed = results.filter((r) => r.status === 'changed').length;
  if (problems.length || applied.length + stale.length + missing.length !== changed) {
    console.error(`${book}: REFUSED — ${problems.slice(0, 5).join('; ') || 'applied/stale/missing do not add up'}`);
    failed = true;
    continue;
  }
  const outPath = OUT ? path.join(OUT, `tn_${book}.tsv`) : path.join(dir, `tn_${book}.tsv`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, text);
  console.log(`${book}: applied ${applied.length} of ${changed} changed notes` +
    (stale.length ? `; ${stale.length} stale (Note changed upstream): ${stale.join(' ')}` : '') +
    (missing.length ? `; ${missing.length} IDs no longer in the file: ${missing.join(' ')}` : '') + ` -> ${outPath}`);
}
process.exit(failed ? 1 : 0);
