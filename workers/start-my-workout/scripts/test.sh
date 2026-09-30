#!/usr/bin/env bash
# P1 end-to-end test: starts `wrangler dev`, exercises MCP + ingestion,
# fusion, cues, auth, and the activity log. Exits non-zero on any failure.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT=8787
BASE="http://127.0.0.1:$PORT"
SECRET=$(grep '^WORKOUT_SHARED_SECRET=' .dev.vars | cut -d= -f2-)
PASS=0
fail() { echo "FAIL: $1" >&2; exit 1; }
ok()   { PASS=$((PASS+1)); echo "ok $PASS - $1"; }

# ---- start wrangler dev ---------------------------------------------------
npx wrangler dev --port "$PORT" > /tmp/workout-p1-dev.log 2>&1 &
DEV_PID=$!
trap 'kill $DEV_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do
  if curl -s -o /dev/null --max-time 2 -H "X-Workout-Secret: $SECRET" "$BASE/state/__probe__"; then
    break
  fi
  sleep 1
done
curl -s -o /dev/null --max-time 2 -H "X-Workout-Secret: $SECRET" "$BASE/state/__probe__" \
  || fail "wrangler dev did not come up (see /tmp/workout-p1-dev.log)"

mcp() { # $1 = JSON-RPC body -> first SSE data payload
  curl -s -H "X-Workout-Secret: $SECRET" -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -X POST "$BASE/mcp" -d "$1" | sed -n 's/^data: //p' | head -1
}
tool() { # $1 = tool name, $2 = arguments JSON -> parsed tool payload
  local raw
  raw=$(mcp "$(jq -nc --arg n "$1" --argjson a "$2" \
    '{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:$n,arguments:$a}}')")
  echo "$raw" | jq -e '.result.content[0].text | fromjson' > /dev/null \
    || fail "tool $1 errored: $raw"
  echo "$raw" | jq '.result.content[0].text | fromjson'
}
mkframe() { # $1 = stand|deep -> coco17 JSON
  python3 - "$1" <<'EOF'
import json,sys
def mk(hx,hy,kx,ky,ax,ay,c=0.9):
    p=[[0.0,0.0,0.0] for _ in range(17)]
    p[11]=[hx,hy,c]; p[13]=[kx,ky,c]; p[15]=[ax,ay,c]
    return p
w=sys.argv[1]
print(json.dumps(mk(0.5,0.6,0.5,0.3,0.5,0.0) if w=='stand'
                 else mk(0.0,1.0,0.0,0.0,0.985,-0.174)))
EOF
}
ingest_pose() { # $1=session $2=frame-id $3=coco17
  curl -s -H "X-Workout-Secret: $SECRET" -H "Content-Type: application/json" \
    -X POST "$BASE/ingest/pose" \
    -d "$(jq -nc --arg s "$1" --arg f "$2" --argjson c "$3" \
      '{session_id:$s,frame_id:$f,coco17:$c}')"
}
ingest_motion() { # $1=session $2=ts $3=event-json
  curl -s -H "X-Workout-Secret: $SECRET" -H "Content-Type: application/json" \
    -X POST "$BASE/ingest/motion" \
    -d "$(jq -nc --arg s "$1" --argjson t "$2" --argjson e "$3" \
      '{session_id:$s,ts:$t,event:$e}')"
}

# ---- 1. MCP handshake ------------------------------------------------------
INIT=$(mcp '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}')
[ "$(echo "$INIT" | jq -r '.result.serverInfo.name')" = "start-my-workout" ] \
  || fail "initialize: $INIT"
ok "MCP initialize"

CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "X-Workout-Secret: $SECRET" \
  -H "Content-Type: application/json" -X POST "$BASE/mcp" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}')
[ "$CODE" = "202" ] || fail "notifications/initialized -> $CODE"
ok "notifications/initialized -> 202"

TOOLS=$(mcp '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}')
for t in start_workout_session get_workout_state get_poor_form_log list_workout_logs end_workout_session; do
  echo "$TOOLS" | jq -e --arg t "$t" '.result.tools | map(.name) | contains([$t])' > /dev/null \
    || fail "tools/list missing $t"
done
ok "tools/list has all 5 tools"

# ---- 2. start session -------------------------------------------------------
SESS=$(tool start_workout_session '{"exercise":"squat","rounds":3}')
SID=$(echo "$SESS" | jq -r '.session_id')
[ "${#SID}" -ge 6 ] || fail "bad session_id: $SID"
echo "$SESS" | grep -q "https://pose-v1.vercel.app?session=$SID" \
  || fail "pose_url wrong: $SESS"
echo "$SESS" | grep -q "https://pose-motion.vercel.app?session=$SID" \
  || fail "motion_url wrong: $SESS"
ok "start_workout_session ($SID)"

# ---- 3. pose ingestion: standing then deep squat -----------------------------
R=$(ingest_pose "$SID" stand1 "$(mkframe stand)")
A=$(echo "$R" | jq -r '.knee_angle')
python3 -c "import sys; a=float('$A'); sys.exit(0 if a>170 else 1)" \
  || fail "standing knee_angle=$A (want >170)"
[ "$(echo "$R" | jq -r '.step')" = "stand.start" ] || fail "step: $R"
ok "pose ingest standing (knee ${A}°)"

R=$(ingest_pose "$SID" deep1 "$(mkframe deep)")
A=$(echo "$R" | jq -r '.knee_angle')
python3 -c "import sys; a=float('$A'); sys.exit(0 if a<110 else 1)" \
  || fail "deep knee_angle=$A (want <110)"
[ "$(echo "$R" | jq -r '.step')" = "squat.down" ] || fail "step: $R"
ok "pose ingest deep squat (knee ${A}°)"

R=$(ingest_pose "$SID" stand2 "$(mkframe stand)")
[ "$(echo "$R" | jq -r '.step')" = "complete" ] || fail "step: $R"
ok "pose step machine stand.start -> squat.down -> complete"

# ---- 4. rep 1: good form, consistent ------------------------------------------
T0=$(python3 -c 'import time; print(int(time.time()*1000))')
R=$(ingest_motion "$SID" "$T0" '"rep_detected"')
[ "$(echo "$R" | jq -r '.reps')" = "1" ] || fail "reps: $R"
ST=$(tool get_workout_state "{\"session_id\":\"$SID\"}")
[ "$(echo "$ST" | jq -r '.form')" = "good" ] || fail "form: $ST"
[ "$(echo "$ST" | jq -r '.motion')" = "consistent" ] || fail "motion: $ST"
[ "$(echo "$ST" | jq -r '.cue.text')" = "One, good." ] || fail "cue: $ST"
ok "rep 1: form good, motion consistent, cue 'One, good.'"

# ---- 5. rep 2 after 3.5s: still consistent ------------------------------------
sleep 4
R=$(ingest_pose "$SID" deep2 "$(mkframe deep)")
R=$(ingest_motion "$SID" "$((T0+3500))" '"rep_detected"')
ST=$(tool get_workout_state "{\"session_id\":\"$SID\"}")
[ "$(echo "$ST" | jq -r '.reps_completed')" = "2" ] || fail "reps: $ST"
[ "$(echo "$ST" | jq -r '.cue.text')" = "Two, good." ] || fail "cue: $ST"
ok "rep 2 (3.5s period): consistent, cue 'Two, good.'"

# ---- 6. rep 3: poor form (never went below 150°) --------------------------------
sleep 4
R=$(ingest_pose "$SID" stand3 "$(mkframe stand)")
R=$(ingest_motion "$SID" "$((T0+7000))" '"rep_detected"')
ST=$(tool get_workout_state "{\"session_id\":\"$SID\"}")
[ "$(echo "$ST" | jq -r '.form')" = "poor" ] || fail "form: $ST"
[ "$(echo "$ST" | jq -r '.cue.text')" = "Deeper on the next one." ] || fail "cue: $ST"
[ "$(echo "$ST" | jq -r '.poor_form_count')" = "1" ] || fail "poor count: $ST"
PL=$(tool get_poor_form_log "{\"session_id\":\"$SID\"}")
echo "$PL" | grep -q "depth short" || fail "poor flag annotation: $PL"
ok "rep 3: poor form flagged + cue 'Deeper on the next one.'"

# ---- 7. rep 4: too fast (2.0s period) -------------------------------------------
sleep 4
R=$(ingest_pose "$SID" deep3 "$(mkframe deep)")
R=$(ingest_motion "$SID" "$((T0+9000))" '"rep_detected"')
ST=$(curl -s -H "X-Workout-Secret: $SECRET" "$BASE/state/$SID")
[ "$(echo "$ST" | jq -r '.motion')" = "too fast" ] || fail "motion: $ST"
[ "$(echo "$ST" | jq -r '.cue.text')" = "Slow down." ] || fail "cue: $ST"
ok "rep 4 (2.0s period): motion too fast, cue 'Slow down.'"

# ---- 8. cadence_hz + stillness events -------------------------------------------
R=$(ingest_motion "$SID" "$((T0+9500))" '{"type":"cadence_hz","value":0.25}')
[ "$(echo "$R" | jq -r '.motion')" = "consistent" ] || fail "cadence: $R"
R=$(ingest_motion "$SID" "$((T0+9600))" '"stillness"')
ST=$(curl -s -H "X-Workout-Secret: $SECRET" "$BASE/state/$SID")
[ "$(echo "$ST" | jq -r '.still')" = "true" ] || fail "still: $ST"
ok "cadence_hz + stillness events"

# ---- 8b. client-token auth ------------------------------------------------------
CTOKEN=$(echo "$SESS" | jq -r '.client_token')
[ "${#CTOKEN}" -gt 32 ] || fail "missing client_token: $SESS"
echo "$SESS" | grep -q "pose-motion.vercel.app?session=$SID&token=$CTOKEN" \
  || fail "motion_url missing token: $SESS"
# ingest with ?token=, no global secret -> 200
R=$(curl -s -H "Content-Type: application/json" \
  -X POST "$BASE/ingest/motion?token=$CTOKEN" \
  -d "$(jq -nc --arg s "$SID" '{session_id:$s,ts:1,event:"stillness"}')")
[ "$(echo "$R" | jq -r '.ok')" = "true" ] || fail "motion ingest ?token=: $R"
# header form on GET /state -> 200
R=$(curl -s -H "X-Client-Token: $CTOKEN" "$BASE/state/$SID")
[ "$(echo "$R" | jq -r '.session_id')" = "$SID" ] || fail "GET /state X-Client-Token: $R"
# token for session A does not open a different session id -> 404 (unknown), not 401
C404=$(curl -s -o /dev/null -w "%{http_code}" -H "X-Client-Token: $CTOKEN" \
  "$BASE/state/nonexistent123")
[ "$C404" = "404" ] || fail "token + unknown session -> $C404"
# wrong token -> 401
C401=$(curl -s -o /dev/null -w "%{http_code}" -H "Content-Type: application/json" \
  -X POST "$BASE/ingest/motion?token=wct_wrong" \
  -d "$(jq -nc --arg s "$SID" '{session_id:$s,ts:1,event:"stillness"}')")
[ "$C401" = "401" ] || fail "wrong client token -> $C401"
# client token on /mcp -> 401 (MCP stays global-secret-only)
C401=$(curl -s -o /dev/null -w "%{http_code}" -H "X-Client-Token: $CTOKEN" \
  -H "Content-Type: application/json" -X POST "$BASE/mcp" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}')
[ "$C401" = "401" ] || fail "client token on /mcp -> $C401"
ok "client-token auth (?token=/header accept, wrong-token 401, MCP global-only)"

# ---- 9. end session -> markdown log ----------------------------------------------
END=$(tool end_workout_session "{\"session_id\":\"$SID\"}")
[ "$(echo "$END" | jq -r '.summary.reps')" = "4" ] || fail "summary: $END"
MD=$(echo "$END" | jq -r '.log_markdown')
echo "$MD" | grep -q "^# Workout .* — Squat" || fail "log title: $MD"
echo "$MD" | grep -q "3 good / 0 fair / 1 poor" || fail "log form counts: $MD"
echo "$MD" | grep -q "depth short" || fail "log poor-form section: $MD"
echo "$MD" | grep -q "not professional coaching" || fail "log disclaimer: $MD"
KEY=$(echo "$END" | jq -r '.log_key')
ok "end_workout_session -> markdown log ($KEY)"

LOGS=$(tool list_workout_logs '{"limit":5}')
echo "$LOGS" | jq -e --arg k "$KEY" '.logs | map(.key) | contains([$k])' > /dev/null \
  || fail "list_workout_logs missing $KEY: $LOGS"
ok "list_workout_logs contains the session"

# ---- 10. auth: 401s ---------------------------------------------------------------
C401=$(curl -s -o /dev/null -w "%{http_code}" -H "Content-Type: application/json" \
  -X POST "$BASE/mcp" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}')
[ "$C401" = "401" ] || fail "MCP without secret -> $C401"
C401=$(curl -s -o /dev/null -w "%{http_code}" -H "X-Workout-Secret: wrong" \
  -H "Content-Type: application/json" -X POST "$BASE/mcp" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}')
[ "$C401" = "401" ] || fail "MCP wrong secret -> $C401"
C401=$(curl -s -o /dev/null -w "%{http_code}" -H "Content-Type: application/json" \
  -X POST "$BASE/ingest/pose" \
  -d "$(jq -nc --arg s "$SID" --argjson c "$(mkframe stand)" '{session_id:$s,coco17:$c}')")
[ "$C401" = "401" ] || fail "REST without secret -> $C401"
C400=$(curl -s -o /dev/null -w "%{http_code}" -H "Content-Type: application/json" \
  -X POST "$BASE/ingest/pose" -d '{}')
[ "$C400" = "400" ] || fail "REST malformed (no session_id) -> $C400"
C401=$(curl -s -o /dev/null -w "%{http_code}" -H "X-Workout-Secret: wrong" \
  -H "Content-Type: application/json" -X POST "$BASE/ingest/motion" \
  -d "$(jq -nc --arg s "$SID" '{session_id:$s,ts:1,event:"stillness"}')")
[ "$C401" = "401" ] || fail "REST wrong secret -> $C401"
C401=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/state/$SID")
[ "$C401" = "401" ] || fail "GET /state without secret -> $C401"
C204=$(curl -s -o /dev/null -w "%{http_code}" -X OPTIONS "$BASE/ingest/motion" \
  -H "Origin: https://pose-motion.vercel.app" \
  -H "Access-Control-Request-Method: POST")
[ "$C204" = "204" ] || fail "CORS preflight -> $C204"
ACAO=$(curl -s -D - -o /dev/null -H "X-Client-Token: $CTOKEN" "$BASE/state/$SID" \
  | grep -i "^access-control-allow-origin:" | tr -d '\r' | tr 'A-Z' 'a-z')
[ "$ACAO" = "access-control-allow-origin: *" ] || fail "ACAO header: '$ACAO'"
ok "401 on missing/wrong secret (MCP + REST), CORS preflight + ACAO"

echo ""
echo "ALL $PASS CHECKS PASSED"
