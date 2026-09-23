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
    const abs = join(this.root, rel);
    return existsSync(abs) ? readFileSync(abs, "utf8") : null;
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
    if (typeof content === "string" && this.readLocal(rel) === content) return false;
    writeAtomic(join(this.root, rel), content);
    return true;
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
    return existed;
  }

  /** Moves a mirror directory or file to a new relative path. */
  move(fromRel: string, toRel: string): void {
    const to = join(this.root, toRel);
    mkdirSync(dirname(to), { recursive: true });
    renameSync(join(this.root, fromRel), to);
    pruneEmptyDirs(this.root, fromRel);
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

/** Removes empty directories under root, bottom-up, except the ones listed and the state dir. */
export function removeEmptyDirs(root: string, keep: Set<string>): void {
  const dirs = readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(e.parentPath, e.name).slice(root.length + 1))
    .filter((rel) => !rel.startsWith(STATE_DIR) && !rel.startsWith(".git"))
    .sort((a, b) => b.length - a.length);
  for (const rel of dirs) {
    if (keep.has(rel) || readdirSync(join(root, rel)).length > 0) continue;
    rmdirSync(join(root, rel));
  }
}
