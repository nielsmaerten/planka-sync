import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assignOrders,
  formatPrefixed,
  parsePrefixed,
  renumber,
  slugify,
  uniqueSlugs,
} from "../src/naming.ts";

test("slugify strips accents and punctuation", () => {
  assert.equal(slugify("Café: Déjà vu!"), "cafe-deja-vu");
  assert.equal(slugify(""), "untitled");
  assert.equal(slugify(null), "untitled");
});

test("uniqueSlugs suffixes repeats in order", () => {
  const m = uniqueSlugs([
    { id: "a", name: "Foo" },
    { id: "b", name: "foo" },
    { id: "c", name: "Bar" },
    { id: "d", name: "FOO" },
  ]);
  assert.deepEqual([...m.values()], ["foo", "foo-2", "bar", "foo-3"]);
});

test("parsePrefixed and formatPrefixed round-trip", () => {
  assert.deepEqual(parsePrefixed("020-my-card"), { order: 20, slug: "my-card" });
  assert.deepEqual(parsePrefixed("my-card"), { order: null, slug: "my-card" });
  assert.deepEqual(parsePrefixed("2026-09-23-notes"), { order: 2026, slug: "09-23-notes" });
  assert.equal(formatPrefixed(20, "my-card"), "020-my-card");
  assert.equal(formatPrefixed(1500, "x", 4), "1500-x");
});

test("assignOrders numbers a fresh list in steps of 10", () => {
  const { orders, width } = assignOrders([
    { id: "a", current: null },
    { id: "b", current: null },
    { id: "c", current: null },
  ]);
  assert.deepEqual([...orders.values()], [10, 20, 30]);
  assert.equal(width, 3);
});

test("assignOrders keeps existing numbers and slots a new item into the gap", () => {
  const { orders } = assignOrders([
    { id: "a", current: 10 },
    { id: "new", current: null },
    { id: "b", current: 20 },
    { id: "c", current: 30 },
  ]);
  assert.deepEqual([...orders.values()], [10, 15, 20, 30]);
});

test("assignOrders appends after the last kept number", () => {
  const { orders } = assignOrders([
    { id: "a", current: 10 },
    { id: "b", current: 25 },
    { id: "new", current: null },
  ]);
  assert.deepEqual([...orders.values()], [10, 25, 35]);
});

test("assignOrders renumbers the tail when a gap is exhausted", () => {
  const { orders } = assignOrders([
    { id: "a", current: 10 },
    { id: "new", current: null },
    { id: "b", current: 11 },
    { id: "c", current: 30 },
  ]);
  assert.deepEqual([...orders.values()], [10, 20, 30, 40]);
});

test("assignOrders renumbers items that moved out of order", () => {
  // Planka order is b, a; on disk a=10, b=20.
  const { orders } = assignOrders([
    { id: "b", current: 20 },
    { id: "a", current: 10 },
  ]);
  assert.deepEqual([...orders.values()], [20, 30]);
});

test("assignOrders widens the prefix past 999", () => {
  const { orders, width } = assignOrders([
    { id: "a", current: 995 },
    { id: "b", current: null },
  ]);
  assert.deepEqual([...orders.values()], [995, 1005]);
  assert.equal(width, 4);
});

test("renumber restarts from 10", () => {
  assert.deepEqual([...renumber(["x", "y"]).orders.values()], [10, 20]);
});
