import { test } from "node:test";
import assert from "node:assert/strict";
import { explainPrompt, extractSql, schemaContext, systemPrompt, writePrompt } from "./ai.ts";
import type { Table } from "./api.ts";

const t = (name: string, n = 2, schema = "public"): Table => ({
  schema, name, kind: "table", rows: 10,
  columns: Array.from({ length: n }, (_, i) => ({ name: i ? `c${i}` : "id", dataType: "integer", nullable: i > 0, pk: i === 0, fk: i === 1 ? "other" : null })),
});

test("schema context lists names and types, no data", () => {
  const s = schemaContext([t("orders")]);
  assert.equal(s.text, "orders(id integer PK NOT NULL, c1 integer -> other)");
  assert.deepEqual([s.listed, s.omitted], [1, 0]);
  assert.match(schemaContext([t("a", 1, "x"), t("b", 1, "y")]).text, /^x\.a\(/, "schemas shown when there are several");
});

test("huge schemas are trimmed and say so", () => {
  const big = Array.from({ length: 3000 }, (_, i) => t(`table_${i}`, 12));
  const s = schemaContext(big);
  assert.ok(s.listed < 3000 && s.omitted === 3000 - s.listed && s.text.length <= 60_000);
  assert.match(systemPrompt("postgres", big), new RegExp(`${s.omitted} more tables exist`));
});

test("prompts carry the SQL and the dialect", () => {
  assert.match(systemPrompt("mysql", [t("orders")]), /MySQL \/ MariaDB database[\s\S]*<schema>\norders\(/);
  assert.match(explainPrompt("SELECT 1"), /```sql\nSELECT 1\n```/);
  assert.doesNotMatch(writePrompt("top customers", "  "), /editor currently holds/);
  assert.match(writePrompt("same but by month", "SELECT 1"), /editor currently holds/);
});

test("extracts the first sql block", () => {
  assert.equal(extractSql("Here:\n```sql\nSELECT *\n  FROM t;\n```\nThen ```sql\nSELECT 2\n```"), "SELECT *\n  FROM t;");
  assert.equal(extractSql("```\nSELECT 3\n```"), "SELECT 3");
  assert.equal(extractSql("No query here."), null);
});
