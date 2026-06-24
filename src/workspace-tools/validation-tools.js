// workspace-tools/validation-tools.js — validation gates backed by bp-assistant-skills
//
// Unlike other workspace tools, these do NOT port logic into the bot. They
// dynamically import the validator modules from the skills clone
// (CSKILLBP_DIR/.claude/skills/utilities/scripts/validation/), so the checks
// stay single-source: updating bp-assistant-skills updates the gates without
// a bot redeploy. Imports are cache-busted on file mtime, so a refreshed
// clone takes effect without restarting the bot process. (Sibling modules
// imported relatively by a validator are cached per their own URL; they
// change together with the entry module in practice.)
//
// Every function returns a text report whose first line starts with "OK:" or
// "FAIL:" so both agents and pipeline code can branch on it. Pipeline code
// can also call these functions directly (not via MCP) for enforced gates.

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const CSKILLBP_DIR = process.env.CSKILLBP_DIR || '/srv/bot/workspace';
const VALIDATION_DIR = path.join(CSKILLBP_DIR, '.claude/skills/utilities/scripts/validation');
const REGRESSION_CHECKS = path.join(CSKILLBP_DIR, '.claude/skills/utilities/regression/regression-checks.json');

function resolveWs(p) {
  return path.isAbsolute(p) ? p : path.resolve(CSKILLBP_DIR, p);
}

async function importValidator(fileName) {
  const p = path.join(VALIDATION_DIR, fileName);
  if (!fs.existsSync(p)) {
    throw new Error(
      `Validator not found: ${p} — the bp-assistant-skills clone is missing the validation scripts. ` +
      'Pull/refresh the skills repo (they shipped with the quality-gates work).');
  }
  const mtime = fs.statSync(p).mtimeMs;
  return import(pathToFileURL(p).href + '?v=' + mtime);
}

function formatProblems(label, problems, okMessage) {
  if (problems.length === 0) return `OK: ${okMessage}`;
  const lines = problems.map((p) => {
    const loc = p.ref ? ` ${p.ref}` : (p.chapter ? ` ${p.chapter}${p.verse ? ':' + p.verse : ''}` : '');
    return `${(p.level || 'error').toUpperCase()}${loc} [${p.code}] ${p.message}`;
  });
  return `FAIL: ${problems.length} problem(s) in ${label}\n${lines.join('\n')}`;
}

/**
 * Structural gate for generated USFM: verse completeness (against the Hebrew
 * source when given), duplicate/out-of-order verses, marker balance, empty
 * verses, balanced supplied-word braces, debug artifacts.
 */
async function validateUsfmStructure({ usfm, source, chapter }) {
  const mod = await importValidator('validate_usfm_structure.mjs');
  const text = fs.readFileSync(resolveWs(usfm), 'utf8');
  const sourceText = source ? fs.readFileSync(resolveWs(source), 'utf8') : null;
  const problems = mod.validateStructure(text, { sourceText, chapter: chapter ?? null });
  return formatProblems(usfm, problems, `${usfm} passed structure validation`);
}

/**
 * Field-level gate for aligned USFM: byte-exact x-content/x-lemma vs the
 * Hebrew source (flags visually-identical Unicode byte drift separately),
 * occurrence numbering consistency, and (ULT mode) full Hebrew coverage.
 */
async function validateAlignmentIntegrityGate({ aligned, hebrew, chapter, ust }) {
  const mod = await importValidator('validate_alignment_integrity.mjs');
  const alignedText = fs.readFileSync(resolveWs(aligned), 'utf8');
  const hebrewText = fs.readFileSync(resolveWs(hebrew), 'utf8');
  const problems = mod.validateAlignmentIntegrity(alignedText, hebrewText, {
    chapter: chapter ?? null,
    ustMode: !!ust,
  });
  return formatProblems(aligned, problems, `${aligned} passed alignment integrity validation`);
}

/**
 * ID gate for TN/TQ TSVs: format ([a-z][a-z0-9]{3}), uniqueness within and
 * across the given files, and optional collision check against a published
 * book TSV. Duplicate IDs break downstream merge/delete operations.
 */
async function checkDuplicateIdsGate({ files, against }) {
  const mod = await importValidator('check_duplicate_ids.mjs');
  const loaded = files.map((f) => ({ label: f, text: fs.readFileSync(resolveWs(f), 'utf8') }));
  const loadedAgainst = (against || []).map((f) => ({ label: f, text: fs.readFileSync(resolveWs(f), 'utf8') }));
  const problems = mod.checkDuplicateIds(loaded, loadedAgainst);
  return formatProblems(files.join(', '), problems, `no duplicate or malformed IDs across ${files.length} file(s)`);
}

/**
 * Loud preflight for reference data: issues_resolved, glossaries, Hebrew
 * source, T4T, Strong's index. Run before generation so a failed fetch stops
 * the run instead of silently degrading output quality.
 */
async function preflightDataCheck({ book, stage }) {
  const mod = await importValidator('preflight_data_check.mjs');
  const { results, ok } = mod.preflightCheck({ book, stage: stage || 'all', root: CSKILLBP_DIR });
  const width = Math.max(...results.map((r) => r.path.length));
  const table = results.map((r) => `${r.status.padEnd(8)} ${r.path.padEnd(width)}  ${r.note}`).join('\n');
  if (ok) return `OK: required reference data for ${book} (${stage || 'all'}) is present.\n${table}`;
  const missing = results.filter((r) => r.status === 'MISSING').length;
  return `FAIL: ${missing} required data source(s) missing for ${book} (${stage || 'all'}).\n${table}\n` +
    'Fetch them before generating (fetch_* tools / curate-published-data.mjs). ' +
    'Generating without them will silently diverge from content-team decisions.';
}

/**
 * Re-test every closed quality bug that could be mechanized against a
 * generated file. A FAIL means a previously fixed mistake has returned.
 * Checks live in the skills repo: .claude/skills/utilities/regression/regression-checks.json
 */
async function runRegressionChecks({ stage, file, book, chapter }) {
  const mod = await importValidator('run_regression_checks.mjs');
  if (!fs.existsSync(REGRESSION_CHECKS)) {
    throw new Error(`Regression checks file not found: ${REGRESSION_CHECKS} — refresh the bp-assistant-skills clone.`);
  }
  const checksData = JSON.parse(fs.readFileSync(REGRESSION_CHECKS, 'utf8'));
  const text = fs.readFileSync(resolveWs(file), 'utf8');
  const results = mod.runChecks({
    stage, text,
    book: book ? book.toUpperCase() : null,
    chapter: chapter ?? null,
    checksData,
  });
  const failed = results.filter((r) => r.status === 'fail');
  const advisory = results.filter((r) => r.status === 'advisory');
  const passed = results.filter((r) => r.status === 'pass');
  const lines = [];
  for (const r of failed) lines.push(`FAIL [#${r.issue}] ${r.explain}${r.detail ? ` — ${r.detail}` : ''}`);
  for (const r of advisory) lines.push(`ADVISORY [#${r.issue}] ${r.detail}`);
  if (failed.length === 0) {
    return `OK: ${passed.length} regression check(s) passed (${advisory.length} advisory, ${results.filter((r) => r.status === 'skip').length} skipped) for ${file}${lines.length ? '\n' + lines.join('\n') : ''}`;
  }
  return `FAIL: ${failed.length} regression check(s) failed for ${file} — a previously fixed mistake has returned\n${lines.join('\n')}`;
}

module.exports = {
  validateUsfmStructure,
  validateAlignmentIntegrityGate,
  checkDuplicateIdsGate,
  preflightDataCheck,
  runRegressionChecks,
};
