# Changelog

## 0.3.0 (10/10/2026)

- `sync --watch` (or `npx planka-sync --watch`) keeps the mirror in sync until stopped: local
  edits are pushed after a quiet period, Planka is polled cheaply for changes, and a periodic
  full sync catches the rest. Timings come from `watch:` in `planka-sync.yaml` or `--quiet`,
  `--poll`, `--full-sync`. `.planka-watcher.pid` and `status` show that a watcher is running.
- Every sync takes a lock in `.planka-sync/`; a second sync waits for the first.
- `card.yaml.draft`: a new card can be prepared over several writes and renamed to
  `card.yaml` when it is ready. `validate` lists drafts as warnings.
- AGENTS.md v3: watcher section, write `card.yaml` last, change the title last, find cards by id.
- A sync never overwrites or removes a local file that changed after it read it: an edit or
  removal made while a sync runs (likely under the watcher) is kept and handled by the next
  run, also under `sync --pull`.
- A created card's id is written to `card.yaml` at once, so a run that fails later cannot
  create the card twice. An emptied card directory is no longer cleaned up (and then trashed).

## 0.2.0 (07/10/2026)

- `boards:` in `planka-sync.yaml` with an `include:` or `exclude:` list of board names or ids
  limits the mirror to some boards of the project. The wizard asks which boards to mirror. A
  board taken out of the mirror keeps its directory but is no longer synced; `validate` and
  `status` say so.

## 0.1.1 (23/09/2026)

- Moves and reorders are now three-way: a card moved or reordered in Planka while the mirror
  still had it in its old place is pulled, not pushed back. A card moved on both sides is
  reported as `blocked` until it is moved by hand or `sync --push` / `sync --pull` decides.
- A blocked card keeps its directory and its recorded state until the report is acted on.

## 0.1.0 (23/09/2026)

First version: interactive setup, non-interactive `init`, two-way sync of one Planka 2 project
(cards, descriptions, tasks, labels, members, due dates, moves, order, creation, trash, comments,
attachments, new labels and lists), `validate`, `status`, `login`, `api`, generated `AGENTS.md`.
