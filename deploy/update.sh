#!/usr/bin/env bash
#
# Update the bell console in place: fetch, install, build, restart, verify.
#
#     sudo /opt/bell-console/deploy/update.sh
#     sudo /opt/bell-console/deploy/update.sh --rollback     # undo the last one
#
# Deliberately does NOT take a Proxmox snapshot. Rolling a VM snapshot back
# reverts the database with it — every schedule change, activity record and
# recording since the snapshot. For an app update the correct rollback is the
# previous commit, which leaves the data alone. This script remembers that
# commit and prints the command; --rollback runs it for you.

set -euo pipefail

REPO=/opt/bell-console
APP="$REPO/console"
SVC_USER=bell
PORT=3000
LAST_GOOD="$REPO/.last-good-commit"

as_svc() { sudo -u "$SVC_USER" -H "$@"; }
say()    { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
fail()   { printf '\n\033[31mFAILED: %s\033[0m\n' "$*" >&2; }

[ "$(id -u)" -eq 0 ] || { fail "run me with sudo"; exit 1; }

# ---------------------------------------------------------------- verify ----
# Three checks, because each catches something the others miss: systemd only
# knows the process is alive, HTTP only knows the web half is serving, and the
# heartbeat is the only one that proves the scheduler — the part that actually
# rings bells — is running rather than merely started.
verify() {
  local ok=0

  say "Verifying"

  for unit in bell-worker bell-web; do
    if systemctl is-active --quiet "$unit"; then
      echo "  ok    $unit active"
    else
      echo "  FAIL  $unit is $(systemctl is-active "$unit")"; ok=1
    fi
  done

  local code=""
  for _ in $(seq 1 15); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
             "http://localhost:$PORT/login" || true)
    [ "$code" = "200" ] && break
    sleep 2
  done
  if [ "$code" = "200" ]; then
    echo "  ok    web serving (/login 200)"
  else
    echo "  FAIL  web returned '${code:-no response}'"; ok=1
  fi

  local age
  age=$(cd "$APP" && as_svc node -e '
    const D = require("better-sqlite3");
    const row = new D("data/bell.db", { readonly: true })
      .prepare("select worker_heartbeat_at from system_state where id=1").get();
    console.log(row ? Date.now() - row.worker_heartbeat_at : "null");
  ' 2>/dev/null || echo null)

  if [ "$age" != "null" ] && [ "$age" -lt 30000 ] 2>/dev/null; then
    echo "  ok    scheduler heartbeat ${age}ms old"
  else
    echo "  FAIL  scheduler heartbeat is '${age}' (stale or missing)"; ok=1
  fi

  return $ok
}

# -------------------------------------------------------------- rollback ----
if [ "${1:-}" = "--rollback" ]; then
  [ -f "$LAST_GOOD" ] || { fail "no $LAST_GOOD — nothing recorded to roll back to"; exit 1; }
  TARGET=$(cat "$LAST_GOOD")
  say "Rolling back to $TARGET"
  cd "$REPO" && as_svc git reset --hard "$TARGET"
  cd "$APP"  && as_svc npm ci && as_svc npm run build
  systemctl restart bell-worker bell-web
  verify && { say "Rolled back to $TARGET"; exit 0; } || { fail "rollback did not verify — look at journalctl -u bell-worker -u bell-web"; exit 1; }
fi

# ---------------------------------------------------------------- update ----
cd "$REPO"
BEFORE=$(as_svc git rev-parse HEAD)

say "Fetching"
# reset rather than pull: the clone is shallow, and a deploy target should
# never stop to ask about a merge conflict from a stray local edit.
as_svc git fetch --depth 1 origin main
as_svc git reset --hard origin/main
AFTER=$(as_svc git rev-parse HEAD)

if [ "$BEFORE" = "$AFTER" ]; then
  say "Already up to date at ${AFTER:0:8} — nothing to do"
  exit 0
fi

echo "$BEFORE" > "$LAST_GOOD"
echo "  ${BEFORE:0:8} -> ${AFTER:0:8}"
as_svc git --no-pager log --oneline "$BEFORE..$AFTER" | sed 's/^/  /'

say "Installing dependencies"
cd "$APP" && as_svc npm ci

# Stop the web process but leave the worker running: the build takes a couple
# of minutes, and bells should keep ringing through it. If the build fails,
# staff lose the UI but the school still gets its bells — the same priority the
# app itself applies everywhere else.
say "Building"
systemctl stop bell-web
if ! as_svc npm run build; then
  fail "build failed — bell-web is stopped, the worker is still ringing bells"
  echo "Roll back with:  sudo $0 --rollback"
  exit 1
fi

say "Restarting"
systemctl restart bell-worker
systemctl start bell-web

if verify; then
  say "Updated to ${AFTER:0:8}"
  echo "Ring a real bell before you call this done — a clean build can still"
  echo "have lost the speaker, and the scheduler fails silently until it doesn't."
else
  fail "update did not verify"
  echo "Roll back with:  sudo $0 --rollback"
  echo "Logs:            journalctl -u bell-worker -u bell-web -n 50"
  exit 1
fi
