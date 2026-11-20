import { test } from "node:test";
import assert from "node:assert/strict";
import { inline, parse } from "./markdown.ts";

test("inline code, bold, italic and links", () => {
  assert.deepEqual(inline("Run `SELECT 1` **now**, *maybe* see [docs](https://x.dev) 2 * 3"), [
    { t: "text", text: "Run " }, { t: "code", text: "SELECT 1" }, { t: "text", text: " " }, { t: "b", text: "now" },
    { t: "text", text: ", " }, { t: "i", text: "maybe" }, { t: "text", text: " see " }, { t: "a", text: "docs", href: "https://x.dev" },
    { t: "text", text: " 2 * 3" },
  ]);
});

test("blocks: headings, paragraphs joined, lists, quotes, code fences", () => {
  const b = parse("# Revenue\n\nFirst line\nsecond line\n\n- one\n- two\n1. a\n> note\n```\nSELECT *\n  FROM t\n```");
  assert.deepEqual(b.map((x) => x.t), ["h", "p", "ul", "ol", "quote", "code"]);
  assert.deepEqual(b[1], { t: "p", inl: [{ t: "text", text: "First line second line" }] });
  assert.equal((b[2] as { items: unknown[] }).items.length, 2);
  assert.deepEqual(b[5], { t: "code", text: "SELECT *\n  FROM t" });
});

test("html stays text", () => {
  assert.deepEqual(parse("<img src=x onerror=alert(1)>"), [{ t: "p", inl: [{ t: "text", text: "<img src=x onerror=alert(1)>" }] }]);
});
