// Planka operations the sync needs, expressed over the REST client.
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Client } from "./api.ts";

export interface Project {
  id: string;
  name: string;
}
export interface Board {
  id: string;
  name: string;
  position: number;
  projectId: string;
}
export interface List {
  id: string;
  name: string | null;
  position: number | null;
  type: string;
}
export interface Card {
  id: string;
  listId: string;
  name: string;
  description: string | null;
  position: number;
  dueDate: string | null;
  isDueCompleted: boolean | null;
  commentsTotal: number;
  createdAt: string;
  updatedAt: string | null;
}
export interface Label {
  id: string;
  name: string;
  color: string | null;
  position: number;
}
export interface TaskList {
  id: string;
  cardId: string;
  name: string;
  position: number;
}
export interface Task {
  id: string;
  taskListId: string;
  name: string;
  position: number;
  isCompleted: boolean;
  assigneeUserId: string | null;
}
export interface Attachment {
  id: string;
  cardId: string;
  name: string;
  type: "file" | "link";
  data?: { url?: string; mimeType?: string; size?: number };
}
export interface User {
  id: string;
  name: string;
  username: string;
  email?: string;
  /** "admin", "projectOwner" or "boardUser". */
  role?: string;
}
export interface Membership {
  userId: string;
  role?: string;
}
export interface CardMembership {
  cardId: string;
  userId: string;
}
export interface CardLabel {
  cardId: string;
  labelId: string;
}
export interface Comment {
  id: string;
  cardId: string;
  userId: string;
  text: string;
  createdAt: string;
  updatedAt: string | null;
}
export interface CardIncluded {
  cardLabels: CardLabel[];
  tasks: Task[];
  taskLists: TaskList[];
  attachments: Attachment[];
  cardMemberships: CardMembership[];
  users: User[];
}
export interface Snapshot {
  item: { id: string; name: string; projectId: string };
  included: CardIncluded & {
    lists: List[];
    cards: Card[];
    labels: Label[];
    boardMemberships: Membership[];
  };
}
export interface ListCards {
  items: Card[];
  included: CardIncluded;
}
export interface Discovery {
  projects: Project[];
  boards: Board[];
}

interface Item<T> {
  item: T;
}
interface Items<T> {
  items: T[];
}

export interface CardPatch {
  name?: string;
  description?: string | null;
  dueDate?: string | null;
  isDueCompleted?: boolean | null;
  listId?: string;
  position?: number;
}
export interface TaskPatch {
  name?: string;
  isCompleted?: boolean;
  assigneeUserId?: string | null;
}

/** The API surface the sync uses. Tests substitute an in-memory fake for the write side. */
export class Planka {
  readonly client: Client;
  constructor(client: Client) {
    this.client = client;
  }

  me = (): Promise<User> => this.client.get<Item<User>>("/api/users/me").then((r) => r.item);

  /** Projects and their boards in one call; boards sorted by position. */
  async discover(): Promise<Discovery> {
    const res = await this.client.get<Items<Project> & { included: { boards: Board[] } }>(
      "/api/projects",
    );
    const boards = res.included.boards.slice().sort((a, b) => a.position - b.position);
    return { projects: res.items, boards };
  }
  snapshot = (boardId: string): Promise<Snapshot> => this.client.get(`/api/boards/${boardId}`);
  listCards = (listId: string): Promise<ListCards> => this.client.get(`/api/lists/${listId}/cards`);

  /** Pages backwards with beforeId until a page comes back empty. */
  async listComments(cardId: string): Promise<Comment[]> {
    const all: Comment[] = [];
    let before = "";
    for (;;) {
      const page = await this.client.get<Items<Comment>>(`/api/cards/${cardId}/comments${before}`);
      if (page.items.length === 0) return all;
      all.push(...page.items);
      before = `?beforeId=${page.items[page.items.length - 1]!.id}`;
    }
  }

  async downloadAttachment(att: Attachment): Promise<Uint8Array> {
    if (!att.data?.url) throw new Error(`attachment ${att.id} has no download url`);
    return this.client.download(att.data.url);
  }

  updateCard = async (cardId: string, body: CardPatch): Promise<Card> =>
    (await this.client.patch<Item<Card>>(`/api/cards/${cardId}`, body)).item;
  createCard = async (
    listId: string,
    name: string,
    description: string,
    position: number,
  ): Promise<Card> =>
    (
      await this.client.post<Item<Card>>(`/api/lists/${listId}/cards`, {
        name,
        description: description || null,
        type: "project",
        position,
      })
    ).item;
  addLabel = (cardId: string, labelId: string): Promise<unknown> =>
    this.client.post(`/api/cards/${cardId}/card-labels`, { labelId });
  removeLabel = (cardId: string, labelId: string): Promise<void> =>
    this.client.del(`/api/cards/${cardId}/card-labels/labelId:${labelId}`);
  addAssignee = (cardId: string, userId: string): Promise<unknown> =>
    this.client.post(`/api/cards/${cardId}/card-memberships`, { userId });
  removeAssignee = (cardId: string, userId: string): Promise<void> =>
    this.client.del(`/api/cards/${cardId}/card-memberships/userId:${userId}`);
  createTaskList = async (cardId: string, name: string, position: number): Promise<TaskList> =>
    (await this.client.post<Item<TaskList>>(`/api/cards/${cardId}/task-lists`, { name, position }))
      .item;
  createTask = async (taskListId: string, name: string, position: number): Promise<Task> =>
    (await this.client.post<Item<Task>>(`/api/task-lists/${taskListId}/tasks`, { name, position }))
      .item;
  updateTask = (taskId: string, body: TaskPatch): Promise<unknown> =>
    this.client.patch(`/api/tasks/${taskId}`, body);
  deleteTask = (taskId: string): Promise<void> => this.client.del(`/api/tasks/${taskId}`);
  createComment = async (cardId: string, text: string): Promise<Comment> =>
    (await this.client.post<Item<Comment>>(`/api/cards/${cardId}/comments`, { text })).item;
  updateComment = (commentId: string, text: string): Promise<unknown> =>
    this.client.patch(`/api/comments/${commentId}`, { text });
  deleteComment = (commentId: string): Promise<void> =>
    this.client.del(`/api/comments/${commentId}`);
  createLabel = async (boardId: string, name: string, color: string): Promise<Label> =>
    (
      await this.client.post<Item<Label>>(`/api/boards/${boardId}/labels`, {
        name,
        color,
        position: 65536,
      })
    ).item;
  createList = async (boardId: string, name: string, position: number): Promise<List> =>
    (
      await this.client.post<Item<List>>(`/api/boards/${boardId}/lists`, {
        name,
        position,
        type: "active",
      })
    ).item;
  updateList = (listId: string, body: { position?: number; name?: string }): Promise<unknown> =>
    this.client.patch(`/api/lists/${listId}`, body);

  async uploadAttachment(cardId: string, file: string): Promise<Attachment> {
    const form = new FormData();
    form.set("type", "file");
    form.set("name", basename(file));
    form.set("file", new Blob([await readFile(file)]), basename(file));
    return (await this.client.postForm<Item<Attachment>>(`/api/cards/${cardId}/attachments`, form))
      .item;
  }
}
