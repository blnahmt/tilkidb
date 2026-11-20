import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChanges, buildCount, buildSelect, buildWhere, literal, qualified, quoteIdent } from "./sqlgen.ts";
import type { Cell } from "./api.ts";

test("identifiers are quoted and escaped per engine", () => {
  assert.equal(quoteIdent("postgres", 'we"ird'), '"we""ird"');
  assert.equal(quoteIdent("mysql", "we`ird"), "`we``ird`");
  assert.equal(qualified("postgres", { schema: "public", name: "t" }), '"t"');
  assert.equal(qualified("postgres", { schema: "sales", name: "t" }), '"sales"."t"');
  assert.equal(qualified("mysql", { schema: "shop", name: "t" }), "`shop`.`t`");
});

test("literals escape quotes, and backslashes only for MySQL", () => {
  assert.equal(literal("postgres", "it's"), "'it''s'");
  assert.equal(literal("postgres", String.raw`C:\x`), String.raw`'C:\x'`);
  assert.equal(literal("mysql", String.raw`C:\x' OR 1=1 --`), String.raw`'C:\\x'' OR 1=1 --'`);
  assert.equal(literal("sqlite", null), "NULL");
  assert.equal(literal("sqlite", 42), "42");
  assert.equal(literal("postgres", true), "TRUE");
  assert.equal(literal("postgres", { a: "b'c" }), `'{"a":"b''c"}'`);
});

test("filter builder: joins, IN lists, NULL checks, empty rows skipped", () => {
  assert.equal(
    buildWhere("postgres", [
      { join: "AND", col: "status", op: "=", val: "paid" },
      { join: "AND", col: "total", op: ">", val: "" }, // no value yet: skipped
      { join: "OR", col: "country", op: "IN", val: "TR, DE" },
      { join: "AND", col: "note", op: "IS NULL", val: "" },
    ]),
    `"status" = 'paid' OR "country" IN ('TR', 'DE') AND "note" IS NULL`,
  );
  assert.equal(buildWhere("mysql", [{ join: "AND", col: "name", op: "ILIKE", val: "%a%" }]), "`name` LIKE '%a%'", "ILIKE only on PostgreSQL");
});

test("page and count queries", () => {
  const t = { schema: "public", name: "orders" };
  assert.equal(buildSelect("postgres", t, `"status" = 'paid'`, [{ col: "id", dir: "DESC" }], 500, 1000), `SELECT * FROM "orders" WHERE "status" = 'paid' ORDER BY "id" DESC LIMIT 500 OFFSET 1000`);
  assert.equal(buildSelect("sqlite", t, " ", [], 500, 0), `SELECT * FROM "orders" LIMIT 500`);
  assert.equal(buildCount("sqlite", t, ""), `SELECT count(*) FROM "orders"`);
});

test("changes: deletes, updates by primary key, inserts", () => {
  const rows: Cell[][] = [[1, "a", null], [2, "b", "x"], [3, "it's", null]];
  const edits = new Map<number, Map<number, Cell>>([
    [0, new Map<number, Cell>([[1, "A"], [2, null]])],
    [1, new Map<number, Cell>([[1, "ignored, row is deleted"]])],
    [3, new Map<number, Cell>([[1, "new"]])], // first inserted row
  ]);
  const ch = buildChanges("postgres", { schema: "public", name: "t" }, ["id", "name", "note"], [0], rows, edits, new Set([1]), 2);
  assert.deepEqual(ch, [
    { sql: `DELETE FROM "t" WHERE "id" = 2`, expectOne: true },
    { sql: `UPDATE "t" SET "name" = 'A', "note" = NULL WHERE "id" = 1`, expectOne: true },
    { sql: `INSERT INTO "t" ("name") VALUES ('new')`, expectOne: false },
    { sql: `INSERT INTO "t" DEFAULT VALUES`, expectOne: false },
  ]);
  assert.equal(buildChanges("mysql", { schema: "shop", name: "t" }, ["id"], [0], [], new Map(), new Set(), 1)[0].sql, "INSERT INTO `shop`.`t` () VALUES ()");
});

test("composite primary keys and string keys", () => {
  const ch = buildChanges("sqlite", { schema: "main", name: "t" }, ["a", "b", "v"], [0, 1], [["x", "it's", 1]], new Map([[0, new Map<number, Cell>([[2, 2]])]]), new Set(), 0);
  assert.equal(ch[0].sql, `UPDATE "t" SET "v" = 2 WHERE "a" = 'x' AND "b" = 'it''s'`);
});
