// Turns the order prefixes on disk into Planka positions: only items that sort differently from
// Planka's order get a new position, chosen between the neighbours it now sits between.
export const POSITION_STEP = 65536;

export interface Placed {
  id: string;
  /** Planka's current position, or null for an item new to this list. */
  remote: number | null;
}

/** Position for the item at `i` in the wanted order, given what is kept before and after it. */
function between(prev: number, next: number | null): number | null {
  if (next === null) return prev + POSITION_STEP;
  const gap = next - prev;
  return gap >= 2 ? prev + Math.floor(gap / 2) : null;
}

function nextKept(items: Placed[], i: number, last: number): number | null {
  for (let j = i + 1; j < items.length; j++) {
    const r = items[j]!.remote;
    if (r !== null && r > last) return r;
  }
  return null;
}

/**
 * `items` in the wanted order. Returns the positions to set, keyed by id, for the items whose
 * Planka position no longer fits the wanted order. When a gap between neighbours is exhausted,
 * every following item gets a fresh position.
 */
export function positionsFor(items: Placed[]): Map<string, number> {
  const out = new Map<string, number>();
  let last = 0;
  let renumbering = false;
  for (let i = 0; i < items.length; i++) {
    const { id, remote } = items[i]!;
    if (!renumbering && remote !== null && remote > last) {
      last = remote;
      continue;
    }
    let position = renumbering ? last + POSITION_STEP : between(last, nextKept(items, i, last));
    if (position === null) {
      renumbering = true;
      position = last + POSITION_STEP;
    }
    out.set(id, position);
    last = position;
  }
  return out;
}

/** Sorts by prefix; items without a prefix go last, in the order given. */
export function byPrefix<T extends { order: number | null }>(items: T[]): T[] {
  const withOrder = items.filter((i) => i.order !== null).sort((a, b) => a.order! - b.order!);
  return [...withOrder, ...items.filter((i) => i.order === null)];
}
