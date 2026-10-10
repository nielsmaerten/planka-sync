// Sync state under <root>/.planka-sync: the manifest (what the last run produced, with the id
// behind each path) and base copies of every text file, keyed by Planka id rather than by path so
// a moved or renamed directory keeps its three-way base.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { STATE_DIR } from "./config.ts";

export type Kind = "board" | "card" | "description" | "comment" | "attachment";

export interface Entry {
  kind: Kind;
  /** sha256 of the content at last sync; null for attachments (never compared by content). */
  hash: string | null;
  /** Planka id behind the file: card, comment or attachment id; the board id for board.yaml. */
  id?: string;
  /** The card a description, comment or attachment belongs to. */
  cardId?: string;
}
export interface Manifest {
  version: 1;
  files: Record<string, Entry>;
}

export const hash = (content: string): string => createHash("sha256").update(content).digest("hex");

/** Write-then-rename, so an interrupted write never leaves a truncated file behind. */
export function writeAtomic(abs: string, content: string | Uint8Array): void {
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, abs);
}

export class Store {
  readonly root: string;
  readonly dir: string;
  /**
   * What this run first read from, or last wrote to, each mirror path. People and agents keep
   * editing while a run goes on; a file that no longer matches was changed by someone else, and
   * the run must not overwrite or remove that change (see `changedSince`).
   */
  private readonly seen = new Map<string, string | null>();

  constructor(root: string) {
    this.root = root;
    this.dir = join(root, STATE_DIR);
  }

  load(): Manifest {
    const path = join(this.dir, "manifest.json");
    if (!existsSync(path)) return { version: 1, files: {} };
    return JSON.parse(readFileSync(path, "utf8")) as Manifest;
  }

  save(files: Manifest["files"]): void {
    const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
    const manifest: Manifest = { version: 1, files: sorted };
    writeAtomic(join(this.dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  }

  readLocal(rel: string): string | null {
    const content = this.peek(rel);
    if (!this.seen.has(rel)) this.seen.set(rel, content);
    return content;
  }

  private peek(rel: string): string | null {
    const abs = join(this.root, rel);
    return existsSync(abs) ? readFileSync(abs, "utf8") : null;
  }

  /** Someone else wrote or removed `rel` since this run read or wrote it (false if it never did). */
  changedSince(rel: string): boolean {
    return this.seen.has(rel) && this.peek(rel) !== this.seen.get(rel);
  }

  /** What this run first read from `rel`, or last wrote to it; undefined if neither. */
  seenContent(rel: string): string | null | undefined {
    return this.seen.get(rel);
  }

  /** Records `content` as what this run knows `rel` to hold, after keeping a newer copy there. */
  markSeen(rel: string, content: string | null): void {
    this.seen.set(rel, content);
  }

  /**
   * What this run read under `from` now counts for `to`: a directory the run would have moved
   * there was removed meanwhile, and its files must still count as removed, not as new.
   */
  follow(from: string, to: string): void {
    this.remapSeen(from, to);
  }

  /** Seen entries at or under `from` move to `to`, or go when `to` is null. */
  private remapSeen(from: string, to: string | null): void {
    // A copy: entries added under `to` must not be visited again.
    for (const [rel, content] of Array.from(this.seen)) {
      if (rel !== from && !rel.startsWith(`${from}/`)) continue;
      this.seen.delete(rel);
      if (to !== null) this.seen.set(`${to}${rel.slice(from.length)}`, content);
    }
  }

  exists(rel: string): boolean {
    return existsSync(join(this.root, rel));
  }

  /** Names of the subdirectories of a mirror directory. */
  listDirs(rel: string): string[] {
    try {
      return readdirSync(join(this.root, rel), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return [];
    }
  }

  /** Writes the mirror file and its base copy; returns true when the mirror file changed. */
  write(rel: string, content: string, baseKey: string): boolean {
    this.writeBase(baseKey, content);
    return this.writeLocal(rel, content);
  }

  writeLocal(rel: string, content: string | Uint8Array): boolean {
    const text = typeof content === "string" ? content : null;
    const same = text !== null && this.peek(rel) === text;
    if (!same) writeAtomic(join(this.root, rel), content);
    if (text !== null) this.seen.set(rel, text);
    else this.seen.delete(rel);
    return !same;
  }

  writeBase(baseKey: string, content: string): void {
    const abs = join(this.dir, "base", baseKey);
    if (existsSync(abs) && readFileSync(abs, "utf8") === content) return;
    writeAtomic(abs, content);
  }

  readBase(baseKey: string): string | null {
    const abs = join(this.dir, "base", baseKey);
    return existsSync(abs) ? readFileSync(abs, "utf8") : null;
  }

  removeBase(baseKey: string): void {
    rmSync(join(this.dir, "base", baseKey), { force: true });
    pruneEmptyDirs(join(this.dir, "base"), baseKey);
  }

  /** Removes a mirror path, then any directories left empty above it. */
  remove(rel: string): boolean {
    const abs = join(this.root, rel);
    const existed = existsSync(abs);
    if (existed) rmSync(abs, { recursive: true });
    pruneEmptyDirs(this.root, rel);
    this.remapSeen(rel, null);
    return existed;
  }

  /** Moves a mirror directory or file to a new relative path. */
  move(fromRel: string, toRel: string): void {
    const to = join(this.root, toRel);
    mkdirSync(dirname(to), { recursive: true });
    renameSync(join(this.root, fromRel), to);
    pruneEmptyDirs(this.root, fromRel);
    this.remapSeen(fromRel, toRel);
  }

  writeJson(name: string, value: unknown): void {
    writeAtomic(join(this.dir, name), `${JSON.stringify(value, null, 2)}\n`);
  }

  readJson<T>(name: string): T | null {
    const abs = join(this.dir, name);
    return existsSync(abs) ? (JSON.parse(readFileSync(abs, "utf8")) as T) : null;
  }
}

function pruneEmptyDirs(root: string, rel: string): void {
  let dir = dirname(rel);
  while (dir !== "." && dir !== "") {
    const abs = join(root, dir);
    if (!existsSync(abs) || readdirSync(abs).length > 0) return;
    rmdirSync(abs);
    dir = dirname(dir);
  }
}

/** Every directory above the given mirror paths. */
export function ancestors(paths: Iterable<string>): Set<string> {
  const dirs = new Set<string>();
  for (const rel of paths)
    for (let dir = dirname(rel); dir !== "." && !dirs.has(dir); dir = dirname(dir)) dirs.add(dir);
  return dirs;
}

/**
 * Removes empty directories under root, bottom-up: only ones the sync produced (`produced`),
 * never the listed ones or the state dir. A directory someone just made
 * for a new card stays, empty or not.
 */
export function removeEmptyDirs(root: string, keep: Set<string>, produced: Set<string>): void {
  const dirs = readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(e.parentPath, e.name).slice(root.length + 1))
    .filter((rel) => !rel.startsWith(STATE_DIR) && !rel.startsWith(".git"))
    .sort((a, b) => b.length - a.length);
  for (const rel of dirs) {
    if (keep.has(rel) || !produced.has(rel) || readdirSync(join(root, rel)).length > 0) continue;
    rmdirSync(join(root, rel));
  }
}
