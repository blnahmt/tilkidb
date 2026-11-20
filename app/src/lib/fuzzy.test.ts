import { test } from "node:test";
import assert from "node:assert/strict";
import { fuzzyMatch, rank } from "./fuzzy.ts";

test("matches letters in order, case-insensitive, ignoring spaces in the query", () => {
  assert.deepEqual(fuzzyMatch("TS B", "Toggle sidebar")?.indices, [0, 7, 11]);
  assert.equal(fuzzyMatch("bst", "Toggle sidebar"), null);
});

test("empty query matches everything with no highlights", () => {
  assert.deepEqual(fuzzyMatch("", "Anything"), { score: 0, indices: [] });
});

test("word starts and contiguous runs rank higher", () => {
  const names = rank(["Format SQL", "Open orders"], "or", (s) => s).map((r) => r.item);
  assert.deepEqual(names, ["Open orders", "Format SQL"]);
});

test("empty query keeps the original order", () => {
  const items = ["b", "a", "c"];
  assert.deepEqual(rank(items, "  ", (s) => s).map((r) => r.item), items);
});

test("non-matching items are dropped", () => {
  assert.deepEqual(rank(["Theme: Red Fox", "Toggle sidebar"], "fox", (s) => s).map((r) => r.item), ["Theme: Red Fox"]);
});
