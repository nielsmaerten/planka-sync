import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ApiError } from "../src/api.ts";
import { type Config, DEFAULT_WATCH } from "../src/config.ts";
import type { Planka } from "../src/planka.ts";
import { runSync } from "../src/sync.ts";

const LIST = { id: "10", boardId: "1", type: "active", position: 65536, name: "Todo" };
const snapshot = () => ({
  item: { id: "1", name: "Main", projectId: "p" },
  included: {
    lists: [LIST],
    cards: [],
    labels: [],
    boardMemberships: [],
    users: [],
    cardLabels: [],
    tasks: [],
    taskLists: [],
    attachments: [],
    cardMemberships: [],
  },
});

test("a created card keeps its id on disk when a later request of the run fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "planka-sync-create-"));
  try {
    let snapshots = 0;
    let created = 0;
    const api = {
      me: async () => ({ username: "admin", role: "admin" }),
      discover: async () => ({
        projects: [{ id: "p", name: "P" }],
        boards: [{ id: "1", name: "Main", position: 1, projectId: "p" }],
      }),
      snapshot: async () => {
        if (++snapshots > 1)
          throw new ApiError("GET /api/boards/1", 503, { code: "HTTP_503", message: "down" });
        return snapshot();
      },
      listCards: async () => ({ items: [], included: {} }),
      createCard: async () => ({ id: `90${++created}` }),
    } as unknown as Planka;
    const cfg: Config = { root, server: "s", project: "p", deletionCap: 10, watch: DEFAULT_WATCH };
    // First run: pull the empty board.
    await runSync(cfg, api);
    snapshots = 0;
    const dir = join(root, "main/010-todo/new-card");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "card.yaml"), "---\n# drafted by hand\ntitle: New card\n");
    // Second run: create succeeds, the snapshot after it fails.
    const report = await runSync(cfg, api);
    assert.equal(created, 1);
    assert.ok(report.events.some((e) => e.outcome === "failed" && e.path === "main"));
    assert.match(readFileSync(join(dir, "card.yaml"), "utf8"), /^id: "901"\ntitle: New card\n/);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("a board whose sync fails keeps its empty list directories", async () => {
  const root = mkdtempSync(join(tmpdir(), "planka-sync-keep-"));
  try {
    let fail = false;
    const api = {
      me: async () => ({ username: "admin", role: "admin" }),
      discover: async () => ({
        projects: [{ id: "p", name: "P" }],
        boards: [{ id: "1", name: "Main", position: 1, projectId: "p" }],
      }),
      snapshot: async () => {
        if (fail) throw new ApiError("GET /api/boards/1", 503, { code: "HTTP_503", message: "x" });
        return snapshot();
      },
      listCards: async () => ({ items: [], included: {} }),
    } as unknown as Planka;
    const cfg: Config = { root, server: "s", project: "p", deletionCap: 10, watch: DEFAULT_WATCH };
    await runSync(cfg, api);
    assert.ok(existsSync(join(root, "main/010-todo")), "the empty list is on disk");
    fail = true;
    await runSync(cfg, api);
    assert.ok(existsSync(join(root, "main/010-todo")), "still there after the failed run");
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("an emptied card directory stays, and the card is not trashed", async () => {
  const root = mkdtempSync(join(tmpdir(), "planka-sync-emptied-"));
  try {
    const card = {
      id: "9",
      boardId: "1",
      listId: "10",
      name: "A",
      description: "Body.",
      position: 65536,
      type: "project",
      dueDate: null,
      isDueCompleted: null,
      commentsTotal: 0,
    };
    const updates: unknown[] = [];
    const api = {
      me: async () => ({ username: "admin", role: "admin" }),
      discover: async () => ({
        projects: [{ id: "p", name: "P" }],
        boards: [{ id: "1", name: "Main", position: 1, projectId: "p" }],
      }),
      snapshot: async () => {
        const snap = snapshot();
        (snap.included.cards as unknown[]).push({ ...card });
        return snap;
      },
      listCards: async () => ({ items: [], included: {} }),
      updateCard: async (...args: unknown[]) => void updates.push(args),
    } as unknown as Planka;
    const cfg: Config = { root, server: "s", project: "p", deletionCap: 10, watch: DEFAULT_WATCH };
    await runSync(cfg, api);
    const dir = join(root, "main/010-todo/010-a");
    assert.ok(existsSync(join(dir, "card.yaml")));
    for (const f of readdirSync(dir)) rmSync(join(dir, f), { recursive: true });
    await runSync(cfg, api);
    assert.ok(existsSync(dir), "the emptied directory survives the run");
    await runSync(cfg, api);
    assert.deepEqual(updates, [], "nothing trashed");
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("an edit made while its earlier edit is pushed survives and goes out next time", async () => {
  const root = mkdtempSync(join(tmpdir(), "planka-sync-midrun-"));
  try {
    const card = {
      id: "9",
      boardId: "1",
      listId: "10",
      name: "A",
      description: "Body.",
      position: 65536,
      type: "project",
      dueDate: null,
      isDueCompleted: null,
      commentsTotal: 0,
    };
    const desc = join(root, "main/010-todo/010-a/description.md");
    const pushed: string[] = [];
    let interfere = false;
    const api = {
      me: async () => ({ username: "admin", role: "admin" }),
      discover: async () => ({
        projects: [{ id: "p", name: "P" }],
        boards: [{ id: "1", name: "Main", position: 1, projectId: "p" }],
      }),
      snapshot: async () => {
        const snap = snapshot();
        (snap.included.cards as unknown[]).push({ ...card });
        return snap;
      },
      listCards: async () => ({ items: [], included: {} }),
      updateCard: async (_id: string, patch: { description?: string }) => {
        if (patch.description !== undefined) {
          pushed.push(patch.description);
          card.description = patch.description;
        }
        // Someone edits the file again while the push is in flight.
        if (interfere) writeFileSync(desc, "Second edit.\n");
        interfere = false;
        return card;
      },
    } as unknown as Planka;
    const cfg: Config = { root, server: "s", project: "p", deletionCap: 10, watch: DEFAULT_WATCH };
    await runSync(cfg, api);
    writeFileSync(desc, "First edit.\n");
    interfere = true;
    const report = await runSync(cfg, api);
    assert.deepEqual(pushed, ["First edit."]);
    assert.equal(readFileSync(desc, "utf8"), "Second edit.\n", "not overwritten by the pull");
    assert.ok(
      report.events.some((e) => e.outcome === "pending" && e.path.endsWith("description.md")),
    );
    await runSync(cfg, api);
    assert.deepEqual(pushed, ["First edit.", "Second edit."], "pushed by the next run");
  } finally {
    rmSync(root, { recursive: true });
  }
});
