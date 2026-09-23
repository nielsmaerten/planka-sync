// Fills the throwaway Planka (compose.yaml) with a project the end-to-end checks can use.
// Re-running it deletes and recreates the project. Prints the project id and the admin's API key
// location; nothing here is secret beyond this test server.
import { writeFileSync } from "node:fs";
import { Client } from "../../src/api.ts";
import { login } from "../../src/auth.ts";

export const SERVER = process.env.PLANKA_TEST_SERVER ?? "http://localhost:3999";
export const ADMIN = { email: "admin@example.com", password: "admin-password" };
export const PROJECT_NAME = "Sync Test";

interface Item<T> {
  item: T;
}
interface Id {
  id: string;
}

async function post<T = Id>(c: Client, path: string, body: object): Promise<T> {
  return (await c.post<Item<T>>(path, body)).item;
}

async function ensureUser(c: Client): Promise<string> {
  const users = await c.get<{ items: { id: string; username: string }[] }>("/api/users");
  const bob = users.items.find((u) => u.username === "bob");
  if (bob) return bob.id;
  return (
    await post(c, "/api/users", {
      email: "bob@example.com",
      password: "bob-password-1",
      name: "Bob Builder",
      role: "boardUser",
      username: "bob",
    })
  ).id;
}

async function resetProject(c: Client): Promise<string> {
  const res = await c.get<{
    items: { id: string; name: string }[];
    included: { boards: { id: string; projectId: string }[] };
  }>("/api/projects");
  for (const p of res.items.filter((p) => p.name === PROJECT_NAME)) {
    for (const b of res.included.boards.filter((b) => b.projectId === p.id))
      await c.del(`/api/boards/${b.id}`);
    await c.del(`/api/projects/${p.id}`);
  }
  return (await post(c, "/api/projects", { name: PROJECT_NAME, type: "private" })).id;
}

interface BoardSetup {
  boardId: string;
  lists: Record<string, string>;
  labels: Record<string, string>;
}

async function board(c: Client, projectId: string, name: string, pos: number): Promise<BoardSetup> {
  const boardId = (await post(c, `/api/projects/${projectId}/boards`, { name, position: pos })).id;
  const lists: Record<string, string> = {};
  for (const [i, n] of ["Backlog", "Doing", "Done"].entries())
    lists[n] = (
      await post(c, `/api/boards/${boardId}/lists`, {
        name: n,
        position: (i + 1) * 65536,
        type: "active",
      })
    ).id;
  const labels: Record<string, string> = {};
  for (const [i, [n, color]] of [
    ["bug", "berry-red"],
    ["feature", "lagoon-blue"],
  ].entries())
    labels[n] = (
      await post(c, `/api/boards/${boardId}/labels`, { name: n, color, position: (i + 1) * 65536 })
    ).id;
  return { boardId, lists, labels };
}

interface NewCard {
  name: string;
  pos: number;
  description?: string;
}

async function card(c: Client, listId: string, spec: NewCard | string): Promise<string> {
  const { name, pos, description } = typeof spec === "string" ? { name: spec, pos: 65536 } : spec;
  return (
    await post(c, `/api/lists/${listId}/cards`, {
      name,
      description: description ?? null,
      type: "project",
      position: pos,
    })
  ).id;
}

async function fillMain(c: Client, b: BoardSetup, bobId: string): Promise<void> {
  await c.post(`/api/boards/${b.boardId}/board-memberships`, { userId: bobId, role: "editor" });
  const first = await card(c, b.lists.Backlog!, {
    name: "Write the README",
    pos: 65536,
    description: "# README\n\nExplain *everything*.\n",
  });
  await c.post(`/api/cards/${first}/card-labels`, { labelId: b.labels.feature });
  await c.post(`/api/cards/${first}/card-memberships`, { userId: bobId });
  const tl = await post(c, `/api/cards/${first}/task-lists`, {
    name: "Checklist",
    position: 65536,
  });
  await post(c, `/api/task-lists/${tl.id}/tasks`, { name: "Outline", position: 65536 });
  const t2 = await post(c, `/api/task-lists/${tl.id}/tasks`, { name: "Draft", position: 131072 });
  await c.patch(`/api/tasks/${t2.id}`, { isCompleted: true, assigneeUserId: bobId });
  await c.post(`/api/cards/${first}/comments`, { text: "First comment" });
  await c.post(`/api/cards/${first}/comments`, { text: "Second comment, same author" });
  const form = new FormData();
  form.set("type", "file");
  form.set("name", "Notes File.txt");
  form.set("file", new Blob(["hello attachment\n"]), "Notes File.txt");
  await c.postForm(`/api/cards/${first}/attachments`, form);

  await card(c, b.lists.Backlog!, { name: "Fix login bug", pos: 131072 });
  const due = await card(c, b.lists.Doing!, {
    name: "Ship v1",
    pos: 65536,
    description: "Due soon.",
  });
  await c.patch(`/api/cards/${due}`, {
    dueDate: "2026-10-01T10:00:00.000Z",
    isDueCompleted: false,
  });
  await c.patch(`/api/cards/${due}`, {}).catch(() => undefined);
  await c.post(`/api/cards/${due}/card-labels`, { labelId: b.labels.bug });
  await card(c, b.lists.Done!, "Café: déjà vu?");
  await card(c, b.lists.Done!, { name: "Cafe deja vu", pos: 131072 });

  const snap = await c.get<{
    included: { lists: { id: string; type: string; name: null | string }[] };
  }>(`/api/boards/${b.boardId}`);
  const builtin = (type: string) =>
    snap.included.lists.find((l) => l.name === null && l.type === type)!.id;
  const archived = await card(c, b.lists.Done!, { name: "Old archived card", pos: 196608 });
  await c.patch(`/api/cards/${archived}`, { listId: builtin("archive"), position: 65536 });
  const trashed = await card(c, b.lists.Done!, { name: "Old trashed card", pos: 262144 });
  await c.patch(`/api/cards/${trashed}`, { listId: builtin("trash"), position: 65536 });
}

export async function seed(): Promise<{ projectId: string; token: string }> {
  const token = await login(SERVER, ADMIN.email, ADMIN.password, async () => true);
  const c = new Client(SERVER, { type: "bearer", token });
  const bobId = await ensureUser(c);
  const projectId = await resetProject(c);
  const main = await board(c, projectId, "Main", 65536);
  await fillMain(c, main, bobId);
  const ideas = await board(c, projectId, "Ideas", 131072);
  await card(c, ideas.lists.Backlog!, "An idea");
  return { projectId, token };
}

if (process.argv[1]?.endsWith("seed.ts")) {
  const { projectId, token } = await seed();
  const out = process.env.PLANKA_TEST_TOKEN_FILE;
  if (out) writeFileSync(out, token, { mode: 0o600 });
  console.log(
    `seeded "${PROJECT_NAME}" (${projectId}) on ${SERVER}${out ? `; token in ${out}` : ""}`,
  );
}
