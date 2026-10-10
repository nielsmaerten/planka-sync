// Which file events the watcher acts on. An event counts when it lies under a mirrored board and
// the path no longer matches what the last sync left there: someone else wrote it. The watcher's
// own writes, and writes that changed nothing, match the manifest and are dropped.
import { statSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { parseBoardYaml } from "./checks.ts";
import { CONFLICT_SUFFIX } from "./validate.ts";
import { hash, type Manifest, type Store } from "./state.ts";

export interface MirrorState {
  files: Manifest["files"];
  /** Directories of the boards the last sync mirrored. */
  boardDirs: Set<string>;
  /** Every directory the last sync produced: ancestors of its files, and list directories. */
  knownDirs: Set<string>;
}

function addAncestors(dirs: Set<string>, rel: string): void {
  for (let dir = dirname(rel); dir !== "." && !dirs.has(dir); dir = dirname(dir)) dirs.add(dir);
}

/** What the last sync left on disk, read from its manifest and board.yaml files. */
export function mirrorState(store: Store): MirrorState {
  const files = store.load().files;
  const boardDirs = new Set<string>();
  const knownDirs = new Set<string>();
  for (const [rel, entry] of Object.entries(files)) {
    addAncestors(knownDirs, rel);
    if (entry.kind !== "board") continue;
    const boardDir = dirname(rel);
    boardDirs.add(boardDir);
    const board = parseBoardYaml(store.readLocal(rel) ?? "");
    for (const list of board?.lists ?? []) knownDirs.add(`${boardDir}/${list.dir}`);
  }
  return { files, boardDirs, knownDirs };
}

/** An fs.watch name in the manifest's form: forward slashes, also on Windows. */
export const toMirrorPath = (name: string, separator: string = sep): string =>
  name.split(separator).join("/");

/** Event paths the watcher considers at all: under a mirrored board, not a temp file. */
export function relevant(state: MirrorState, rel: string): boolean {
  const parts = rel.split("/");
  // writeAtomic's temp files come and go within one write.
  return parts.length >= 2 && state.boardDirs.has(parts[0]!) && !rel.endsWith(".tmp");
}

type Kind = "file" | "dir" | null;

function kindOf(abs: string): Kind {
  try {
    return statSync(abs).isDirectory() ? "dir" : "file";
  } catch {
    return null;
  }
}

/** Whether the event at `rel` (relative to the mirror root) is a change nobody has synced. */
export function isForeign(store: Store, state: MirrorState, rel: string): boolean {
  const entry = state.files[rel];
  const kind = kindOf(join(store.root, rel));
  // Gone: foreign only when the last sync produced it (a removal to push).
  if (kind === null) return entry !== undefined;
  // A directory the sync did not produce: created, moved or renamed by someone else.
  if (kind === "dir") return !state.knownDirs.has(rel);
  // The sync writes .conflict files itself; people only delete them.
  if (rel.endsWith(CONFLICT_SUFFIX)) return false;
  if (entry === undefined) return true;
  if (entry.hash === null) return false;
  return hash(store.readLocal(rel) ?? "") !== entry.hash;
}
