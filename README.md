# planka-sync

Mirror a [Planka 2](https://planka.app) project into a directory and keep it in sync both ways.
Boards become directories, lists become directories, cards become a `card.yaml` plus a
`description.md`, comments and attachments become files. Edit the files (you, a script, an AI
agent), run `npx planka-sync`, and the changes land in Planka; changes made in Planka land on disk.

## Get started

```sh
mkdir planka && cd planka        # any name; commit it or gitignore it, your call
npx planka-sync                  # asks for the server URL, signs you in, lets you pick a project
```

That first run pulls the project and writes:

- `planka-sync.yaml` — which server and project this directory mirrors (safe to commit)
- `AGENTS.md` — instructions for anyone, human or agent, who works in this directory
- `.gitignore` — keeps `.planka-sync/` (credential, sync state) out of git
- one directory per board

Requires Node 22.6 or newer. Sign in with email and password, or with a Planka API key when your
server uses single sign-on.

## Layout

```
planka-sync.yaml
<board>/board.yaml                              lists, labels, members
<board>/010-<list>/010-<card>/card.yaml         id, title, labels, members, due, dueCompleted, tasks
<board>/010-<list>/010-<card>/description.md    plain Markdown
<board>/010-<list>/010-<card>/comments/         <date>-<time>-<author>.md, one file per comment
<board>/010-<list>/010-<card>/attachments/      the card's files
<board>/archive/, <board>/trash/                Planka's built-in lists, read-only
```

Directory names carry an order prefix so that filesystem sort order is Planka order. Insert a
card between `010-` and `020-` by naming its directory `015-…`; the tool renumbers only when a
gap runs out. See the generated `AGENTS.md` for the full editing rules.

## Commands

| Command                                       | Does                                                           |
| --------------------------------------------- | -------------------------------------------------------------- |
| `npx planka-sync`                             | set up this directory (interactive), or sync it                |
| `npx planka-sync sync`                        | push local changes, pull Planka's; `--dry-run`, `--json`       |
| `npx planka-sync validate`                    | check the tree offline, list pending changes; exit 1 on errors |
| `npx planka-sync status`                      | server, project, pending changes, conflicts, last run          |
| `npx planka-sync login`                       | sign in again                                                  |
| `npx planka-sync init --server … --project …` | non-interactive setup for scripts and CI                       |
| `npx planka-sync api GET /api/users/me`       | one raw API request with the mirror's credential               |

`--dir <path>` runs against another directory. Exit codes: 0 ok, 1 errors reported, 2 usage or
not a mirror, 3 not signed in.

For scripts, the credential can come from the environment instead of the credential file:
`PLANKA_API_KEY`, `PLANKA_TOKEN` (a bearer token), or `--email` with `PLANKA_PASSWORD`.

## Status

Two-way sync works: card fields, description, tasks, moves, order, creation, trash, comments,
attachments, new labels and lists. Not published to npm yet; see [PLAN.md](PLAN.md) for what
is in and out of scope.

## Development

```sh
pnpm install
pnpm planka:up && pnpm planka:seed     # a throwaway Planka 2 in Docker on http://localhost:3999
pnpm e2e                                # end-to-end check against it (seeds it again)
pnpm test && pnpm lint && pnpm fmt:check && pnpm typecheck
pnpm build                              # dist/, what `npx planka-sync` runs
pnpm planka:down                        # removes the test server and its data
```

The seeded admin is `admin@example.com` / `admin-password` on the test server only.

## License

MIT
