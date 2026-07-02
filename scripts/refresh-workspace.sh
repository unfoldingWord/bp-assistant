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
# Strategy: capture the runtime decision-CSV delta, hard-reset to origin/main,
# reapply the delta, then commit/push it back. reset (not `merge --ff-only`) is
# deliberate: it SELF-HEALS a diverged HEAD. The prior ff-only version froze the
# checkout whenever the decision-CSV commit below was pushed and rejected as
# non-fast-forward (origin/main had moved on via a merged PR): the local commit
# stranded HEAD off origin/main, so every later ff-only merge failed silently and
# no skill change deployed (observed: HEAD stuck at 76c7c7d, 8 commits stale).
# reset --hard reconciles regardless of divergence; a rejected push now just
# re-heals on the next deploy instead of wedging.
# Defensive throughout; ALWAYS exits 0 so a refresh hiccup never fails the deploy.
set +e
WS="${CSKILLBP_DIR:-/data/workspace}"

# Tolerate ownership drift (e.g. a root-owned .git from an earlier clone).
git config --global --add safe.directory "$WS" 2>/dev/null

cd "$WS" || { echo "[refresh-workspace] $WS missing; skip"; exit 0; }

git fetch origin main 2>&1 || { echo "[refresh-workspace] fetch failed; skip"; exit 0; }

# Capture the runtime decision-CSV delta versus origin/main BEFORE reconciling.
# Diffing against origin/main (not HEAD) captures appends whether they are only
# in the working tree OR already committed by a prior deploy whose push was
# rejected — the exact rows that would otherwise be lost by the hard reset below.
# The quoted pathspec keeps git (not the shell) expanding the glob, and scopes
# the capture to just the decision CSVs. Only these tracked files are mutated at
# runtime, so nothing else needs preserving across the reset.
CSV_PATCH="$(mktemp 2>/dev/null || echo /tmp/refresh-csv-delta.patch)"
git diff origin/main -- 'data/quick-ref/*_decisions.csv' > "$CSV_PATCH" 2>/dev/null

# Reconcile the skills checkout to origin/main unconditionally — fast-forward OR
# diverged self-heal. Safe: tracked skill files are upstream-owned, and untracked
# runtime dirs (output/, tmp/, door43-repos/) are not touched by reset --hard.
git reset --hard origin/main 2>&1 || echo "[refresh-workspace] reset to origin/main failed"

# Reapply the captured decision-CSV appends on top of the fresh origin/main.
# --3way first so an upstream reseed of the same CSVs merges rather than rejects;
# plain apply as a fallback. On failure the appends stay in $CSV_PATCH (not lost).
if [ -s "$CSV_PATCH" ]; then
  git apply --3way "$CSV_PATCH" 2>/dev/null \
    || git apply "$CSV_PATCH" 2>/dev/null \
    || echo "[refresh-workspace] could not re-apply decision-CSV delta (kept at $CSV_PATCH)"
fi

# Commit runtime decision-CSV appends back to origin/main so accumulated
# decisions survive beyond this one machine instead of only ever living in a
# local stash (see issue #167 — this is the loop-closer for PR #163's
# stash/pop mitigation, which kept appends from blocking deploys but never
# shared them back to git). Scoped to just these files so nothing else that
# might be sitting in the tree gets swept into the commit.
if [ -n "$(git status --porcelain -- 'data/quick-ref/*_decisions.csv')" ]; then
  git add -- 'data/quick-ref/*_decisions.csv'
  git -c user.name='BW Bot' -c user.email='bot@unfoldingword.org' \
      commit -m 'data(quick-ref): sync runtime decision CSVs from live bot' 2>&1 \
    || echo "[refresh-workspace] decision-CSV commit failed; leaving changes uncommitted"
fi

# Push whenever local main is ahead of origin/main — covers both a fresh
# commit just above AND a commit stranded here by a push failure on a prior
# deploy (once committed, the working tree is clean, so the block above alone
# would never retry it; this makes retry unconditional on being ahead).
AHEAD="$(git rev-list --count origin/main..HEAD 2>/dev/null || echo 0)"
if [ "$AHEAD" != "0" ]; then
  git push origin HEAD:main 2>&1 || echo "[refresh-workspace] push failed; local commit self-heals next deploy (reset --hard re-captures the delta)"
fi

rm -f "$CSV_PATCH" 2>/dev/null

# Keep the tree writable by the app user in case this ran as root.
chown -R botuser:botuser "$WS/.claude" "$WS/data" "$WS/.git" 2>/dev/null || true

echo "[refresh-workspace] now at $(git log -1 --format=%h 2>/dev/null)"
exit 0
