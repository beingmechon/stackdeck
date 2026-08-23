#!/usr/bin/env bash
# Spin up a self-contained demo board with fictional services — for README
# screenshots, GIFs, and trying Stackdeck without touching your real config.
#
#   ./scripts/demo.sh          → http://localhost:9899 (isolated STACKDECK_HOME)
#   ./scripts/demo.sh stop     → tear it down
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
DEMO="${STACKDECK_DEMO_DIR:-/tmp/stackdeck-demo}"
PORT=9899

if [ "${1:-}" = "stop" ]; then
  pkill -f "STACKDECK_DEMO_MARK" 2>/dev/null || true
  [ -n "$(lsof -tnP -iTCP:$PORT -sTCP:LISTEN 2>/dev/null)" ] && kill "$(lsof -tnP -iTCP:$PORT -sTCP:LISTEN)"
  rm -rf "$DEMO"
  echo "demo stopped and removed"
  exit 0
fi

rm -rf "$DEMO"
mkdir -p "$DEMO/home" "$DEMO/projects"

# ── fictional repos so the Projects section has content ──────────────────
mkrepo() { # name, extra-branch, kind
  local d="$DEMO/projects/$1"
  mkdir -p "$d"
  cd "$d"
  git init -q -b main
  git config user.email demo@example.com && git config user.name demo
  if [ "$3" = node ]; then
    printf '{ "name": "%s", "scripts": { "dev": "node server.js" } }\n' "$1" > package.json
  else
    printf '[project]\nname = "%s"\n' "$1" > pyproject.toml
    touch main.py
  fi
  git add -A && git commit -qm "init"
  [ -n "$2" ] && git branch "$2"
  cd - >/dev/null
}
mkrepo shopfront        feature/checkout-v2   node
mkrepo orders-api       feature/rate-limits   node
mkrepo email-worker     ""                    py
mkrepo ml-recommender   experiment/embeddings py
mkrepo mobile-app       ""                    node

# ── demo services: real processes, fictional purpose ─────────────────────
LOOP='STACKDECK_DEMO_MARK=1; while true; do'
cat > "$DEMO/home/config.json" <<JSON
{
  "port": $PORT,
  "projectRoots": ["$DEMO/projects"],
  "groups": ["Shop", "Pipeline"],
  "categoryOrder": ["Product", "Services", "Experiments"],
  "projectCategories": {
    "shopfront": "Product", "mobile-app": "Product",
    "orders-api": "Services", "email-worker": "Services",
    "ml-recommender": "Experiments"
  },
  "services": [
    { "name": "shopfront", "dir": "$DEMO/projects/shopfront", "group": "Shop", "port": 7411,
      "command": "python3 -m http.server \${PORT:-7411} --bind 127.0.0.1" },
    { "name": "orders-api", "dir": "$DEMO/projects/orders-api", "group": "Shop", "port": 7412,
      "dependsOn": ["session-cache"],
      "command": "python3 -m http.server \${PORT:-7412} --bind 127.0.0.1" },
    { "name": "session-cache", "dir": "$DEMO/projects/orders-api", "group": "Shop",
      "command": "$LOOP echo \"GET session:\$RANDOM → hit (2ms)\"; sleep 3; done" },
    { "name": "email-worker", "dir": "$DEMO/projects/email-worker", "group": "Pipeline", "restart": "on-failure",
      "command": "$LOOP echo \"[worker] sent order confirmation #\$RANDOM\"; sleep 2; done" },
    { "name": "search-indexer", "dir": "$DEMO/projects/ml-recommender", "group": "Pipeline",
      "command": "$LOOP echo \"indexed \$((RANDOM % 90 + 10)) documents\"; sleep 4; done" }
  ]
}
JSON

# ── daemon + start everything ─────────────────────────────────────────────
STACKDECK_HOME="$DEMO/home" STACKDECK_PORT=$PORT nohup node "$REPO/server.js" \
  > "$DEMO/daemon.log" 2>&1 &
for _ in $(seq 1 20); do
  curl -sf -m 1 -o /dev/null "http://localhost:$PORT/api/ping" && break
  sleep 0.5
done
TOKEN=$(cat "$DEMO/home/secret")
H=(-H "X-Stackdeck-Token: $TOKEN" -H 'Content-Type: application/json')
curl -s "${H[@]}" -X POST "http://localhost:$PORT/api/start-all" -d '{"group":"Shop"}' >/dev/null
curl -s "${H[@]}" -X POST "http://localhost:$PORT/api/start-all" -d '{"group":"Pipeline"}' >/dev/null
# one worktree instance for the money shot
curl -s "${H[@]}" -X POST "http://localhost:$PORT/api/worktree/start" \
  -d '{"name":"orders-api","branch":"feature/rate-limits"}' >/dev/null

echo "demo board: http://localhost:$PORT"
