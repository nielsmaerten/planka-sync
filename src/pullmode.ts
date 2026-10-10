// How the pull phase treats one remote file: pull it, force it over a local edit, or keep a
// change someone made while this run went on. One rule for all of them: a sync pass never
// overwrites or removes local state that changed since the pass read it (`Store.changedSince`).
import { carryAdditions } from "./board.ts";
import type { FileSpec } from "./model.ts";
import type { BoardOutcome } from "./reconcile.ts";
import { entryOf, type Run } from "./sync.ts";

type Mode = "pull" | "force" | "kept";

/** Leaves the disk as it is under `entry`, so the next run judges the change. */
function keep(run: Run, file: FileSpec, entry = run.previous.files[file.path]): void {
  run.next[file.path] = entry ?? entryOf(file);
}

/** A pushed card's file changed since the pass read it: Planka's copy (what was pushed) is its base. */
function keptPushed(run: Run, out: BoardOutcome, file: FileSpec): void {
  const removed = run.store.readLocal(file.path) === null;
  if (removed && file.kind === "card") out.vanished.add(file.cardId!);
  keep(run, file, entryOf(file));
  if (!run.dry) run.store.writeBase(file.baseKey, file.content);
  run.rec.add(
    "pending",
    file.path,
    `${removed ? "removed" : "edited"} during this sync; pushed next time`,
  );
}

/** Removed since the pass read it: stays removed under its previous entry, a removal next run. */
function keptRemoval(run: Run, out: BoardOutcome, file: FileSpec): void {
  // Downloading its attachments would recreate a directory someone just removed.
  if (file.kind === "card") out.vanished.add(file.cardId!);
  keep(run, file);
  run.rec.add("pending", file.path, "removed during this sync; handled next time");
}

/**
 * board.yaml changed while its additions were pushed: Planka's copy plus the entries appended
 * meanwhile (the whole local file lacks the ids Planka just assigned, so the next run would
 * reset it). Null when nothing pushable came in: the reset goes ahead.
 */
function keptBoardAdditions(run: Run, file: FileSpec): boolean {
  const now = run.store.readLocal(file.path);
  const seen = run.store.seenContent(file.path);
  const merged =
    now === null || seen === undefined ? null : carryAdditions(file.content, seen, now);
  if (merged === null) return false;
  keep(run, file, entryOf(file));
  if (!run.dry) {
    run.store.writeBase(file.baseKey, file.content);
    run.store.writeLocal(file.path, merged);
  }
  run.rec.add("pending", file.path, "additions made during this sync; pushed next time");
  return true;
}

/** Forced pulls: `--pull` over a conflict, a reset board.yaml, a pushed card's files. */
function forced(run: Run, out: BoardOutcome, file: FileSpec): Mode {
  if (!run.store.changedSince(file.path)) return "force";
  if (out.overwrite.has(file.path)) {
    // `--pull` decided the conflict the pass read, not an edit made after it.
    keep(run, file);
    run.rec.add("pending", file.path, "edited during this sync; not overwritten");
    return "kept";
  }
  if (file.kind === "board") return keptBoardAdditions(run, file) ? "kept" : "force";
  keptPushed(run, out, file);
  return "kept";
}

export function pullMode(run: Run, out: BoardOutcome, file: FileSpec): Mode {
  const pushed = file.kind === "board" ? out.boardReset : out.touched.has(file.cardId ?? "");
  if (out.overwrite.has(file.path) || pushed) return forced(run, out, file);
  // An edit made meanwhile is caught by the pull itself (it reads the file now); a removal isn't.
  if (run.store.changedSince(file.path) && run.store.readLocal(file.path) === null) {
    keptRemoval(run, out, file);
    return "kept";
  }
  return "pull";
}
