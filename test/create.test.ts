import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
