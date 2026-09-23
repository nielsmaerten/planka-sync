// Attachment downloads during the pull phase.
import { apiError } from "./api.ts";
import type { AttachmentSpec, BoardFiles } from "./model.ts";
import type { BoardOutcome } from "./reconcile.ts";
import type { Run } from "./sync.ts";

async function ensureAttachment(run: Run, att: AttachmentSpec): Promise<void> {
  run.next[att.path] = { kind: "attachment", hash: null, id: att.id, cardId: att.cardId };
  if (run.store.exists(att.path)) return run.rec.unchanged();
  if (run.dry) return run.rec.add("downloaded", att.path);
  try {
    run.store.writeLocal(att.path, await run.api.downloadAttachment(att.source));
    run.rec.add("downloaded", att.path);
  } catch (err) {
    run.rec.add("failed", att.path, apiError(err));
    delete run.next[att.path];
  }
}

export async function pullAttachments(
  run: Run,
  built: BoardFiles,
  out: BoardOutcome,
): Promise<void> {
  for (const att of built.attachments) {
    if (out.keep.has(att.cardId)) keepPrevious(run, att.cardId, att.path);
    else await ensureAttachment(run, att);
  }
}

/** A kept card's attachment stays where the last run recorded it (or nowhere yet). */
function keepPrevious(run: Run, cardId: string, path: string): void {
  for (const [rel, entry] of Object.entries(run.previous.files))
    if (entry.kind === "attachment" && entry.cardId === cardId) run.next[rel] = entry;
  run.rec.add("kept", path, "card blocked; not downloaded");
}
