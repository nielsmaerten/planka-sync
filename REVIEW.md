# Review guidelines

For anyone reviewing changes to this repository or acting on review findings: people, GitHub
Codex, Claude Code Review, Copilot, local agents. Judge every finding against the intended use
below. A finding that cannot name a realistic scenario within it is not a finding here.

## Intended use

- **Where:** a developer's workstation, Linux or macOS, Node 22.6 or newer. Windows is not
  supported. Published on npm for any Planka 2 user; they use it the same way.
- **Who acts at once:** one mirror directory, at most one `--watch` process, and 1 to 3 coding
  agents plus at most one human editing its files. Manual `npx planka-sync` runs happen next to
  the watcher (the sync lock serialises them). Other people edit the same Planka project in the
  web UI at any time.
- **How fast:** agents edit files seconds apart and keep editing while a sync pass runs. Humans
  act on a scale of minutes.
- **How it stops:** the watcher with Ctrl-C or a service stop. A manual sync can be killed
  mid-run by Ctrl-C or an agent's command timeout; the next run must recover from that (no lost
  edit, no duplicate it can avoid cheaply). A SIGKILL timed to a specific microsecond window is
  not a scenario.
- **Server and scale:** one small self-hosted Planka 2 server, a few boards per project, tens to
  a few hundred cards per board, small attachments, a network that drops now and then.
- **Must never happen:** losing a local edit (card fields, description, comment, attachment),
  losing a card or comment in Planka (trash, behind the deletion cap, is not loss), or leaking
  the credential into output, logs or tracked files.
- **Cheap to recover:** anything the next sync or a rerun brings back on its own, and anything
  that shows an error and works on a rerun. A card or comment created twice is visible and
  recoverable (someone trashes one): fix it when the fix is small, otherwise record it.
- **Out of scope:** Windows; several watchers on one mirror (refused by design); one mirror
  shared by several machines or kept on a network filesystem; hostile local users; boards with
  thousands of cards.

## Reporting a finding

- Name the scenario within the intended use above that triggers it, and what goes wrong
  (state or input → wrong result, lost data, crash).
- Say what it costs and whether it recovers on its own, on a rerun, or not at all.
- Leave out scenarios outside the intended use: other platforms, scales nobody runs, a SIGKILL
  inside a microsecond window, two unlikely events at once.

## Handling findings

- Check the scenario holds within the intended use and the claim is true in the code; decline,
  with the reason, what fails either test.
- **Cost of fixing:** weigh severity × frequency × recoverability against everything the fix
  costs (code, tests, complexity, regression risk, new review surface).
  - Always fix: unrecoverable data loss, silent corruption, a security exposure within intended
    use.
  - Judgement: silent but recoverable; fix when the fix is small and local.
  - Don't fix, or only make it visible: rare, shows an error, a rerun recovers.
- **Class rule:** at the first finding, name the invariant it breaks and look for other places
  that break it. At the second finding of the same class, or when a fix draws a follow-up in it,
  stop patching: fix the invariant once and test the class, not the instance.
- Before pushing a fix, ask what new window or state the fix itself opens.
