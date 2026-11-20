import { test } from "node:test";
import assert from "node:assert/strict";
import type { Column, Table } from "./api.ts";
import { aliasFor, joinHints, tablesInScope } from "./joins.ts";
import { errorSpan } from "./errpos.ts";
import { diffRows, kindOf, norm, syncSql } from "./datadiff.ts";
import { fakeRows } from "./fakedata.ts";
import { editorKind, enumValues, fromInputDateTime, toInputDateTime } from "./celltypes.ts";
import { canon, clash, keyOf, loadKeys, matches, pretty } from "./keymap.ts";
import { parseClipboard } from "./gridcopy.ts";
import { buildWhere } from "./sqlgen.ts";

const col = (name: string, dataType: string, pk = false, fk: string | null = null, nullable = true): Column => ({ name, dataType, nullable, pk, fk });
const tbl = (name: string, columns: Column[]): Table => ({ schema: "public", name, kind: "table", rows: null, columns });
const shop = [
  tbl("customers", [col("id", "integer", true), col("email", "text"), col("referred_by", "integer", false, "customers")]),
  tbl("orders", [col("id", "integer", true), col("customer_id", "integer", false, "customers")]),
  tbl("order_items", [col("id", "integer", true), col("order_id", "integer", false, "orders"), col("product_id", "integer", false, "products")]),
  tbl("products", [col("id", "integer", true), col("name", "text")]),
];

test("join hints follow foreign keys both ways", () => {
  assert.deepEqual(tablesInScope("SELECT * FROM customers c JOIN orders AS o ON o.customer_id = c.id JOIN ", shop).map((s) => s.alias), ["c", "o"]);
  assert.deepEqual(joinHints("SELECT * FROM customers c JOIN ", shop).map((h) => h.label), [
    "customers c2 ON c2.id = c.referred_by", "orders o ON o.customer_id = c.id",
  ]);
  assert.deepEqual(joinHints("select * from order_items JOIN ", shop).map((h) => h.label), [
    "orders o ON o.id = order_items.order_id", "products p ON p.id = order_items.product_id",
  ]);
  assert.equal(aliasFor("order_items", new Set(["oi"])), "oi2");
  assert.deepEqual(joinHints("SELECT 1 JOIN ", shop), []);
});

test("error spans: PostgreSQL position, MySQL near, SQLite near, unknown names", () => {
  const sql = "SELECT id, nope FROM customers";
  assert.deepEqual(errorSpan("postgres", 'column "nope" does not exist\nAt character 12.', sql), { from: 11, to: 15 });
  assert.deepEqual(errorSpan("mysql", "You have an error in your SQL syntax; check the manual near 'FORM customers' at line 2", "SELECT id\nFORM customers"), { from: 10, to: 14 });
  assert.deepEqual(errorSpan("sqlite", 'near "FORM": syntax error', "SELECT 1 FORM t"), { from: 9, to: 13 });
  assert.deepEqual(errorSpan("sqlite", "no such column: nope", sql), { from: 11, to: 15 });
  assert.deepEqual(errorSpan("mysql", "Unknown column 'c.nope' in 'field list'", "SELECT c.nope FROM customers c"), { from: 7, to: 13 });
  assert.equal(errorSpan("postgres", "permission denied", sql), null);
});

test("data diff: keyed changes, adds, removes, and values that only look different", () => {
  assert.equal(norm("1.50", "num"), norm(1.5, "num"));
  assert.equal(norm(true), norm(1));
  assert.equal(norm("007", "num"), "7");
  assert.equal(norm("007"), "007", "text columns compare exactly (zip codes)");
  assert.equal(norm("t", "bool"), norm(true));
  const src = [[1, "a", "1.50"], [2, "b", "2"], [4, "d", "4"]];
  const dst = [[1, "a", 1.5], [2, "B", "2"], [3, "c", "3"]];
  const d = diffRows(src, dst, [0], ["num", "text", "num"]);
  assert.deepEqual(diffRows([["01", "x"]], [["1", "x"]], [0], ["text", "text"]).added.length, 1, "text keys 01 and 1 are different rows");
  assert.equal(d.same, 1);
  assert.deepEqual(d.added, [[4, "d", "4"]]);
  assert.deepEqual(d.removed, [[3, "c", "3"]]);
  assert.deepEqual(d.changed.map((c) => c.cols), [[1]]);
  assert.deepEqual(syncSql("postgres", { schema: "public", name: "t" }, ["id", "v", "n"], [0], d, true), [
    `DELETE FROM "t" WHERE "id" = 3;`, `UPDATE "t" SET "v" = 'b' WHERE "id" = 2;`, `INSERT INTO "t" ("id", "v", "n") OVERRIDING SYSTEM VALUE VALUES (4, 'd', '4');`,
  ]);
  const whole = diffRows([[1], [1], [2]], [[1], [3]], []);
  assert.deepEqual([whole.same, whole.added, whole.removed], [1, [[1], [2]], [[3]]]);
});

test("fake rows: generated keys left out, FKs from parents, types and names respected, deterministic", () => {
  const cols = [col("id", "integer", true), col("email", "varchar(40)"), col("customer_id", "integer", false, "customers", false), col("price", "numeric(10,2)"),
    col("active", "boolean"), col("created_at", "timestamp"), col("status", "enum('new','paid')"), col("code", "uuid", true)];
  const a = fakeRows(cols, 3, 7, { customer_id: [10, 11] });
  assert.deepEqual(a, fakeRows(cols, 3, 7, { customer_id: [10, 11] }));
  for (const [k, r] of a.entries()) {
    assert.equal(r[0], undefined);
    assert.match(String(r[1]), new RegExp(`${k + 1}@example\\.com$`));
    assert.ok([10, 11].includes(r[2] as number));
    assert.equal(typeof r[3], "number");
    assert.equal(typeof r[4], "boolean");
    assert.match(String(r[5]), /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
    assert.ok(["new", "paid"].includes(r[6] as string));
    assert.match(String(r[7]), /^[0-9a-f]{8}-[0-9a-f]{4}-4/);
  }
  assert.equal(fakeRows([col("parent", "int", false, "x", false)], 1, 1)[0][0], undefined, "no parent rows: leave a required FK out");
  assert.equal(fakeRows([col("tags", "text[]")], 1, 1)[0][0], null, "arrays get NULL");
});

test("cell editor kinds", () => {
  assert.equal(editorKind("boolean"), "bool");
  assert.equal(editorKind("tinyint(1)"), "bool");
  assert.equal(editorKind("jsonb"), "json");
  assert.equal(editorKind("timestamp without time zone"), "datetime");
  assert.equal(editorKind("timestamp with time zone"), null);
  assert.equal(editorKind("date"), "date");
  assert.equal(editorKind("mood", true), "enum");
  assert.deepEqual(enumValues("enum('a','it''s')"), ["a", "it's"]);
  assert.equal(toInputDateTime("2024-05-01 10:20:30.25"), "2024-05-01T10:20:30");
  assert.equal(fromInputDateTime("2024-05-01T10:20"), "2024-05-01 10:20:00");
});

test("keymap: matching, display, clashes", () => {
  const ev = (key: string, m: Partial<{ ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean }> = {}) => ({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...m });
  assert.equal(keyOf(ev("E", { ctrlKey: true, shiftKey: true })), "Mod-Shift-e");
  assert.equal(keyOf(ev("?", { shiftKey: true })), "?");
  assert.equal(keyOf(ev("Shift", { shiftKey: true })), null);
  assert.ok(matches(ev("Enter", { ctrlKey: true, shiftKey: true }), "Shift-Mod-Enter"));
  assert.ok(matches(ev("+", { ctrlKey: true }), "Mod-="));
  assert.equal(canon("Shift-Ctrl-E"), "Mod-Shift-e");
  assert.equal(pretty("Mod-Shift-Enter"), "Ctrl Shift ↵");
  assert.equal(clash(loadKeys(), "run", "Mod-k")?.id, "palette");
  assert.equal(clash(loadKeys(), "palette", "Mod-k"), null);
});

test("clipboard parsing: tabs, rows, Excel quoting, empty = NULL", () => {
  assert.deepEqual(parseClipboard("a\tb\r\n\tc\n"), [["a", "b"], [null, "c"]]);
  assert.deepEqual(parseClipboard('"x\ty"\t"he said ""hi"""\n"two\nlines"\tz'), [["x\ty", 'he said "hi"'], ["two\nlines", "z"]]);
  assert.deepEqual(parseClipboard("solo"), [["solo"]]);
});

test("BETWEEN filters need both bounds", () => {
  assert.equal(buildWhere("postgres", [{ join: "AND", col: "n", op: "BETWEEN", val: "1", val2: "5" }]), `"n" BETWEEN '1' AND '5'`);
  assert.equal(buildWhere("postgres", [{ join: "AND", col: "n", op: "BETWEEN", val: "1" }]), "");
});

import { connectionLost, poolTimeout, shouldReopen } from "./reconnect.ts";
test("reconnect: dropped connections yes, a busy pool only when its SSH tunnel died", async () => {
  assert.ok(connectionLost("error communicating with database: An existing connection was forcibly closed by the remote host"));
  assert.ok(connectionLost("Lost connection to MySQL server during query"));
  assert.ok(!connectionLost('column "x" does not exist'));
  const busy = "The server isn't answering: no connection could be opened within 10 seconds.";
  assert.ok(poolTimeout(busy) && !connectionLost(busy));
  assert.equal(await shouldReopen(busy, async () => true), false, "pool full, tunnel fine: leave it");
  assert.equal(await shouldReopen(busy, async () => false), true, "tunnel died: reopen");
  assert.equal(await shouldReopen("Lost connection to MySQL server", async () => { throw new Error("not asked"); }), true);
});

import { copyTableDdl, portType } from "./typemap.ts";
test("types moved between engines; copy DDL keeps the key and makes integer keys auto", () => {
  assert.equal(portType("tinyint(1)", "mysql", "postgres"), "boolean");
  assert.equal(portType("int unsigned", "mysql", "postgres"), "bigint");
  assert.equal(portType("decimal(10,2)", "mysql", "postgres"), "numeric(10,2)");
  assert.equal(portType("datetime", "mysql", "postgres"), "timestamp");
  assert.equal(portType("enum('a','b')", "mysql", "postgres"), "text");
  assert.equal(portType("boolean", "postgres", "mysql"), "tinyint(1)");
  assert.equal(portType("text", "postgres", "mysql", true), "varchar(255)");
  assert.equal(portType("timestamp with time zone", "postgres", "mysql"), "datetime(6)");
  assert.equal(portType("integer[]", "postgres", "mysql"), "json");
  assert.equal(portType("uuid", "postgres", "sqlite"), "TEXT");
  assert.equal(portType("numeric(10,2)", "postgres", "sqlite"), "NUMERIC");
  assert.equal(portType("varchar(40)", "postgres", "postgres"), "varchar(40)");
  const t = tbl("orders", [col("id", "integer", true, null, false), col("customer_id", "integer", false, "customers", false), col("note", "text")]);
  assert.equal(copyTableDdl(t, "sqlite", "postgres", "public"), `CREATE TABLE "orders" (\n  "id" bigint GENERATED BY DEFAULT AS IDENTITY,\n  "customer_id" bigint NOT NULL,\n  "note" text,\n  PRIMARY KEY ("id")\n)`);
  assert.equal(copyTableDdl(t, "postgres", "mysql", "shop"), "CREATE TABLE `shop`.`orders` (\n  `id` bigint AUTO_INCREMENT,\n  `customer_id` int NOT NULL,\n  `note` longtext,\n  PRIMARY KEY (`id`)\n)");
});

test("fake rows: the name and the email belong to the same person", () => {
  const [row] = fakeRows([col("full_name", "text"), col("email", "text")], 1, 3);
  const [first, last] = String(row[0]).split(" ");
  const ascii = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ı/g, "i").toLowerCase();
  assert.ok(String(row[1]).startsWith(`${ascii(first)}.${ascii(last)}`), `${row[0]} / ${row[1]}`);
});

import { parsePgArray, portValue } from "./typemap.ts";
test("values moved between engines: PostgreSQL arrays to JSON, offsets to UTC for MySQL", () => {
  assert.deepEqual(parsePgArray('{"a b",NULL,"q\\"x"}'), ["a b", null, 'q"x']);
  assert.deepEqual(parsePgArray("{{1,2},{3,4}}"), [["1", "2"], ["3", "4"]]);
  assert.deepEqual(parsePgArray("{}"), []);
  assert.equal(parsePgArray("not {an} array"), null);
  assert.equal(portValue("{x,y}", "text[]", "postgres", "mysql"), '["x","y"]');
  assert.equal(portValue("2024-01-05 07:00:00+00", "timestamptz", "postgres", "mysql"), "2024-01-05 07:00:00");
  assert.equal(portValue("2024-01-05 01:30:00.25-05:30", "timestamptz", "postgres", "mysql"), "2024-01-05 07:00:00.25");
  assert.equal(portValue("2024-01-05 07:00:00+03", "timestamptz", "postgres", "postgres"), "2024-01-05 07:00:00+03");
  assert.equal(portValue("plain", "text", "postgres", "mysql"), "plain");
});

test("data diff treats engine formats of the same value as equal", () => {
  assert.equal(norm("2024-01-05 10:00:00.000000", "time"), norm("2024-01-05T10:00:00", "time"));
  assert.equal(norm("2024-01-05 13:00:00+03", "time"), norm("2024-01-05 10:00:00", "time"));
  assert.equal(norm("2024-01-05 10:00:00.250", "time"), norm("2024-01-05 10:00:00.25", "time"));
  assert.notEqual(norm("2024-01-05 10:00:01", "time"), norm("2024-01-05 10:00:00", "time"));
  assert.equal(norm("{x,y}", "array"), norm(["x", "y"], "array"));
  assert.equal(kindOf("numeric(10,2)"), "num");
  assert.equal(kindOf("timestamp with time zone"), "time");
  assert.equal(kindOf("text[]"), "array");
  assert.equal(kindOf("tinyint(1)"), "bool");
  assert.equal(kindOf("varchar(10)"), "text");
});

import { readExpr, writeLiteral } from "./typemap.ts";
test("bytes copy as hex both ways; booleans become true/false for PostgreSQL", () => {
  assert.equal(readExpr("postgres", "img", "bytea"), `upper(encode("img", 'hex')) AS "img"`);
  assert.equal(readExpr("mysql", "flag", "bit(1)"), "CAST(`flag` AS UNSIGNED) AS `flag`");
  assert.equal(readExpr("sqlite", "name", "TEXT"), `"name"`);
  assert.equal(writeLiteral("postgres", "CAFE", "BLOB", "sqlite"), "decode('CAFE', 'hex')");
  assert.equal(writeLiteral("mysql", "CAFE", "bytea", "postgres"), "X'CAFE'");
  assert.equal(writeLiteral("postgres", 1, "BOOLEAN", "sqlite"), "TRUE");
  assert.equal(writeLiteral("postgres", 0, "tinyint(1)", "mysql"), "FALSE");
  assert.equal(writeLiteral("mysql", null, "blob", "sqlite"), "NULL");
});

test("join hints quote odd names and follow the right schema", () => {
  const odd = [
    tbl("customers", [col("id", "integer", true)]),
    { ...tbl("Order Items", [col("Item ID", "integer", true), col("customer_id", "integer", false, "customers"), col("select", "text")]) },
    { ...tbl("customers", [col("id", "integer", true)]), schema: "sales" },
    { ...tbl("orders", [col("id", "integer", true), col("customer_id", "integer", false, "customers")]), schema: "sales" },
  ];
  assert.deepEqual(joinHints('SELECT * FROM "Order Items" JOIN ', odd).map((h) => h.label), [`customers c ON c.id = "Order Items".customer_id`]);
  assert.deepEqual(joinHints("SELECT * FROM customers c JOIN ", odd).map((h) => h.label), [`"Order Items" oi ON oi.customer_id = c.id`]);
  assert.deepEqual(joinHints("SELECT * FROM sales.customers sc JOIN ", odd).map((h) => h.label), [`sales.orders o ON o.customer_id = sc.id`]);
  assert.deepEqual(joinHints("SELECT * FROM `Order Items` oi JOIN ", odd, "mysql").map((h) => h.label), ["customers c ON c.id = oi.customer_id"]);
});

test("error position counts characters, so emoji before it don't shift the underline", () => {
  const sql = "SELECT '🦊', nope FROM t";
  assert.equal(sql.slice(errorSpan("postgres", "x\nAt character 13.", sql)!.from).slice(0, 4), "nope");
});

test("settings: saved values over defaults, bad entries ignored", async () => {
  const { parseSettings, DEFAULTS } = await import("./settings.ts");
  assert.deepEqual(parseSettings(null), DEFAULTS);
  assert.deepEqual(parseSettings("not json"), DEFAULTS);
  const s = parseSettings(JSON.stringify({ rowLimit: 100, wrap: true, nullText: 5, dataFont: "Comic Sans", junk: 1 }));
  assert.equal(s.rowLimit, 100);
  assert.equal(s.wrap, true);
  assert.equal(s.nullText, "NULL", "wrong type keeps the default");
  assert.equal(s.dataFont, "JetBrains Mono", "unknown font falls back");
  assert.ok(!("junk" in s));
});
