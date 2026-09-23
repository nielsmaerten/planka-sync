// Filesystem names for Planka entities: slugs, collision suffixes, and the order prefixes that
// make filesystem sort order match Planka's order.
const SLUG_MAX = 60;
export const PREFIX_STEP = 10;
export const PREFIX_WIDTH = 3;

export function slugify(name: string | null): string {
  const base = (name ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/, "");
  return base || "untitled";
}

/** Slugs in the given order; a repeated slug gets `-2`, `-3`, … */
export function uniqueSlugs<T extends { id: string; name: string | null }>(
  items: T[],
): Map<string, string> {
  const seen = new Map<string, number>();
  const out = new Map<string, string>();
  for (const item of items) {
    const slug = slugify(item.name);
    const n = (seen.get(slug) ?? 0) + 1;
    seen.set(slug, n);
    out.set(item.id, n === 1 ? slug : `${slug}-${n}`);
  }
  return out;
}

export function splitExt(name: string): [string, string] {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? [name.slice(0, dot), name.slice(dot).toLowerCase()] : [name, ""];
}

export interface Prefixed {
  order: number | null;
  slug: string;
}

/** `020-my-card` → order 20, slug `my-card`; a name without a prefix has order null. */
export function parsePrefixed(name: string): Prefixed {
  const m = /^(\d+)-(.+)$/.exec(name);
  if (!m) return { order: null, slug: name };
  return { order: Number(m[1]), slug: m[2]! };
}

export const formatPrefixed = (order: number, slug: string, width = PREFIX_WIDTH): string =>
  `${String(order).padStart(width, "0")}-${slug}`;

export interface OrderInput {
  id: string;
  /** The prefix the entity has on disk now, or null when it is new to the mirror. */
  current: number | null;
}
export interface Ordering {
  orders: Map<string, number>;
  width: number;
}

/** The next existing prefix after index i that is still usable as an upper bound. */
function nextBound(items: OrderInput[], i: number, last: number): number {
  for (let j = i + 1; j < items.length; j++) {
    const c = items[j]!.current;
    if (c !== null && c > last) return c;
  }
  return Infinity;
}

/**
 * Gives every item (in Planka order) an order number. Existing numbers are kept when they still
 * sort correctly; new items take a free number below the next kept one; when no number fits,
 * the rest of the list is renumbered in steps of PREFIX_STEP.
 */
export function assignOrders(items: OrderInput[]): Ordering {
  const orders = new Map<string, number>();
  let last = 0;
  let renumbering = false;
  for (let i = 0; i < items.length; i++) {
    const { id, current } = items[i]!;
    let order: number;
    if (!renumbering && current !== null && current > last) order = current;
    else if (renumbering) order = last + PREFIX_STEP;
    else {
      const bound = nextBound(items, i, last);
      const mid = last + Math.floor((bound - last) / 2);
      order = Math.min(last + PREFIX_STEP, mid);
      if (order <= last) {
        renumbering = true;
        order = last + PREFIX_STEP;
      }
    }
    orders.set(id, order);
    last = order;
  }
  const width = Math.max(PREFIX_WIDTH, String(last).length);
  return { orders, width };
}

/** Full renumbering: 010, 020, … in the given order. */
export function renumber(ids: string[]): Ordering {
  const orders = new Map(ids.map((id, i) => [id, (i + 1) * PREFIX_STEP]));
  return { orders, width: Math.max(PREFIX_WIDTH, String(ids.length * PREFIX_STEP).length) };
}
