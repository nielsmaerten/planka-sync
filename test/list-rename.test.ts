import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type Config, DEFAULT_WATCH } from "../src/config.ts";
import type { List, Planka } from "../src/planka.ts";
import { runSync } from "../src/sync.ts";

type Rec = Record<string, unknown>;

/** Isolated remote state; the real sync engine reads and writes a temporary mirror. */
function fakePlanka() {
  const lists: (List & { boardId: string })[] = [
    { id: "10", boardId: "1", type: "active", position: 65536, name: "Todo" },
  ];
  const cards: Rec[] = [];
  const labels: Rec[] = [];
  let ids = 100;
  const card = (fields: Rec): Rec => ({
    boardId: "1",
    listId: "10",
    type: "project",
    dueDate: null,
    isDueCompleted: null,
    commentsTotal: 0,
    position: 65536 * (cards.length + 1),
    ...fields,
  });
  cards.push(card({ id: "9", name: "A", description: "Body." }));
  cards.push(card({ id: "8", name: "B", description: "Other." }));
  const listed = (listId: string) =>
    cards.filter((c) => c.listId === listId).map((c) => ({ ...c }));
  const none = {
    users: [],
    cardLabels: [],
    tasks: [],
    taskLists: [],
    attachments: [],
    cardMemberships: [],
  };
  const api = {
    me: async () => ({ username: "admin", role: "admin" }),
    discover: async () => ({
      projects: [{ id: "p", name: "P" }],
      boards: [{ id: "1", name: "Main", position: 1, projectId: "p" }],
    }),
    snapshot: async () => ({
      item: { id: "1", name: "Main", projectId: "p" },
      included: {
        lists: lists.map((l) => ({ ...l })),
        cards: lists.filter((l) => l.name !== null).flatMap((l) => listed(l.id)),
        labels: labels.map((l) => ({ ...l })),
        boardMemberships: [],
        users: [],
        cardLabels: [],
        tasks: [],
        taskLists: [],
        attachments: [],
        cardMemberships: [],
      },
    }),
    listCards: async (listId: string) => ({ items: listed(listId), included: none }),
    updateCard: async (id: string, patch: Rec) => {
      const c = cards.find((x) => x.id === id)!;
      for (const [k, v] of Object.entries(patch)) if (v !== undefined) c[k] = v;
      return c;
    },
    createCard: async (_list: string, name: string, description: string, position: number) => {
      const c = card({ id: String(++ids), name, description, position });
      cards.push(c);
      return c;
    },
    createLabel: async (boardId: string, name: string, color: string) => {
      const l = { id: String(++ids), boardId, name, color, position: labels.length + 1 };
      labels.push(l);
      return l;
    },
  };
  return { api: api as unknown as Planka, cards, lists };
}

function stageEdit(edit: string, old: string, cards: Rec[]): void {
  if (edit === "description" || edit === "conflict")
    writeFileSync(join(old, "description.md"), "Local edit.\n");
  if (edit === "conflict") cards[0]!.description = "Remote edit.";
  if (edit === "title")
    writeFileSync(
      join(old, "card.yaml"),
      readFileSync(join(old, "card.yaml"), "utf8").replace("title: A", "title: Edited"),
    );
  if (edit === "invalid") writeFileSync(join(old, "card.yaml"), "[invalid");
}

for (const edit of ["none", "description", "title", "invalid", "conflict"]) {
  test(`remote list rename preserves cards with ${edit} local edit`, async () => {
    const root = mkdtempSync(join(tmpdir(), "planka-sync-list-rename-"));
    try {
      const { api, cards, lists } = fakePlanka();
      const cfg: Config = {
        root,
        server: "s",
        project: "p",
        deletionCap: 10,
        watch: DEFAULT_WATCH,
      };
      assert.equal((await runSync(cfg, api)).stats.errors, 0);
      const old = join(root, "main/010-todo/010-a");
      stageEdit(edit, old, cards);
      lists[0]!.name = "Reference";
      const dry = await runSync(cfg, api, { dry: true });
      assert.ok(existsSync(join(old, "card.yaml")), "dry run leaves files in place");
      const report = await runSync(cfg, api);
      assert.equal(report.stats.deleted, 0);
      assert.equal(report.stats.errors, edit === "invalid" ? 1 : 0);
      assert.equal(dry.stats.errors, report.stats.errors);
      const dir = join(root, `main/010-reference/010-${edit === "title" ? "edited" : "a"}`);
      assert.ok(existsSync(join(dir, "card.yaml")));
      assert.equal(
        readFileSync(join(dir, "description.md"), "utf8"),
        edit === "description" || edit === "conflict" ? "Local edit.\n" : "Body.\n",
      );
      if (edit === "title") assert.equal(cards[0]!.name, "Edited");
      if (edit === "description") assert.equal(cards[0]!.description, "Local edit.");
      if (edit === "conflict")
        assert.equal(readFileSync(join(dir, "description.md.conflict"), "utf8"), "Remote edit.\n");
      assert.ok(existsSync(join(root, "main/010-reference/020-b/card.yaml")));
      const next = await runSync(cfg, api);
      assert.equal(next.stats.deleted, 0);
      assert.equal(next.stats.pushed, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

function stageMove(change: string, root: string, cards: Rec[]): void {
  if (change === "remote move") cards[0]!.listId = "20";
  if (change === "local move")
    renameSync(join(root, "main/010-todo/010-a"), join(root, "main/020-doing/010-a"));
  if (change === "remote reorder") cards[1]!.position = 1;
  if (change === "local reorder")
    renameSync(join(root, "main/010-todo/020-b"), join(root, "main/010-todo/005-b"));
  if (change === "new card") {
    mkdirSync(join(root, "main/010-todo/030-new"));
    writeFileSync(join(root, "main/010-todo/030-new/card.yaml"), "title: New\n");
  }
}

for (const change of ["remote move", "local move", "remote reorder", "local reorder", "new card"]) {
  test(`list rename preserves ${change} intent`, async () => {
    const root = mkdtempSync(join(tmpdir(), "planka-sync-list-move-"));
    try {
      const { api, cards, lists } = fakePlanka();
      lists.push({ id: "20", boardId: "1", type: "active", position: 131072, name: "Doing" });
      const cfg: Config = {
        root,
        server: "s",
        project: "p",
        deletionCap: 10,
        watch: DEFAULT_WATCH,
      };
      assert.equal((await runSync(cfg, api)).stats.errors, 0);
      lists[0]!.name = "Reference";
      stageMove(change, root, cards);
      const report = await runSync(cfg, api);
      assert.equal(report.stats.errors, 0, JSON.stringify(report.events));
      assert.equal(report.stats.deleted, 0);
      if (change.endsWith("move")) {
        assert.equal(cards[0]!.listId, "20");
        assert.ok(existsSync(join(root, "main/020-doing/010-a/card.yaml")));
      }
      if (change.endsWith("reorder"))
        assert.ok(Number(cards[1]!.position) < Number(cards[0]!.position));
      if (change === "new card") assert.equal(cards.filter((c) => c.name === "New").length, 1);
      if (change.startsWith("remote")) assert.equal(report.stats.pushed, 0);
      const next = await runSync(cfg, api);
      assert.equal(next.stats.errors, 0);
      assert.equal(next.stats.pushed, 0);
      assert.equal(next.stats.deleted, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const builtin of ["archive", "trash"]) {
  test(`named ${builtin} list does not shadow the built-in directory`, async () => {
    const root = mkdtempSync(join(tmpdir(), "planka-sync-builtin-"));
    try {
      const { api, cards, lists } = fakePlanka();
      lists[0]!.name = builtin[0]!.toUpperCase() + builtin.slice(1);
      lists.push({ id: "90", boardId: "1", type: builtin, position: null, name: null });
      cards[0]!.listId = "90";
      const cfg: Config = {
        root,
        server: "s",
        project: "p",
        deletionCap: 10,
        watch: DEFAULT_WATCH,
      };
      assert.equal((await runSync(cfg, api)).stats.errors, 0);
      cards[0]!.description = "Remote builtin edit.";
      cards[1]!.description = "Remote named-list edit.";
      const report = await runSync(cfg, api);
      assert.equal(report.stats.errors, 0, JSON.stringify(report.events));
      assert.equal(report.stats.pushed, 0);
      assert.equal(
        readFileSync(join(root, `main/${builtin}/010-a/description.md`), "utf8"),
        "Remote builtin edit.\n",
      );
      assert.equal(
        readFileSync(join(root, `main/010-${builtin}/010-b/description.md`), "utf8"),
        "Remote named-list edit.\n",
      );
      // The normal list can still be renamed while the reserved directory keeps its identity.
      lists[0]!.name = "Reference";
      assert.equal((await runSync(cfg, api)).stats.errors, 0);
      assert.equal(cards[0]!.listId, "90");
      assert.ok(existsSync(join(root, `main/${builtin}/010-a/card.yaml`)));
      assert.ok(existsSync(join(root, "main/010-reference/010-b/card.yaml")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
