#!/usr/bin/env node
// survey.mjs — which en_tn books still carry pre-template notes? Read-only.
//
//   node scripts/tn-modernize/survey.mjs --tn <en_tn clone> [--out <dir>]
//
// The clone must have history for the age columns
// (git clone --filter=blob:none https://git.door43.org/unfoldingWord/en_tn.git).
// Writes survey.csv and survey.md to --out (default $TN_MODERNIZE_DIR/survey).
//
// Conformance (primary signal) is lib.classifyRow over every row. Age is
// advisory: the last year an editor's commit touched the book. Skipped: mass
// commits (> MASS_FILES tn files, e.g. the column migration), bot "AI TN"
// commits (counted as ai_commits), and maintenance commits by the accounts in
// MAINT_AUTHORS (quote, bullet, link and punctuation fixes across books;
// counted as maint_commits).

import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const lib = require('./lib.js');

const MASS_FILES = 10;
const MAINT_AUTHORS = /^(Richard Mahn|richmahn|richqa)$/;
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const TN = flag('--tn');
const OUT = flag('--out', path.join(lib.WORK_DIR, 'survey'));
if (!TN || !fs.existsSync(path.join(TN, '.git'))) {
  console.error('usage: survey.mjs --tn <en_tn git clone with history> [--out dir]');
  process.exit(2);
}

// ---- age: one pass over the whole history -------------------------------
const log = execFileSync('git', ['-C', TN, 'log', '--no-merges', '--name-only', '--date=format:%Y', '--format=@@%ad\t%an\t%s'],
  { maxBuffer: 1 << 30, encoding: 'utf8' });
const age = {}; // book -> { last, lastAi, byYear: {year: n}, ai: n, maint: n }
for (const block of log.split('@@').slice(1)) {
  const [head, ...files] = block.split('\n').filter(Boolean);
  const [year, author, subject] = head.split('\t');
  const books = files.map((f) => (f.match(/^tn_([0-9A-Z]{3})\.tsv$/) || [])[1]).filter(Boolean);
  if (!books.length || books.length > MASS_FILES) continue;
  // Bot TN pushes land as branch commits from "BW Bot" merged via "AI TN" PRs.
  const isAi = author === 'BW Bot' || /^AI TN\b/.test(subject || '');
  for (const b of books) {
    const a = (age[b] ||= { last: '', lastAi: '', byYear: {}, ai: 0, maint: 0 });
    if (isAi) { a.ai++; if (year > a.lastAi) a.lastAi = year; continue; }
    if (MAINT_AUTHORS.test(author)) { a.maint++; continue; }
    a.byYear[year] = (a.byYear[year] || 0) + 1;
    if (year > a.last) a.last = year;
  }
}

// ---- conformance --------------------------------------------------------
const rows = [];
const total = { rows: 0, intro: 0, no_sref: 0, no_template: 0, no_phrase: 0, conforms: 0, old: 0, see_links: 0 };
for (const f of fs.readdirSync(TN).filter((f) => /^tn_[0-9A-Z]{3}\.tsv$/.test(f)).sort()) {
  const book = f.slice(3, 6);
  const tsv = lib.parseTnTsv(fs.readFileSync(path.join(TN, f), 'utf8'));
  const c = { book, rows: tsv.length, intro: 0, no_sref: 0, no_template: 0, no_phrase: 0, conforms: 0, old: 0, see_links: 0 };
  for (const r of tsv) {
    c[lib.classifyRow(r).status]++;
    if (!lib.isIntroReference(r.Reference) && /\[\[rc:\/\//.test(r.Note)) c.see_links++;
  }
  const tested = c.conforms + c.old;
  c.conform_pct = tested ? Math.round((100 * c.conforms) / tested) : null;
  const a = age[book] || { last: '', lastAi: '', byYear: {}, ai: 0, maint: 0 };
  const human = Object.values(a.byYear).reduce((s, n) => s + n, 0);
  const since = (y) => Object.entries(a.byYear).filter(([yr]) => yr >= y).reduce((s, [, n]) => s + n, 0);
  Object.assign(c, {
    last_editor_year: a.last, editor_commits: human, editor_commits_2025plus: since('2025'),
    maint_commits: a.maint, ai_commits: a.ai, last_ai_year: a.lastAi,
  });
  rows.push(c);
  for (const k of Object.keys(total)) total[k] += c[k];
}

// Most old rows first: that is where the work is.
rows.sort((x, y) => y.old - x.old);

const cols = ['book', 'rows', 'old', 'conforms', 'conform_pct', 'no_template', 'no_phrase', 'no_sref', 'intro', 'see_links',
  'last_editor_year', 'editor_commits', 'editor_commits_2025plus', 'maint_commits', 'ai_commits', 'last_ai_year'];
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'survey.csv'), [cols.join(','), ...rows.map((r) => cols.map((k) => r[k] ?? '').join(','))].join('\n') + '\n');

const head = `# en_tn template survey

Source: \`${execFileSync('git', ['-C', TN, 'log', '-1', '--format=%h %ad', '--date=short'], { encoding: 'utf8' }).trim()}\` (en_tn master) · templates snapshot ${lib.templatesSnapshotDate()}

- **old**: the note matches none of its SupportReference's templates (a rewrite candidate).
- **conforms**: it contains the first fixed phrase of at least one template variant (never rewritten).
- **conform %**: conforms / (conforms + old).
- **no template / no phrase / no sref / intro**: not testable, never rewritten.
- **see links**: non-intro rows with a \`[[rc://...]]\` link (D5).
- Age columns are advisory. Editor columns skip commits touching more than ${MASS_FILES} tn files, bot "AI TN" commits (ai_commits) and cross-book maintenance commits (maint_commits).

Totals: ${total.rows} rows; ${total.old} old, ${total.conforms} conform, ${total.no_template} no template, ${total.no_phrase} no phrase, ${total.no_sref} no sref, ${total.intro} intro.

| ${cols.join(' | ')} |
| ${cols.map(() => '---').join(' | ')} |
`;
fs.writeFileSync(path.join(OUT, 'survey.md'), head + rows.map((r) => `| ${cols.map((k) => r[k] ?? '').join(' | ')} |`).join('\n') + '\n');
console.log(`wrote ${path.join(OUT, 'survey.md')} (${rows.length} books; ${total.old} old rows of ${total.rows})`);
