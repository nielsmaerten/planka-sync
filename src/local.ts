// Reads the card directories of one board from disk.
import { type Dirent, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  ATTACHMENTS_DIR,
  CARD_FILE,
  type CardYaml,
  COMMENTS_DIR,
  DESCRIPTION_FILE,
  parseCardYaml,
} from "./card.ts";
import type { BoardIndex } from "./model.ts";
import { parsePrefixed } from "./naming.ts";
import type { Manifest, Store } from "./state.ts";

export interface LocalCard {
  /** Card directory relative to root. */
  dir: string;
  listDir: string;
  /** Order prefix of the directory name, null when it has none. */
  order: number | null;
  meta: CardYaml;
  cardYaml: string;
  description: string | null;
  /** Comment file name → content. */
  comments: Map<string, string>;
  attachments: string[];
}

export interface LocalBoard {
  byId: Map<string, LocalCard>;
  /** Card directories without an id: cards to create. */
  fresh: LocalCard[];
  /** Card ids whose local card.yaml is unreadable, with the reason; left alone this run. */
  invalid: Map<string, string>;
  /** Unreadable card.yaml paths that no previous run produced (nothing to protect). */
  broken: { path: string; reason: string }[];
  /** List directory name → its order prefix, for list reorders. */
  listOrders: Map<string, number | null>;
}

const dirs = (abs: string): Dirent[] => {
  try {
    return readdirSync(abs, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return [];
  }
};
const fileNames = (abs: string): string[] => {
  try {
    return readdirSync(abs, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
};

function readCard(store: Store, dir: string, listDir: string): LocalCard | string | null {
  const cardYaml = store.readLocal(`${dir}/${CARD_FILE}`);
  if (cardYaml === null) return null;
  const meta = parseCardYaml(cardYaml);
  if (typeof meta === "string") return meta;
  const comments = new Map<string, string>();
  for (const name of fileNames(join(store.root, dir, COMMENTS_DIR))) {
    if (name.endsWith(".md"))
      comments.set(name, store.readLocal(`${dir}/${COMMENTS_DIR}/${name}`)!);
  }
  return {
    dir,
    listDir,
    order: parsePrefixed(dir.slice(dir.lastIndexOf("/") + 1)).order,
    meta,
    cardYaml,
    description: store.readLocal(`${dir}/${DESCRIPTION_FILE}`),
    comments,
    attachments: fileNames(join(store.root, dir, ATTACHMENTS_DIR)),
  };
}

function place(out: LocalBoard, previous: Manifest, dir: string, card: LocalCard | string): void {
  if (typeof card !== "string") {
    if (card.meta.id !== undefined) out.byId.set(String(card.meta.id), card);
    else out.fresh.push(card);
    return;
  }
  const known = previous.files[`${dir}/${CARD_FILE}`]?.id;
  if (known) out.invalid.set(known, card);
  else out.broken.push({ path: `${dir}/${CARD_FILE}`, reason: card });
}

/** A directory the last run produced that still exists but lost its card.yaml: not a deletion. */
function missingCardYaml(
  out: LocalBoard,
  store: Store,
  previous: Manifest,
  boardDir: string,
): void {
  for (const [path, entry] of Object.entries(previous.files)) {
    if (entry.kind !== "card" || !path.startsWith(`${boardDir}/`) || !entry.id) continue;
    const dir = path.slice(0, path.lastIndexOf("/"));
    if (!out.byId.has(entry.id) && store.exists(dir) && !store.exists(path))
      out.invalid.set(
        entry.id,
        `${CARD_FILE} is missing (remove the whole directory to trash the card)`,
      );
  }
}

/** Every card directory under the board's list directories (built-in lists included). */
export function scanBoard(store: Store, previous: Manifest, index: BoardIndex): LocalBoard {
  const out: LocalBoard = {
    byId: new Map(),
    fresh: [],
    invalid: new Map(),
    broken: [],
    listOrders: new Map(),
  };
  for (const list of dirs(join(store.root, index.boardDir))) {
    out.listOrders.set(list.name, parsePrefixed(list.name).order);
    for (const entry of dirs(join(store.root, index.boardDir, list.name))) {
      const dir = `${index.boardDir}/${list.name}/${entry.name}`;
      const card = readCard(store, dir, list.name);
      if (card !== null) place(out, previous, dir, card);
    }
  }
  missingCardYaml(out, store, previous, index.boardDir);
  return out;
}
