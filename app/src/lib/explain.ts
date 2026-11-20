// Turn each engine's EXPLAIN output into one tree shape for the plan view.
// PostgreSQL: EXPLAIN (FORMAT JSON [, ANALYZE]); MySQL 8: EXPLAIN FORMAT=TREE / EXPLAIN ANALYZE;
// SQLite: EXPLAIN QUERY PLAN rows (id, parent, notused, detail).
import type { Cell } from "./api.ts";

export interface PlanNode {
  label: string;
  detail: string[];
  cost: number | null; // planner cost, inclusive of children
  rows: number | null; // planner row estimate
  time: number | null; // actual ms, inclusive, × loops (ANALYZE only)
  actualRows: number | null;
  children: PlanNode[];
  self: number; // this node's own share of the metric (inclusive minus children)
  share: number; // self / total, 0..1
  hot: boolean; // the single most expensive node
  misestimate: number | null; // ×N when actual rows are far from the estimate
}

export interface Plan {
  roots: PlanNode[];
  metric: "time" | "cost" | null;
  total: number;
  planningMs?: number;
  executionMs?: number;
}

const node = (label: string, extra: Partial<PlanNode> = {}): PlanNode => ({
  label, detail: [], cost: null, rows: null, time: null, actualRows: null, children: [], self: 0, share: 0, hot: false, misestimate: null, ...extra,
});

function finish(roots: PlanNode[], extra: Partial<Plan> = {}): Plan {
  const all: PlanNode[] = [];
  const walk = (n: PlanNode) => { all.push(n); n.children.forEach(walk); };
  roots.forEach(walk);
  const metric = all.some((n) => n.time != null) ? "time" : all.some((n) => n.cost != null) ? "cost" : null;
  const m = (n: PlanNode) => (metric === "time" ? n.time : metric === "cost" ? n.cost : null) ?? 0;
  const total = roots.reduce((a, n) => a + m(n), 0);
  for (const n of all) {
    n.self = Math.max(0, m(n) - n.children.reduce((a, c) => a + m(c), 0));
    n.share = total > 0 ? n.self / total : 0;
    if (n.rows != null && n.actualRows != null) {
      const hi = Math.max(n.rows, n.actualRows), lo = Math.max(1, Math.min(n.rows, n.actualRows));
      if (hi >= 100 && hi / lo >= 10) n.misestimate = Math.round(hi / lo);
    }
  }
  const hottest = metric ? all.reduce<PlanNode | null>((a, n) => (!a || n.self > a.self ? n : a), null) : null;
  if (hottest && hottest.self > 0) hottest.hot = true;
  return { roots, metric, total, ...extra };
}

// ---- PostgreSQL ----
type PgNode = Record<string, unknown> & { Plans?: PgNode[] };
const DETAIL_KEYS = ["Index Cond", "Recheck Cond", "Filter", "Join Filter", "Hash Cond", "Merge Cond", "Sort Key", "Group Key", "Presorted Key"];

function pgNode(n: PgNode): PlanNode {
  const type = String(n["Node Type"] ?? "?");
  const join = n["Join Type"] && n["Join Type"] !== "Inner" ? ` (${n["Join Type"]})` : "";
  const rel = n["Relation Name"] ? ` on ${n["Schema"] && n["Schema"] !== "public" ? `${n["Schema"]}.` : ""}${n["Relation Name"]}${n["Alias"] && n["Alias"] !== n["Relation Name"] ? ` ${n["Alias"]}` : ""}` : "";
  const idx = n["Index Name"] ? ` using ${n["Index Name"]}` : "";
  const cte = n["CTE Name"] ? ` ${n["CTE Name"]}` : n["Function Name"] ? ` ${n["Function Name"]}()` : "";
  const loops = Number(n["Actual Loops"] ?? 1) || 1;
  const out = node(`${type}${join}${rel}${idx}${cte}`, {
    cost: n["Total Cost"] != null ? Number(n["Total Cost"]) : null,
    rows: n["Plan Rows"] != null ? Number(n["Plan Rows"]) : null,
    time: n["Actual Total Time"] != null ? Number(n["Actual Total Time"]) * loops : null,
    actualRows: n["Actual Rows"] != null ? Number(n["Actual Rows"]) * loops : null,
  });
  for (const k of DETAIL_KEYS) {
    const v = n[k];
    if (v != null) out.detail.push(`${k}: ${Array.isArray(v) ? v.join(", ") : v}`);
  }
  if (n["Rows Removed by Filter"]) out.detail.push(`Rows removed by filter: ${Number(n["Rows Removed by Filter"])}`); // no locale formatting in data
  out.children = (n.Plans ?? []).map(pgNode);
  return out;
}

export function parsePg(value: Cell): Plan {
  const data = typeof value === "string" ? JSON.parse(value) : value;
  const top = (Array.isArray(data) ? data[0] : data) as Record<string, unknown>;
  if (!top || !top.Plan) throw new Error("Unexpected EXPLAIN output");
  return finish([pgNode(top.Plan as PgNode)], {
    planningMs: top["Planning Time"] != null ? Number(top["Planning Time"]) : undefined,
    executionMs: top["Execution Time"] != null ? Number(top["Execution Time"]) : undefined,
  });
}

// ---- MySQL 8 tree ----
export function parseMyTree(text: string): Plan {
  const roots: PlanNode[] = [];
  const stack: { level: number; n: PlanNode }[] = [];
  for (const line of text.split("\n")) {
    const at = line.indexOf("->");
    if (at < 0) continue;
    const level = Math.round(at / 4);
    const body = line.slice(at + 2).trim();
    const cost = /\(cost=([\d.e+]+) rows=([\d.e+]+)\)/.exec(body);
    const act = /\(actual time=[\d.e+]+\.\.([\d.e+]+) rows=([\d.e+]+) loops=(\d+)\)/.exec(body);
    const loops = act ? Number(act[3]) || 1 : 1;
    const n = node(body.split(/\s{2}\(|\s\((?:cost|actual|never)/)[0].trim(), {
      cost: cost ? Number(cost[1]) : null,
      rows: cost ? Number(cost[2]) : null,
      time: act ? Number(act[1]) * loops : null,
      actualRows: act ? Number(act[2]) * loops : null,
    });
    if (/never executed/.test(body)) n.detail.push("Never executed");
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    if (stack.length) stack[stack.length - 1].n.children.push(n); else roots.push(n);
    stack.push({ level, n });
  }
  if (!roots.length) throw new Error("Unexpected EXPLAIN output");
  return finish(roots);
}

// ---- MySQL / MariaDB classic table (MariaDB has no FORMAT=TREE): one row per table access ----
export function parseMyTable(cols: string[], rows: Cell[][]): Plan {
  const at = (r: Cell[], name: string) => { const i = cols.findIndex((c) => c.toLowerCase() === name); return i < 0 || r[i] == null ? null : String(r[i]); };
  const roots = rows.map((r) => {
    const type = at(r, "type"), table = at(r, "table");
    const n = node(`${type === "ALL" ? "Full scan" : type ? `Access (${type})` : at(r, "select_type") ?? "Step"}${table ? ` on ${table}` : ""}`, {
      rows: at(r, "rows") != null ? Number(at(r, "rows")) : null,
      actualRows: at(r, "r_rows") != null ? Number(at(r, "r_rows")) : null, // ANALYZE (MariaDB)
    });
    const st = at(r, "select_type");
    if (st && st !== "SIMPLE") n.detail.push(`Select: ${st}`);
    if (at(r, "key")) n.detail.push(`Index: ${at(r, "key")}${at(r, "ref") ? ` (ref ${at(r, "ref")})` : ""}`);
    else if (at(r, "possible_keys")) n.detail.push(`Possible indexes: ${at(r, "possible_keys")}`);
    if (at(r, "extra")) n.detail.push(at(r, "extra")!);
    return n;
  });
  if (!roots.length) throw new Error("Unexpected EXPLAIN output");
  return finish(roots);
}

// ---- SQLite ----
export function parseSqlite(rows: Cell[][]): Plan {
  const byId = new Map<number, PlanNode>();
  const roots: PlanNode[] = [];
  for (const [id, parent, , detail] of rows) {
    const n = node(String(detail));
    byId.set(Number(id), n);
    const p = byId.get(Number(parent));
    if (p) p.children.push(n); else roots.push(n);
  }
  return finish(roots);
}
