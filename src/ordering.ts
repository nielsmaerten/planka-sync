// Order pushes: the prefixes on disk decide card order within a list and list order on a board.
import { apiError } from "./api.ts";
import type { LocalCard } from "./local.ts";
import { byPrefix, type Placed, positionsFor } from "./order.ts";
import { previousListDirs } from "./current.ts";
import { resolveListId } from "./model.ts";
import { parsePrefixed } from "./naming.ts";
import { listDirOf, type Planned, type Pass } from "./reconcile.ts";

export interface FreshCard {
  local: LocalCard;
  listId: string;
  position: number;
}

function wantedPerList(pass: Pass, planned: Planned[]): Map<string, (Planned | LocalCard)[]> {
  const perList = new Map<string, (Planned | LocalCard)[]>();
  const add = (listDir: string, item: Planned | LocalCard) =>
    perList.set(listDir, [...(perList.get(listDir) ?? []), item]);
  for (const p of planned) if (!p.plan.blocked && !p.plan.pulledMove) add(p.local.listDir, p);
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

/** Ids in the order the last run wrote them into this list (by resolved list id). */
function previousOrder(pass: Pass, listId: string): string[] {
  const rows: { id: string; order: number | null }[] = [];
  for (const [id, dir] of pass.previousDirs) {
    const listDir = listDirOf(dir);
    if (listDir === null || resolveListId(pass.built.index, listDir) !== listId) continue;
    rows.push({ id, order: parsePrefixed(dir.slice(dir.lastIndexOf("/") + 1)).order });
  }
  return byPrefix(rows).map((r) => r.id);
}

const sameSequence = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Fills in `move` ops and `position` ops from the prefixes on disk and decides the position of
 * every fresh card. A list whose local order is what the last run wrote is left alone, so a
 * reorder made in Planka is pulled, not reverted. Returns the fresh cards in creation order.
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
    const ids = wanted.map((w) => (isPlanned(w.item) ? w.item.remote.id : `fresh:${w.item.dir}`));
    if (sameSequence(ids, previousOrder(pass, listId))) continue;
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

/** List ids in the order the local board.yaml (written by the last run) lists them. */
function previousListOrder(pass: Pass): string[] {
  const { boardDir, builtinDirs } = pass.built.index;
  const rows = [...previousListDirs(pass.run.store, boardDir)]
    .map(([id, dir]) => ({ id, name: dir.slice(dir.lastIndexOf("/") + 1) }))
    .filter(({ name }) => !builtinDirs.has(name))
    .map(({ id, name }) => ({ id, order: parsePrefixed(name).order }));
  return byPrefix(rows).map((r) => r.id);
}

/** List directories renamed to a different prefix order become list position updates. */
export async function orderLists(pass: Pass): Promise<void> {
  const { run, built } = pass;
  const { builtinDirs, listPositions, boardDir } = built.index;
  const known = [...pass.local.listOrders]
    .filter(([dir]) => !builtinDirs.has(dir) && resolveListId(built.index, dir) !== undefined)
    .map(([dir, order]) => ({ id: resolveListId(built.index, dir)!, order }));
  const wanted = byPrefix(known);
  if (
    sameSequence(
      wanted.map((l) => l.id),
      previousListOrder(pass),
    )
  )
    return;
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
