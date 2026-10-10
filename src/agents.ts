// AGENTS.md, written into the mirror root for agents and humans. planka-sync owns only the block
// between its begin and end markers; text outside the block belongs to the user and is kept as is.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FILE, STATE_DIR } from "./config.ts";
import { WATCHER_PID_FILE } from "./lock.ts";

export const AGENTS_VERSION = 4;

const BEGIN = `<!-- planka-sync:begin v${AGENTS_VERSION}; generated, edits inside this block are overwritten. Text outside it is yours and kept. -->`;
const END = "<!-- planka-sync:end -->";
const BEGIN_RE = /^<!-- planka-sync:begin\b.*-->[ \t]*$/gm;
const END_RE = /^<!-- planka-sync:end -->[ \t]*$/gm;
/** The header of v1 to v3, when planka-sync owned the whole file. */
const LEGACY = "<!-- planka-sync agents v";

export const AGENTS_BLOCK = `${BEGIN}
# This directory mirrors a Planka project

Every board, list and card of one Planka project lives here as directories and files. Planka is
the system of record; these files are the editing surface. Edit, create, move or delete files,
then run \`npx planka-sync\` in this directory: it pushes your changes to Planka, pulls Planka's
changes to disk, and prints one line per file it touched. Nothing reaches Planka until a sync
runs, by hand or by a watcher (below).

## Layout

\`\`\`
${CONFIG_FILE}                       which server, project and boards (safe to commit)
<board>/board.yaml                      lists (dir, name, type, id), labels, members
<board>/010-<list>/020-<card>/card.yaml       id, title, labels, members, due, dueCompleted, tasks
<board>/010-<list>/020-<card>/description.md  the card body, plain Markdown
<board>/010-<list>/020-<card>/comments/       one file per comment: <date>-<time>-<author>.md
<board>/010-<list>/020-<card>/attachments/    the card's files
<board>/archive/, <board>/trash/        Planka's built-in lists; read-only
\`\`\`

Directory names carry an order prefix: filesystem sort order is Planka order, for lists and for
cards. The number is only a rank (gaps are normal); the slug after it is derived from the title.
The directory a card sits in is its list. Read \`board.yaml\` for the list, label and member names.

## Workflow

1. Edit files, then run \`npx planka-sync\` here. A non-zero exit means at least one \`error\`,
   \`blocked\` or \`failed\` line; fix what it names and run it again.
2. \`npx planka-sync validate\` checks the tree offline and lists pending changes.
   \`npx planka-sync sync --dry-run\` shows what a sync would do without doing it.
   \`npx planka-sync status\` summarises pending changes, conflicts and the last run.
3. On \`conflict\`, Planka's version is written beside your file as \`<file>.conflict\`. Merge it
   into your file, delete the \`.conflict\` file, run the sync again. \`sync --pull\` resolves
   every conflict in Planka's favour, \`sync --push\` in the local file's favour.
4. \`--json\` prints the run report as JSON; \`--yes\` allows a run that would trash more cards
   than the deletion cap; \`--renumber\` rewrites every order prefix from 010 in steps of 10.

## When a watcher runs

If \`${WATCHER_PID_FILE}\` exists and \`npx planka-sync status\` says \`watcher: running\`, a
\`npx planka-sync --watch\` process keeps this directory in sync: your edits are pushed on their
own a few seconds after you stop writing (\`status\` shows how many), and Planka's changes appear
on disk within seconds. You do not need to run the sync, but running it by hand is still safe:
it waits for the watcher and prints its own report. Check \`status\` for conflicts and errors,
since nobody reads the watcher's report for you. Directories can be renamed under you at any
moment (see "Title" and "Find a card by id" below).

## Editing rules

- **Existing card:** edit \`description.md\`, or \`title\`, \`labels\`, \`members\`, \`due\`,
  \`dueCompleted\`, \`tasks\` in \`card.yaml\`. Keep \`id\` and task \`id\`s as they are.
- **New card:** create \`<board>/<list>/<any-name>/card.yaml\` with at least \`title\` and no
  \`id\`. Add \`description.md\` for the body. Give the directory an order prefix to choose its
  spot (\`015-\` sorts between \`010-\` and \`020-\`); without one it goes to the bottom. The
  sync renames the directory to its canonical name.
- **Write \`card.yaml\` last.** A directory without \`card.yaml\` is ignored by the sync, so write
  \`description.md\`, comments and attachments first; \`card.yaml\` makes it a card. For a card
  you cannot write in one go, write \`card.yaml.draft\` instead, edit as long as you need, then
  \`mv card.yaml.draft card.yaml\` when it is ready. \`validate\` lists drafts as warnings.
- **Title:** the directory name follows the title, so a title change renames the directory on
  the next sync. Make a title change your last edit to a card.
- **Find a card by id:** after any sync, find a card by its \`id\` (for example
  \`grep -rl --include=card.yaml '<id>' <board>\`), not by a path you remember. Writing to an old path
  creates a stray directory without \`card.yaml\`; \`validate\` reports it as an error and the
  sync ignores it.
- **Move:** move the card directory into another list directory of the same board.
- **Reorder:** rename the prefix so the directory sorts where you want it. Same for lists.
- **Delete:** remove the card directory; the card goes to Planka's trash, not away. Removing
  more directories than the deletion cap in one run is refused and they come back.
- **Tasks:** groups with items \`{ name, done }\`; a new item has no \`id\`; removing an item
  deletes it.
- **Comment:** add a \`.md\` file to \`comments/\`. Editing an existing comment file updates that
  comment; removing it deletes the comment. Only the author (or an admin) can change a comment:
  the filename names the author, and an edit to someone else's is reported as \`blocked\` until
  \`sync --pull\` restores it.
- **Attachment:** add a file to \`attachments/\`. Removing one is undone by the next sync;
  delete attachments in the Planka UI (Planka deletes them permanently).
- **New label or list:** append an entry without \`id\` to \`labels\` (\`name\`, \`color\`) or to
  \`lists\` (\`name\`) in \`board.yaml\`. Any other board.yaml edit is undone.
- Do not edit \`archive/\`, \`trash/\`, \`${STATE_DIR}/\` or the planka-sync block of this
  file. Every push is attributed to the Planka user that logged in.

## Direct API access

For what the tree cannot express (custom fields, board settings, users):
\`npx planka-sync api <METHOD> </api/path> [json-body]\` sends one request with the mirror's
credential and prints the JSON response. It has none of the safety nets above: \`DELETE\` is
permanent, and the next sync overwrites the tree with whatever the API left behind.
${END}
`;

/** Lines planka-sync needs in .gitignore, each with the name that shows it is already there. */
const IGNORES: { name: string; block: string }[] = [
  {
    name: STATE_DIR,
    block: `# planka-sync: credential, manifest and base copies stay out of git.\n/${STATE_DIR}/\n`,
  },
  {
    name: WATCHER_PID_FILE,
    block: `# planka-sync: a running watcher's pid, per machine.\n/${WATCHER_PID_FILE}\n`,
  },
];

/** Why the markers in an AGENTS.md cannot be trusted to fence the block, or null when they can. */
export function agentsMdProblem(text: string): string | null {
  const begins = [...text.matchAll(BEGIN_RE)];
  const ends = [...text.matchAll(END_RE)];
  if (begins.length === 0 && ends.length === 0) return null;
  if (begins.length !== 1 || ends.length !== 1 || begins[0].index > ends[0].index)
    return "the planka-sync begin and end markers do not form one block";
  return null;
}

/**
 * AGENTS.md with the current block: the block replaced in place, the v1-v3 file (all generated)
 * replaced whole, or the block appended to a file of the user's own. Null when the markers are
 * broken; such a file is left alone.
 */
export function mergeAgentsMd(existing: string | null): string | null {
  if (existing === null || existing.trim() === "" || existing.startsWith(LEGACY))
    return AGENTS_BLOCK;
  if (agentsMdProblem(existing) !== null) return null;
  const begin = [...existing.matchAll(BEGIN_RE)][0];
  const end = [...existing.matchAll(END_RE)][0];
  if (!begin || !end) return `${existing.replace(/\n*$/, "\n")}\n${AGENTS_BLOCK}`;
  let after = end.index + end[0].length;
  if (existing[after] === "\n") after++;
  return existing.slice(0, begin.index) + AGENTS_BLOCK + existing.slice(after);
}

/** Writes the AGENTS.md block when missing or different. Returns what changed, if anything. */
function writeAgentsMd(root: string): string | null {
  const agents = join(root, "AGENTS.md");
  const current = existsSync(agents) ? readFileSync(agents, "utf8") : null;
  const merged = mergeAgentsMd(current);
  if (merged === null) {
    console.error(`warning: AGENTS.md: ${agentsMdProblem(current ?? "")}; not updated`);
    return null;
  }
  if (merged === current) return null;
  const tmp = `${agents}.${process.pid}.tmp`;
  writeFileSync(tmp, merged);
  renameSync(tmp, agents);
  return current === null ? "AGENTS.md" : "AGENTS.md (updated)";
}

/** Writes AGENTS.md when its block is missing or outdated and .gitignore lines when missing. */
export function writeScaffold(root: string): string[] {
  const agents = writeAgentsMd(root);
  const written = agents === null ? [] : [agents];
  const gitignore = join(root, ".gitignore");
  const existing = existsSync(gitignore) ? readFileSync(gitignore, "utf8") : null;
  const missing = IGNORES.filter((i) => !existing?.includes(i.name)).map((i) => i.block);
  if (missing.length === 0) return written;
  const before = existing === null ? "" : existing.replace(/\n?$/, "\n");
  writeFileSync(gitignore, before + missing.join(""));
  written.push(existing === null ? ".gitignore" : ".gitignore (appended)");
  return written;
}
