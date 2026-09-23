// Turns a board snapshot into the directory layout the mirror should contain.
import { stringify } from "yaml";
import { BOARD_FILE } from "./card.ts";
import { cardFiles } from "./cardfiles.ts";
import {
  assignOrders,
  formatPrefixed,
  type Ordering,
  parsePrefixed,
  slugify,
  uniqueSlugs,
} from "./naming.ts";
import type { Attachment, Comment, List, Snapshot, Task, TaskList } from "./planka.ts";
import type { Kind } from "./state.ts";

export interface FileSpec {
  path: string;
  content: string;
  kind: Kind;
  /** Where the base copy lives, independent of the mirror path: boards/<id>/…, cards/<id>/…. */
  baseKey: string;
  /** Card id for card files, comment id for comments, board id for board.yaml. */
  id?: string;
  /** The card a description or comment belongs to. */
  cardId?: string;
  /** Username of a comment's author. */
  author?: string;
}
export interface AttachmentSpec {
  cardId: string;
  id: string;
  path: string;
  source: Attachment;
}
/** Name → id lookups the push side needs to turn files back into API calls. */
export interface BoardIndex {
  boardId: string;
  boardDir: string;
  listIdByDir: Map<string, string>;
  /** Named lists by the slug part of their directory, for directories renamed to another prefix. */
  listIdBySlug: Map<string, string>;
  /** Dirs of Planka's built-in archive/trash lists; files there are pull-only. */
  builtinDirs: Set<string>;
  labelIdByName: Map<string, string>;
  userIdByName: Map<string, string>;
  trashListId: string | undefined;
  taskLists: TaskList[];
  tasks: Task[];
  /** Card id → its directory (relative to root). */
  cardDirs: Map<string, string>;
  /** List id → its directory (relative to root). */
  listDirs: Map<string, string>;
  /** Planka positions, for order pushes. */
  cardPositions: Map<string, number>;
  listPositions: Map<string, number>;
}
export interface BoardFiles {
  files: FileSpec[];
  attachments: AttachmentSpec[];
  index: BoardIndex;
}

/** What the mirror holds now, so pulls keep prefixes and names stable. */
export interface CurrentNames {
  /** List id → directory name (one segment) currently on disk. */
  listDir: (id: string) => string | null;
  /** Card id → directory name (one segment) currently on disk. */
  cardDir: (id: string) => string | null;
}
export const noCurrent: CurrentNames = { listDir: () => null, cardDir: () => null };

/** Named lists (active and closed) by position, then Planka's built-in archive and trash lists. */
function mirroredLists(snap: Snapshot): List[] {
  const { lists } = snap.included;
  const named = lists.filter((l) => l.name !== null).sort(byPosition);
  const builtin = lists.filter((l) => l.name === null).sort((a, b) => a.type.localeCompare(b.type));
  return [...named, ...builtin];
}

const listLabel = (l: List): string => l.name ?? l.type;

/** Prefixed names for items in Planka order, keeping the prefixes they already have on disk. */
function prefixedNames<T extends { id: string; name: string | null }>(
  items: T[],
  current: (id: string) => string | null,
  force?: Ordering,
): Map<string, string> {
  const slugs = uniqueSlugs(items);
  const ordering =
    force ??
    assignOrders(
      items.map((it) => {
        const now = current(it.id);
        return { id: it.id, current: now === null ? null : parsePrefixed(now).order };
      }),
    );
  return new Map(
    items.map((it) => [
      it.id,
      formatPrefixed(ordering.orders.get(it.id)!, slugs.get(it.id)!, ordering.width),
    ]),
  );
}

/** Named lists get prefixed dirs; built-in lists use their type as the name. */
function listDirNames(lists: List[], current: CurrentNames, force?: Ordering): Map<string, string> {
  const named = lists.filter((l) => l.name !== null);
  const dirs = prefixedNames(named, current.listDir, force);
  for (const l of lists) if (!dirs.has(l.id)) dirs.set(l.id, slugify(l.type));
  return dirs;
}

export interface Context {
  snap: Snapshot;
  users: Map<string, string>;
  labelNames: Map<string, string>;
  comments: Map<string, Comment[]>;
}
export const username = (ctx: Context, userId: string): string => ctx.users.get(userId) ?? userId;
export const byPosition = <T extends { position: number | null }>(a: T, b: T): number =>
  (a.position ?? 0) - (b.position ?? 0);
export function boardYaml(ctx: Context, lists: List[], dirs: Map<string, string>): string {
  const { labels, boardMemberships } = ctx.snap.included;
  return stringify(
    {
      id: ctx.snap.item.id,
      name: ctx.snap.item.name,
      lists: lists.map((l) => ({
        dir: dirs.get(l.id),
        name: listLabel(l),
        type: l.type,
        id: l.id,
      })),
      labels: labels
        .slice()
        .sort(byPosition)
        .map((l) => ({ name: l.name, color: l.color, id: l.id })),
      members: boardMemberships.map((m) => ({ user: username(ctx, m.userId), role: m.role })),
    },
    { lineWidth: 0 },
  );
}

/** The list a local directory stands for: by exact name, else by slug (prefix renamed). */
export const resolveListId = (index: BoardIndex, dir: string): string | undefined =>
  index.listIdByDir.get(dir) ?? index.listIdBySlug.get(parsePrefixed(dir).slug);

export interface BuildOptions {
  current?: CurrentNames;
  /** Ignore the prefixes on disk and number everything from 010 again. */
  renumber?: boolean;
}

export function buildBoardFiles(
  snap: Snapshot,
  comments: Map<string, Comment[]>,
  boardDir: string,
  opts: BuildOptions = {},
): BoardFiles {
  const current = opts.current ?? noCurrent;
  const ctx: Context = {
    snap,
    users: new Map(snap.included.users.map((u) => [u.id, u.username])),
    labelNames: new Map(snap.included.labels.map((l) => [l.id, l.name])),
    comments,
  };
  const lists = mirroredLists(snap);
  const fresh = (ids: string[]) => (opts.renumber ? renumberIds(ids) : undefined);
  const dirs = listDirNames(
    lists,
    current,
    fresh(lists.filter((l) => l.name !== null).map((l) => l.id)),
  );
  const files: FileSpec[] = [
    {
      path: `${boardDir}/${BOARD_FILE}`,
      content: boardYaml(ctx, lists, dirs),
      kind: "board",
      baseKey: `boards/${snap.item.id}/${BOARD_FILE}`,
      id: snap.item.id,
    },
  ];
  const attachments: AttachmentSpec[] = [];
  const cardDirs = new Map<string, string>();
  for (const list of lists) {
    const cards = snap.included.cards.filter((c) => c.listId === list.id).sort(byPosition);
    const names = prefixedNames(cards, current.cardDir, fresh(cards.map((c) => c.id)));
    for (const card of cards) {
      const cardDir = `${boardDir}/${dirs.get(list.id)}/${names.get(card.id)}`;
      cardDirs.set(card.id, cardDir);
      const [f, a] = cardFiles(ctx, card, cardDir);
      files.push(...f);
      attachments.push(...a);
    }
  }
  return { files, attachments, index: buildIndex(ctx, { boardDir, lists, dirs, cardDirs }) };
}

function renumberIds(ids: string[]): Ordering {
  return assignOrders(ids.map((id) => ({ id, current: null })));
}

interface Layout {
  boardDir: string;
  lists: List[];
  dirs: Map<string, string>;
  cardDirs: Map<string, string>;
}

function buildIndex(ctx: Context, { boardDir, lists, dirs, cardDirs }: Layout): BoardIndex {
  const { labels, users, cards } = ctx.snap.included;
  return {
    boardId: ctx.snap.item.id,
    boardDir,
    listIdByDir: new Map(lists.map((l) => [dirs.get(l.id)!, l.id])),
    listIdBySlug: new Map(
      lists.filter((l) => l.name !== null).map((l) => [parsePrefixed(dirs.get(l.id)!).slug, l.id]),
    ),
    builtinDirs: new Set(lists.filter((l) => l.name === null).map((l) => dirs.get(l.id)!)),
    labelIdByName: new Map(labels.map((l) => [l.name, l.id])),
    userIdByName: new Map(users.map((u) => [u.username, u.id])),
    trashListId: lists.find((l) => l.type === "trash")?.id,
    taskLists: ctx.snap.included.taskLists,
    tasks: ctx.snap.included.tasks,
    cardDirs,
    listDirs: new Map(lists.map((l) => [l.id, `${boardDir}/${dirs.get(l.id)!}`])),
    cardPositions: new Map(cards.map((c) => [c.id, c.position])),
    listPositions: new Map(lists.map((l) => [l.id, l.position ?? 0])),
  };
}
