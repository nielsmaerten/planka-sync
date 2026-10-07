import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseBoardFilter, readConfig, writeConfig } from "../src/config.ts";
import { selectBoards } from "../src/project.ts";
import { parseSelection } from "../src/prompt.ts";

const boards = [
  { id: "1", name: "Main", position: 1, projectId: "p" },
  { id: "2", name: "Ideas", position: 2, projectId: "p" },
  { id: "3", name: "Archive", position: 3, projectId: "p" },
];

test("no filter mirrors every board", () => {
  const s = selectBoards(boards, undefined);
  assert.deepEqual(s.boards, boards);
  assert.deepEqual(s.excluded, []);
  assert.deepEqual(s.unmatched, []);
});

test("include keeps project order and matches by name or id", () => {
  const s = selectBoards(boards, { include: ["3", "Main"] });
  assert.deepEqual(
    s.boards.map((b) => b.name),
    ["Main", "Archive"],
  );
  assert.deepEqual(
    s.excluded.map((b) => b.name),
    ["Ideas"],
  );
});

test("exclude drops the named boards and reports unknown names", () => {
  const s = selectBoards(boards, { exclude: ["Archive", "Gone"] });
  assert.deepEqual(
    s.boards.map((b) => b.name),
    ["Main", "Ideas"],
  );
  assert.deepEqual(
    s.excluded.map((b) => b.name),
    ["Archive"],
  );
  assert.deepEqual(s.unmatched, ["Gone"]);
});

test("parseBoardFilter accepts one list and rejects the rest", () => {
  assert.equal(parseBoardFilter(undefined), undefined);
  assert.equal(parseBoardFilter(null), undefined);
  assert.deepEqual(parseBoardFilter({ include: ["A", 42] }), { include: ["A", "42"] });
  assert.deepEqual(parseBoardFilter({ exclude: ["B"] }), { exclude: ["B"] });
  assert.throws(() => parseBoardFilter({}), /exactly one/);
  assert.throws(() => parseBoardFilter({ include: ["A"], exclude: ["B"] }), /exactly one/);
  assert.throws(() => parseBoardFilter({ include: [] }), /non-empty/);
  assert.throws(() => parseBoardFilter({ exclude: "A" }), /non-empty/);
  assert.throws(() => parseBoardFilter({ include: [{ name: "A" }] }), /not a board name/);
});

test("config round-trips the board filter and omits it when absent", () => {
  const root = mkdtempSync(join(tmpdir(), "planka-sync-"));
  try {
    const base = { root, server: "https://p.example", project: "7", deletionCap: 10 };
    writeConfig(base);
    assert.equal(readConfig(root)?.boards, undefined);
    assert.doesNotMatch(readFileSync(join(root, "planka-sync.yaml"), "utf8"), /^boards:/m);
    writeConfig({ ...base, boards: { exclude: ["Archive"] } });
    assert.deepEqual(readConfig(root)?.boards, { exclude: ["Archive"] });
    writeFileSync(
      join(root, "planka-sync.yaml"),
      "server: s\nproject: 7\nboards:\n  include: []\n",
    );
    assert.throws(() => readConfig(root), /non-empty/);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("parseSelection reads numbers and ranges within bounds", () => {
  assert.deepEqual(parseSelection("1, 3-4", 5), [0, 2, 3]);
  assert.deepEqual(parseSelection("2 2", 2), [1]);
  assert.deepEqual(parseSelection("", 3), []);
  assert.equal(parseSelection("0", 3), null);
  assert.equal(parseSelection("4", 3), null);
  assert.equal(parseSelection("3-1", 3), null);
  assert.equal(parseSelection("a", 3), null);
});
