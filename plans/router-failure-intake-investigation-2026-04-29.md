# Router Failure Intake Investigation (2026-04-29)

## Incident
- Timestamp: `2026-04-29T15:53:59.737Z`
- Scope: `ZEC 5`
- Log line: `Pipeline "write-notes" failed: ctx is not defined`

## What Happened
- The `write-notes` run completed `tn-quality-check` successfully.
- Before `door43-push`, `notes-pipeline` hit a runtime error from an out-of-scope `ctx` reference near final canonical quote sync.
- The router catch logged the failure, but the failure was not emitted as an admin-status event.

## Why Auto Self-Analyze Missed It
1. Router dispatch failures were only logged to stderr.
   - `router.js` catch did not publish structured failure events via `publishAdminStatus`.
   - The pipeline-failure selector consumes `admin-status.jsonl`, so router-only logs were invisible to it.
2. Pipeline failure handler is mode-gated in Fly automation.
   - Dedicated flow runs only when `PIPELINE_FAILURE_RUN_MODE=failure-handler`.
   - If running in hourly issue mode, failures are not processed by the dedicated failure-handler path.

## Fix Implemented In This Branch
- Added router-level failure publication (`source=router`, `phase=router-dispatch`, `severity=error`).
- Added pipeline type mapping and scope inference for router dispatch failures.
- Added regression test to enforce admin-status event emission when `runPipeline` rejects.
- Added selector test coverage for router-dispatch failures to ensure they are eligible and deduped.
