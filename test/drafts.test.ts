import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { writeScaffold } from "../src/agents.ts";
import { scanBoard } from "../src/local.ts";
import type { BoardIndex } from "../src/model.ts";
import { ancestors, hash, removeEmptyDirs, Store } from "../src/state.ts";
import { validateRoot } from "../src/validate.ts";

const BOARD_YAML =
  "id: '1'\nname: Main\nlists:\n  - { dir: 010-todo, name: Todo, type: active, id: '2' }\nlabels: []\nmembers: []\n";

/** A mirror with one board, one list, one synced card and one directory being drafted. */
function mirror(): { root: string; store: Store } {
  const root = mkdtempSync(join(tmpdir(), "planka-sync-drafts-"));
  const write = (rel: string, content: string) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), content);
  };
  write("planka-sync.yaml", "server: s\nproject: '7'\n");
  write("main/board.yaml", BOARD_YAML);
  write("main/010-todo/010-a/card.yaml", "id: '9'\ntitle: A\n");
  write("main/010-todo/new-card/description.md", "Body first.\n");
  write("main/010-todo/new-card/card.yaml.draft", "title: New\n");
  const store = new Store(root);
  store.save({
    "main/board.yaml": { kind: "board", hash: hash(BOARD_YAML), id: "1" },
    "main/010-todo/010-a/card.yaml": {
      kind: "card",
      hash: hash("id: '9'\ntitle: A\n"),
      id: "9",
      cardId: "9",
    },
  });
  return { root, store };
}

test("a directory without card.yaml is invisible to the sync", () => {
  const { root, store } = mirror();
  try {
    const index = { boardDir: "main" } as BoardIndex;
    const local = scanBoard(store, store.load(), index);
    assert.deepEqual([...local.byId.keys()], ["9"]);
    assert.deepEqual(local.fresh, [], "a draft is not a card to create");
    assert.deepEqual(local.broken, []);
    assert.equal(local.invalid.size, 0);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("validate lists a draft as a warning, not as errors", () => {
  const { root } = mirror();
  try {
    const v = validateRoot(root);
    assert.deepEqual(v.errors, []);
    assert.ok(v.warnings.some((w) => w.startsWith("main/010-todo/new-card: draft, not synced")));
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("a synced card whose card.yaml became a draft is still an error", () => {
  const { root } = mirror();
  try {
    const dir = join(root, "main/010-todo/010-a");
    rmSync(join(dir, "card.yaml"));
    writeFileSync(join(dir, "card.yaml.draft"), "id: '9'\ntitle: A\n");
    const v = validateRoot(root);
    assert.ok(v.errors.includes("main/010-todo/010-a/card.yaml: missing"));
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("the scaffold ignores the watcher's pid file, also in an existing .gitignore", () => {
  const root = mkdtempSync(join(tmpdir(), "planka-sync-scaffold-"));
  try {
    assert.ok(writeScaffold(root).includes(".gitignore"));
    const fresh = readFileSync(join(root, ".gitignore"), "utf8");
    assert.match(fresh, /^\/\.planka-sync\/$/m);
    assert.match(fresh, /^\/\.planka-watcher\.pid$/m);
    writeFileSync(join(root, ".gitignore"), "node_modules\n/.planka-sync/\n");
    assert.deepEqual(writeScaffold(root), [".gitignore (appended)"]);
    assert.equal(
      readFileSync(join(root, ".gitignore"), "utf8"),
      "node_modules\n/.planka-sync/\n# planka-sync: a running watcher's pid, per machine.\n/.planka-watcher.pid\n",
    );
    assert.deepEqual(writeScaffold(root), []);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("cleanup keeps an empty directory someone made, removes ones the sync left empty", () => {
  const root = mkdtempSync(join(tmpdir(), "planka-sync-empty-"));
  try {
    mkdirSync(join(root, "main/010-todo/new-card"), { recursive: true });
    mkdirSync(join(root, "main/010-todo/010-a/comments"), { recursive: true });
    writeFileSync(join(root, "main/010-todo/010-a/card.yaml"), "id: '9'\n");
    const produced = ancestors(["main/010-todo/010-a/comments/old.md", "main/board.yaml"]);
    removeEmptyDirs(root, new Set(["main/010-todo"]), produced);
    assert.ok(existsSync(join(root, "main/010-todo/new-card")), "a card in the making stays");
    assert.ok(!existsSync(join(root, "main/010-todo/010-a/comments")), "emptied by the sync");
  } finally {
    rmSync(root, { recursive: true });
  }
});
