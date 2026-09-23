// What the mirror holds now: list and card directory names by Planka id, read from the manifest
// and the local board.yaml, so a pull keeps prefixes and can relocate renamed directories.
import { BOARD_FILE, CARD_FILE } from "./card.ts";
import { parseBoardYaml } from "./checks.ts";
import type { CurrentNames } from "./model.ts";
import type { Manifest, Store } from "./state.ts";

const lastSegment = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
const parentDir = (path: string): string => path.slice(0, path.lastIndexOf("/"));

/** Card id → full card dir from the previous run's manifest. */
export function previousCardDirs(previous: Manifest, boardDir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [path, entry] of Object.entries(previous.files)) {
    if (entry.kind !== "card" || !entry.id || !path.startsWith(`${boardDir}/`)) continue;
    if (lastSegment(path) === CARD_FILE) out.set(entry.id, parentDir(path));
  }
  return out;
}

/** List id → full list dir, from the local board.yaml (unreadable: prefixes start over). */
export function previousListDirs(store: Store, boardDir: string): Map<string, string> {
  const out = new Map<string, string>();
  const board = parseBoardYaml(store.readLocal(`${boardDir}/${BOARD_FILE}`) ?? "");
  for (const l of board?.lists ?? []) if (l.id && l.dir) out.set(l.id, `${boardDir}/${l.dir}`);
  return out;
}

export function currentNames(store: Store, previous: Manifest, boardDir: string): CurrentNames {
  const cards = previousCardDirs(previous, boardDir);
  const lists = previousListDirs(store, boardDir);
  return {
    listDir: (id) => {
      const dir = lists.get(id);
      return dir === undefined ? null : lastSegment(dir);
    },
    cardDir: (id) => {
      const dir = cards.get(id);
      return dir === undefined || !store.exists(dir) ? null : lastSegment(dir);
    },
  };
}
