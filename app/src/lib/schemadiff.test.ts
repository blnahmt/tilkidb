import { test } from "node:test";
import assert from "node:assert/strict";
import { diffSchemas, migration } from "./schemadiff.ts";
import type { Table } from "./api.ts";

const t = (name: string, cols: [string, string, boolean?, boolean?, string?][], kind: "table" | "view" = "table", schema = "public"): Table => ({
  schema, name, kind, rows: null,
  columns: cols.map(([n, ty, pk = false, nullable = true, fk]) => ({ name: n, dataType: ty, nullable, pk, fk: fk ?? null })),
});

const source = [
  t("customers", [["id", "integer", true, false], ["email", "text", false, false], ["phone", "varchar(20)"]]),
  t("orders", [["id", "integer", true, false], ["customer_id", "integer", false, true, "customers"]]),
  t("v_totals", [["n", "bigint"]], "view"),
];
const target = [
  t("customers", [["id", "integer", true, false], ["email", "varchar(100)", false, true], ["legacy", "text"]]),
  t("old_log", [["id", "integer", true, false]]),
];

test("finds added, removed and changed tables and columns", () => {
  const d = diffSchemas(source, target);
  assert.deepEqual(d.map((x) => `${x.kind} ${x.name}`), ["changed customers", "added orders", "added v_totals", "removed old_log"]);
  assert.deepEqual(d[0].cols.map((c) => `${c.kind} ${c.name} ${c.what.join("+")}`), ["changed email type+null", "added phone ", "removed legacy "]);
  assert.equal(diffSchemas(source, source).length, 0, "identical schemas have no differences");
});

test("names match case-insensitively and across schemas when one side has a single schema", () => {
  const lite = [t("CUSTOMERS", [["ID", "integer", true, false]], "table", "main")];
  assert.equal(diffSchemas(lite, [t("customers", [["id", "INTEGER", true, false]])]).length, 0);
});

test("postgres migration: create, alter, commented drops", () => {
  const sql = migration(diffSchemas(source, target), "postgres", false);
  assert.match(sql, /ALTER TABLE "customers" ALTER COLUMN "email" TYPE text;/);
  assert.match(sql, /ALTER TABLE "customers" ALTER COLUMN "email" SET NOT NULL;/);
  assert.match(sql, /ALTER TABLE "customers" ADD COLUMN "phone" varchar\(20\);/);
  assert.match(sql, /^-- ALTER TABLE "customers" DROP COLUMN "legacy";$/m);
  assert.match(sql, /CREATE TABLE "orders" \(\n  "id" integer NOT NULL,\n  "customer_id" integer REFERENCES "customers",\n  PRIMARY KEY \("id"\)\n\);/);
  assert.match(sql, /^-- DROP TABLE "old_log";$/m);
  assert.match(migration(diffSchemas(source, target), "postgres", true), /^DROP TABLE "old_log";$/m);
});

test("mysql uses MODIFY, sqlite explains what it can't do", () => {
  const d = diffSchemas(source, target);
  assert.match(migration(d, "mysql", false), /ALTER TABLE `customers` MODIFY COLUMN `email` text NOT NULL;/);
  assert.match(migration(d, "mysql", false), /-- orders\.customer_id references customers: add the FOREIGN KEY by hand\./, "no source schema: can't know the column");
  assert.match(migration(d, "mysql", false, "", source), /  FOREIGN KEY \(`customer_id`\) REFERENCES `customers` \(`id`\)\n\);/);
  assert.match(migration(d, "sqlite", false), /-- customers\.email: SQLite can't change a column's type or null; rebuild the table\./);
});
