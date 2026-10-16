#!/usr/bin/env bash
# Smoke test: boots the server with the example config and checks the invite
# renders, RSVPs persist across restarts, and the race window is enforced.
set -euo pipefail
cd "$(dirname "$0")/.."

node --check server.js

TMP=$(mktemp -d)
PID1=""; PID2=""; PID3=""; PID4=""
trap 'kill $PID1 $PID2 $PID3 $PID4 2>/dev/null || true; rm -rf "$TMP"' EXIT
cp config.example.json "$TMP/config.json"

wait_up() {
  for _ in $(seq 1 20); do curl -sf "$1/" > /dev/null && return; sleep 0.25; done
  echo "FAIL: server did not come up at $1"; exit 1
}

PORT=3999 CONFIG_FILE="$TMP/config.json" STATE_FILE="$TMP/rsvp.json" node server.js > "$TMP/boot1.log" 2>&1 &
PID1=$!
BASE=http://127.0.0.1:3999
wait_up "$BASE"

curl -sf "$BASE/" | grep -q "Your Name's Halloween Party" || { echo "FAIL: example config not rendered"; exit 1; }
test -f "$TMP/rsvp.db" || { echo "FAIL: SQLite database not created"; exit 1; }

curl -sf -X POST "$BASE/api/rsvp" -H 'Content-Type: application/json' \
  -d '{"name":"CI Ghost","status":"yes"}' > /dev/null
curl -sf "$BASE/api/state" | grep -q "CI Ghost" || { echo "FAIL: rsvp not stored"; exit 1; }

# the race must be sealed outside its window (example party is in 2027)
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/ping" \
  -H 'Content-Type: application/json' -d '{"name":"CI Ghost","lat":1,"lng":1}')
[ "$code" = "403" ] || { echo "FAIL: expected ping 403 outside race window, got $code"; exit 1; }

kill $PID1; wait $PID1 2>/dev/null || true

# second process: RSVPs survive restarts, and with the race open pings flow
PORT=3998 CONFIG_FILE="$TMP/config.json" STATE_FILE="$TMP/rsvp.json" RACE_FORCE=1 \
  node server.js > "$TMP/boot2.log" 2>&1 &
PID2=$!
BASE2=http://127.0.0.1:3998
wait_up "$BASE2"

curl -sf "$BASE2/api/state" | grep -q "CI Ghost" || { echo "FAIL: rsvp lost across restart"; exit 1; }
curl -sf -X POST "$BASE2/api/ping" -H 'Content-Type: application/json' \
  -d '{"name":"CI Ghost","lat":19.1,"lng":72.9}' > /dev/null || { echo "FAIL: ping rejected with race open"; exit 1; }
curl -sf "$BASE2/api/state" | grep -q '"lat":19.1' || { echo "FAIL: ping not in state"; exit 1; }
# RSVPs survived the restart into a new process
curl -sf "$BASE2/api/state" | grep -q "CI Ghost" || { echo "FAIL: rsvp lost across restart"; exit 1; }

kill $PID2; wait $PID2 2>/dev/null || true

# serverless mode: storage via Upstash REST (stubbed), pings through the store
node test/upstash-stub.js > "$TMP/stub.log" 2>&1 &
PID3=$!
sleep 1
PORT=3997 STATE_FILE="$TMP/cloud.json" UPSTASH_REDIS_REST_URL=http://127.0.0.1:6399 UPSTASH_REDIS_REST_TOKEN=x \
  RACE_FORCE=1 node server.js > "$TMP/boot3.log" 2>&1 &
PID4=$!
BASE3=http://127.0.0.1:3997
wait_up "$BASE3"
curl -sf -X POST "$BASE3/api/rsvp" -H 'Content-Type: application/json' -d '{"name":"Cloud Ghost","status":"yes"}' > /dev/null
curl -sf "$BASE3/api/state" | grep -q "Cloud Ghost" || { echo "FAIL: rsvp not stored via upstash"; exit 1; }
curl -sf -X POST "$BASE3/api/ping" -H 'Content-Type: application/json' -d '{"name":"Cloud Ghost","lat":19.2,"lng":72.8}' > /dev/null
curl -sf "$BASE3/api/state" | grep -q '"lat":19.2' || { echo "FAIL: ping not stored via upstash"; exit 1; }
test ! -f "$TMP/cloud.db" || { echo "FAIL: upstash mode must not touch sqlite"; exit 1; }

echo "smoke: all checks passed"
