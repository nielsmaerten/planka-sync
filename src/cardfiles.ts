// The files of one card: card.yaml, description.md, comment files and attachment specs.
import { stringify } from "yaml";
import { ATTACHMENTS_DIR, CARD_FILE, COMMENTS_DIR, DESCRIPTION_FILE } from "./card.ts";
import { type AttachmentSpec, byPosition, type Context, type FileSpec, username } from "./model.ts";
import { slugify, splitExt, uniqueSlugs } from "./naming.ts";
import type { Attachment, Card, Comment } from "./planka.ts";

function cardTasks(ctx: Context, cardId: string) {
  const { tasks, taskLists } = ctx.snap.included;
  return taskLists
    .filter((tl) => tl.cardId === cardId)
    .sort(byPosition)
    .map((tl) => ({
      name: tl.name,
      items: tasks
        .filter((t) => t.taskListId === tl.id)
        .sort(byPosition)
        .map((t) => ({
          id: t.id,
          name: t.name,
          done: t.isCompleted,
          ...(t.assigneeUserId ? { assignee: username(ctx, t.assigneeUserId) } : {}),
        })),
    }));
}

/** `comments/2026-09-23-1730-admin.md` (UTC); a second comment in the same minute gets `-2`. */
export function commentStem(c: Comment, author: string): string {
  const d = c.createdAt;
  return `${d.slice(0, 10)}-${d.slice(11, 13)}${d.slice(14, 16)}-${slugify(author)}`;
}

function commentFiles(ctx: Context, cardId: string, cardDir: string): FileSpec[] {
  const list = (ctx.comments.get(cardId) ?? [])
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const names = uniqueSlugs(
    list.map((c) => ({ id: c.id, name: commentStem(c, username(ctx, c.userId)) })),
  );
  return list.map((c) => ({
    path: `${cardDir}/${COMMENTS_DIR}/${names.get(c.id)}.md`,
    content: `${c.text.trimEnd()}\n`,
    kind: "comment" as const,
    baseKey: `cards/${cardId}/comments/${c.id}.md`,
    id: c.id,
    cardId,
  }));
}

/** ponytail: only `file` attachments are downloaded; `link` attachments are not mirrored. */
function cardAttachments(atts: Attachment[], cardDir: string): AttachmentSpec[] {
  const files = atts.filter((a) => a.type !== "link");
  const names = uniqueSlugs(files.map((a) => ({ id: a.id, name: splitExt(a.name)[0] })));
  return files.map((a) => ({
    cardId: a.cardId,
    id: a.id,
    path: `${cardDir}/${ATTACHMENTS_DIR}/${names.get(a.id)}${splitExt(a.name)[1]}`,
    source: a,
  }));
}

function cardYaml(ctx: Context, card: Card): string {
  const { cardLabels, cardMemberships } = ctx.snap.included;
  return stringify(
    {
      id: card.id,
      title: card.name,
      labels: cardLabels
        .filter((cl) => cl.cardId === card.id)
        .map((cl) => ctx.labelNames.get(cl.labelId)),
      members: cardMemberships
        .filter((m) => m.cardId === card.id)
        .map((m) => username(ctx, m.userId)),
      due: card.dueDate,
      dueCompleted: card.isDueCompleted,
      tasks: cardTasks(ctx, card.id),
    },
    { lineWidth: 0 },
  );
}

export function cardFiles(
  ctx: Context,
  card: Card,
  cardDir: string,
): [FileSpec[], AttachmentSpec[]] {
  const files: FileSpec[] = [
    {
      path: `${cardDir}/${CARD_FILE}`,
      content: cardYaml(ctx, card),
      kind: "card",
      baseKey: `cards/${card.id}/${CARD_FILE}`,
      id: card.id,
      cardId: card.id,
    },
    {
      path: `${cardDir}/${DESCRIPTION_FILE}`,
      content: `${(card.description ?? "").trimEnd()}\n`,
      kind: "description",
      baseKey: `cards/${card.id}/${DESCRIPTION_FILE}`,
      id: card.id,
      cardId: card.id,
    },
    ...commentFiles(ctx, card.id, cardDir),
  ];
  const atts = ctx.snap.included.attachments.filter((a) => a.cardId === card.id);
  return [files, cardAttachments(atts, cardDir)];
}
