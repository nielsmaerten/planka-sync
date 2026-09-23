// Fetches a board snapshot, completes it with archived/trashed cards and comments, builds files.
import { type BoardFiles, type BuildOptions, buildBoardFiles } from "./model.ts";
import type { CardIncluded, Comment, Planka, Snapshot } from "./planka.ts";

const CARD_INCLUDED = [
  "cardLabels",
  "tasks",
  "taskLists",
  "attachments",
  "cardMemberships",
] as const;

function mergeIncluded(snap: Snapshot, included: CardIncluded): void {
  for (const key of CARD_INCLUDED) snap.included[key].push(...(included[key] as never[]));
  const known = new Set(snap.included.users.map((u) => u.id));
  snap.included.users.push(...included.users.filter((u) => !known.has(u.id)));
}

/** Board snapshots omit cards in the built-in archive/trash lists; one call per list adds them. */
async function withArchivedCards(api: Planka, snap: Snapshot): Promise<Snapshot> {
  for (const list of snap.included.lists.filter((l) => l.name === null)) {
    const page = await api.listCards(list.id);
    snap.included.cards.push(...page.items);
    mergeIncluded(snap, page.included);
  }
  return snap;
}

async function fetchComments(api: Planka, snap: Snapshot): Promise<Map<string, Comment[]>> {
  const out = new Map<string, Comment[]>();
  for (const card of snap.included.cards) {
    if (card.commentsTotal > 0) out.set(card.id, await api.listComments(card.id));
  }
  return out;
}

export async function snapshotBoard(
  api: Planka,
  boardId: string,
  boardDir: string,
  opts: BuildOptions,
): Promise<BoardFiles> {
  const snap = await withArchivedCards(api, await api.snapshot(boardId));
  return buildBoardFiles(snap, await fetchComments(api, snap), boardDir, opts);
}
