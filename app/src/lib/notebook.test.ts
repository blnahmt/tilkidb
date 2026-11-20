import { test } from "node:test";
import assert from "node:assert/strict";
import { fromFile, newNotebook, toFile } from "./notebook.ts";

test("a notebook survives a file round trip with fresh ids", () => {
  const nb = newNotebook("Revenue");
  const back = fromFile(toFile(nb), "x");
  assert.equal(back.name, "Revenue");
  assert.deepEqual(back.cells.map((c) => [c.kind, c.src]), nb.cells.map((c) => [c.kind, c.src]));
  assert.notEqual(back.id, nb.id);
  assert.notEqual(back.cells[0].id, nb.cells[0].id);
});

test("other files are refused with a readable message", () => {
  assert.throws(() => fromFile("not json", "x"), /not JSON/);
  assert.throws(() => fromFile('{"cells": []}', "x"), /not a Tilki DB notebook/);
  assert.throws(() => fromFile('{"format":"tilki-notebook","cells":[{"kind":"js","src":"x"}]}', "x"), /can't read/);
  assert.equal(fromFile('{"format":"tilki-notebook","cells":[]}', "File name").name, "File name");
});
