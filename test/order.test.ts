import assert from "node:assert/strict";
import { test } from "node:test";
import { byPrefix, positionsFor } from "../src/order.ts";

test("positionsFor leaves an unchanged order alone", () => {
  const m = positionsFor([
    { id: "a", remote: 65536 },
    { id: "b", remote: 131072 },
  ]);
  assert.equal(m.size, 0);
});

test("positionsFor places a moved card between its new neighbours", () => {
  // wanted: b, a, c ; remote: a=65536 b=131072 c=196608
  const m = positionsFor([
    { id: "b", remote: 131072 },
    { id: "a", remote: 65536 },
    { id: "c", remote: 196608 },
  ]);
  assert.deepEqual([...m], [["a", 131072 + Math.floor((196608 - 131072) / 2)]]);
});

test("positionsFor appends a new card at the bottom", () => {
  const m = positionsFor([
    { id: "a", remote: 65536 },
    { id: "n", remote: null },
  ]);
  assert.deepEqual([...m], [["n", 131072]]);
});

test("positionsFor inserts a new card between two kept ones", () => {
  const m = positionsFor([
    { id: "a", remote: 100 },
    { id: "n", remote: null },
    { id: "b", remote: 200 },
  ]);
  assert.deepEqual([...m], [["n", 150]]);
});

test("positionsFor renumbers the tail when no gap is left", () => {
  const m = positionsFor([
    { id: "a", remote: 100 },
    { id: "n", remote: null },
    { id: "b", remote: 101 },
  ]);
  assert.deepEqual(
    [...m],
    [
      ["n", 100 + 65536],
      ["b", 100 + 2 * 65536],
    ],
  );
});

test("byPrefix sorts by prefix and keeps unprefixed items last", () => {
  const sorted = byPrefix([
    { order: null, n: "x" },
    { order: 20, n: "b" },
    { order: 10, n: "a" },
  ]);
  assert.deepEqual(
    sorted.map((i) => i.n),
    ["a", "b", "x"],
  );
});
