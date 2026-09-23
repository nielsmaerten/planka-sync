// Pure comparison of a local card against the remote-built one: produces API operations.
import { type CardYaml, flatTasks, type TaskItem } from "./card.ts";
import type { BoardIndex } from "./model.ts";

export type Op =
  | {
      op: "update";
      title?: string;
      description?: string;
      dueDate?: string | null;
      dueCompleted?: boolean | null;
    }
  | { op: "move"; listId: string; position: number }
  | { op: "position"; position: number }
  | { op: "label"; add: boolean; labelId: string }
  | { op: "assignee"; add: boolean; userId: string }
  | { op: "task-create"; name: string; done: boolean; assigneeId?: string }
  | { op: "task-update"; taskId: string; name?: string; done?: boolean; assigneeId?: string | null }
  | { op: "task-delete"; taskId: string }
  | { op: "comment-create"; path: string; text: string }
  | { op: "comment-update"; commentId: string; text: string }
  | { op: "comment-delete"; commentId: string };

export type Plan = { ops: Op[] } | { blocked: string };

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function setOps<T extends Op>(
  local: string[],
  remote: string[],
  resolve: Map<string, string>,
  make: (add: boolean, id: string) => T,
): { ops: T[]; unknown: string[] } {
  const ops: T[] = [];
  const unknown: string[] = [];
  for (const name of local.filter((n) => !remote.includes(n))) {
    const id = resolve.get(name);
    if (id) ops.push(make(true, id));
    else unknown.push(name);
  }
  for (const name of remote.filter((n) => !local.includes(n))) {
    const id = resolve.get(name);
    if (id) ops.push(make(false, id));
  }
  return { ops, unknown };
}

type TaskUpdate = Extract<Op, { op: "task-update" }>;

function taskChange(
  t: TaskItem,
  prev: TaskItem,
  assigneeId: string | undefined,
): TaskUpdate | null {
  const change: TaskUpdate = { op: "task-update", taskId: t.id! };
  if (t.name !== prev.name) change.name = t.name;
  if (Boolean(t.done) !== prev.done) change.done = Boolean(t.done);
  if (t.assignee !== prev.assignee) change.assigneeId = assigneeId ?? null;
  return Object.keys(change).length > 2 ? change : null;
}

/** Splits local tasks into those to create and those to update, blocking on unknown assignees. */
function localTaskOps(
  local: CardYaml,
  remoteById: Map<string, TaskItem>,
  users: Map<string, string>,
): Plan {
  const ops: Op[] = [];
  for (const t of flatTasks(local)) {
    const assigneeId = t.assignee === undefined ? undefined : users.get(t.assignee);
    if (t.assignee !== undefined && assigneeId === undefined)
      return { blocked: `unknown task assignee: ${t.assignee}` };
    const prev = t.id ? remoteById.get(t.id) : undefined;
    const change = prev
      ? taskChange(t, prev, assigneeId)
      : ({ op: "task-create", name: t.name, done: Boolean(t.done), assigneeId } as Op);
    if (change) ops.push(change);
  }
  return { ops };
}

function taskOps(local: CardYaml, remote: CardYaml, users: Map<string, string>): Plan {
  const remoteById = new Map(flatTasks(remote).map((t) => [t.id!, t]));
  const plan = localTaskOps(local, remoteById, users);
  if ("blocked" in plan) return plan;
  const seen = new Set(flatTasks(local).map((t) => t.id));
  const deletes: Op[] = [...remoteById.keys()]
    .filter((id) => !seen.has(id))
    .map((taskId) => ({ op: "task-delete", taskId }));
  return { ops: [...plan.ops, ...deletes] };
}

type Update = Extract<Op, { op: "update" }>;

const FIELDS: [key: keyof Update, get: (m: CardYaml) => unknown][] = [
  ["title", (m) => m.title],
  ["dueDate", (m) => m.due ?? null],
  ["dueCompleted", (m) => m.dueCompleted ?? null],
];

function metaUpdate(l: CardYaml, r: CardYaml): Partial<Update> {
  const out: Record<string, unknown> = {};
  for (const [key, get] of FIELDS) if (!same(get(l), get(r))) out[key] = get(l);
  if ("title" in out) out.title = String(out.title ?? "");
  return out as Partial<Update>;
}

const blocked = (what: string, names: string[]): Plan | null =>
  names.length > 0 ? { blocked: `unknown ${what}: ${names.join(", ")}` } : null;

export interface MetaDiff {
  local: CardYaml;
  remote: CardYaml;
  index: BoardIndex;
}

function setPlans(local: CardYaml, remote: CardYaml, index: BoardIndex): Plan {
  const labels = setOps(
    local.labels ?? [],
    remote.labels ?? [],
    index.labelIdByName,
    (add, labelId) => ({ op: "label" as const, add, labelId }),
  );
  const members = setOps(
    local.members ?? [],
    remote.members ?? [],
    index.userIdByName,
    (add, userId) => ({ op: "assignee" as const, add, userId }),
  );
  const stop = blocked("labels", labels.unknown) ?? blocked("members", members.unknown);
  return stop ?? { ops: [...labels.ops, ...members.ops] };
}

/** Operations for a changed card.yaml (title, due, labels, members, tasks). */
export function metaOps({ local, remote, index }: MetaDiff): Plan {
  const sets = setPlans(local, remote, index);
  if ("blocked" in sets) return sets;
  const tasks = taskOps(local, remote, index.userIdByName);
  if ("blocked" in tasks) return tasks;
  const update = metaUpdate(local, remote);
  const ops: Op[] = Object.keys(update).length > 0 ? [{ op: "update", ...update }] : [];
  return { ops: [...ops, ...sets.ops, ...tasks.ops] };
}

/** Merges consecutive `update` ops (title/due from card.yaml, description from description.md). */
export function mergeUpdates(ops: Op[]): Op[] {
  const updates = ops.filter((o): o is Update => o.op === "update");
  if (updates.length < 2) return ops;
  const merged = Object.assign({}, ...updates) as Update;
  return [merged, ...ops.filter((o) => o.op !== "update")];
}

export const describeOps = (ops: Op[]): string =>
  [
    ...new Set(
      ops.map((o) =>
        o.op === "update"
          ? Object.keys(o)
              .filter((k) => k !== "op")
              .join("+")
          : o.op,
      ),
    ),
  ].join(", ");
