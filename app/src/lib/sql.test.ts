import { test } from "node:test";
import assert from "node:assert/strict";
import { leavesTransactionOpen, risks, splitStatements, statementAt, topLevelWords } from "./sql.ts";

const reasons = (sql: string, prod = false) => risks(sql, { prod }).map((r) => r.reason);

test("top-level words skip strings, comments and subqueries", () => {
  assert.deepEqual(topLevelWords("UPDATE t SET a = (SELECT 1 FROM x WHERE y) -- where\n, b = 'where'"), ["update", "t", "set", "a", "b"]);
});

test("whole-table writes and irreversible statements are flagged on any connection", () => {
  assert.deepEqual(reasons("DELETE FROM orders"), ["DELETE without WHERE changes every row in the table."]);
  assert.deepEqual(reasons("update t set a = 1 -- where id = 1"), ["UPDATE without WHERE changes every row in the table."], "a WHERE in a comment doesn't count");
  assert.deepEqual(reasons("UPDATE t SET a = (SELECT max(v) FROM x WHERE x.id = 1)"), ["UPDATE without WHERE changes every row in the table."], "a WHERE in a subquery doesn't count");
  assert.deepEqual(reasons("DROP TABLE t; TRUNCATE t2"), ["DROP can't be undone.", "TRUNCATE can't be undone."]);
  assert.deepEqual(reasons("WITH old AS (SELECT id FROM t) DELETE FROM t"), ["DELETE without WHERE changes every row in the table."]);
});

test("ordinary statements pass on a normal connection", () => {
  assert.deepEqual(reasons("DELETE FROM t WHERE id = 1; UPDATE t SET a = 1 WHERE id = 2; INSERT INTO t VALUES (1); SELECT * FROM t"), []);
  assert.deepEqual(reasons("SELECT 'DROP TABLE t'"), [], "text inside a string is not a statement");
  assert.deepEqual(reasons("EXPLAIN DELETE FROM t"), [], "plain EXPLAIN doesn't run anything");
  assert.deepEqual(reasons("EXPLAIN ANALYZE DELETE FROM t"), ["DELETE without WHERE changes every row in the table."]);
});

test("production: every write needs confirmation, reads don't", () => {
  assert.deepEqual(reasons("INSERT INTO t VALUES (1)", true), ["Writes to a production connection."]);
  assert.deepEqual(reasons("ALTER TABLE t ADD c int", true), ["Writes to a production connection."]);
  assert.deepEqual(reasons("SELECT * FROM t; SHOW TABLES; SET search_path = x", true), []);
});

const texts = (sql: string, bs = false) => splitStatements(sql, bs).map((s) => s.text);

test("splits on top-level semicolons and trims", () => {
  assert.deepEqual(texts("SELECT 1;\n  SELECT 2 ;\n"), ["SELECT 1", "SELECT 2"]);
});

test("semicolons in strings, identifiers, comments and $$ bodies don't split", () => {
  assert.deepEqual(texts(`SELECT 'a;b', "x;y" FROM t; -- c;d\nSELECT 2 /* e;f */`), [`SELECT 'a;b', "x;y" FROM t`, "-- c;d\nSELECT 2 /* e;f */"]);
  assert.deepEqual(texts("CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END $$ LANGUAGE plpgsql; SELECT f()"), [
    "CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END $$ LANGUAGE plpgsql", "SELECT f()",
  ]);
  assert.deepEqual(texts("SELECT 'it''s; fine'; SELECT 2"), ["SELECT 'it''s; fine'", "SELECT 2"]);
});

test("MySQL backslash escapes only when asked", () => {
  assert.deepEqual(texts(String.raw`SELECT 'a\';b'; SELECT 2`, true), [String.raw`SELECT 'a\';b'`, "SELECT 2"]);
  assert.deepEqual(texts(String.raw`SELECT 'C:\'; SELECT 2`), [String.raw`SELECT 'C:\'`, "SELECT 2"]);
});

test("comment-only pieces are dropped", () => {
  assert.deepEqual(texts("SELECT 1; -- done\n"), ["SELECT 1"]);
  assert.deepEqual(texts("  \n -- nothing\n"), []);
});

test("statement under the cursor", () => {
  const sql = "SELECT 1;\n\nSELECT 2;\nSELECT 3";
  assert.equal(statementAt(sql, 3)?.text, "SELECT 1");
  assert.equal(statementAt(sql, 9)?.text, "SELECT 1", "right after the ;");
  assert.equal(statementAt(sql, 10)?.text, "SELECT 1", "blank line after it");
  assert.equal(statementAt(sql, 12)?.text, "SELECT 2");
  assert.equal(statementAt(sql, sql.length)?.text, "SELECT 3");
  assert.equal(statementAt("", 0), null);
});

test("open-transaction heuristic", () => {
  assert.equal(leavesTransactionOpen("BEGIN; UPDATE t SET a = 1;"), true);
  assert.equal(leavesTransactionOpen("BEGIN; UPDATE t SET a = 1; COMMIT;"), false);
  assert.equal(leavesTransactionOpen("SELECT 1 -- begin"), false);
});

test("guard sees writes hidden in CTEs, ALTER … DROP and SELECT INTO", () => {
  const r = (sql: string, prod = false) => risks(sql, { prod }).map((x) => x.reason);
  assert.deepEqual(r("WITH gone AS (DELETE FROM orders RETURNING *) SELECT count(*) FROM gone"), ["DELETE without WHERE changes every row in the table."]);
  assert.deepEqual(r("WITH x AS (UPDATE t SET a = 1 WHERE id = 2 RETURNING id) SELECT * FROM x", true), ["Writes to a production connection."], "a CTE write is a write on prod");
  assert.deepEqual(r("WITH x AS (SELECT 1) SELECT * FROM x", true), [], "read-only CTEs stay unguarded");
  assert.match(r("ALTER TABLE customers DROP COLUMN email")[0], /can't be undone/);
  assert.deepEqual(r("ALTER TABLE customers ADD COLUMN x int"), []);
  assert.deepEqual(r("ALTER TABLE t ALTER COLUMN price DROP DEFAULT; ALTER TABLE t ALTER COLUMN c DROP NOT NULL"), [], "no data lost");
  assert.match(r("ALTER TABLE t DROP email")[0], /can't be undone/, "PostgreSQL allows DROP without COLUMN");
  assert.match(r("ALTER TABLE t DROP CONSTRAINT fk_x")[0], /can't be undone/);
  assert.deepEqual(r("SELECT * INTO backup FROM orders", true), ["Writes to a production connection."]);
  assert.deepEqual(r("SELECT * FROM orders WHERE note = 'into'", true), [], "words in strings don't count");
});
