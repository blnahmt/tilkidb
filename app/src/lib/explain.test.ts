import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMyTable, parseMyTree, parsePg, parseSqlite } from "./explain.ts";

test("PostgreSQL JSON with ANALYZE: labels, details, self time, hottest node, misestimate", () => {
  const out = [{
    Plan: {
      "Node Type": "Hash Join", "Join Type": "Inner", "Total Cost": 120, "Plan Rows": 50, "Actual Total Time": 30, "Actual Rows": 4000, "Actual Loops": 1,
      "Hash Cond": "(o.customer_id = c.id)",
      Plans: [
        { "Node Type": "Seq Scan", "Relation Name": "orders", Alias: "o", "Total Cost": 80, "Plan Rows": 5000, "Actual Total Time": 22, "Actual Rows": 5000, "Actual Loops": 1, Filter: "(total > '10'::numeric)", "Rows Removed by Filter": 1200 },
        { "Node Type": "Hash", "Total Cost": 20, "Plan Rows": 100, "Actual Total Time": 3, "Actual Rows": 100, "Actual Loops": 1,
          Plans: [{ "Node Type": "Index Scan", "Relation Name": "customers", Alias: "c", "Index Name": "customers_pkey", "Total Cost": 18, "Plan Rows": 100, "Actual Total Time": 2.5, "Actual Rows": 100, "Actual Loops": 1 }] },
      ],
    },
    "Planning Time": 0.4, "Execution Time": 30.5,
  }];
  const p = parsePg(out);
  assert.equal(p.metric, "time");
  assert.equal(p.executionMs, 30.5);
  const [join] = p.roots;
  const [scan, hash] = join.children;
  assert.equal(scan.label, "Seq Scan on orders o");
  assert.equal(hash.children[0].label, "Index Scan on customers c using customers_pkey");
  assert.deepEqual(scan.detail, ["Filter: (total > '10'::numeric)", "Rows removed by filter: 1200"]);
  assert.equal(join.self, 5, "30 ms total minus 22 + 3 in children");
  assert.equal(scan.hot, true, "the 22 ms scan is the most expensive step");
  assert.equal(join.misestimate, 80, "estimated 50 rows, got 4000");
});

test("PostgreSQL JSON without ANALYZE falls back to cost; text input is parsed", () => {
  const p = parsePg(JSON.stringify([{ Plan: { "Node Type": "Seq Scan", "Relation Name": "t", "Total Cost": 35.5, "Plan Rows": 2550 } }]));
  assert.equal(p.metric, "cost");
  assert.equal(p.total, 35.5);
  assert.equal(p.roots[0].hot, true);
});

test("MySQL tree: nesting by indentation, costs, actual time × loops", () => {
  const text = [
    "-> Limit: 10 row(s)  (cost=2.65 rows=10) (actual time=0.05..0.06 rows=2 loops=1)",
    "    -> Nested loop inner join  (cost=2.65 rows=3) (actual time=0.04..0.05 rows=2 loops=1)",
    "        -> Filter: (o.total > 10)  (cost=0.55 rows=1) (actual time=0.02..0.03 rows=2 loops=1)",
    "            -> Table scan on o  (cost=0.55 rows=3) (actual time=0.02..0.02 rows=3 loops=1)",
    "        -> Single-row index lookup on c using PRIMARY (id=o.customer_id)  (cost=0.30 rows=1) (actual time=0.01..0.01 rows=1 loops=2)",
  ].join("\n");
  const p = parseMyTree(text);
  assert.equal(p.roots.length, 1);
  const join = p.roots[0].children[0];
  assert.equal(join.label, "Nested loop inner join");
  assert.deepEqual(join.children.map((c) => c.label), ["Filter: (o.total > 10)", "Single-row index lookup on c using PRIMARY (id=o.customer_id)"]);
  assert.equal(join.children[1].time, 0.02, "0.01 ms × 2 loops");
  assert.equal(join.children[0].children[0].label, "Table scan on o");
  assert.equal(p.metric, "time");
});

test("MySQL tree without ANALYZE uses cost", () => {
  const p = parseMyTree("-> Table scan on t  (cost=1.25 rows=10)");
  assert.equal(p.metric, "cost");
  assert.equal(p.roots[0].rows, 10);
});

test("SQLite query plan rows become a tree with no metric", () => {
  const p = parseSqlite([[2, 0, 0, "SCAN o"], [4, 0, 0, "SEARCH c USING INTEGER PRIMARY KEY (rowid=?)"], [7, 4, 0, "LIST SUBQUERY"]]);
  assert.deepEqual(p.roots.map((r) => r.label), ["SCAN o", "SEARCH c USING INTEGER PRIMARY KEY (rowid=?)"]);
  assert.equal(p.roots[1].children[0].label, "LIST SUBQUERY");
  assert.equal(p.metric, null);
});

test("unexpected output is an error, not an empty plan", () => {
  assert.throws(() => parsePg([{ nope: 1 }]));
  assert.throws(() => parseMyTree("id | select_type"));
});

test("classic MySQL / MariaDB EXPLAIN table, with MariaDB ANALYZE actual rows", () => {
  const cols = ["id", "select_type", "table", "type", "possible_keys", "key", "key_len", "ref", "rows", "r_rows", "Extra"];
  const p = parseMyTable(cols, [
    [1, "SIMPLE", "o", "ALL", null, null, null, null, "5000", "4800", "Using where"],
    [1, "SIMPLE", "c", "eq_ref", "PRIMARY", "PRIMARY", "4", "shop.o.customer_id", "1", "1", null],
  ]);
  assert.deepEqual(p.roots.map((n) => n.label), ["Full scan on o", "Access (eq_ref) on c"]);
  assert.deepEqual(p.roots[0].detail, ["Using where"]);
  assert.deepEqual(p.roots[1].detail, ["Index: PRIMARY (ref shop.o.customer_id)"]);
  assert.equal(p.roots[0].actualRows, 4800);
  assert.throws(() => parseMyTable(cols, []));
});
