// How the pull phase treats one remote file: pull it, force it over a local edit, or keep a
// local edit that was made while this run went on.
import { carryAdditions } from "./board.ts";
import type { FileSpec } from "./model.ts";
import type { BoardOutcome } from "./reconcile.ts";
import { entryOf, type Run } from "./sync.ts";

/** What a pushed card's file held when this run read it; undefined when it was not read. */
function scannedContent(out: BoardOutcome, file: FileSpec): string | null | undefined {
  const local = out.scanned.get(file.cardId ?? "");
  if (!local) return undefined;
  if (file.kind === "card") return local.cardYaml;
  if (file.kind === "description") return local.description;
  return local.comments.get(file.path.slice(file.path.lastIndexOf("/") + 1));
}

/**
 * A pushed card's file that someone wrote or removed while this run went on (the watcher syncs
 * while agents keep editing): force-pulling Planka's copy would undo that. Keep the disk as it
 * is, with Planka's copy as base and manifest entry, so the next run pushes the edit or removal.
 */
function keptNewerEdit(run: Run, out: BoardOutcome, file: FileSpec): boolean {
  const before = scannedContent(out, file);
  const now = run.store.readLocal(file.path);
  if (before === undefined || now === before) return false;
  run.next[file.path] = entryOf(file);
  if (!run.dry) run.store.writeBase(file.baseKey, file.content);
  if (file.kind === "card" && now === null) out.vanished.add(file.cardId!);
  const what = now === null ? "removed" : "edited";
  run.rec.add("pending", file.path, `${what} during this sync; pushed next time`);
  return true;
}

/** board.yaml after pushed additions: entries appended meanwhile survive on top of Planka's. */
function keptBoardAdditions(run: Run, out: BoardOutcome, file: FileSpec): boolean {
  const now = run.store.readLocal(file.path);
  if (out.scannedBoard === undefined || now === null || now === out.scannedBoard) return false;
  const merged = carryAdditions(file.content, out.scannedBoard, now);
  if (merged === null) return false;
  run.next[file.path] = entryOf(file);
  if (!run.dry) {
    run.store.writeBase(file.baseKey, file.content);
    run.store.writeLocal(file.path, merged);
  }
  run.rec.add("pending", file.path, "additions made during this sync; pushed next time");
  return true;
}

export function pullMode(run: Run, out: BoardOutcome, file: FileSpec): "pull" | "force" | "kept" {
  if (out.overwrite.has(file.path)) return "force";
  if (file.kind === "board") {
    if (!out.boardReset) return "pull";
    return keptBoardAdditions(run, out, file) ? "kept" : "force";
  }
  if (!out.touched.has(file.cardId ?? "")) return "pull";
  return keptNewerEdit(run, out, file) ? "kept" : "force";
}
