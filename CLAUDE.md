# Zulip Bot App

## Safety
- **Before rebuilding/restarting the bot**, always run `sudo docker logs zulip-bot --tail 30` and check for active running pipelines. Look for `[notes] Running` or `[generate] Processing` or `[claude-runner] Starting` lines without a corresponding completion. A restart will kill any in-progress pipeline.
- Rebuild command: `cd /srv/bot/app && sudo docker compose down && sudo docker compose build && sudo docker compose up -d`

## Git Discipline
- After making code changes, always suggest a commit to the user. Don't commit automatically — ask first.
- Use descriptive commit messages summarizing what changed and why.
