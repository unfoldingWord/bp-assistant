#!/usr/bin/env bash
# Deploy release step — refresh the /data/workspace skills checkout to origin/main.
#
# /data/workspace is the bp-assistant-skills clone (CSKILLBP_DIR) that the bot
# reads skills from at pipeline runtime. It is ALSO runtime-mutable:
# data/quick-ref/*_decisions.csv are appended during pipelines. The old release
# command (`git pull --ff-only`) aborted on that dirty tree — and on a root-owned
# .git ("dubious ownership") — so it silently failed via `|| true` and the
# checkout sat 124 commits behind for months (no skill change ever deployed).
#
# Strategy: stash runtime changes, fast-forward to origin/main, reapply them.
# Defensive throughout; ALWAYS exits 0 so a refresh hiccup never fails the deploy.
set +e
WS="${CSKILLBP_DIR:-/data/workspace}"

# Tolerate ownership drift (e.g. a root-owned .git from an earlier clone).
git config --global --add safe.directory "$WS" 2>/dev/null

cd "$WS" || { echo "[refresh-workspace] $WS missing; skip"; exit 0; }

git fetch origin main 2>&1 || { echo "[refresh-workspace] fetch failed; skip"; exit 0; }

# Stash only tracked runtime modifications (e.g. appended decision CSVs); leave
# untracked runtime dirs (output/, tmp/, door43-repos/) alone.
STASHED=0
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  git stash push -m deploy-autostash 2>&1 && STASHED=1
fi

git merge --ff-only origin/main 2>&1 || echo "[refresh-workspace] ff-merge skipped (diverged from origin/main?)"

if [ "$STASHED" = 1 ]; then
  # Reapply runtime changes. On the rare conflict (upstream touched the same CSV
  # region), leave them safely in the stash rather than dropping them.
  git stash pop 2>&1 || echo "[refresh-workspace] stash pop conflict — runtime changes preserved in stash@{0}"
fi

# Commit runtime decision-CSV appends back to origin/main so accumulated
# decisions survive beyond this one machine instead of only ever living in a
# local stash (see issue #167 — this is the loop-closer for PR #163's
# stash/pop mitigation, which kept appends from blocking deploys but never
# shared them back to git). Scoped to just these files so nothing else that
# might be sitting in the tree gets swept into the commit. Best-effort: if the
# push fails (no push credentials configured, or origin advanced meanwhile),
# the commit stays local and is retried on the next deploy.
if [ -n "$(git status --porcelain -- 'data/quick-ref/*_decisions.csv')" ]; then
  git add -- 'data/quick-ref/*_decisions.csv'
  if git -c user.name='BW Bot' -c user.email='bot@unfoldingword.org' \
      commit -m 'data(quick-ref): sync runtime decision CSVs from live bot' 2>&1; then
    git push origin HEAD:main 2>&1 || echo "[refresh-workspace] push failed; decision-CSV commit stays local, will retry next deploy"
  else
    echo "[refresh-workspace] decision-CSV commit failed; leaving changes uncommitted"
  fi
fi

# Keep the tree writable by the app user in case this ran as root.
chown -R botuser:botuser "$WS/.claude" "$WS/data" "$WS/.git" 2>/dev/null || true

echo "[refresh-workspace] now at $(git log -1 --format=%h 2>/dev/null)"
exit 0
