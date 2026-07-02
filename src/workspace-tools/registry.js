// workspace-tools/registry.js — single source of truth for tool name -> handler
//
// Consumed by BOTH surfaces that expose workspace tools:
//   - the in-process SDK MCP server (index.js) — kept registered as a fallback
//   - the Bash CLI wrapper (src/workspace-tools-cli.js) — the primary path for
//     pipeline agents since Bash was re-enabled (the distroless container the
//     MCP-only design targeted never shipped)
//
// Every entry maps the snake_case tool name (as agents know it, i.e. the
// mcp__workspace-tools__<name> suffix) to the same exported handler function
// the MCP server calls. Handlers take a single args object and return a string
// (or an object, which callers JSON-stringify) — sync or async.
//
// `cli: false` marks tools deliberately NOT exposed via the CLI:
//   - gitea_pr: secret-bearing side effect (Gitea token via ../secrets);
//     orchestrator-only, and the push flow already has door43-push-cli.js.
//   - fetch_issues_resolved: chains an LLM optimizer (spends API tokens) —
//     must not be invocable from arbitrary Bash loops.
// (read_prepared_notes IS CLI-exposed: it slices prepared_notes.json by item
//  index — the Read tool can only slice by line, so tn-writer needs this.)
//
// A parity test (test/workspace-tools-cli.test.js) asserts every tool name
// registered in index.js exists here, so the two surfaces cannot drift.

const {
  fetchHebrewBible, fetchUlt, fetchUst, fetchMasterUlt, fetchMasterUst, fetchT4t, fetchDoor43,
  fetchGlossary, fetchIssuesResolved, fetchTemplates,
} = require('./fetch-tools');
const { splitTsv, mergeTsvs, fixTrailingNewlines } = require('./tsv-tools');
const {
  extractUltEnglish, filterPsalms, curlyQuotes, checkUstPassives, createAlignedUsfm,
  repairAlignmentXContent, readUsfmChapter, mergeAlignedUsfm, validateAlignmentJson,
  validateUltBrackets, checkUltVoiceMismatch,
} = require('./usfm-tools');
const { buildStrongsIndex, buildTnIndex, buildUstIndex } = require('./index-tools');
const { checkTwHeadwords, compareUltUst, detectAbstractNouns } = require('./issue-tools');
const {
  extractAlignmentData, fixHebrewQuotes, flagNarrowQuotes, generateIds, resolveGlQuotes,
  verifyAtFit, assembleNotes, updateNoteText, updatePreparedQuote, removeNote, prepareNotes,
  prepareAndValidate, fixUnicodeQuotes, verifyBoldMatches, fillTsvIds, fillOrigQuotes,
  prepareATContext, readPreparedNotes,
} = require('./tn-tools');
const { validateTnTsv, checkTnQuality } = require('./quality-tools');
const { giteaPr, prepareCompare, prepareTq, verifyTq, appendQuickref } = require('./misc-tools');
const {
  validateUsfmStructure, validateAlignmentIntegrityGate, checkDuplicateIdsGate,
  preflightDataCheck, runRegressionChecks,
} = require('./validation-tools');

const TOOLS = {
  // --- Fetch tools ---
  fetch_hebrew_bible: { handler: fetchHebrewBible },
  fetch_ult: { handler: fetchUlt },
  fetch_ust: { handler: fetchUst },
  fetch_master_ult: { handler: fetchMasterUlt },
  fetch_master_ust: { handler: fetchMasterUst },
  fetch_t4t: { handler: fetchT4t },
  fetch_door43: { handler: fetchDoor43 },
  fetch_glossary: { handler: fetchGlossary },
  fetch_issues_resolved: { handler: fetchIssuesResolved, cli: false },
  fetch_templates: { handler: fetchTemplates },

  // --- TSV tools ---
  split_tsv: { handler: splitTsv },
  merge_tsvs: { handler: mergeTsvs },
  fix_trailing_newlines: { handler: fixTrailingNewlines },

  // --- USFM tools ---
  extract_ult_english: { handler: extractUltEnglish },
  filter_psalms: { handler: filterPsalms },
  curly_quotes: { handler: curlyQuotes },
  check_ust_passives: { handler: checkUstPassives },
  create_aligned_usfm: { handler: createAlignedUsfm },
  repair_alignment_x_content: { handler: repairAlignmentXContent },
  read_usfm_chapter: { handler: readUsfmChapter },
  merge_aligned_usfm: { handler: mergeAlignedUsfm },
  validate_alignment_json: { handler: validateAlignmentJson },
  validate_ult_brackets: { handler: validateUltBrackets },
  check_ult_voice_mismatch: { handler: checkUltVoiceMismatch },

  // --- Index builders ---
  build_strongs_index: { handler: buildStrongsIndex },
  build_tn_index: { handler: buildTnIndex },
  build_ust_index: { handler: buildUstIndex },

  // --- Issue identification ---
  check_tw_headwords: { handler: checkTwHeadwords },
  compare_ult_ust: { handler: compareUltUst },
  detect_abstract_nouns: { handler: detectAbstractNouns },

  // --- TN writer pipeline ---
  extract_alignment_data: { handler: extractAlignmentData },
  fix_hebrew_quotes: { handler: fixHebrewQuotes },
  flag_narrow_quotes: { handler: flagNarrowQuotes },
  generate_ids: { handler: generateIds },
  resolve_gl_quotes: { handler: resolveGlQuotes },
  verify_at_fit: { handler: verifyAtFit },
  assemble_notes: { handler: assembleNotes },
  fill_tsv_ids: { handler: fillTsvIds },
  fill_orig_quotes: { handler: fillOrigQuotes },
  prepare_notes: { handler: prepareNotes },
  prepare_and_validate: { handler: prepareAndValidate },
  fix_unicode_quotes: { handler: fixUnicodeQuotes },
  verify_bold_matches: { handler: verifyBoldMatches },
  prepare_at_context: { handler: prepareATContext },
  read_prepared_notes: { handler: readPreparedNotes },

  // --- Structured note edits (quality server) ---
  update_note_text: { handler: updateNoteText },
  update_prepared_quote: { handler: updatePreparedQuote },
  remove_note: { handler: removeNote },

  // --- Quality checks ---
  validate_tn_tsv: { handler: validateTnTsv },
  check_tn_quality: { handler: checkTnQuality },

  // --- Misc tools ---
  gitea_pr: { handler: giteaPr, cli: false },
  prepare_compare: { handler: prepareCompare },
  prepare_tq: { handler: prepareTq },
  verify_tq: { handler: verifyTq },
  append_quickref: { handler: appendQuickref },

  // --- Validation gates (logic lives in the skills repo; see validation-tools.js) ---
  validate_usfm_structure: { handler: validateUsfmStructure },
  validate_alignment_integrity: { handler: validateAlignmentIntegrityGate },
  check_duplicate_ids: { handler: checkDuplicateIdsGate },
  preflight_data_check: { handler: preflightDataCheck },
  run_regression_checks: { handler: runRegressionChecks },
};

/** Tool names exposed via the CLI wrapper (everything not marked cli:false). */
function cliToolNames() {
  return Object.keys(TOOLS).filter((name) => TOOLS[name].cli !== false);
}

module.exports = { TOOLS, cliToolNames };
