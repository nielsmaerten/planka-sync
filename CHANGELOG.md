# Changelog

## 0.1.1 (23/09/2026)

- Moves and reorders are now three-way: a card moved or reordered in Planka while the mirror
  still had it in its old place is pulled, not pushed back. A card moved on both sides is
  reported as `blocked` until it is moved by hand or `sync --push` / `sync --pull` decides.
- A blocked card keeps its directory and its recorded state until the report is acted on.

## 0.1.0 (23/09/2026)

First version: interactive setup, non-interactive `init`, two-way sync of one Planka 2 project
(cards, descriptions, tasks, labels, members, due dates, moves, order, creation, trash, comments,
attachments, new labels and lists), `validate`, `status`, `login`, `api`, generated `AGENTS.md`.
