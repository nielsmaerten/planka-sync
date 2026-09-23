// Order pushes: the prefixes on disk decide card order within a list and list order on a board.
import { apiError } from "./api.ts";
import type { LocalCard } from "./local.ts";
import { byPrefix, type Placed, positionsFor } from "./order.ts";
import { resolveListId } from "./model.ts";
import type { Planned, Pass } from "./reconcile.ts";

export interface FreshCard {
  local: LocalCard;
  listId: string;
  position: number;
}

function wantedPerList(pass: Pass, planned: Planned[]): Map<string, (Planned | LocalCard)[]> {
  const perList = new Map<string, (Planned | LocalCard)[]>();
  const add = (listDir: string, item: Planned | LocalCard) =>
    perList.set(listDir, [...(perList.get(listDir) ?? []), item]);
  for (const p of planned) if (!p.plan.blocked) add(p.local.listDir, p);
  for (const f of pass.local.fresh) add(f.listDir, f);
  return perList;
}

const isPlanned = (x: Planned | LocalCard): x is Planned => "plan" in x;

function placed(pass: Pass, listId: string, item: Planned | LocalCard): Placed {
  if (!isPlanned(item)) return { id: `fresh:${item.dir}`, remote: null };
  const stays = item.plan.moveTo === undefined;
  const remote = stays ? (pass.built.index.cardPositions.get(item.remote.id) ?? null) : null;
  return { id: item.remote.id, remote: remote === null ? null : remote };
}

function applyPositions(
  items: (Planned | LocalCard)[],
  positions: Map<string, number>,
  listId: string,
  fresh: FreshCard[],
): void {
  for (const item of items) {
    if (!isPlanned(item)) {
      const position = positions.get(`fresh:${item.dir}`) ?? 65536;
      fresh.push({ local: item, listId, position });
      continue;
    }
    const position = positions.get(item.remote.id);
    if (position === undefined) continue;
    if (item.plan.moveTo) item.plan.ops.unshift({ op: "move", listId: item.plan.moveTo, position });
    else item.plan.ops.push({ op: "position", position });
  }
}

const unplaceable = (items: (Planned | LocalCard)[]): FreshCard[] =>
  items
    .filter((i): i is LocalCard => !isPlanned(i))
    .map((local) => ({ local, listId: "", position: 0 }));

/**
 * Fills in `move` ops and `position` ops from the prefixes on disk and decides the position of
 * every fresh card. Returns the fresh cards in creation order.
 */
export function orderCards(pass: Pass, planned: Planned[]): FreshCard[] {
  const fresh: FreshCard[] = [];
  for (const [listDir, items] of wantedPerList(pass, planned)) {
    const listId = resolveListId(pass.built.index, listDir);
    if (!listId || pass.built.index.builtinDirs.has(listDir)) {
      // Unknown or built-in list: the card plans are blocked elsewhere; fresh cards get reported.
      fresh.push(...unplaceable(items));
      continue;
    }
    const wanted = byPrefix(
      items.map((item) => ({ item, order: isPlanned(item) ? item.local.order : item.order })),
    );
    const positions = positionsFor(wanted.map((w) => placed(pass, listId, w.item)));
    applyPositions(
      wanted.map((w) => w.item),
      positions,
      listId,
      fresh,
    );
  }
  return fresh;
}

/** List directories renamed to a different prefix order become list position updates. */
export async function orderLists(pass: Pass): Promise<void> {
  const { run, built } = pass;
  const { builtinDirs, listPositions, boardDir } = built.index;
  const known = [...pass.local.listOrders]
    .filter(([dir]) => !builtinDirs.has(dir) && resolveListId(built.index, dir) !== undefined)
    .map(([dir, order]) => ({ id: resolveListId(built.index, dir)!, order }));
  const wanted = byPrefix(known);
  const positions = positionsFor(
    wanted.map((l) => ({ id: l.id, remote: listPositions.get(l.id) ?? null })),
  );
  if (positions.size === 0) return;
  if (run.dry) return void run.rec.add("pushed", boardDir, `would reorder ${positions.size} lists`);
  try {
    for (const [listId, position] of positions) await run.api.updateList(listId, { position });
    run.rec.add("pushed", boardDir, `reordered ${positions.size} lists`);
    pass.out.boardReset = true;
  } catch (err) {
    run.rec.add("failed", boardDir, apiError(err));
  }
}
