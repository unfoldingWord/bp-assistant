# Zulip Bot App

## Runtime

The bot runs as the Fly.io app `uw-bt-bot` (single machine, region `dfw`).
- Live logs: `flyctl logs -a uw-bt-bot` (or `--no-tail` for a snapshot).
- Deploy: push to `main` triggers `.github/workflows/deploy.yml`, which runs
  `flyctl deploy --remote-only --strategy immediate --ha=false`. Manual deploys
  go through `gh workflow run deploy.yml -f confirm=yes`.

## Safety
- **Before redeploying**, check for active pipelines with
  `flyctl logs -a uw-bt-bot --no-tail | tail -50`. Look for `[notes] Running`,
  `[generate] Processing`, or `[claude-runner] Starting` lines without a
  corresponding completion — `--strategy immediate` will kill any in-progress
  pipeline.
- `[claude-runner]` lines that appear between a `[self-diagnosis] Starting`
  and a `[self-diagnosis] Done` boundary belong to the diagnosis sub-agent,
  not a user pipeline — those are safe to interrupt.

## Branch Awareness
At the start of a session, run `git branch` to check the current branch. If not on `main`, flag it to the user before making changes — they may have been left on a feature branch from a previous session.

## Git Discipline
- After making code changes, always suggest a commit to the user. Don't commit automatically — ask first.
- Use descriptive commit messages summarizing what changed and why.

## Known Constraints

### door43-push HTTP handler
- `door43-push.js` uses a **custom HTTP handler** (native `https`) instead of
  isomorphic-git's default `simple-get` module. The default aborts on large
  repos (en_ult, en_ust) under newer Node versions in containers. Do not
  revert to `require('isomorphic-git/http/node')`.
- Originally hardened for the Chainguard container; the constraint persists
  on Fly.io with the current Node version.

### Pipeline checkpoints
- Checkpoint state must be one of: `running`, `failed`, `paused_for_outage`, `paused_for_usage_limit`
- When manually editing checkpoint JSON to set a resume point, use `"state": "failed"` — other values like `"resumable"` are silently ignored

### Alignment batching
- `align-all-parallel` splits chapters > 18 verses into N batches of 18
- Merge step uses `mcp__workspace-tools__merge_aligned_usfm` MCP tool — never Bash or sub-agents (they don't have Bash access in the SDK pipeline)
