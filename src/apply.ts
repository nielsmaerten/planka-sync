// Executes the operations produced by diff.ts against Planka, in order.
import type { Op } from "./diff.ts";
import type { BoardIndex } from "./model.ts";
import type { Planka, Task, TaskList } from "./planka.ts";

/** The Planka calls the executor needs; tests substitute an in-memory fake. */
export type Api = Pick<
  Planka,
  | "updateCard"
  | "addLabel"
  | "removeLabel"
  | "addAssignee"
  | "removeAssignee"
  | "createTaskList"
  | "createTask"
  | "updateTask"
  | "deleteTask"
  | "createComment"
  | "updateComment"
  | "deleteComment"
  | "createCard"
  | "uploadAttachment"
  | "createLabel"
  | "createList"
  | "updateList"
>;

type Handler<K extends Op["op"]> = (
  cardId: string,
  op: Extract<Op, { op: K }>,
  index: BoardIndex,
  api: Api,
) => Promise<unknown>;
type Handlers = { [K in Op["op"]]: Handler<K> };

/** Comment ids created this run, keyed by the local file path, so the caller can re-pull them. */
export interface Applied {
  createdComments: Map<string, string>;
}

/** Tasks need a task list; reuse the card's first one or create "Tasks". Appends at the bottom. */
async function createTask(
  cardId: string,
  name: string,
  index: BoardIndex,
  api: Api,
): Promise<Task> {
  let list: TaskList | undefined = index.taskLists.find((tl) => tl.cardId === cardId);
  if (!list) {
    list = await api.createTaskList(cardId, "Tasks", 65536);
    index.taskLists.push(list);
  }
  const listId = list.id;
  const position =
    Math.max(0, ...index.tasks.filter((t) => t.taskListId === listId).map((t) => t.position)) +
    65536;
  const task = await api.createTask(listId, name, position);
  index.tasks.push(task);
  return task;
}

const handlers: Handlers = {
  update: (cardId, op, _index, api) =>
    api.updateCard(cardId, {
      name: op.title,
      description: op.description,
      dueDate: op.dueDate,
      isDueCompleted: op.dueCompleted,
    }),
  move: (cardId, op, _index, api) =>
    api.updateCard(cardId, { listId: op.listId, position: op.position }),
  position: (cardId, op, _index, api) => api.updateCard(cardId, { position: op.position }),
  label: (cardId, op, _index, api) => (op.add ? api.addLabel : api.removeLabel)(cardId, op.labelId),
  assignee: (cardId, op, _index, api) =>
    (op.add ? api.addAssignee : api.removeAssignee)(cardId, op.userId),
  "task-create": async (cardId, op, index, api) => {
    const task = await createTask(cardId, op.name, index, api);
    if (op.done || op.assigneeId)
      await api.updateTask(task.id, {
        isCompleted: op.done || undefined,
        assigneeUserId: op.assigneeId,
      });
  },
  "task-update": (_cardId, op, _index, api) =>
    api.updateTask(op.taskId, {
      name: op.name,
      isCompleted: op.done,
      assigneeUserId: op.assigneeId,
    }),
  "task-delete": (_cardId, op, _index, api) => api.deleteTask(op.taskId),
  "comment-create": (cardId, op, _index, api) => api.createComment(cardId, op.text),
  "comment-update": (_cardId, op, _index, api) => api.updateComment(op.commentId, op.text),
  "comment-delete": (_cardId, op, _index, api) => api.deleteComment(op.commentId),
};

export async function applyOps(
  cardId: string,
  ops: Op[],
  index: BoardIndex,
  api: Api,
): Promise<Applied> {
  const applied: Applied = { createdComments: new Map() };
  for (const op of ops) {
    const result = await (handlers[op.op] as Handler<typeof op.op>)(
      cardId,
      op as never,
      index,
      api,
    );
    if (op.op === "comment-create")
      applied.createdComments.set(op.path, (result as { id: string }).id);
  }
  return applied;
}
