// Structural pushes: creating cards from new directories, trashing cards whose directory went
// away, uploading new attachments.
import { apiError } from "./api.ts";
import { ATTACHMENTS_DIR, CARD_FILE } from "./card.ts";
import { checkCard } from "./checks.ts";
import { metaOps, type Op } from "./diff.ts";
import type { LocalCard } from "./local.ts";
import type { FreshCard } from "./ordering.ts";
import { type Pass, push } from "./reconcile.ts";
import type { RemoteCard } from "./verdict.ts";

/** A remote card whose directory was produced before and is gone now: send it to the trash. */
function trashable(pass: Pass, remote: RemoteCard): boolean {
  const { index } = pass.built;
  const producedBefore = `${remote.dir}/${CARD_FILE}` in pass.run.previous.files;
  return (
    producedBefore && !index.builtinDirs.has(remote.listDir) && index.trashListId !== undefined
  );
}

async function trashOne(pass: Pass, r: RemoteCard): Promise<void> {
  const { run } = pass;
  const { trashListId, cardPositions } = pass.built.index;
  if (run.dry) return void run.rec.add("pushed", r.dir, "would trash the card (directory removed)");
  try {
    const bottom = Math.max(0, ...cardPositions.values()) + 65536;
    await run.api.updateCard(r.id, { listId: trashListId!, position: bottom });
    run.rec.add("pushed", r.dir, "trashed (directory removed)");
    pass.out.touched.add(r.id);
  } catch (err) {
    run.rec.add("failed", r.dir, apiError(err));
  }
}

export async function trashCards(pass: Pass, gone: RemoteCard[]): Promise<void> {
  const { run } = pass;
  const cards = gone.filter((r) => trashable(pass, r));
  if (cards.length === 0) return;
  run.trashed += cards.length;
  if (run.trashed > run.cfg.deletionCap && !run.yes) {
    // Not marked handled: the pull phase restores the directories from Planka.
    const why =
      `${cards.length} card directories disappeared, more than the deletion cap (${run.cfg.deletionCap}); ` +
      "nothing was trashed and the directories are restored. Remove fewer at a time, pass --yes, or raise deletionCap in planka-sync.yaml";
    run.rec.add("error", pass.built.index.boardDir, why);
    return;
  }
  for (const r of cards) await trashOne(pass, r);
}

/** Labels, members, tasks, due and comments of a just-created card, against an empty card. */
function freshOps(pass: Pass, fresh: LocalCard, title: string): Op[] {
  const extras = metaOps({ local: fresh.meta, remote: { title }, index: pass.built.index });
  const comments = [...fresh.comments].map(([name, text]) => ({
    op: "comment-create" as const,
    path: `${fresh.dir}/comments/${name}`,
    text: text.trimEnd(),
  }));
  return [...("ops" in extras ? extras.ops : []), ...comments];
}

async function create(pass: Pass, f: FreshCard, title: string): Promise<string | null> {
  const { run } = pass;
  try {
    const body = (f.local.description ?? "").trimEnd();
    return (await run.api.createCard(f.listId, title, body, f.position)).id;
  } catch (err) {
    run.rec.add("failed", f.local.dir, apiError(err));
    return null;
  }
}

/** A card directory without an id: create the card, then push its extras against an empty card. */
async function createCard(pass: Pass, f: FreshCard): Promise<void> {
  const { run } = pass;
  const { local } = f;
  const errors = checkCard(local.meta, local.listDir, pass.board);
  if (!f.listId || errors.length > 0) {
    const why = errors.join("; ") || `"${local.listDir}" is not a list directory`;
    return void run.rec.add("blocked", local.dir, why);
  }
  const title = String(local.meta.title);
  if (run.dry) return void run.rec.add("pushed", local.dir, `would create card "${title}"`);
  const cardId = await create(pass, f, title);
  if (cardId === null) return;
  pass.out.touched.add(cardId);
  pass.out.dirs.set(cardId, local.dir);
  const ops = freshOps(pass, local, title);
  if (ops.length > 0) await push(pass, cardId, local.dir, ops);
  else run.rec.add("pushed", local.dir, `created card "${title}"`);
  await uploadNew(pass, cardId, local, local.dir);
}

export async function createCards(pass: Pass, fresh: FreshCard[]): Promise<void> {
  for (const f of fresh) await createCard(pass, f);
}

/** Local attachment paths no previous run produced: new files to upload. */
function newAttachments(
  local: LocalCard,
  previous: Record<string, unknown>,
  remoteDir: string,
): string[] {
  return local.attachments
    .map(
      (name) =>
        [
          `${local.dir}/${ATTACHMENTS_DIR}/${name}`,
          `${remoteDir}/${ATTACHMENTS_DIR}/${name}`,
        ] as const,
    )
    .filter(([here, there]) => !(here in previous) && !(there in previous))
    .map(([here]) => here);
}

/** New files in the card's attachments directory go up; the re-pull names them canonically. */
export async function uploadNew(
  pass: Pass,
  cardId: string,
  local: LocalCard,
  remoteDir: string,
): Promise<void> {
  const { run } = pass;
  for (const rel of newAttachments(local, run.previous.files, remoteDir)) {
    if (run.dry) {
      run.rec.add("pushed", rel, "would upload");
      continue;
    }
    try {
      await run.api.uploadAttachment(cardId, `${run.cfg.root}/${rel}`);
      run.rec.add("pushed", rel, "uploaded");
      pass.out.touched.add(cardId);
      pass.out.tidy.push(rel);
    } catch (err) {
      run.rec.add("failed", rel, apiError(err));
      run.next[rel] = { kind: "attachment", hash: null, cardId };
    }
  }
}
