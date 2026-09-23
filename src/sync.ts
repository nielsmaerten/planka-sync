// One sync run: pull every board of the project into the mirror, relocating directories whose
// canonical name changed, downloading new attachments, pruning what Planka dropped. Local edits
// are never overwritten: a locally edited file that Planka also changed is reported as pending.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { apiError } from "./api.ts";
import type { Config } from "./config.ts";
import { currentNames, previousCardDirs, previousListDirs } from "./current.ts";
import type { AttachmentSpec, BoardFiles, FileSpec } from "./model.ts";
import type { Board, Planka, Project } from "./planka.ts";
import { snapshotBoard } from "./pull.ts";
import { Recorder, type Report } from "./report.ts";
import { uniqueSlugs } from "./naming.ts";
import { type Entry, hash, type Manifest, removeEmptyDirs, Store } from "./state.ts";

export interface Run {
  cfg: Config;
  api: Planka;
  store: Store;
  previous: Manifest;
  next: Manifest["files"];
  rec: Recorder;
  dry: boolean;
  renumber: boolean;
  /** List directories to (re)create after pruning, so empty lists stay browsable. */
  listDirs: Set<string>;
}

/** The base copy for a path the previous run produced, found through its manifest entry. */
export function baseKeyOf(entry: Entry | undefined): string | null {
  if (!entry || entry.hash === null) return null;
  if (entry.kind === "board") return `boards/${entry.id}/board.yaml`;
  if (entry.kind === "comment") return `cards/${entry.cardId}/comments/${entry.id}.md`;
  return `cards/${entry.cardId}/${entry.kind === "card" ? "card.yaml" : "description.md"}`;
}

/** Local file differs from the base copy the last run wrote: someone edited it. */
export function locallyEdited(run: Run, rel: string): boolean {
  const baseKey = baseKeyOf(run.previous.files[rel]);
  if (baseKey === null) return false;
  const local = run.store.readLocal(rel);
  const base = run.store.readBase(baseKey);
  return local !== null && base !== null && local !== base;
}

export const entryOf = (file: FileSpec): Entry => ({
  kind: file.kind,
  hash: hash(file.content),
  id: file.id,
  cardId: file.cardId,
});

/** Remote → disk for one text file, unless the local copy carries an unpushed edit. */
export function pullFile(run: Run, file: FileSpec, force = false): void {
  run.next[file.path] = entryOf(file);
  if (!force && locallyEdited(run, file.path) && run.store.readLocal(file.path) !== file.content) {
    // Base stays as it was, so a later run still sees exactly what was changed locally.
    run.rec.add("pending", file.path, "local edit not pushed yet");
    run.next[file.path] = {
      ...run.next[file.path]!,
      hash: hash(run.store.readBase(file.baseKey)!),
    };
    return;
  }
  if (run.dry) {
    if (run.store.readLocal(file.path) !== file.content) run.rec.add("pulled", file.path);
    return;
  }
  if (run.store.write(file.path, file.content, file.baseKey)) run.rec.add("pulled", file.path);
  else run.rec.unchanged();
}

async function ensureAttachment(run: Run, att: AttachmentSpec): Promise<void> {
  run.next[att.path] = { kind: "attachment", hash: null, id: att.id, cardId: att.cardId };
  if (run.store.exists(att.path)) return run.rec.unchanged();
  if (run.dry) return run.rec.add("downloaded", att.path);
  try {
    run.store.writeLocal(att.path, await run.api.downloadAttachment(att.source));
    run.rec.add("downloaded", att.path);
  } catch (err) {
    run.rec.add("failed", att.path, apiError(err));
    delete run.next[att.path];
  }
}

/** Manifest entries under `from` now describe files under `to`. */
function remapPrevious(run: Run, from: string, to: string): void {
  for (const [path, entry] of Object.entries(run.previous.files)) {
    if (path !== from && !path.startsWith(`${from}/`)) continue;
    delete run.previous.files[path];
    run.previous.files[`${to}${path.slice(from.length)}`] = entry;
  }
}

/** Directories whose canonical name changed (prefix, slug, list) move before the pull. */
function relocate(run: Run, was: Map<string, string>, now: Map<string, string>): void {
  for (const [id, from] of was) {
    const to = now.get(id);
    if (!to || from === to || !run.store.exists(from)) continue;
    if (run.dry) {
      run.rec.add("moved", to, `from ${from}`);
      remapPrevious(run, from, to);
      continue;
    }
    if (run.store.exists(to)) continue; // ponytail: a stray dir at the target wins; reported by validate
    run.store.move(from, to);
    remapPrevious(run, from, to);
    run.rec.add("moved", to, `from ${from}`);
  }
}

async function pullBoard(run: Run, built: BoardFiles): Promise<void> {
  for (const file of built.files) pullFile(run, file);
  for (const att of built.attachments) await ensureAttachment(run, att);
  for (const dir of built.index.listDirs.values()) run.listDirs.add(dir);
}

async function syncBoard(run: Run, boardId: string, boardDir: string): Promise<void> {
  const current = currentNames(run.store, run.previous, boardDir);
  const built = await snapshotBoard(run.api, boardId, boardDir, {
    current,
    renumber: run.renumber,
  });
  relocate(run, previousListDirs(run.store, boardDir), built.index.listDirs);
  relocate(run, previousCardDirs(run.previous, boardDir), built.index.cardDirs);
  await pullBoard(run, built);
}

/** The base copy goes when no produced path still refers to it. */
function dropBase(run: Run, rel: string): void {
  const baseKey = baseKeyOf(run.previous.files[rel]);
  if (baseKey && !Object.values(run.next).some((e) => baseKeyOf(e) === baseKey))
    run.store.removeBase(baseKey);
}

/** Paths from the last run that this run did not produce: gone in Planka, so gone on disk too. */
function prune(run: Run): void {
  for (const rel of Object.keys(run.previous.files)) {
    if (rel in run.next) continue;
    if (locallyEdited(run, rel)) {
      run.rec.add("kept", rel, "edited locally, gone in Planka");
      run.next[rel] = run.previous.files[rel]!;
      continue;
    }
    if (run.dry) {
      if (run.store.exists(rel)) run.rec.add("deleted", rel);
      continue;
    }
    dropBase(run, rel);
    if (run.store.remove(rel)) run.rec.add("deleted", rel);
  }
}

function finish(run: Run): void {
  prune(run);
  if (run.dry) return;
  removeEmptyDirs(run.cfg.root, run.listDirs);
  for (const dir of run.listDirs) mkdirSync(join(run.cfg.root, dir), { recursive: true });
  run.store.save(run.next);
}

/** A board that failed to fetch keeps its previous files instead of being pruned. */
function keepBoard(run: Run, boardDir: string): void {
  for (const [rel, entry] of Object.entries(run.previous.files)) {
    if (rel.startsWith(`${boardDir}/`)) run.next[rel] = entry;
  }
}

async function syncBoardSafely(run: Run, boardId: string, boardDir: string): Promise<void> {
  try {
    await syncBoard(run, boardId, boardDir);
  } catch (err) {
    run.rec.add("error", boardDir, apiError(err));
    if (process.env.PLANKA_SYNC_DEBUG) console.error((err as Error).stack);
    keepBoard(run, boardDir);
  }
}

export function findProject(projects: Project[], wanted: string): Project {
  const project = projects.find((p) => p.id === wanted || p.name === wanted);
  if (!project) {
    const names = projects.map((p) => `"${p.name}"`).join(", ") || "none";
    throw new Error(`no visible project matches "${wanted}"; visible: ${names}`);
  }
  return project;
}

/** Boards of one project and the directory each mirrors into. */
export async function projectBoards(
  api: Planka,
  wanted: string,
): Promise<{ project: Project; boards: Board[] }> {
  const { projects, boards } = await api.discover();
  const project = findProject(projects, wanted);
  return { project, boards: boards.filter((b) => b.projectId === project.id) };
}

export interface RunOptions {
  dry?: boolean;
  renumber?: boolean;
}

export async function runSync(cfg: Config, api: Planka, opts: RunOptions = {}): Promise<Report> {
  const startedAt = new Date().toISOString();
  const store = new Store(cfg.root);
  const run: Run = {
    cfg,
    api,
    store,
    previous: store.load(),
    next: {},
    rec: new Recorder(),
    dry: opts.dry ?? false,
    renumber: opts.renumber ?? false,
    listDirs: new Set(),
  };
  const { project, boards } = await projectBoards(api, cfg.project);
  const dirs = uniqueSlugs(boards);
  for (const board of boards) await syncBoardSafely(run, board.id, dirs.get(board.id)!);
  finish(run);
  return {
    project: project.name,
    startedAt,
    finishedAt: new Date().toISOString(),
    dry: run.dry,
    boards: boards.map((b) => b.name),
    stats: run.rec.stats,
    events: run.rec.events,
  };
}
