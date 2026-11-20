import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregate, isNumeric, niceTicks } from "./chart.ts";
import type { Cell } from "./api.ts";

const rows: Cell[][] = [
  ["paid", "10.5", 1], ["shipped", 4, 2], ["paid", 2, 3], [null, 1, 4], ["refunded", null, 5],
];

test("numeric columns: numbers and numeric strings, nulls ignored", () => {
  assert.equal(isNumeric(rows, 1), true);
  assert.equal(isNumeric(rows, 0), false);
  assert.equal(isNumeric([[null], [null]], 0), false, "all NULL is not numeric");
});

test("bar: sum by category, biggest first; NULL is its own category; non-numbers skipped", () => {
  assert.deepEqual(aggregate(rows, 0, 1, "bar"), [{ label: "paid", value: 12.5 }, { label: "shipped", value: 4 }, { label: "NULL", value: 1 }]);
});

test("bar: count rows when no value column is chosen", () => {
  assert.deepEqual(aggregate(rows, 0, -1, "bar")[0], { label: "paid", value: 2 });
});

test("bar: long tails fold into Other", () => {
  const many: Cell[][] = Array.from({ length: 40 }, (_, i) => [`c${i}`, 40 - i]);
  const pts = aggregate(many, 0, 1, "bar", 10);
  assert.equal(pts.length, 10);
  assert.deepEqual(pts[9], { label: "Other", value: [...Array(31).keys()].reduce((a, i) => a + (31 - i), 0) });
});

test("line: numbers and dates sort along x", () => {
  assert.deepEqual(aggregate([[3, 1], [1, 2], [2, 3]], 0, 1, "line").map((p) => p.label), ["1", "2", "3"]);
  assert.deepEqual(aggregate([["2026-03-01", 1], ["2026-01-01", 2]], 0, 1, "line").map((p) => p.label), ["2026-01-01", "2026-03-01"]);
});

test("nice ticks", () => {
  assert.deepEqual(niceTicks(0, 87), [0, 20, 40, 60, 80, 100]);
  assert.deepEqual(niceTicks(0, 4), [0, 1, 2, 3, 4]);
  assert.deepEqual(niceTicks(-30, 45), [-40, -20, 0, 20, 40, 60]);
});

import { pieSlices } from "./chart.ts";
test("pie: top four plus Other, shares add up, negatives refused", () => {
  const rows = [["a", 50], ["b", 20], ["c", 10], ["d", 10], ["e", 6], ["f", 4]];
  const s = pieSlices(aggregate(rows, 0, 1, "bar", 5));
  assert.ok(Array.isArray(s));
  assert.deepEqual(s.map((x) => x.label), ["a", "b", "c", "d", "Other"]);
  assert.equal(s[4].value, 10);
  assert.ok(Math.abs(s[4].end - 2 * Math.PI) < 1e-9);
  assert.equal(s[0].share, 0.5);
  assert.ok("error" in (pieSlices([{ label: "x", value: -1 }]) as object));
  assert.ok("error" in (pieSlices([{ label: "x", value: 0 }]) as object));
});
