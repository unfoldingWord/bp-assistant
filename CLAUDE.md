# Zulip Bot App

## Safety
- **Before rebuilding/restarting the bot**, always run `docker logs zulip-bot --tail 30` and check for active running pipelines. Look for `[notes] Running` or `[generate] Processing` or `[claude-runner] Starting` lines without a corresponding completion. A restart will kill any in-progress pipeline.
- Rebuild command: `cd /srv/bot/app && docker compose down && docker compose build && docker compose up -d`

## Branch Awareness
At the start of a session, run `git branch` to check the current branch. If not on `main`, flag it to the user before making changes — they may have been left on a feature branch from a previous session.

## Git Discipline
- After making code changes, always suggest a commit to the user. Don't commit automatically — ask first.
- Use descriptive commit messages summarizing what changed and why.
