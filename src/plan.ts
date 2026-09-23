// Per-card plan: pure decisions from base (last run), local (disk) and remote (Planka).
import { type CardYaml, parseCardYaml } from "./card.ts";
import { type BoardYaml, checkCard } from "./checks.ts";
import { planComments } from "./comments.ts";
import { mergeUpdates, metaOps, type Op } from "./diff.ts";
import type { LocalCard } from "./local.ts";
import { type BoardIndex, type FileSpec, resolveListId } from "./model.ts";
import type { Manifest } from "./state.ts";
import { type RemoteCard, type Resolve, verdict } from "./verdict.ts";

export interface PlanInput {
  local: LocalCard;
  remote: RemoteCard;
  index: BoardIndex;
  board: BoardYaml;
  previous: Manifest;
  base: (key: string) => string | null;
  hasConflict: (path: string) => boolean;
  resolve: Resolve;
  canEdit: (author: string | undefined) => boolean;
  /** List directory the last run put this card in, null when the run did not know it. */
  previousListDir: string | null;
}

export interface CardPlan {
  pull: FileSpec[];
  /** Files to pull over the local copy even though it was edited (`--pull`). */
  overwrite: FileSpec[];
  conflicts: FileSpec[];
  unresolved: FileSpec[];
  /** Another user's comments, edited or removed locally; kept as they are and reported. */
  blockedComments: FileSpec[];
  ops: Op[];
  /** The card changes list; position is filled in by the ordering pass. */
  moveTo?: string;
  /** Planka moved the card and the pull will relocate it: leave it out of local ordering. */
  pulledMove?: boolean;
  blocked?: string;
}

const emptyPlan = (): CardPlan => ({
  pull: [],
  overwrite: [],
  conflicts: [],
  unresolved: [],
  blockedComments: [],
  ops: [],
});

function file(input: PlanInput, plan: CardPlan, f: FileSpec, local: string | null): boolean {
  const raw = verdict(local, f.content, input.base(f.baseKey));
  const v = input.resolve(raw);
  if (v === "push") return true;
  if (v === "conflict") plan.conflicts.push(f);
  else if (raw === "conflict") plan.overwrite.push(f);
  else plan.pull.push(f);
  return false;
}

function planMeta(input: PlanInput, plan: CardPlan): void {
  const { local, remote, index, board } = input;
  if (!file(input, plan, remote.card, local.cardYaml)) return;
  const errors = checkCard(local.meta, local.listDir, board);
  if (errors.length > 0) return void (plan.blocked = errors.join("; "));
  const remoteMeta = parseCardYaml(remote.card.content) as CardYaml;
  const ops = metaOps({ local: local.meta, remote: remoteMeta, index });
  if ("blocked" in ops) return void (plan.blocked = ops.blocked);
  if (ops.ops.length === 0) plan.pull.push(remote.card);
  else plan.ops.push(...ops.ops);
}

function planDescription(input: PlanInput, plan: CardPlan): void {
  const { local, remote } = input;
  const norm = local.description === null ? null : `${local.description.trimEnd()}\n`;
  if (!file(input, plan, remote.description, norm)) return;
  plan.ops.push({ op: "update", description: local.description!.trimEnd() });
}

/** Why a card cannot be moved into this directory, or null when it can. */
function moveProblem(
  index: BoardIndex,
  listDir: string,
  listId: string | undefined,
): string | null {
  if (!listId) return `"${listDir}" is not a list directory of this board`;
  if (index.builtinDirs.has(listDir))
    return `cannot be moved into the built-in ${listDir} list from the tree`;
  return null;
}

/** Where the card should go given the three lists, or null when nothing is to be pushed. */
function moveTarget(
  input: PlanInput,
  ids: { local: string; remote?: string; previous: string | null },
): string | null | "conflict" {
  if (ids.previous !== null && ids.local === ids.previous) return null; // moved in Planka only
  const bothMoved = ids.previous !== null && ids.remote !== ids.previous;
  const v = input.resolve(bothMoved ? "conflict" : "push");
  if (v === "push") return ids.local;
  return v === "conflict" ? "conflict" : null;
}

/** Three-way on the list: local vs remote, judged against where the last run put the card. */
function planMove(input: PlanInput, plan: CardPlan): void {
  const { local, remote, index } = input;
  const listId = resolveListId(index, local.listDir);
  const remoteId = index.listIdByDir.get(remote.listDir);
  if (listId === remoteId) return;
  const problem = moveProblem(index, local.listDir, listId);
  if (problem) return void (plan.blocked = problem);
  const previousDir = input.previousListDir;
  const previous = previousDir === null ? null : (resolveListId(index, previousDir) ?? null);
  const target = moveTarget(input, { local: listId!, remote: remoteId, previous });
  if (target === "conflict")
    plan.blocked = `moved on both sides (Planka: ${remote.listDir}); move it there, or sync --push / --pull`;
  else if (target !== null) plan.moveTo = target;
  else plan.pulledMove = true;
}

/** The remote file's place inside the local card directory (which may have moved). */
export const localPath = (local: LocalCard, remote: RemoteCard, f: FileSpec): string =>
  `${local.dir}${f.path.slice(remote.dir.length)}`;

/** Decides, per file, what to do for one existing card. */
export function planCard(input: PlanInput): CardPlan {
  const plan = emptyPlan();
  const files = [input.remote.card, input.remote.description];
  const open = files.filter((f) => input.hasConflict(localPath(input.local, input.remote, f)));
  if (open.length > 0) {
    plan.unresolved.push(...open);
    return plan;
  }
  planMeta(input, plan);
  planDescription(input, plan);
  planMove(input, plan);
  const comments = planComments(input);
  plan.pull.push(...comments.pull);
  plan.conflicts.push(...comments.conflicts);
  plan.unresolved.push(...comments.unresolved);
  plan.blockedComments.push(...comments.blocked);
  plan.ops.push(...comments.ops);
  if (plan.blocked) {
    plan.ops = [];
    delete plan.moveTo;
  }
  plan.ops = mergeUpdates(plan.ops);
  return plan;
}
