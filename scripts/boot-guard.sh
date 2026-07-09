#!/usr/bin/env bash
# Crash-loop backoff + circuit breaker. Targets failure mode B: an in-container
# crash-loop under Fly's `restart.policy = "always"`.
#
# entrypoint.sh is the container CMD, so Fly re-runs it on every process restart.
# If `node src/index.js` exits fast and repeatedly (bad deploy, missing secret,
# poisoned checkpoint) the "always" restart policy re-launches it with no delay —
# a tight crash-loop that pins CPU, floods logs, and, because every restart is a
# fresh container boot, can pile machine-level churn onto the Fly API.
#
# This guard records boot timestamps in the persistent /data volume. When it sees
# too many boots inside a short window it SLEEPS before launching the app (a real
# delay between restarts). Past a hard threshold it stops launching the app at all
# and holds the machine idle-but-up (`sleep infinity`) so a human can intervene —
# the closest thing to "exit-and-stay-down" available when Fly restarts anything
# that exits. Holding the machine "started" also denies Fly's proxy the stopped
# machine it would otherwise auto-start-storm (see .github/workflows/
# storm-watchdog.yml for the complementary mode-A guard).
#
# Fail-open: nothing here may block a normal boot. The script deliberately does
# NOT use `set -e`, guards every step, and entrypoint.sh invokes it without exec
# so the optional backoff sleep (and the circuit-break hold) apply before the app
# is launched. A single, non-rapid boot adds zero delay.

STATE_DIR="${BP_BOOT_STATE_DIR:-/data}"
HISTORY_FILE="${STATE_DIR}/boot-history"

# Tunables (env-overridable so a crash-loop can be simulated in a test container).
WINDOW="${BP_BOOT_WINDOW_SECS:-600}"   # look-back window for "rapid" boots (s)
SOFT="${BP_BOOT_SOFT_LIMIT:-3}"        # boots/window before we start delaying
HARD="${BP_BOOT_HARD_LIMIT:-8}"        # boots/window before we circuit-break
BASE="${BP_BOOT_BACKOFF_BASE:-5}"      # base backoff (s): 5, 10, 20, 40, ...
CAP="${BP_BOOT_BACKOFF_CAP:-300}"      # max backoff (s)

now="$(date +%s 2>/dev/null)" || now=0
if [ "$now" = 0 ]; then
  echo "[boot-guard] could not read clock; skipping crash-loop guard"
  exit 0
fi

mkdir -p "$STATE_DIR" 2>/dev/null

# Record this boot, then keep only timestamps inside the look-back window so the
# history file cannot grow without bound.
echo "$now" >> "$HISTORY_FILE" 2>/dev/null
recent="$(awk -v now="$now" -v w="$WINDOW" \
  '($0 ~ /^[0-9]+$/) && (now - $0) <= w { print }' "$HISTORY_FILE" 2>/dev/null)"
printf '%s\n' "$recent" > "$HISTORY_FILE" 2>/dev/null

count="$(printf '%s\n' "$recent" | grep -c '^[0-9]' 2>/dev/null)"
[ -z "$count" ] && count=1
echo "[boot-guard] boot #${count} within the last ${WINDOW}s"

# Circuit break: too many boots too fast. Hold the machine up but idle instead of
# launching the app (which would just crash and restart again). NOTE: a plain
# restart does NOT clear this — the boot timestamps live in $HISTORY_FILE on the
# persistent /data volume and survive reboots, so a restart inside $WINDOW just
# re-trips the break. Recovery = fix the cause, then delete $HISTORY_FILE (or wait
# for the timestamps to age past $WINDOW), then restart.
if [ "$count" -ge "$HARD" ]; then
  echo "[boot-guard] CIRCUIT BREAK: ${count} boots in ${WINDOW}s (>= ${HARD}). Not launching the app."
  echo "[boot-guard] Holding the machine idle (boot history persists on /data across reboots)."
  echo "[boot-guard] To recover: fix the crash cause, then 'rm ${HISTORY_FILE}' (or wait ${WINDOW}s for it to age out), then restart the machine."
  exec sleep infinity
fi

# Backoff: past the soft limit, delay proportionally (capped) so restarts are
# spaced out rather than tight-looping. Below the soft limit this returns
# immediately (the normal single-boot fast path adds no delay).
if [ "$count" -gt "$SOFT" ]; then
  over=$(( count - SOFT ))
  delay=$(( BASE * (1 << (over - 1)) ))
  [ "$delay" -gt "$CAP" ] && delay="$CAP"
  echo "[boot-guard] crash-loop suspected; backing off ${delay}s before launch"
  sleep "$delay"
fi

exit 0
