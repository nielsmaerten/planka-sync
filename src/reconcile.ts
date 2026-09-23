// Push phase for one board: plan every card, work out positions from the prefixes, then execute.
import { apiError } from "./api.ts";
import { applyOps } from "./apply.ts";
import { CARD_FILE } from "./card.ts";
import type { BoardYaml } from "./checks.ts";
import { createCards, trashCards, uploadNew } from "./changes.ts";
import { describeOps, type Op } from "./diff.ts";
import { type LocalBoard, type LocalCard, scanBoard } from "./local.ts";
import type { BoardFiles, FileSpec } from "./model.ts";
import { orderCards, orderLists } from "./ordering.ts";
import { type CardPlan, localPath, planCard } from "./plan.ts";
import type { Run } from "./sync.ts";
import { entryOf } from "./sync.ts";
import { CONFLICT_SUFFIX } from "./validate.ts";
import { groupRemote, type RemoteCard, resolver } from "./verdict.ts";

export interface BoardOutcome {
  /** Card ids pushed this run: re-snapshot and force-pull them. */
  touched: Set<string>;
  /** Paths already decided (conflict, blocked, unresolved, invalid): the pull phase skips them. */
  handled: Set<string>;
  /** Local directory of every matched or created card, for relocation to the canonical dir. */
  dirs: Map<string, string>;
  /** User-written files whose content now lives at a canonical path; removed after the pull. */
  tidy: string[];
  /** Files to pull over a local edit (`--pull`). */
  overwrite: Set<string>;
  boardReset?: boolean;
}

export interface Pass {
  run: Run;
  built: BoardFiles;
  board: BoardYaml;
  local: LocalBoard;
  out: BoardOutcome;
}

export interface Planned {
  local: LocalCard;
  remote: RemoteCard;
  plan: CardPlan;
}

/** The file stays as it is on disk; neither its remote path nor its local path gets pulled. */
export function keepHandled(pass: Pass, path: string, file: FileSpec): void {
  pass.out.handled.add(path);
  pass.out.handled.add(file.path);
  pass.run.next[path] = pass.run.previous.files[path] ?? entryOf(file);
}

function markConflict(pass: Pass, local: LocalCard, remote: RemoteCard, f: FileSpec): void {
  const path = localPath(local, remote, f);
  const where = `${path}${CONFLICT_SUFFIX}`;
  pass.run.rec.add("conflict", path, `Planka's version at ${where}; merge, delete it, sync again`);
  pass.out.handled.add(path);
  pass.out.handled.add(f.path);
  pass.run.next[path] = entryOf(f);
  if (pass.run.dry) return;
  pass.run.store.writeLocal(where, f.content);
  pass.run.store.writeBase(f.baseKey, f.content);
}

function markForeignComment(pass: Pass, local: LocalCard, remote: RemoteCard, f: FileSpec): void {
  const path = localPath(local, remote, f);
  const why = `comment by ${f.author}; only its author can change it, run sync --pull to restore it`;
  pass.run.rec.add("blocked", path, why);
  keepHandled(pass, path, f);
}

/** Files the user did not touch still pull; the edited ones wait for the fix. */
function markBlocked(pass: Pass, { local, remote, plan }: Planned): void {
  pass.run.rec.add("blocked", local.dir, plan.blocked!);
  for (const f of [remote.card, remote.description, ...remote.comments]) {
    if (!plan.pull.includes(f)) keepHandled(pass, localPath(local, remote, f), f);
  }
}

export async function push(pass: Pass, cardId: string, dir: string, ops: Op[]): Promise<boolean> {
  const { run } = pass;
  const label = describeOps(ops);
  if (run.dry) {
    run.rec.add("pushed", dir, `would push ${label}`);
    return false;
  }
  try {
    const applied = await applyOps(cardId, ops, pass.built.index, run.api);
    pass.out.tidy.push(...applied.createdComments.keys());
    run.rec.add("pushed", dir, label);
    pass.out.touched.add(cardId);
    return true;
  } catch (err) {
    run.rec.add("failed", dir, apiError(err));
    return false;
  }
}

function planOne(pass: Pass, local: LocalCard, remote: RemoteCard): Planned {
  const { run } = pass;
  const plan = planCard({
    local,
    remote,
    index: pass.built.index,
    board: pass.board,
    previous: run.previous,
    base: (key) => run.store.readBase(key),
    hasConflict: (path) => run.store.exists(`${path}${CONFLICT_SUFFIX}`),
    resolve: resolver(run.conflicts),
    canEdit: (author) => run.me.admin || author === run.me.username,
  });
  return { local, remote, plan };
}

/** Records unresolved and new conflicts, foreign comments and files to overwrite. */
function markFiles(pass: Pass, { local, remote, plan }: Planned): void {
  for (const f of plan.unresolved) {
    const path = localPath(local, remote, f);
    const why = `unresolved: merge ${path}${CONFLICT_SUFFIX} into it, then delete it`;
    pass.run.rec.add("conflict", path, why);
    keepHandled(pass, path, f);
  }
  for (const f of plan.conflicts) markConflict(pass, local, remote, f);
  for (const f of plan.blockedComments) markForeignComment(pass, local, remote, f);
  for (const f of plan.overwrite) pass.out.overwrite.add(f.path);
}

async function execute(pass: Pass, planned: Planned): Promise<void> {
  const { run } = pass;
  const { local, remote, plan } = planned;
  markFiles(pass, planned);
  if (plan.blocked) return markBlocked(pass, planned);
  // Should the re-snapshot fail, the card's files stay known so nothing prunes them.
  for (const f of [remote.card, remote.description, ...remote.comments]) {
    const path = localPath(local, remote, f);
    run.next[path] = run.previous.files[path] ?? entryOf(f);
  }
  if (plan.ops.length > 0) await push(pass, remote.id, local.dir, plan.ops);
  await uploadNew(pass, remote.id, local, remote.dir);
}

/** An unreadable card.yaml: nothing of that card is pulled or pruned this run. */
function keepInvalid(pass: Pass, id: string, remote: RemoteCard, reason: string): void {
  const previous = Object.entries(pass.run.previous.files).filter(([, e]) => e.cardId === id);
  const cardYaml = previous.find(([, e]) => e.kind === "card")?.[0] ?? `${remote.dir}/${CARD_FILE}`;
  pass.run.rec.add("error", cardYaml, `${reason}; card left untouched`);
  for (const [path, entry] of previous) {
    pass.out.handled.add(path);
    pass.run.next[path] = entry;
  }
  for (const f of [remote.card, remote.description, ...remote.comments])
    pass.out.handled.add(f.path);
}

/** Push phase for one board. The pull phase (sync.ts) follows with a fresh snapshot. */
export async function reconcileBoard(
  run: Run,
  built: BoardFiles,
  board: BoardYaml,
): Promise<BoardOutcome> {
  const local = scanBoard(run.store, run.previous, built.index);
  const out: BoardOutcome = {
    touched: new Set(),
    handled: new Set(),
    dirs: new Map(),
    tidy: [],
    overwrite: new Set(),
  };
  const pass: Pass = { run, built, board, local, out };
  const gone: RemoteCard[] = [];
  const planned: Planned[] = [];
  for (const [id, remote] of groupRemote(built)) {
    const reason = local.invalid.get(id);
    if (reason !== undefined) {
      keepInvalid(pass, id, remote, reason);
      continue;
    }
    const l = local.byId.get(id);
    if (!l) {
      gone.push(remote);
      continue;
    }
    out.dirs.set(id, l.dir);
    planned.push(planOne(pass, l, remote));
  }
  const fresh = orderCards(pass, planned);
  for (const p of planned) await execute(pass, p);
  await createCards(pass, fresh);
  await trashCards(pass, gone);
  await orderLists(pass);
  for (const b of local.broken) run.rec.add("error", b.path, b.reason);
  return out;
}
