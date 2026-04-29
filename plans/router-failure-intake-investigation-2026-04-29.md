# Router Failure Intake Investigation

## Problem
- Router dispatch failures were being logged to stderr only.
- Those failures were not emitted as structured admin-status events.

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
