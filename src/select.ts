// Applying the config's board filter to one run: which boards to mirror, and letting go of the
// ones the filter now leaves out without touching their files.
import { CONFIG_FILE } from "./config.ts";
import type { Board } from "./planka.ts";
import { selectBoards } from "./project.ts";
import type { Manifest } from "./state.ts";
import { baseKeyOf, type Run } from "./sync.ts";

/** The directory a previously synced board lives in, found through its board.yaml entry. */
function previousBoardDir(previous: Manifest, boardId: string): string | null {
  for (const [rel, entry] of Object.entries(previous.files))
    if (entry.kind === "board" && entry.id === boardId) return rel.slice(0, rel.lastIndexOf("/"));
  return null;
}

/**
 * A board the config now excludes leaves the mirror but stays on disk: its manifest entries and
 * base copies go, so nothing under it is pruned, pushed, or reported as pending from now on.
 */
function releaseBoard(run: Run, boardId: string): void {
  const dir = previousBoardDir(run.previous, boardId);
  if (dir === null) return;
  for (const [rel, entry] of Object.entries(run.previous.files)) {
    if (!rel.startsWith(`${dir}/`)) continue;
    delete run.previous.files[rel];
    const baseKey = baseKeyOf(entry);
    if (baseKey && !run.dry) run.store.removeBase(baseKey);
  }
  run.rec.add("kept", dir, "excluded by planka-sync.yaml; no longer synced");
}

/** The boards this run mirrors, after reporting what the config left out or got wrong. */
export function chooseBoards(run: Run, all: Board[]): Board[] {
  const { boards, excluded, unmatched } = selectBoards(all, run.cfg.boards);
  for (const name of unmatched)
    run.rec.add("error", CONFIG_FILE, `boards: "${name}" is not a board of this project`);
  for (const board of excluded) releaseBoard(run, board.id);
  return boards;
}
