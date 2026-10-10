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

### Slice 4 — release (CI and docs landed 23/09/2026; `npm publish` is Niels's call)

- README for strangers, `api` verb, `status`, `--version`, CHANGELOG, GitHub Actions (lint, test
  with the Docker Planka), `npm publish` from a tag. First version 0.1.0.

## Out of scope

- Live Socket.IO feed (watch mode polls; see "Watch mode" below). Custom fields. Task group structure and order
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

## Amendment (23/09/2026, 0.1.1)

- Moves and order pushes judge three ways against where the last run wrote the card or list.
  Found while upgrading the katana mirror: its README recorded that the rc1 engine reverted a
  Planka-side move, and the port had the same gap.

## Open questions (resolved 23/09/2026)

- Comment edits stay pushable. An edit or removal of another user's comment (author from the
  filename, signed-in user from `/api/users/me`, admins exempt) is reported as `blocked` before
  any API call, with `sync --pull` as the way to restore it.
- Expired token: `sync` exits 3 and points at `login`; no inline prompt (yagni, Niels).
- `init` refuses only a directory whose `planka-sync.yaml` names another server or project.
  Other files in the directory are fine.

## Needs Niels

- (done) The public GitHub repo: https://github.com/nielsmaerten/planka-sync.

## Watch mode (decided 10/10/2026, grilled 10/10/2026)

Reverses "one-shot only, no daemon, watcher or lock" from 23/09/2026. Target version 0.3.0.

### Decisions

- **`planka-sync --watch`** (also `sync --watch`) runs the sync in a loop until Ctrl-C or SIGTERM.
  **Foreground only**: logs one line per pass to stdout. Users background it themselves (tmux,
  `&`, systemd user unit). No self-detach, no stop verb in this work.
- **Two-way, debounced.** A recursive `fs.watch` on the mirror root triggers a full sync after a
  quiet period without writes. Agents never need to run sync while a watcher is running.
  **Only events under mirrored board directories count.** Ignored: `.planka-sync/`, `.git*`,
  `*.tmp`, the pid file, root-level non-board directories, and boards excluded by `boards:`.
  Writes to a draft card (below) do wake the watcher, and the pass does nothing: an accepted
  cost.
- **Remote detection: cheap poll + periodic full sync.** On each poll, `GET /api/boards/:id` for
  every mirrored board (one call per board). Hash a **normalised projection**: ids, `updatedAt`,
  positions, list membership, `commentsTotal`, labels, memberships. Never hash the raw response,
  because a volatile field (signed URLs, presence) would make every poll look like a change. A
  hash change triggers a full sync. A periodic full sync also catches what the projection misses:
  edits to existing comments, boards added to the project.
- **Configurable timings.** `watch:` in `planka-sync.yaml`, with flags overriding it for one run:

  ```yaml
  watch:
    quiet: 5      # seconds without local writes before a push   (--quiet,     min 1)
    poll: 10      # seconds between cheap polls                  (--poll,      min 2)
    fullSync: 300 # seconds between full syncs                   (--full-sync, min 30, >= poll)
  ```

  Values below the minimums are config errors (exit 2), so a typo can't flood a shared server.
  The watcher reads the config once at start, so a change needs a restart.
- **`.planka-watcher.pid`** at the mirror root holds the watcher's pid. It means "this mirror is
  being synced automatically". Written on start, removed on clean exit. A stale file (`kill -0`
  fails) counts as no watcher and gets replaced. A live one makes a second `--watch` exit 2. The
  generated `.gitignore` covers it. `status` shows the running watcher's pid and effective
  timings. AGENTS.md points there rather than hardcoding seconds.
- **Sync lock for every run.** Each sync, from the watcher or by hand, takes an exclusive lock
  file in `.planka-sync/` (O_EXCL, holding the pid; stale when the pid is dead). A manual
  `npx planka-sync` waits for the watcher's current pass, then runs normally and prints its own
  report. Agents can still force an immediate push and read conflicts directly.
- **Rescheduling only on foreign writes.** File events during a pass are recorded, not acted on.
  After the pass, an event whose file now matches what the pass wrote is the watcher's own
  write and is dropped. Any other event (an agent edit made during the pass) schedules the next
  pass. **Never reschedule just because `validate` still shows pending changes.** Blocked cards,
  unresolved `.conflict` files, edits in excluded boards and half-built card directories stay
  pending through any number of passes, and would make the watcher sync back to back forever.
- **Failures.** A network or 5xx error is logged and retried with backoff, and the watcher keeps
  running. A 401 or missing credential logs the `login` hint, removes the pid file and exits 3:
  agents must not believe a dead watcher is syncing. Conflicts, blocked and failed items land as
  they do today (`.conflict` files, `last-run.json`). The deletion cap still refuses (no `--yes`
  in watch mode).

### Agent contract (AGENTS.md v3)

Applies whether or not a watcher runs, since a manual sync can rename directories too. It just
matters more under a watcher.

- **New card: write `card.yaml` last.** A card directory without `card.yaml` is invisible to the
  sync: not created, not renamed, not pruned. This becomes a documented guarantee, with a unit
  test so a refactor can't break it. Write `description.md`, `comments/` and `attachments/`
  first. `card.yaml` is the commit.
- **Complex new card: `card.yaml.draft`.** When a card can't be written in one go, write
  `card.yaml.draft` in the target list directory instead. Rewrite the draft and the other files
  as often as needed, then `mv card.yaml.draft card.yaml` when it's ready. The rename is
  atomic, so the card arrives complete in one pass. `validate` reports a draft as a warning
  ("draft, not synced; rename to card.yaml when ready"), not as an error. Otherwise an agent
  checking mid-draft would be told to fix it (exit 1) and would create `card.yaml` too early.
  ponytail: a rename convention instead of a draft area that the watcher ignores. Revisit if
  agents leave drafts behind, or if wasted passes while drafting become a cost.
- **Title last.** The directory name derives from the title, so a title change renames the
  directory on the next pass. Change `title:` as the last edit to a card. After any sync, find a
  card by its `id:` (e.g. `grep -rl "id: <id>" <board>`), not by an old path.
- **Watcher present** (`.planka-watcher.pid` exists, `status` says running): edits push by
  themselves after the quiet period shown in `status`. Check `status` for conflicts and errors.
  Running sync by hand is still safe.

### Accepted risks

- **Drafting wakes the watcher.** Each write to a draft card triggers a pass that changes
  nothing (a full sync's requests). Agents without a shell can't rename a file and fall back to
  writing `card.yaml` last.

- **Writing to a stale path after a rename.** An agent that changes a title (or whose card is
  renamed or moved in Planka) and later writes to the old path recreates a directory holding
  only `description.md`. The sync ignores it, so the edit is not pushed, and `validate`/`status`
  report `card.yaml: missing`. Nothing is lost on the Planka side, and the AGENTS.md rules
  above make this rare. Revisit if it shows up in practice: options are a per-card-directory
  quiet period, or the watcher adopting a `card.yaml`-less directory whose old path the
  manifest knows.

### Slices

#### Watch slice 1: the loop, end to end

1. **First, the poll check** (it decides the projection). Against the Docker Planka: call
   `GET /api/boards/:id` twice with nothing changed and diff the responses (volatile fields).
   Then add a comment, edit a comment, and edit a task in turn, and note which projection
   fields change (`updatedAt`, `commentsTotal`, …). Record the result in this plan.
2. Sync lock in `syncVerb`, used by every sync.
3. `--watch`: pid file lifecycle with stale detection, event filtering, local quiet period,
   cheap poll on the normalised projection, own-write detection and rescheduling, one log line
   per pass, SIGINT/SIGTERM cleanup. Timings fixed at the defaults in this slice.

- **Done when**, against the Docker Planka: a `description.md` edit reaches Planka within ~quiet
  seconds of the last write; a card edited in the Planka UI/API lands on disk within ~poll
  seconds; a card written into a **list directory created after the watcher started** is
  pushed (proves recursive `fs.watch` picks up new directories); a manual `npx planka-sync`
  during a pass waits, then reports cleanly; a second `--watch` exits 2; after `kill -9`, the
  next `--watch` replaces the stale pid file; an idle watcher makes only the poll calls and
  writes nothing; a mirror with a blocked card and a `.conflict` file stays idle and doesn't
  loop.

#### Watch slice 2: config, agent contract, robustness

- `watch:` config block with flag overrides, minimums, and `status` showing effective values.
- AGENTS.md v3 (section above), plus a unit test for the guarantee that a directory without
  `card.yaml` is invisible to the sync.
- `validate`: `card.yaml.draft` is a known card entry, and a directory holding one gets a draft
  warning instead of `unknown entry` and `card.yaml: missing` errors.
- `status` (and `--json`) shows the watcher: running with pid and timings, stale, or none.
- `.gitignore` template gains the pid file (appended to existing mirrors, as for
  `.planka-sync/`).
- Periodic full sync, network backoff, exit 3 on auth failure.
- README commands table, CHANGELOG 0.3.0, e2e coverage for the watcher.
- **Done when:** a card drafted as `card.yaml.draft` over several writes spaced beyond the quiet
  period stays local, `validate` exits 0 with a draft warning, and after the rename the card
  arrives in Planka complete in one pass; a card whose `description.md` is written
  first and whose `card.yaml` comes in after the quiet period arrives complete; a comment edited
  in Planka reaches disk within `fullSync` seconds (or `poll`, if step 1 shows the projection
  catches it); `poll: 0.5` is refused; stopping the test server makes the watcher log and retry
  without exiting; revoking the token exits 3 and removes the pid file.

### Later, if missed

- Self-detaching `--watch` with a log file and a stop verb.
- Socket.IO live feed instead of polling.
- A per-card-directory quiet period (see accepted risks).

### Open questions

- Which fields does a comment edit change in `GET /api/boards/:id`? Answered by slice 1 step 1.
