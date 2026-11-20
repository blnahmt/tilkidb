import { test } from "node:test";
import assert from "node:assert/strict";
import { addColumn, addIndex, changeColumn, createTable, dropColumn, dropIndex, renameColumn, renameTable } from "./ddl.ts";

const pg = { schema: "sales", name: "order items" }, my = { schema: "shop", name: "orders" }, lite = { schema: "main", name: "t" };
const col = { name: "note", type: "varchar(50)", nullable: false, default: "''" };

test("column statements quote names per engine", () => {
  assert.equal(addColumn("postgres", pg, col), `ALTER TABLE "sales"."order items" ADD COLUMN "note" varchar(50) NOT NULL DEFAULT ''`);
  assert.equal(dropColumn("mysql", my, "a`b"), "ALTER TABLE `shop`.`orders` DROP COLUMN `a``b`");
  assert.equal(renameColumn("sqlite", lite, "a", "b"), `ALTER TABLE "t" RENAME COLUMN "a" TO "b"`);
  assert.equal(renameTable("mysql", my, "orders_old"), "RENAME TABLE `shop`.`orders` TO `orders_old`");
});

test("type / null changes: PostgreSQL step by step, MySQL MODIFY, SQLite not possible", () => {
  assert.deepEqual(changeColumn("postgres", pg, { ...col, nullable: true, default: "" }, { type: "text", nullable: false }), [
    `ALTER TABLE "sales"."order items" ALTER COLUMN "note" TYPE varchar(50)`,
    `ALTER TABLE "sales"."order items" ALTER COLUMN "note" DROP NOT NULL`,
    `ALTER TABLE "sales"."order items" ALTER COLUMN "note" DROP DEFAULT`,
  ]);
  assert.deepEqual(changeColumn("mysql", my, col, { type: "text", nullable: true }), ["ALTER TABLE `shop`.`orders` MODIFY COLUMN `note` varchar(50) NOT NULL DEFAULT ''"]);
  assert.equal(changeColumn("sqlite", lite, col, { type: "TEXT", nullable: true }), null);
});

test("indexes and new tables", () => {
  assert.equal(addIndex("postgres", pg, "ix", ["a", "b"], true), `CREATE UNIQUE INDEX "ix" ON "sales"."order items" ("a", "b")`);
  assert.equal(dropIndex("postgres", pg, "ix"), `DROP INDEX "sales"."ix"`);
  assert.equal(dropIndex("mysql", my, "ix"), "DROP INDEX `ix` ON `shop`.`orders`");
  assert.equal(dropIndex("mysql", my, "PRIMARY"), "ALTER TABLE `shop`.`orders` DROP PRIMARY KEY");
  assert.equal(createTable("postgres", { schema: "public", name: "people" }, [
    { name: "id", type: "bigserial", nullable: true, default: "", pk: true },
    { name: "name", type: "text", nullable: false, default: "" },
    { name: "", type: "text", nullable: true, default: "" },
  ]), `CREATE TABLE "people" (\n  "id" bigserial NOT NULL,\n  "name" text NOT NULL,\n  PRIMARY KEY ("id")\n)`);
});
