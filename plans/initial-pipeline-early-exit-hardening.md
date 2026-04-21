# Initial Pipeline Early Exit Hardening

## Summary

Fix a failure mode in `initial-pipeline` where the parent Claude run can return success after Wave 2 even though the pipeline never produces the required downstream outputs. The concrete regression was an `ISA 52` generate run on April 20, 2026 that wrote:

- `output/AI-ULT/ISA/ISA-52.usfm`
- `tmp/pipeline-ISA-52/wave2_structure.tsv`
- `tmp/pipeline-ISA-52/wave2_rhetoric.tsv`

but never wrote:

- `tmp/pipeline-ISA-52/wave3_challenges.tsv`
- `tmp/pipeline-ISA-52/merged_issues.tsv`
- `output/issues/ISA/ISA-52.tsv`
- `output/AI-UST/ISA/ISA-52.usfm`

The generate wrapper eventually marked the run failed because expected outputs were missing, but the underlying `initial-pipeline` run itself ended with `subtype: success`. The fix should harden the orchestration contract and the wrapper-side validation so this class of early exit is detected explicitly and cannot be mistaken for a normal successful stage completion.

## Key Changes

### 1. Harden wrapper-side completion validation

Update `app/src/generate-pipeline.js` so `initial-pipeline` success is validated against required final outputs, not only against generic generation success.

For full `initial-pipeline` runs, require:

- `output/AI-ULT/<BOOK>/<BOOK>-<CH>.usfm`
- `output/issues/<BOOK>/<BOOK>-<CH>.tsv`
- `output/AI-UST/<BOOK>/<BOOK>-<CH>.usfm`

Behavior:

- If Claude returns `subtype === "success"` but one or more required outputs are missing, classify the run as orchestration failure, not generic missing output.
- Record a specific error kind such as `initial_pipeline_early_exit` or `orchestration_incomplete`.
- Include the first missing required artifact in admin-facing status text and logs.
- Preserve resumable checkpoint state instead of treating the run as a normal completed chapter.

This hardening applies only when the requested skill is `initial-pipeline`. Direct `ULT-gen`, direct `UST-gen`, `align-only`, and file-only flows should keep their current output expectations.

### 2. Strengthen the `initial-pipeline` invocation contract

Add an invocation-level guardrail for `initial-pipeline` so the parent agent is explicitly instructed that Wave 1 and Wave 2 are intermediate milestones only.

The contract should state that the run is not complete until all of the following have happened:

- Wave 3 challenge completed
- merged issues written to final output
- UST written
- any required cleanup or intentional stop path reached

The wrapper should not rely only on the skill markdown to enforce this. It should append a concise runtime constraint that completion before final artifacts exist is invalid.

### 3. Improve diagnostics for early-exit runs

When a run is classified as orchestration incomplete, log enough context to debug it from app logs without inspecting the Claude task store:

- book/chapter
- requested content types
- discovered artifacts under `tmp/pipeline-<BOOK>-<CH>`
- discovered final outputs
- first missing required output
- final failure classification

Status/admin messages should use the same classification so operators can tell this apart from:

- Claude outage
- auth failure
- Door43 push failure
- stale output detection

### 4. Keep the fix scoped to orchestration hardening

Do not roll Door43 push logic, align logic, or direct single-skill generation changes into this patch. The implementation goal is to make early `initial-pipeline` termination impossible to misclassify and easy to diagnose.

## Test Plan

Add regression tests around `app/src/generate-pipeline.js`.

Core cases:

1. `initial-pipeline` returns success and only ULT exists.
   Expected: chapter fails with `initial_pipeline_early_exit`.

2. `initial-pipeline` returns success and ULT + Wave 2 temp files exist, but no final issues or UST.
   Expected: chapter fails with `initial_pipeline_early_exit`.

3. `initial-pipeline` returns success and ULT + final issues exist, but no UST.
   Expected: chapter fails with `initial_pipeline_early_exit`.

4. `initial-pipeline` returns success and all required outputs exist.
   Expected: chapter succeeds normally.

Non-regression cases:

5. Direct `ULT-gen` success with only ULT output still succeeds.
6. Direct `UST-gen` success with only UST output still succeeds.
7. `align-only` path remains unchanged.
8. Early-exit failure writes checkpoint state that remains resumable and records the missing downstream stage.

Manual verification:

- Re-run a single-chapter `generate` flow using `initial-pipeline`.
- Confirm the run cannot terminate after Wave 2 without being marked orchestration-incomplete.
- Confirm a healthy run produces `AI-ULT`, final `output/issues`, and `AI-UST`.

## Assumptions

- The issue belongs in `unfoldingWord/bp-assistant`.
- The `ISA 52` incident is representative of a class of orchestration failures, not a one-off chapter data problem.
- The correct fix point is the app wrapper plus invocation guardrails, even if the exact prompt-level cause inside the skill remains uncertain.
- No public API change is needed; the behavior change is internal classification and validation hardening.
