// The invariant behind review rounds 13–15 of PR #1, tested as a class: a sync pass never
// overwrites or removes local state that changed since it read it. One run pushes a title edit,
// creates a card and adds a label; at the k-th write to Planka, for every k, someone edits the
// files involved. Every such edit must reach Planka by the next run.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse, stringify } from "yaml";
import { type Config, DEFAULT_WATCH } from "../src/config.ts";
import type { Planka } from "../src/planka.ts";
import { runSync } from "../src/sync.ts";

type Rec = Record<string, unknown>;

/** An in-memory Planka with one board and one list; `onWrite` runs before each write applies. */
function fakePlanka(onWrite: () => void) {
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
  const api = {
    me: async () => ({ username: "admin", role: "admin" }),
    discover: async () => ({
      projects: [{ id: "p", name: "P" }],
      boards: [{ id: "1", name: "Main", position: 1, projectId: "p" }],
    }),
    snapshot: async () => ({
      item: { id: "1", name: "Main", projectId: "p" },
      included: {
        lists: [{ id: "10", boardId: "1", type: "active", position: 65536, name: "Todo" }],
        cards: cards.map((c) => ({ ...c })),
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
    updateCard: async (id: string, patch: Rec) => {
      onWrite();
      const c = cards.find((x) => x.id === id)!;
      for (const [k, v] of Object.entries(patch)) if (v !== undefined) c[k] = v;
      return c;
    },
    createCard: async (_list: string, name: string, description: string, position: number) => {
      onWrite();
      const c = card({ id: String(++ids), name, description, position });
      cards.push(c);
      return c;
    },
    createLabel: async (boardId: string, name: string, color: string) => {
      onWrite();
      const l = { id: String(++ids), boardId, name, color, position: labels.length + 1 };
      labels.push(l);
      return l;
    },
  };
  return { api: api as unknown as Planka, cards, labels };
}

/** The card directory under main/010-todo whose card.yaml has this title, if any. */
function findCard(root: string, title: string): string | undefined {
  const list = join(root, "main/010-todo");
  const dir = readdirSync(list).find((d) => {
    const yaml = parse(readFileSync(join(list, d, "card.yaml"), "utf8")) as { title?: string };
    return yaml.title === title;
  });
  return dir === undefined ? undefined : join(list, dir);
}

function cardDir(root: string, title: string): string {
  const dir = findCard(root, title);
  assert.ok(dir, `a card titled ${title}`);
  return dir;
}

/** The local changes this run pushes: a title edit, a new card, a new label. */
function stageChanges(root: string): void {
  const a = join(cardDir(root, "A"), "card.yaml");
  writeFileSync(a, readFileSync(a, "utf8").replace("title: A", "title: A2"));
  mkdirSync(join(root, "main/010-todo/new"));
  writeFileSync(join(root, "main/010-todo/new/card.yaml"), "title: New\n");
  appendLabel(root, "bug");
}

function appendLabel(root: string, name: string): void {
  const path = join(root, "main/board.yaml");
  const doc = parse(readFileSync(path, "utf8")) as { labels: Rec[] };
  doc.labels.push({ name, color: "berry-red" });
  writeFileSync(path, stringify(doc));
}

/** What someone does at the k-th write: edits every file this run is pushing. */
function interfere(root: string, k: number): void {
  const a = findCard(root, "A2") ?? cardDir(root, "A");
  writeFileSync(join(a, "description.md"), `Edited at write ${k}.\n`);
  const fresh = join(cardDir(root, "New"), "card.yaml");
  writeFileSync(fresh, readFileSync(fresh, "utf8").replace("title: New", `title: New ${k}`));
  appendLabel(root, `late-${k}`);
}

async function scenario(
  k: number,
): Promise<{ writes: number; planka: ReturnType<typeof fakePlanka> }> {
  const root = mkdtempSync(join(tmpdir(), "planka-sync-interleave-"));
  try {
    let writes = 0;
    let armed = false;
    const planka = fakePlanka(() => {
      writes += 1;
      if (armed && writes === k) interfere(root, k);
    });
    const cfg: Config = { root, server: "s", project: "p", deletionCap: 10, watch: DEFAULT_WATCH };
    await runSync(cfg, planka.api);
    stageChanges(root);
    writes = 0;
    armed = true;
    await runSync(cfg, planka.api);
    armed = false;
    await runSync(cfg, planka.api);
    return { writes, planka };
  } finally {
    rmSync(root, { recursive: true });
  }
}

test("edits made at any write of a run reach Planka by the next run", async () => {
  const { writes } = await scenario(0);
  assert.ok(writes >= 3, `the run writes the title, the new card and the label (${writes})`);
  for (let k = 1; k <= writes; k++) {
    const { planka } = await scenario(k);
    const a = planka.cards.find((c) => c.id === "9")!;
    assert.equal(a.description, `Edited at write ${k}.`, `description edited at write ${k}`);
    assert.ok(
      planka.cards.some((c) => c.name === `New ${k}`),
      `new card renamed at write ${k}: ${planka.cards.map((c) => c.name).join(", ")}`,
    );
    assert.ok(
      planka.labels.some((l) => l.name === `late-${k}`),
      `label appended at write ${k}: ${planka.labels.map((l) => l.name).join(", ")}`,
    );
  }
});
