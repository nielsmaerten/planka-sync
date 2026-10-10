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
trap 'echo "failed at line $LINENO"' ERR

pnpm -s planka:seed
mkdir -p "$work/planka" && cd "$work/planka"
PLANKA_PASSWORD=admin-password "${cli[@]}" init --server "$PLANKA_TEST_SERVER" --project "Sync Test" --email admin@example.com > /dev/null
printf 'watch:\n  quiet: 2\n  poll: 2\n  fullSync: 600\n' >> planka-sync.yaml

# Waits up to $1 seconds for the command after it to succeed.
until_ok() {
  local limit=$1; shift
  for _ in $(seq "$((limit * 4))"); do "$@" && return 0; sleep 0.25; done
  echo "timed out after ${limit}s: $*"; tail -20 watch.log; return 1
}
passes() { grep -cE '^[0-9:]{8}  (start|local|remote|full|retry) ' watch.log || true; }
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

echo "== a local edit reaches Planka after the quiet period"
card=main/010-backlog/010-write-the-readme
id=$(grep '^id' "$card/card.yaml" | grep -o '[0-9]*')
printf 'Edited while watching.\n' > "$card/description.md"
until_ok 15 in_planka "Edited while watching"

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

echo "== a conflict is written once and the watcher stays idle"
printf 'Local side.\n' > "$card/description.md"
"${cli[@]}" api PATCH "/api/cards/$id" '{"description":"Remote side.\n"}' > /dev/null
until_ok 15 test -f "$card/description.md.conflict"
sleep 4
before=$(passes)
sleep 8
test "$(passes)" = "$before" || { echo "watcher kept syncing"; tail -20 watch.log; exit 1; }
cp "$card/description.md.conflict" "$card/description.md" && rm "$card/description.md.conflict"
until_ok 15 in_planka "Remote side"

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
start_watcher
test "$(cat .planka-watcher.pid)" = "$watcher"
kill -TERM "$watcher"; wait "$watcher" || true
watcher=""
test ! -e .planka-watcher.pid

echo "watch e2e ok"
