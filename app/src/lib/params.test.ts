import { test } from "node:test";
import assert from "node:assert/strict";
import { fillParams, findParams } from "./params.ts";

test("finds :name placeholders but not casts, assignments, strings or comments", () => {
  assert.deepEqual(findParams("SELECT * FROM t WHERE id = :id AND d > :since::date AND x = ':no' -- :c\n AND y = :id"), ["id", "since"]);
  assert.deepEqual(findParams("SELECT @a := 1, created::text, $$ :body $$, \"col:x\""), []);
  assert.deepEqual(findParams("SELECT 10:30"), [], "a time literal is not a parameter");
});

test("fills values as literals", () => {
  const sql = "SELECT * FROM t WHERE id = :id AND name = :name AND note IS :n AND p = :p::numeric";
  assert.equal(fillParams(sql, { id: "42", name: "O'Neil", n: "null", p: "-1.5" }, "postgres"),
    "SELECT * FROM t WHERE id = 42 AND name = 'O''Neil' AND note IS NULL AND p = -1.5::numeric");
  assert.equal(fillParams("WHERE a = :a", { a: "x\\y" }, "mysql"), "WHERE a = 'x\\\\y'", "MySQL doubles backslashes");
});
