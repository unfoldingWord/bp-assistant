# Zulip Bot App

## Safety
- **Before rebuilding/restarting the bot**, always run `docker logs zulip-bot --tail 30` and check for active running pipelines. Look for `[notes] Running` or `[generate] Processing` or `[claude-runner] Starting` lines without a corresponding completion. A restart will kill any in-progress pipeline.
- Rebuild command: `cd /srv/bot/app && docker compose down && docker compose build && docker compose up -d`

## Branch Awareness
At the start of a session, run `git branch` to check the current branch. If not on `main`, flag it to the user before making changes — they may have been left on a feature branch from a previous session.

## Git Discipline
- After making code changes, always suggest a commit to the user. Don't commit automatically — ask first.
- Use descriptive commit messages summarizing what changed and why.

## Known Constraints

### Docker container (Chainguard Node.js)
- No bash, no Python, no native git binary — only Node.js
- Node v25 (not v18 like the host) — different HTTP behavior
- `door43-push.js` uses a **custom HTTP handler** (native `https`) instead of isomorphic-git's default `simple-get` module, which aborts on large repos (en_ult, en_ust) under Node v25 in containers. Do not revert to the default `require('isomorphic-git/http/node')`.

### Pipeline checkpoints
- Checkpoint state must be one of: `running`, `failed`, `paused_for_outage`, `paused_for_usage_limit`
- When manually editing checkpoint JSON to set a resume point, use `"state": "failed"` — other values like `"resumable"` are silently ignored

### Alignment batching
- `align-all-parallel` splits chapters > 18 verses into N batches of 18
- Merge step uses `mcp__workspace-tools__merge_aligned_usfm` MCP tool — never Bash or sub-agents (they don't have Bash access in the SDK pipeline)
