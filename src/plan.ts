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
}

export interface CardPlan {
  pull: FileSpec[];
  /** Files to pull over the local copy even though it was edited (`--pull`). */
  overwrite: FileSpec[];
  conflicts: FileSpec[];
  unresolved: FileSpec[];
  ops: Op[];
  /** The card changes list; position is filled in by the ordering pass. */
  moveTo?: string;
  blocked?: string;
}

const emptyPlan = (): CardPlan => ({
  pull: [],
  overwrite: [],
  conflicts: [],
  unresolved: [],
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

function planMove(input: PlanInput, plan: CardPlan): void {
  const { local, remote, index } = input;
  const listId = resolveListId(index, local.listDir);
  if (listId === index.listIdByDir.get(remote.listDir)) return;
  if (!listId) plan.blocked = `"${local.listDir}" is not a list directory of this board`;
  else if (index.builtinDirs.has(local.listDir))
    plan.blocked = `cards cannot be moved into the built-in ${local.listDir} list from the tree`;
  else plan.moveTo = listId;
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
  plan.ops.push(...comments.ops);
  if (plan.blocked) {
    plan.ops = [];
    delete plan.moveTo;
  }
  plan.ops = mergeUpdates(plan.ops);
  return plan;
}
