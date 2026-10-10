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
import { parse, stringify } from "yaml";
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

function oneCardApi(
  card: Record<string, unknown>,
  onUpdate: (patch: Record<string, unknown>) => void,
) {
  return {
    me: async () => ({ username: "admin", role: "admin" }),
    discover: async () => ({
      projects: [{ id: "p", name: "P" }],
      boards: [{ id: "1", name: "Main", position: 1, projectId: "p" }],
    }),
    snapshot: async () => {
      const snap = snapshot();
      if (card.id) (snap.included.cards as unknown[]).push({ ...card });
      return snap;
    },
    listCards: async () => ({ items: [], included: {} }),
    updateCard: async (_id: string, patch: Record<string, unknown>) => {
      onUpdate(patch);
      if (patch.name !== undefined) card.name = patch.name;
      if (patch.description !== undefined) card.description = patch.description;
      return card;
    },
  } as unknown as Planka;
}

const CARD = {
  boardId: "1",
  listId: "10",
  position: 65536,
  type: "project",
  dueDate: null,
  isDueCompleted: null,
  commentsTotal: 0,
};

test("a card.yaml edit made while the card is being created is kept and pushed next", async () => {
  const root = mkdtempSync(join(tmpdir(), "planka-sync-create-edit-"));
  try {
    const card: Record<string, unknown> = { ...CARD, id: "", name: "", description: "" };
    const patches: Record<string, unknown>[] = [];
    const dir = join(root, "main/010-todo/new-card");
    const api = oneCardApi(card, (p) => patches.push(p)) as unknown as Record<string, unknown>;
    api.createCard = async (_list: string, name: string) => {
      writeFileSync(join(dir, "card.yaml"), "title: Renamed while creating\n");
      Object.assign(card, { id: "901", name });
      return card;
    };
    const cfg: Config = { root, server: "s", project: "p", deletionCap: 10, watch: DEFAULT_WATCH };
    await runSync(cfg, api as unknown as Planka);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "card.yaml"), "title: New card\n");
    const report = await runSync(cfg, api as unknown as Planka);
    const yaml = readdirSync(join(root, "main/010-todo"))
      .map((d) => readFileSync(join(root, "main/010-todo", d, "card.yaml"), "utf8"))
      .join("");
    assert.match(yaml, /^id: "901"\ntitle: Renamed while creating\n/);
    assert.ok(report.events.some((e) => e.outcome === "pending" && e.path.endsWith("card.yaml")));
    await runSync(cfg, api as unknown as Planka);
    assert.ok(
      patches.some((p) => p.name === "Renamed while creating"),
      JSON.stringify(patches),
    );
  } finally {
    rmSync(root, { recursive: true });
  }
});

// Same branch as a comment file removed mid-run, whose removal the next run pushes as a delete;
// a removed description.md is restored by design, so the next run treats it like any removal.
test("a file removed while its card is pushed is handled like any removal next time", async () => {
  const root = mkdtempSync(join(tmpdir(), "planka-sync-midrun-rm-"));
  try {
    const card: Record<string, unknown> = { ...CARD, id: "9", name: "A", description: "Body." };
    const cardYaml = join(root, "main/010-todo/010-a/card.yaml");
    const desc = join(root, "main/010-todo/010-a/description.md");
    const patches: Record<string, unknown>[] = [];
    let interfere = false;
    const api = oneCardApi(card, (p) => {
      patches.push(p);
      if (interfere) rmSync(desc);
      interfere = false;
    });
    const cfg: Config = { root, server: "s", project: "p", deletionCap: 10, watch: DEFAULT_WATCH };
    await runSync(cfg, api);
    writeFileSync(cardYaml, readFileSync(cardYaml, "utf8").replace("title: A", "title: B"));
    interfere = true;
    const report = await runSync(cfg, api);
    assert.ok(!existsSync(join(root, "main/010-todo/010-b/description.md")), "not restored");
    assert.ok(report.events.some((e) => e.detail?.startsWith("removed during this sync")));
    await runSync(cfg, api);
    assert.equal(patches.length, 1, "the removal pushed nothing");
    assert.equal(patches[0]!.name, "B");
    assert.equal(patches[0]!.description, undefined);
    assert.ok(existsSync(join(root, "main/010-todo/010-b/description.md")), "then restored");
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("a board.yaml addition made while another one is pushed is kept and pushed next", async () => {
  const root = mkdtempSync(join(tmpdir(), "planka-sync-board-midrun-"));
  try {
    const labels: Record<string, unknown>[] = [];
    const created: string[] = [];
    const boardYaml = join(root, "main/board.yaml");
    const append = (name: string, color: string) => {
      const doc = parse(readFileSync(boardYaml, "utf8")) as { labels: unknown[] };
      doc.labels.push({ name, color });
      writeFileSync(boardYaml, stringify(doc));
    };
    let interfere = false;
    const api = {
      me: async () => ({ username: "admin", role: "admin" }),
      discover: async () => ({
        projects: [{ id: "p", name: "P" }],
        boards: [{ id: "1", name: "Main", position: 1, projectId: "p" }],
      }),
      snapshot: async () => {
        const snap = snapshot();
        (snap.included.labels as unknown[]).push(...labels.map((l) => ({ ...l })));
        return snap;
      },
      listCards: async () => ({ items: [], included: {} }),
      createLabel: async (_board: string, name: string, color: string) => {
        created.push(name);
        const label = { id: `5${labels.length}`, boardId: "1", name, color, position: 1 };
        labels.push(label);
        // Someone appends another label while this one is being created.
        if (interfere) append("later", "pumpkin-orange");
        interfere = false;
        return label;
      },
    } as unknown as Planka;
    const cfg: Config = { root, server: "s", project: "p", deletionCap: 10, watch: DEFAULT_WATCH };
    await runSync(cfg, api);
    append("bug", "berry-red");
    interfere = true;
    const report = await runSync(cfg, api);
    assert.deepEqual(created, ["bug"]);
    assert.match(readFileSync(boardYaml, "utf8"), /name: later/, "not overwritten by the pull");
    assert.ok(report.events.some((e) => e.outcome === "pending" && e.path === "main/board.yaml"));
    await runSync(cfg, api);
    assert.deepEqual(created, ["bug", "later"], "pushed by the next run");
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("a card directory removed while its card is pushed is trashed next, not recreated", async () => {
  const root = mkdtempSync(join(tmpdir(), "planka-sync-vanish-"));
  try {
    const card: Record<string, unknown> = { ...CARD, id: "9", name: "A", description: "Body." };
    const trash = { id: "99", boardId: "1", type: "trash", position: null, name: null };
    const attachment = {
      id: "7",
      cardId: "9",
      name: "notes.txt",
      type: "file",
      data: { url: "http://s/attachments/7/download/notes.txt", mimeType: "text/plain", size: 2 },
    };
    const dir = join(root, "main/010-todo/010-a");
    const patches: Record<string, unknown>[] = [];
    let interfere = false;
    const api = {
      me: async () => ({ username: "admin", role: "admin" }),
      discover: async () => ({
        projects: [{ id: "p", name: "P" }],
        boards: [{ id: "1", name: "Main", position: 1, projectId: "p" }],
      }),
      snapshot: async () => {
        const snap = snapshot();
        (snap.included.lists as unknown[]).push(trash);
        if (card.listId === "10") {
          (snap.included.cards as unknown[]).push({ ...card });
          (snap.included.attachments as unknown[]).push(attachment);
        }
        return snap;
      },
      listCards: async () => ({
        items: [],
        included: {
          users: [],
          cardLabels: [],
          tasks: [],
          taskLists: [],
          attachments: [],
          cardMemberships: [],
        },
      }),
      downloadAttachment: async () => new TextEncoder().encode("hi"),
      updateCard: async (_id: string, patch: Record<string, unknown>) => {
        patches.push(patch);
        Object.assign(
          card,
          Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
        );
        if (patch.name !== undefined) card.name = patch.name;
        // Someone removes the whole card directory while the title is being pushed.
        if (interfere) rmSync(dir, { recursive: true });
        interfere = false;
        return card;
      },
    } as unknown as Planka;
    const cfg: Config = { root, server: "s", project: "p", deletionCap: 10, watch: DEFAULT_WATCH };
    await runSync(cfg, api);
    assert.ok(existsSync(join(dir, "attachments/notes.txt")));
    const yaml = join(dir, "card.yaml");
    writeFileSync(yaml, readFileSync(yaml, "utf8").replace("title: A", "title: B"));
    interfere = true;
    await runSync(cfg, api);
    assert.deepEqual(
      readdirSync(join(root, "main/010-todo")),
      [],
      "the removed directory is not recreated by the attachment pull",
    );
    await runSync(cfg, api);
    assert.ok(
      patches.some((p) => p.listId === "99"),
      `trashed: ${JSON.stringify(patches)}`,
    );
  } finally {
    rmSync(root, { recursive: true });
  }
});
