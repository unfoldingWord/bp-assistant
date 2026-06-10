// Tests for workspace-tools/validation-tools.js — the validation gates that
// dynamic-import their logic from the bp-assistant-skills clone.
//
// CSKILLBP_DIR is pointed at the skills checkout for the test run. If the
// validation scripts are not present there (e.g. CI without the skills repo,
// or a skills clone older than the quality-gates work), the suite skips
// rather than fails.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Candidate skills checkouts, most specific first. Override with SKILLS_DIR_FOR_TESTS.
const candidates = [
  process.env.SKILLS_DIR_FOR_TESTS,
  process.env.CSKILLBP_DIR,
  path.resolve(__dirname, '../../bp-assistant-skills/.claude/worktrees/jolly-payne-b1c14e'),
  path.resolve(__dirname, '../../bp-assistant-skills'),
  '/srv/bot/workspace',
].filter(Boolean);

const skillsDir = candidates.find((d) =>
  fs.existsSync(path.join(d, '.claude/skills/utilities/scripts/validation/validate_usfm_structure.mjs')));

const SKIP = !skillsDir;
if (!SKIP) {
  process.env.CSKILLBP_DIR = skillsDir;
  delete require.cache[require.resolve('../src/workspace-tools/validation-tools')];
}
const tools = SKIP ? null : require('../src/workspace-tools/validation-tools');

const skipNote = 'skills validation scripts not found in any known checkout';

function tmpFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valtools-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

const HEBREW = `\\id TST Test
\\c 1
\\v 1
\\w שָׁלוֹם|lemma="שָׁלוֹם" strong="H7965" x-morph="He,Ncmsa"\\w*
\\v 2
\\w ט֣וֹב|lemma="טוֹב" strong="H2896a" x-morph="He,Aamsa"\\w*
`;

test('validate_usfm_structure: passes clean USFM, fails missing verse', { skip: SKIP && skipNote }, async () => {
  const good = tmpFile('good.usfm', '\\id TST\n\\c 1\n\\v 1 Peace.\n\\v 2 Good.\n');
  let out = await tools.validateUsfmStructure({ usfm: good });
  assert.match(out, /^OK:/);

  const hebrew = tmpFile('heb.usfm', HEBREW);
  const missing = tmpFile('missing.usfm', '\\id TST\n\\c 1\n\\v 1 Peace.\n');
  out = await tools.validateUsfmStructure({ usfm: missing, source: hebrew, chapter: 1 });
  assert.match(out, /^FAIL:/);
  assert.match(out, /missing_vs_source/);
});

test('validate_alignment_integrity: flags content not in Hebrew', { skip: SKIP && skipNote }, async () => {
  const hebrew = tmpFile('heb.usfm', HEBREW);
  const aligned = tmpFile('aligned.usfm',
    '\\id TST\n\\c 1\n\\v 1\n'
    + '\\zaln-s |x-strong="H7965" x-lemma="שָׁלוֹם" x-morph="" x-occurrence="1" x-occurrences="1" x-content="שָׁלוֹם"\\*\\w peace|x-occurrence="1" x-occurrences="1"\\w*\\zaln-e\\*\n');
  let out = await tools.validateAlignmentIntegrityGate({ aligned, hebrew, chapter: 1 });
  assert.match(out, /^OK:/, out);

  const bad = tmpFile('bad.usfm',
    '\\id TST\n\\c 1\n\\v 1\n'
    + '\\zaln-s |x-strong="H7965" x-lemma="שָׁלוֹם" x-morph="" x-occurrence="1" x-occurrences="1" x-content="טעות"\\*\\w peace|x-occurrence="1" x-occurrences="1"\\w*\\zaln-e\\*\n');
  out = await tools.validateAlignmentIntegrityGate({ aligned: bad, hebrew, chapter: 1 });
  assert.match(out, /^FAIL:/);
  assert.match(out, /content_not_in_hebrew/);
});

test('check_duplicate_ids: catches duplicates across files', { skip: SKIP && skipNote }, async () => {
  const header = 'Reference\tID\tTags\tQuote\tOccurrence\tNote\n';
  const a = tmpFile('a.tsv', header + '1:1\tab12\t\tq\t1\tn\n');
  const b = tmpFile('b.tsv', header + '2:1\tab12\t\tq\t1\tn\n');
  let out = await tools.checkDuplicateIdsGate({ files: [a] });
  assert.match(out, /^OK:/);
  out = await tools.checkDuplicateIdsGate({ files: [a, b] });
  assert.match(out, /^FAIL:/);
  assert.match(out, /duplicate_id/);
});

test('preflight_data_check: reports missing reference data', { skip: SKIP && skipNote }, async () => {
  // The real CSKILLBP_DIR for tests is the dev checkout, which intentionally
  // has little data — preflight should FAIL loudly, never throw.
  const out = await tools.preflightDataCheck({ book: 'NAM', stage: 'ult' });
  assert.match(out, /^(OK|FAIL):/);
  assert.match(out, /issues_resolved|hebrew_bible/);
});

test('run_regression_checks: catches a reintroduced closed bug', { skip: SKIP && skipNote }, async () => {
  const bad = tmpFile('isa51.usfm', '\\id ISA\n\\c 51\n\\v 7 Listen to me. Do not fear the reproach of man.\n');
  let out = await tools.runRegressionChecks({ stage: 'ULT', file: bad, book: 'ISA', chapter: 51 });
  assert.match(out, /^FAIL:/);
  assert.match(out, /#24/);

  const good = tmpFile('isa51-good.usfm', '\\id ISA\n\\c 51\n\\v 7 Listen to me. May you not fear the reproach of man, and may you not be dismayed.\n');
  out = await tools.runRegressionChecks({ stage: 'ULT', file: good, book: 'ISA', chapter: 51 });
  assert.match(out, /^OK:/, out);
});

test('validators missing from clone produce a clear error', { skip: SKIP && skipNote }, async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'noskills-'));
  const old = process.env.CSKILLBP_DIR;
  process.env.CSKILLBP_DIR = empty;
  delete require.cache[require.resolve('../src/workspace-tools/validation-tools')];
  const fresh = require('../src/workspace-tools/validation-tools');
  try {
    await assert.rejects(
      () => fresh.preflightDataCheck({ book: 'NAM' }),
      /Validator not found.*refresh the skills repo|missing the validation scripts/i,
    );
  } finally {
    process.env.CSKILLBP_DIR = old;
    delete require.cache[require.resolve('../src/workspace-tools/validation-tools')];
  }
});
