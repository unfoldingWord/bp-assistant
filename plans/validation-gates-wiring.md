# Wiring Validation Gates into the Pipelines

Status: planned (MCP wrappers landed; pipeline enforcement not yet wired)
Owner: Benjamin / bp-assistant
Companion work: bp-assistant-skills branch `claude/jolly-payne-b1c14e` (validators,
regression checks, golden benchmark), `src/workspace-tools/validation-tools.js` here.

## Goal

Catch structural and previously-fixed mistakes **inside the pipeline run**, so what
auto-merges to Door43 is already clean. Hard requirement: the pipeline keeps running
**end-to-end with no human intervention**. Humans review after merge in the friendly
UI tools — nobody reads aligned USFM. So a gate has exactly three outcomes:

1. **pass** → continue silently
2. **fail** → feed the validator's output back to the working Claude session to fix,
   then re-validate (bounded retries)
3. **still failing** → abort *that artifact's push*, post the validator report to the
   Zulip thread, and let the rest of the run continue where independent

A gate never waits for a person.

## What exists already

- Five gate functions in `src/workspace-tools/validation-tools.js`. They dynamic-import
  the actual check logic from the skills clone (`CSKILLBP_DIR/.claude/skills/utilities/
  scripts/validation/`), so check updates ship via the skills repo with no bot deploy.
- The same five are registered as MCP tools (`mcp__workspace-tools__validate_usfm_structure`,
  `validate_alignment_integrity`, `check_duplicate_ids`, `preflight_data_check`,
  `run_regression_checks`) in the main toolset, and the last two also in the quality
  subset. Agents can self-check; the skills' SKILL.md files already instruct the
  Bash/MCP variants at the right steps.
- `repairAlignmentXContent` already runs inside every `createAlignedUsfm` call —
  the integrity gate **verifies** what repair claims to have fixed.

The missing piece is *enforcement*: deterministic gate calls in pipeline JS between
steps, so quality does not depend on the agent remembering to self-check.

## Gate placement (implementation anchors)

All calls are plain async functions from `require('./workspace-tools/validation-tools')`
— no MCP round-trip needed in pipeline code. Branch on `result.startsWith('FAIL:')`.

| # | Pipeline point | Gate call | On FAIL |
|---|----------------|-----------|---------|
| 1 | `generate-pipeline.js` before starting the initial skill session (~the step launcher near line 615) | `preflightDataCheck({ book, stage: 'all' })` | Run the relevant `fetch_*` tools programmatically once, re-check; still failing → abort run, Zulip report. No agent involved. |
| 2 | `generate-pipeline.js` after the initial session writes ULT/UST (the early-exit output checks already verify files exist — extend there) | `validateUsfmStructure({ usfm, source: hebrewPath, chapter })` for each of AI-ULT and AI-UST, plus `runRegressionChecks({ stage, file, book, chapter })` | One resume turn into the same session: "validator output below — fix the file and stop". Re-validate. Second failure → abort artifact, Zulip. |
| 3 | `generate-pipeline.js` after each alignment subagent completes (the Sonnet alignment steps near lines 1068/1188) | `validateAlignmentIntegrityGate({ aligned, hebrew, chapter, ust })` + `validateUsfmStructure` on the aligned file | Re-run that alignment step once with the problem list appended to its prompt. Second failure → abort artifact, Zulip. |
| 4 | `notes-pipeline.js` after assembly/post-process, before the door43-push step (the skill chain completes near line 2281; tn-quality-check invocation ~1965 already exists — add the deterministic pair next to it) | `runRegressionChecks({ stage: 'TN', file, book, chapter })` + `checkDuplicateIdsGate({ files: [file] })` | tn-quality-check (Opus) already runs and fixes; feed regression FAILs into that same review pass. Persisting failure → abort push, Zulip. |
| 5 | TQ path (`tqs` pipeline) before insertion | `checkDuplicateIdsGate({ files: chapterFiles, against: [publishedTqTsv] })` + `runRegressionChecks({ stage: 'TQ', ... })` | Deterministic ID fix is safe to automate (regenerate colliding ID, no semantics); regression FAILs → one fix turn, then abort. |
| 6 | `door43-push.js` inside `door43Push()` just before commit (belt-and-suspenders; it already validates TN bracket pairing) | structure gate for USFM types, ID gate for TSV types | Return `{ success: false, details: <validator first lines> }` — callers already surface failures to Zulip. No retry here; this gate should never fire if 1-5 ran. |

## Retry semantics (uniform)

- `MAX_GATE_RETRIES = 1` (one fix attempt per gate; the fix prompt includes the full
  validator output verbatim — it is written to be actionable line-by-line).
- A gate failure after retry marks that artifact `blocked` in the run status, posts
  the report to the Zulip thread (existing `publishAdminStatus` / thread-reply path),
  and the run continues with remaining artifacts. The machine still stops itself —
  never left waiting.
- Escape hatch: env `VALIDATION_GATES=off|log|enforce` (default `log` initially,
  flip to `enforce` after burn-in). `off` exists for emergency unblocking only.

## Rollout

1. **Phase A — log-only (1-2 weeks of real runs).** Wire all six points with
   `VALIDATION_GATES=log`: gates run, results land in the run log and a one-line
   Zulip note when they would have blocked. Measures false-positive rate on real
   books at zero risk to throughput. (TN convention checks were calibrated against
   published NAM/MAL/JOS 1, so expected FP rate is low; the pinned ISA checks skip
   automatically when their verses aren't in the file.)
2. **Phase B — enforce.** Flip to `enforce` once a week of runs shows no false
   blocks, or after fixing any check that misfires (checks live in the skills repo:
   `.claude/skills/utilities/regression/regression-checks.json` — edit + push there,
   no bot deploy).
3. **Phase C — benchmark cadence (optional, later).** Monthly: run the golden-benchmark
   skill on JOS 1 / NAM 1 / MAL 1 and post scorecards to Zulip, so drift is visible
   even when no one changed anything on purpose.

## Test plan

- Unit: `test/validation-tools.test.js` (landed) — gates pass/fail/skip correctly and
  fail loudly when the skills clone is stale.
- Integration: one `--test-fast` style dry run per pipeline with a deliberately broken
  artifact (drop a verse from the ULT; duplicate a TQ ID) confirming log-mode logs and
  enforce-mode blocks + reports without hanging the run.
- Regression: full `npm test` (2 pre-existing failures in `tn-tools.test.js`
  `fillOrigQuotes` are unrelated and predate this work — tracked separately).

## Explicitly out of scope

- **gemini-review**: dormant; no Gemini model meaningfully better than flash is
  available (as of 2026-06), so the second-opinion wave stays parked. The skills'
  `--gemini` flags remain opt-in no-ops in practice. Consider removing the wave
  references in a future cleanup rather than fixing the integration.
- Human approval steps anywhere in the run — deliberately none, per the post-merge
  review workflow in the UI tools.
- Model assignment changes (separate decision; see June 2026 audit: the generate
  session inherits the runner's Opus default via `claude-runner.js:155` — if cost
  matters, set `"model": "sonnet"` on the generate pipeline config since its Opus
  workers are pinned separately).
