#!/usr/bin/env bash
# End-to-end step 2: real API calls against the Docker stack, as written in
# server/docs/api.md — speed limit at a position, nearby, post a report,
# confirm it. Needs three credential files (see mkclient.sh):
#   $DIR/importer.json (scope bulk-import), $DIR/alice.json and $DIR/bob.json (scope client)
set -u
DIR="${DURCHSTICH_DIR:?directory with importer.json, alice.json, bob.json}"
BASE="${TN_BASE:-http://localhost:3000}"
field() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s)$1))"; }
token() { curl -s -X POST "$BASE/v1/auth/token" -H 'content-type: application/json' -d "$(cat "$DIR/$1")" | field .accessToken; }
show() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.stringify(JSON.parse(s),null,1).slice(0,900))}catch{console.log(s.slice(0,300))}})"; }
IMPORT=$(token importer.json); ALICE=$(token alice.json); BOB=$(token bob.json)
echo "## POST /v1/auth/token (alice) -> $(echo "$ALICE" | cut -c1-24)... (JWT)"

echo; echo "## Seed: one speed-limit segment at Alexanderplatz (bulk-import scope)"
curl -s -X POST "$BASE/v1/bulk-import/speed-limit-segments" -H "authorization: Bearer $IMPORT" -H 'content-type: application/json' \
  -d '{"rows":[{"lineString":[[13.4035,52.5200],[13.4065,52.5200]],"speedLimit":30,"speedLimitUnit":"kmh","source":"durchstich","sourceLicense":"CC0-1.0"}]}' | show

echo; echo "## 1. Speed limit at a position: GET /v1/speed-limit?lat=52.52&lng=13.405"
curl -s "$BASE/v1/speed-limit?lat=52.5200&lng=13.4050" -H "authorization: Bearer $ALICE" | show

echo; echo "## 2. Around a position (before any report): GET /v1/hazard-reports/nearby"
curl -s "$BASE/v1/hazard-reports/nearby?lat=52.52&lng=13.405&radiusM=2000" -H "authorization: Bearer $ALICE" | show

echo; echo "## 3. Post a report (alice): POST /v1/hazard-reports {type:accident}"
RESP=$(curl -s -w '\nHTTP %{http_code}\n' -X POST "$BASE/v1/hazard-reports" -H "authorization: Bearer $ALICE" -H 'content-type: application/json' -d '{"type":"accident","lat":52.5201,"lng":13.4052}')
echo "$RESP" | tail -1; echo "$RESP" | head -n -1 > "$DIR/report.json"; show < "$DIR/report.json"
ID=$(field .report.id < "$DIR/report.json"); echo "report id: $ID"

echo; echo "## 4. Confirm it (bob): POST /v1/hazard-reports/$ID/confirmations {kind:stillThere}"
curl -s -w '\nHTTP %{http_code}\n' -X POST "$BASE/v1/hazard-reports/$ID/confirmations" -H "authorization: Bearer $BOB" -H 'content-type: application/json' -d '{"kind":"stillThere"}' | show

echo; echo "## 2b. Around the position again: the report is there, confirmed once"
curl -s "$BASE/v1/hazard-reports/nearby?lat=52.52&lng=13.405&radiusM=2000" -H "authorization: Bearer $ALICE" | show
