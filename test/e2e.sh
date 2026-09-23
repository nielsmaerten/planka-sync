#!/usr/bin/env bash
# End-to-end check against the Docker Planka: seed, non-interactive init, idempotent pull,
# push of an edit, creation from a new directory, trash on removal. Run `pnpm planka:up` first.
set -euo pipefail
cd "$(dirname "$0")/.."
export PLANKA_TEST_SERVER="${PLANKA_TEST_SERVER:-http://localhost:3999}"
cli=(node --experimental-strip-types "$PWD/src/cli.ts")
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

pnpm -s planka:seed
mkdir -p "$work/planka" && git -C "$work" init -q .
cd "$work/planka"

echo "== init"
PLANKA_PASSWORD=admin-password "${cli[@]}" init --server "$PLANKA_TEST_SERVER" --project "Sync Test" --email admin@example.com
test -f planka-sync.yaml && test -f AGENTS.md && test -f .gitignore
test "$(stat -c %a .planka-sync/credentials.json)" = 600
test -f main/010-backlog/010-write-the-readme/attachments/notes-file.txt

echo "== second run writes nothing"
"${cli[@]}" sync > sync.log; tail -1 sync.log | grep -q "^written 0, unchanged [1-9]"; rm sync.log
git -C "$work" status --porcelain | grep -q "^?? planka/"
git -C "$work" status --porcelain --ignored | grep -q "^!! planka/.planka-sync/"

echo "== push a description and a title"
card=main/010-backlog/010-write-the-readme
printf 'Edited from disk.\n' > "$card/description.md"
sed -i 's/^title: Write the README$/title: Write the README today/' "$card/card.yaml"
"${cli[@]}" sync > sync.log; grep -q "^pushed .*010-write-the-readme " sync.log; rm sync.log
"${cli[@]}" api GET "/api/cards/$(grep '^id' main/010-backlog/010-write-the-readme-today/card.yaml | grep -o '[0-9]*')" | grep -q '"description":"Edited from disk."'

echo "== create at a chosen spot, then trash"
mkdir -p main/010-backlog/015-new-card
printf 'title: New card\nlabels: [bug]\n' > main/010-backlog/015-new-card/card.yaml
"${cli[@]}" sync > sync.log; grep -q '015-new-card' sync.log; rm sync.log
test -d main/010-backlog/015-new-card
rm -r main/010-backlog/015-new-card
"${cli[@]}" sync > sync.log; grep -q "trashed (directory removed)" sync.log; rm sync.log
ls main/trash | grep -q new-card

echo "== validate flags a broken file"
printf 'title: [broken\n' > main/010-backlog/020-fix-login-bug/card.yaml
if "${cli[@]}" validate >/dev/null; then echo "validate should have failed"; exit 1; fi

echo "e2e ok"
