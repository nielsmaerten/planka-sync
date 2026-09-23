# planka-sync v2 — plan

A public npm package that mirrors one Planka 2 project into a directory inside any repo. Humans and
agents edit files; `npx planka-sync` reconciles both ways. Successor to `../rc1` (read 23/09/2026);
rc1's code is reference material only, nothing is kept verbatim.

## Decisions (23/09/2026)

- **Audience: public.** Any Planka 2 user. No homelab defaults, no assumed keyring. MIT, semver,
  README written for strangers.
- **Runtime: Node ≥ 22, TypeScript, pnpm, oxlint (shared budgets), oxfmt, node:test.** Published as
  `planka-sync` (free on npm as of 23/09/2026). `npx planka-sync` is the onboarding command. No
  single-binary build.
- **Sync model: one-shot only.** Every run is a full three-way reconcile that exits. No daemon,
  socket, watcher, live feed or lock. A `watch` verb (Socket.IO feed + file watcher) is a later
  slice if it is missed.
- **Repo: new public GitHub repo** (Niels creates it and hands over the URL). rc1's Forgejo repo
  stays as archive.
- **Onboarding.** User creates a directory (any name, ignored or committed, their call), runs
  `npx planka-sync` inside it. With no config present the wizard asks: server URL → auth →
  project. Then first pull, then `AGENTS.md` and `.gitignore` are written. If config exists, bare
  `planka-sync` is `sync`.
- **Auth: password first, API key as escape.** Wizard asks email + password (echo off, never
  stored) and calls `POST /api/access-tokens`; "I have an API key" covers OIDC-only servers
  (`X-API-Key`). `PLANKA_TOKEN` / `PLANKA_API_KEY` env vars override the stored credential for
  agents and CI. `login` re-authenticates when a token expired.
- **Secret storage: gitignored file in the mirror dir.** `.planka-sync/credentials` (0600) holds the
  token; `.planka-sync/` also holds the manifest and base copies. The wizard writes a `.gitignore`
  covering `.planka-sync/`. Non-secret config is committable: `planka-sync.yaml` at the mirror
  root (server URL, project id, options such as deletion cap). A fresh clone needs only `login`.
- **Layout: rc1's shape, with two changes.**

  ```
  <mirror>/planka-sync.yaml, AGENTS.md, .gitignore, .planka-sync/
  <mirror>/<board>/board.yaml                       lists (dir → id, type), labels, members
  <mirror>/<board>/010-<list>/020-<card>/
      card.yaml          title, labels, members, due, dueCompleted, tasks (nested by group)
      description.md     plain Markdown
      comments/          one file per comment: <YYYY-MM-DD HHMM>-<author>.md
      attachments/       files; add a file to upload; removal is undone (pull-only, as rc1)
  <mirror>/<board>/archive/, trash/                 pull-only
  ```

  1. **Editable ordering via gapped prefixes.** Pull writes `010-`, `020-`, … (step 10, 3 digits)
     on list and card directories so filesystem sort order is Planka order. To insert, name a
     directory `015-slug/`; a moved directory's prefix sets its position in the target list. Push
     translates relative prefix order into Planka positions. The tool renumbers only when a gap
     is exhausted or on `sync --renumber`. State is keyed by Planka id, so renames cost nothing.
  2. **Human-readable names everywhere.** No ids in directory or file names; ids live in the
     manifest only. Collisions get a numeric suffix (`-2`).

- **Semantics kept from rc1:** per-file three-way merge with stored bases; `<file>.conflict`
  beside the file; invalid or unreadable files are errors, never deletions; card directory
  removal = trash, behind a deletion cap (default 10, `--yes` overrides); board.yaml label/list
  additions push, other board.yaml edits are undone; pushes attributed to the logged-in user.
- **CLI.** `planka-sync` (wizard or sync) · `init --server U --project P` (non-interactive,
  credential from env) · `sync [--dry-run] [--pull | --push] [--yes] [--json] [--renumber]`
  (`--pull`: remote wins conflicts, `--push`: local wins) · `validate` (offline, exit 1 on errors,
  `--json`) · `status` (pending changes, conflicts, last run) · `login` · `api METHOD /path [body]`
  (raw proxy with the mirror's credential; bypasses the safety nets, documented as such).
  Exit codes: 0 ok, 1 errors in the report, 2 usage/no config, 3 auth failure.
- **Generated `AGENTS.md`** is the contract for agents and humans: what the directory is, the
  layout, how to create/edit/move/delete, `npx planka-sync` to sync, how to read the report and
  resolve conflicts, the flags for non-interactive use, and the `api` escape hatch last.
  Regenerated on every run when the template version changes.
- **Tests run against a local Planka 2 in Docker** (rootless Docker on Fedora; SELinux `:z`),
  seeded by a script through the API. Fully isolated, reusable in CI later. Pure parts (diff,
  reconcile, validate, naming) have unit tests against an in-memory fake API.

## Slices

Each slice ends verified end to end against the Docker Planka, lint, format, typecheck and tests
clean, `AGENTS.md` regenerated if its contract changed.

### Slice 1 — onboarding and pull

- Scaffold: package with `bin`, tsconfig, oxlint budgets, oxfmt, node:test, `pnpm build` (tsc to
  `dist/`), `npx`-able locally via `pnpm link`/`npm pack`.
- `compose.yaml` + seed script for the test Planka (project with two boards, lists, cards with
  labels, members, tasks, comments, an attachment, an archived and a trashed card).
- REST client (bearer + API key), `login` (`POST /api/access-tokens`), credential file 0600.
- Wizard on a TTY; `init` non-interactive; usage + exit 2 without a TTY and without config.
- Pull into the layout above with gapped prefixes and readable names; manifest + base copies.
- `validate` (layout, card.yaml schema, references to board.yaml, prefix parsing, pending changes).
- `AGENTS.md` and `.gitignore` generation.
- **Done when:** in an empty directory inside a git repo, `npx planka-sync` reaches a synced mirror
  through the wizard alone; a second run writes nothing; `validate` flags a planted YAML error and
  a locally edited file as pending; `git status` shows only committable files.

### Slice 2 — push existing cards

- Three-way reconcile per file: description, card.yaml fields, tasks; directory move = list move;
  prefix change = reorder; conflicts, `--pull`/`--push`, `--dry-run`, `--json`.
- **Done when:** rc1's push regression passes in the new layout, plus reorder within a list,
  insert-by-prefix, and Planka-side reorder landing on disk without renaming untouched siblings.

### Slice 3 — create, trash, comments, attachments, board.yaml additions

- New directory → card; removed directory → trash behind the cap; comment file lifecycle;
  attachment upload; new labels and lists; `--renumber`.
- **Done when:** rc1's slice 3 and 4 regressions pass, cap refusal restores the removed directories.

### Slice 4 — release (open)

- README for strangers, `api` verb, `status`, `--version`, CHANGELOG, GitHub Actions (lint, test
  with the Docker Planka), `npm publish` from a tag. First version 0.1.0.

## Out of scope

- Watch mode / live feed (later slice, if missed). Custom fields. Task group structure and order
  as pushable. Attachment deletion from disk. Editing archived or trashed cards. Several projects
  in one mirror. OS keychain storage.

## Amendments (23/09/2026, during slice 1)

- `card.yaml` keeps `id` (and task items keep `id`): it is how a moved or renamed directory is
  recognised as the same card rather than a delete plus a create. Directory and file names carry
  no ids, as decided.
- Comment files: `<YYYY-MM-DD>-<HHMM>-<author>.md` in UTC; a collision gets `-2`. Renaming a
  comment file counts as delete plus create.
- Planka 2's first login can demand terms acceptance (a pending-token step). The wizard prints the
  terms and asks; `init` needs `--accept-terms`. Attachment downloads take a bearer token only as
  a cookie; the client handles that.
- Test server: `ghcr.io/plankanban/planka:2.0.0` on port 3999, seeded by `test/planka/seed.ts`.
- Slice 1 landed 23/09/2026: wizard through a pty, `init`, idempotent second run, list reorder,
  card rename, card move and mid-list insert in Planka relocate directories on disk while a local
  edit survives as `pending`; `validate` flags a planted YAML error and an unknown label.

## Amendments (23/09/2026, slices 2 and 3)

- Landed together: per-file three-way push (description, card.yaml fields, tasks), moves
  between lists, order pushes from the prefixes (cards and lists; only items that sort
  differently get a new Planka position, chosen between their neighbours), conflicts as
  `<file>.conflict` with `--pull` / `--push` deciding them, card creation with the prefix choosing
  the spot (no prefix: bottom), trash behind the deletion cap with `--yes`, comment create /
  update / delete, attachment upload, new labels and lists from board.yaml, `--dry-run`,
  `--json`, `--renumber`, the `api` verb.
- A list directory renamed to another prefix is recognised by its slug, so renaming
  `030-done` to `005-done` reorders the list in Planka instead of orphaning its cards.
- Verified live against the Docker Planka (23/09/2026): every case above, each followed by an
  idempotent run. Found and fixed on the way: files a user added under a directory that gets
  relocated in the same run (canonical rename) were re-uploaded on the next run.

## Open questions

- Comment filename format (`<date>-<author>.md` proposed); whether comment edits push for the
  public tool, since Planka refuses edits to other users' comments (rc1 pushed and reported the
  refusal).
- Token lifetime: Planka access tokens expire per server config; `login` covers renewal, but
  whether `sync` should prompt on a TTY when it hits 401.
- Whether `init` should refuse a non-empty directory or only refuse when it holds a foreign
  `planka-sync.yaml`.
- Wizard on a server whose swagger endpoint is closed: fine, the tool needs no spec at runtime.

## Needs Niels

- (done) The public GitHub repo: https://github.com/nielsmaerten/planka-sync.
