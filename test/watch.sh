#!/usr/bin/env bash
# End-to-end check of `sync --watch` against the Docker Planka: pid file, local push after the
# quiet period, remote changes through the poll, new directories, the sync lock, conflicts that
# leave the watcher idle, stale pid files. Run `pnpm planka:up` first.
set -euo pipefail
cd "$(dirname "$0")/.."
export PLANKA_TEST_SERVER="${PLANKA_TEST_SERVER:-http://localhost:3999}"
cli=(node --experimental-strip-types "$PWD/src/cli.ts")
work=$(mktemp -d)
watcher=""
cleanup() {
  [[ -n "$watcher" ]] && kill "$watcher" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT
trap 'echo "failed at line $LINENO"; tail -15 "$work/planka/watch.log" 2>/dev/null' ERR

pnpm -s planka:seed
mkdir -p "$work/planka" && cd "$work/planka"
PLANKA_PASSWORD=admin-password "${cli[@]}" init --server "$PLANKA_TEST_SERVER" --project "Sync Test" --email admin@example.com > /dev/null
printf 'watch:\n  quiet: 2\n  poll: 2\n  fullSync: 30\n' >> planka-sync.yaml

# Waits up to $1 seconds for the command after it to succeed.
until_ok() {
  local limit=$1; shift
  for _ in $(seq "$((limit * 4))"); do "$@" && return 0; sleep 0.25; done
  echo "timed out after ${limit}s: $*"; tail -20 watch.log; return 1
}
# Passes something asked for; the periodic full sync is left out so timing cannot flake it.
passes() { grep -cE '^[0-9:]{8}  (start|local|remote|retry) ' watch.log || true; }
json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(eval('('+s+')')$1))"; }
in_planka() { "${cli[@]}" api GET "/api/cards/$id" | grep -q "$1"; }

starts() { grep -cE '^[0-9:]{8}  start ' watch.log || true; }
started_since() { test "$(starts)" -gt "$1"; }
start_watcher() {
  local before
  touch watch.log
  before=$(starts)
  "${cli[@]}" sync --watch >> watch.log 2>&1 &
  watcher=$!
  until_ok 30 started_since "$before"
}

echo "== the watcher writes its pid file and refuses a second watcher"
start_watcher
test "$(cat .planka-watcher.pid)" = "$watcher"
grep -q "quiet 2s, poll 2s" watch.log
code=0; "${cli[@]}" sync --watch > second.log 2>&1 || code=$?
test "$code" = 2 && grep -q "already syncs" second.log && rm second.log
code=0; "${cli[@]}" sync --watch --dry-run > /dev/null 2>&1 || code=$?
test "$code" = 2
"${cli[@]}" status | grep -q "^watcher:   running (pid $watcher): pushes 2s after the last write"
"${cli[@]}" status --json | json ".watcher.timings.fullSync" | grep -qx 30
! "${cli[@]}" validate | grep -q "planka-watcher.pid"
grep -qx '/.planka-watcher.pid' .gitignore

echo "== a local edit reaches Planka after the quiet period"
card=main/010-backlog/010-write-the-readme
id=$(grep '^id' "$card/card.yaml" | grep -o '[0-9]*')
printf 'Edited while watching.\n' > "$card/description.md"
until_ok 15 in_planka "Edited while watching"
# The pass re-snapshots after pushing, so its own push is not mistaken for a remote change.
sleep 5
! grep -qE '^[0-9:]{8}  remote ' watch.log || { echo "own push polled as remote"; exit 1; }

echo "== a change in Planka lands on disk through the poll"
"${cli[@]}" api PATCH "/api/cards/$id" '{"description":"Edited in Planka.\n"}' > /dev/null
until_ok 15 grep -q "Edited in Planka" "$card/description.md"

echo "== a list created after the watcher started is watched too"
board=$(grep '^id' main/board.yaml | grep -o '[0-9]*')
"${cli[@]}" api POST "/api/boards/$board/lists" '{"name":"Later","type":"active","position":999999}' > /dev/null
until_ok 15 compgen -G 'main/*-later' > /dev/null
list=$(ls -d main/*-later)
sleep 1
mkdir "$list/new-card" && printf 'title: Born in a new list\n' > "$list/new-card/card.yaml"
until_ok 15 compgen -G "$list/*-born-in-a-new-list/card.yaml" > /dev/null
grep -q '^id' "$list"/*-born-in-a-new-list/card.yaml

echo "== an empty list deleted in Planka loses its directory"
empty=$("${cli[@]}" api POST "/api/boards/$board/lists" '{"name":"Brief","type":"active","position":1999999}' | json ".item.id")
until_ok 15 compgen -G 'main/*-brief' > /dev/null
"${cli[@]}" api DELETE "/api/lists/$empty" > /dev/null
until_ok 15 bash -c '! compgen -G "main/*-brief" > /dev/null'

echo "== a conflict is written once and the watcher stays idle"
printf 'Local side.\n' > "$card/description.md"
"${cli[@]}" api PATCH "/api/cards/$id" '{"description":"Remote side.\n"}' > /dev/null
until_ok 15 test -f "$card/description.md.conflict"
sleep 4
before=$(passes)
sleep 8
test "$(passes)" = "$before" || { echo "watcher kept syncing"; tail -20 watch.log; exit 1; }
# Keeping the local version takes nothing but deleting the .conflict file.
rm "$card/description.md.conflict"
until_ok 15 in_planka "Local side"

echo "== a draft stays local until card.yaml.draft is renamed"
draft=main/010-backlog/030-drafted
mkdir "$draft" && printf 'title: Drafted card\n' > "$draft/card.yaml.draft"
sleep 3
printf 'Written in two steps.\n' > "$draft/description.md"
sleep 3
test -d "$draft" && ! grep -q '^id' "$draft/card.yaml.draft"
"${cli[@]}" validate > validate.log
grep -q "030-drafted: draft, not synced" validate.log && rm validate.log
mv "$draft/card.yaml.draft" "$draft/card.yaml"
until_ok 15 test -f main/010-backlog/030-drafted-card/card.yaml
new_id=$(grep '^id' main/010-backlog/030-drafted-card/card.yaml | grep -o '[0-9]*')
"${cli[@]}" api GET "/api/cards/$new_id" | grep -q '"description":"Written in two steps.'

echo "== description.md first, card.yaml after the quiet period: the card arrives complete"
mkdir main/010-backlog/body-first
printf 'Body before card.\n' > main/010-backlog/body-first/description.md
sleep 3
test -d main/010-backlog/body-first
printf 'title: Body first\n' > main/010-backlog/body-first/card.yaml
synced_card() { grep -l '^title: Body first' main/010-backlog/*/card.yaml | xargs grep -q '^id'; }
until_ok 15 synced_card
body_id=$(grep -h '^id' "$(grep -l '^title: Body first' main/010-backlog/*/card.yaml)" | grep -o '[0-9]*')
"${cli[@]}" api GET "/api/cards/$body_id" | grep -q '"description":"Body before card.'

echo "== a comment edited in Planka arrives with the full sync"
comment=$("${cli[@]}" api POST "/api/cards/$id/comments" '{"text":"Fresh comment."}' | json ".item.id")
until_ok 15 bash -c 'grep -lq "Fresh comment." '"$card"'/comments/*.md'
"${cli[@]}" api PATCH "/api/comments/$comment" '{"text":"Edited comment."}' > /dev/null
until_ok 45 bash -c 'grep -lq "Edited comment." '"$card"'/comments/*.md'
# A pass logs its line when it ends, which can be just after the file it wrote shows up.
until_ok 10 grep -qE '^[0-9:]{8}  full ' watch.log

echo "== an idle watcher writes nothing"
sleep 3
touch "$work/marker"
sleep 6
test -z "$(find . -newer "$work/marker" -not -path './.planka-sync/*' -not -name watch.log -print -quit)"

echo "== a manual sync waits for the lock"
sleep 300 &
holder=$!
echo "$holder" > .planka-sync/sync.lock
"${cli[@]}" sync > manual.log 2> manual.err &
manual=$!
until_ok 5 grep -q "waiting for the sync run by pid $holder" manual.err
kill -0 "$manual"
kill "$holder"; wait "$holder" 2>/dev/null || true
wait "$manual"
grep -q "^written" manual.log && test ! -e .planka-sync/sync.lock
rm manual.log manual.err

echo "== a killed watcher leaves a stale pid file that the next one replaces"
kill -9 "$watcher"; wait "$watcher" 2>/dev/null || true
test -f .planka-watcher.pid
"${cli[@]}" status | grep -q "^watcher:   none (stale pid file for $watcher"
start_watcher
test "$(cat .planka-watcher.pid)" = "$watcher"
kill -TERM "$watcher"; wait "$watcher" || true
watcher=""
test ! -e .planka-watcher.pid
"${cli[@]}" status | grep -q "^watcher:   none; run"

echo "== a revoked credential stops the watcher with exit 3 and removes its pid file"
start_watcher
"${cli[@]}" api DELETE /api/access-tokens/me > /dev/null
code=0; wait "$watcher" || code=$?
watcher=""
test "$code" = 3 && test ! -e .planka-watcher.pid && test ! -e .planka-sync/watcher.json
grep -q "npx planka-sync login" watch.log

echo "watch e2e ok"
