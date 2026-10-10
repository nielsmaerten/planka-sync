// How the pull phase treats one remote file: pull it, force it over a local edit, or keep a
// change someone made while this run went on. One rule for all of them: a sync pass never
// overwrites or removes local state that changed since the pass read it (`Store.changedSince`).
import { carryAdditions } from "./board.ts";
import type { FileSpec } from "./model.ts";
import type { BoardOutcome } from "./reconcile.ts";
import { entryOf, type Run } from "./sync.ts";

/** Keeps the disk as it is, with Planka's copy as base and manifest entry: pushed next run. */
function keep(run: Run, file: FileSpec, detail: string): void {
  run.next[file.path] = entryOf(file);
  if (!run.dry) run.store.writeBase(file.baseKey, file.content);
  run.rec.add("pending", file.path, detail);
}

/** A pushed card's file written or removed since the pass read it keeps that change. */
function keptCardFile(run: Run, out: BoardOutcome, file: FileSpec): boolean {
  if (!run.store.changedSince(file.path)) return false;
  const removed = run.store.readLocal(file.path) === null;
  // Downloading its attachments would recreate a directory someone just removed.
  if (removed && file.kind === "card") out.vanished.add(file.cardId!);
  keep(run, file, `${removed ? "removed" : "edited"} during this sync; pushed next time`);
  return true;
}

/**
 * board.yaml changed since the pass read it, while its additions were pushed: Planka's copy plus
 * the entries appended meanwhile. Keeping the whole local file would not do: it lacks the ids
 * Planka just assigned, so the next run would reset it.
 */
function keptBoardAdditions(run: Run, file: FileSpec): boolean {
  if (!run.store.changedSince(file.path)) return false;
  const now = run.store.readLocal(file.path);
  const merged =
    now === null ? null : carryAdditions(file.content, run.store.seenContent(file.path)!, now);
  if (merged === null) return false;
  keep(run, file, "additions made during this sync; pushed next time");
  if (!run.dry) run.store.writeLocal(file.path, merged);
  return true;
}

export function pullMode(run: Run, out: BoardOutcome, file: FileSpec): "pull" | "force" | "kept" {
  if (out.overwrite.has(file.path)) return "force";
  if (file.kind === "board") {
    if (!out.boardReset) return "pull";
    return keptBoardAdditions(run, file) ? "kept" : "force";
  }
  if (!out.touched.has(file.cardId ?? "")) return "pull";
  return keptCardFile(run, out, file) ? "kept" : "force";
}
