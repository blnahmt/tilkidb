import { test } from "node:test";
import assert from "node:assert/strict";
import { edges, layers, layout, mermaid, router, tkey } from "./erd.ts";
import type { Table } from "./api.ts";

const t = (name: string, cols: [string, string, boolean, string | null][], schema = "main"): Table => ({
  schema, name, kind: "table", rows: null, columns: cols.map(([n, ty, pk, fk]) => ({ name: n, dataType: ty, nullable: true, pk, fk })),
});
const shop: Table[] = [
  t("order_items", [["id", "integer", true, null], ["order_id", "integer", false, "orders"], ["product_id", "integer", false, "products"]]),
  t("orders", [["id", "integer", true, null], ["customer_id", "integer", false, "customers"]]),
  t("customers", [["id", "integer", true, null], ["email", "text", false, null], ["referred_by", "integer", false, "customers"]]),
  t("products", [["id", "integer", true, null], ["tags", "text[]", false, null]]),
];

test("edges from FK columns, including self references", () => {
  assert.deepEqual(edges(shop).map((e) => `${e.from}.${e.col}->${e.to}`), [
    "main.order_items.order_id->main.orders", "main.order_items.product_id->main.products",
    "main.orders.customer_id->main.customers", "main.customers.referred_by->main.customers",
  ]);
});

test("FK targets prefer the same schema", () => {
  const two = [t("users", [["id", "int", true, null]], "auth"), t("users", [["id", "int", true, null]], "app"), t("posts", [["user_id", "int", false, "users"]], "app")];
  assert.equal(edges(two)[0].to, "app.users");
});

test("layers: referenced tables left of the tables that reference them; self-reference ignored", () => {
  const l = layers(shop, edges(shop));
  assert.deepEqual([l.get("main.customers"), l.get("main.products"), l.get("main.orders"), l.get("main.order_items")], [0, 0, 1, 2]);
});

test("cycles don't hang the layout", () => {
  const cyc = [t("a", [["b_id", "int", false, "b"]]), t("b", [["a_id", "int", false, "a"]])];
  assert.equal(layout(cyc, false).size, 2);
});

test("layout stacks tables per layer without overlap", () => {
  const pos = layout(shop, false);
  const c = pos.get("main.customers")!, p = pos.get("main.products")!;
  assert.equal(c.x, p.x, "same layer, same column");
  assert.ok(p.y > c.y + 100, "products sits below customers");
  assert.ok(pos.get("main.order_items")!.x > pos.get("main.orders")!.x);
});

test("mermaid output", () => {
  const m = mermaid(shop);
  assert.match(m, /^erDiagram\n {2}main_orders \|\|--o\{ main_order_items : "order_id"/);
  assert.match(m, /text_array tags/);
  assert.match(m, /integer id PK/);
});

// does the polyline enter any box (other than touching the edges it starts and ends on)?
const hits = (pts: [number, number][], boxes: { x: number; y: number; w: number; h: number }[]) =>
  pts.slice(1).some(([x2, y2], k) => {
    const [x1, y1] = pts[k];
    return boxes.some((o) => Math.max(x1, x2) > o.x && Math.min(x1, x2) < o.x + o.w && Math.max(y1, y2) > o.y && Math.min(y1, y2) < o.y + o.h);
  });
const orthogonal = (pts: [number, number][]) => pts.slice(1).every(([x, y], k) => x === pts[k][0] || y === pts[k][1]);

test("router goes around a box sitting between the two ends", () => {
  const a = { x: 0, y: 100, w: 200, h: 100 }, mid = { x: 300, y: 50, w: 200, h: 300 }, b = { x: 600, y: 100, w: 200, h: 100 };
  const boxes = [a, mid, b];
  const pts = router(boxes, [150, 150])(a, 150, b, 150)!;
  assert.ok(pts, "a route exists");
  assert.deepEqual(pts[0], [200, 150], "leaves a from its right edge");
  assert.deepEqual(pts[pts.length - 1], [600, 150], "enters b on its left edge");
  assert.ok(orthogonal(pts));
  assert.ok(!hits(pts, boxes), JSON.stringify(pts));
});

test("router: straight line when nothing is in the way, loop for a self reference", () => {
  const a = { x: 0, y: 0, w: 100, h: 100 }, b = { x: 300, y: 0, w: 100, h: 100 };
  const r = router([a, b], [50, 30, 70]);
  assert.deepEqual(r(a, 50, b, 50), [[100, 50], [300, 50]]);
  assert.deepEqual(r(a, 30, a, 70), [[100, 30], [114, 30], [114, 70], [100, 70]]);
});

test("router on the shop layout never crosses a table", () => {
  const big = [...shop, ...Array.from({ length: 12 }, (_, i) => t(`t${i}`, [["id", "int", true, null], ["o", "int", false, i % 2 ? "orders" : "customers"]]))];
  const pos = layout(big, false);
  const boxes = new Map(big.map((x) => [tkey(x), { ...pos.get(tkey(x))!, w: 250, h: 34 + x.columns.length * 22 + 6 }]));
  const es = edges(big).map((e) => ({ a: boxes.get(e.from)!, b: boxes.get(e.to)! }));
  const r = router([...boxes.values()], es.flatMap((e) => [e.a.y + 40, e.b.y + 40]));
  for (const e of es) {
    const pts = r(e.a, e.a.y + 40, e.b, e.b.y + 40)!;
    assert.ok(pts && orthogonal(pts));
    const inner = pts.slice(1, -1);
    assert.ok(!hits(inner, [...boxes.values()]), JSON.stringify(pts));
  }
});
