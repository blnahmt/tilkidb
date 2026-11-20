import { test } from "node:test";
import assert from "node:assert/strict";
import { columnStats, copyText } from "./gridcopy.ts";

const cols = ["id", "note"];
const rows = [[1, "a,b \"q\""], [2, null], [3, "line1\nline2\t|x"]];

test("copy formats", () => {
  assert.equal(copyText(cols, rows, "tsv"), "1\ta,b \"q\"\n2\t\n3\tline1 line2 |x");
  assert.equal(copyText(cols, rows.slice(0, 1), "tsv", { headers: true }), "id\tnote\n1\ta,b \"q\"");
  assert.equal(copyText(cols, rows.slice(0, 2), "csv"), 'id,note\r\n1,"a,b ""q"""\r\n2,');
  assert.deepEqual(JSON.parse(copyText(cols, rows.slice(0, 2), "json")), [{ id: 1, note: 'a,b "q"' }, { id: 2, note: null }]);
  assert.equal(copyText(cols, rows.slice(1, 3), "markdown"), "| id | note |\n| --- | --- |\n| 2 | NULL |\n| 3 | line1 line2\t\\|x |");
  assert.equal(copyText(cols, rows.slice(0, 2), "insert", { engine: "mysql", table: "`t`" }), "INSERT INTO `t` (`id`, `note`) VALUES\n  (1, 'a,b \"q\"'),\n  (2, NULL);");
});

test("column statistics", () => {
  assert.deepEqual(columnStats([3, "10", null, 3]), { count: 4, nulls: 1, distinct: 2, min: "3", max: "10", avg: 16 / 3, numeric: true });
  const s = columnStats(["b", "a", null, "c"]);
  assert.deepEqual([s.min, s.max, s.avg, s.numeric], ["a", "c", null, false]);
  assert.equal(columnStats([null, null]).distinct, 0);
});
