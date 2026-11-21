#!/usr/bin/env bash
# Runs the demo shops used by docs/test-guide.md.
#
#   scripts/demo-servers.sh seed     # first time: fresh demo DB, seed-demo.py, seed-history.ts, seed-catalogue.py
#   scripts/demo-servers.sh start    # start what isn't running
#   scripts/demo-servers.sh stop
#   scripts/demo-servers.sh status
#
# Main shop:   API + shop on :3000 (.env.demo, data in demo-data/), backoffice on :4200
# Empty shop:  API + shop on :3001 (data in demo-data/restore/), backoffice on :4201 (for the backup-restore test)
#
# The backoffice needs Node >= 22.22.3 (or 24); set NODE_FOR_NG=/path/to/bin to put a newer node first in PATH.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
LOGS="$ROOT/demo-data/logs"
mkdir -p "$LOGS" demo-data/import-media demo-data/restore
[ -f .env.demo ] || { echo "Copy .env.demo.example to .env.demo and fill it in first."; exit 1; }

running() { [ -f "$LOGS/$1.pid" ] && kill -0 "$(cat "$LOGS/$1.pid")" 2>/dev/null; }
wait_http() { for _ in $(seq 1 90); do curl -sf "$1" >/dev/null && return 0; sleep 1; done; echo "timeout waiting for $1"; return 1; }

api() { # name port db uploads
  running "$1" && return 0
  ( set -a; . ./.env.demo; set +a
    export PORT="$2" DB_PATH="$3" UPLOAD_DIR="$4"
    [ "$1" = api-restore ] && unset IMPORT_MEDIA_DIR
    setsid nohup node apps/api/src/main.ts >"$LOGS/$1.log" 2>&1 & echo $! >"$LOGS/$1.pid" )
  wait_http "http://localhost:$2/health"
}

backoffice() { # port api-port
  running "bo-$1" && return 0
  local proxy="$ROOT/demo-data/proxy-$2.json"
  python3 - "$ROOT/apps/backoffice/proxy.conf.json" "$proxy" "$2" <<'PY'
import json, sys
conf = json.load(open(sys.argv[1]))
for v in conf.values(): v["target"] = f"http://localhost:{sys.argv[3]}"
json.dump(conf, open(sys.argv[2], "w"), indent=2)
PY
  ( cd apps/backoffice
    unset PORT   # ng serve would take PORT over --port
    [ -n "${NODE_FOR_NG:-}" ] && export PATH="$NODE_FOR_NG:$PATH"
    setsid nohup npx ng serve --port "$1" --proxy-config "$proxy" >"$LOGS/bo-$1.log" 2>&1 & echo $! >"$LOGS/bo-$1.pid" )
  wait_http "http://localhost:$1/"
}

# each server runs in its own process group (setsid), so npx and the ng process it starts stop together
stop_one() { if running "$1"; then kill -- "-$(cat "$LOGS/$1.pid")" 2>/dev/null || kill "$(cat "$LOGS/$1.pid")" 2>/dev/null || true; sleep 1; fi; rm -f "$LOGS/$1.pid"; }

status() {
  for n in api api-restore bo-4200 bo-4201; do printf '%-12s %s\n' "$n" "$(running "$n" && echo "running (pid $(cat "$LOGS/$n.pid"))" || echo stopped)"; done
  echo "Shop http://localhost:3000  Backoffice http://localhost:4200  |  Empty shop http://localhost:3001  Backoffice http://localhost:4201"
}

start() {
  api api 3000 ./demo-data/db.sqlite ./demo-data/uploads
  api api-restore 3001 ./demo-data/restore/db.sqlite ./demo-data/restore/uploads
  backoffice 4200 3000
  backoffice 4201 3001
  status
}

case "${1:-status}" in
  seed)
    for n in api api-restore bo-4200 bo-4201; do stop_one "$n"; done
    rm -rf demo-data/db.sqlite* demo-data/uploads demo-data/restore
    mkdir -p demo-data/restore
    api api 3000 ./demo-data/db.sqlite ./demo-data/uploads
    python3 scripts/seed-demo.py
    stop_one api; sleep 1
    DB_PATH=./demo-data/db.sqlite node scripts/seed-history.ts
    api api 3000 ./demo-data/db.sqlite ./demo-data/uploads
    python3 scripts/seed-catalogue.py
    start ;;
  start) start ;;
  stop) for n in api api-restore bo-4200 bo-4201; do stop_one "$n"; done; echo stopped ;;
  status) status ;;
  *) echo "usage: $0 seed|start|stop|status"; exit 1 ;;
esac
