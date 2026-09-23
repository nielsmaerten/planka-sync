// The three-way verdict per file, and the remote view of one card.
import type { BoardFiles, FileSpec } from "./model.ts";

export type Verdict = "pull" | "push" | "conflict";

/** Whole-file three-way verdict. A missing base means lost state: remote wins. */
export function verdict(local: string | null, remote: string, base: string | null): Verdict {
  if (local === null || local === remote || base === null || local === base) return "pull";
  return remote === base ? "push" : "conflict";
}

/** How a conflict is settled: left for the user, or decided for one side (`--pull`, `--push`). */
export type ConflictMode = "ask" | "pull" | "push";
export type Resolve = (v: Verdict) => Verdict;
export const resolver =
  (mode: ConflictMode): Resolve =>
  (v) =>
    v === "conflict" && mode !== "ask" ? mode : v;

export interface RemoteCard {
  id: string;
  dir: string;
  listDir: string;
  card: FileSpec;
  description: FileSpec;
  comments: FileSpec[];
}

/** Groups a board's remote files by card. */
export function groupRemote(built: BoardFiles): Map<string, RemoteCard> {
  const out = new Map<string, RemoteCard>();
  for (const f of built.files) {
    if (!f.cardId) continue;
    const dir = built.index.cardDirs.get(f.cardId)!;
    const listDir = dir.slice(built.index.boardDir.length + 1, dir.lastIndexOf("/"));
    const card = out.get(f.cardId) ?? {
      id: f.cardId,
      dir,
      listDir,
      card: f,
      description: f,
      comments: [],
    };
    if (f.kind === "card") card.card = f;
    else if (f.kind === "description") card.description = f;
    else if (f.kind === "comment") card.comments.push(f);
    out.set(f.cardId, card);
  }
  return out;
}
