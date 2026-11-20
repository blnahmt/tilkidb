// ER diagram model: foreign-key edges, a layered auto-layout and Mermaid export.
import type { Table } from "./api.ts";

export const tkey = (t: { schema: string; name: string }) => `${t.schema}.${t.name}`;

export interface Edge {
  from: string; // child table key
  col: string; // FK column in the child
  to: string; // parent table key
}

/** FK edges. Column.fk only names the parent table, so prefer one in the same schema. */
export function edges(tables: Table[]): Edge[] {
  const byName = new Map<string, Table[]>();
  for (const t of tables) byName.set(t.name, [...(byName.get(t.name) ?? []), t]);
  const out: Edge[] = [];
  for (const t of tables) {
    for (const c of t.columns) {
      if (!c.fk) continue;
      const candidates = byName.get(c.fk) ?? [];
      const parent = candidates.find((p) => p.schema === t.schema) ?? candidates[0];
      if (parent) out.push({ from: tkey(t), col: c.name, to: tkey(parent) });
    }
  }
  return out;
}

/** Layer per table: parents (referenced) left, children right. Cycles and self-references are cut. */
export function layers(tables: Table[], es: Edge[]): Map<string, number> {
  const parents = new Map<string, string[]>();
  for (const e of es) if (e.from !== e.to) parents.set(e.from, [...(parents.get(e.from) ?? []), e.to]);
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const layer = (k: string): number => {
    if (memo.has(k)) return memo.get(k)!;
    if (visiting.has(k)) return 0; // cycle
    visiting.add(k);
    const l = Math.max(-1, ...(parents.get(k) ?? []).map(layer)) + 1;
    visiting.delete(k);
    memo.set(k, l);
    return l;
  };
  for (const t of tables) layer(tkey(t));
  return memo;
}

export const BOX_W = 250, HEAD_H = 34, ROW_H = 22, GAP_X = 110, GAP_Y = 36;

export const boxHeight = (t: Table, keysOnly: boolean) => HEAD_H + (keysOnly ? t.columns.filter((c) => c.pk || c.fk).length : t.columns.length) * ROW_H + 6;

/** Columns by layer, tables stacked in each column, sorted by name for a stable picture. */
export function layout(tables: Table[], keysOnly: boolean): Map<string, { x: number; y: number }> {
  const ls = layers(tables, edges(tables));
  const cols = new Map<number, Table[]>();
  for (const t of [...tables].sort((a, b) => a.name.localeCompare(b.name))) {
    const l = ls.get(tkey(t)) ?? 0;
    cols.set(l, [...(cols.get(l) ?? []), t]);
  }
  const pos = new Map<string, { x: number; y: number }>();
  for (const [l, ts] of cols) {
    let y = 30;
    for (const t of ts) {
      pos.set(tkey(t), { x: 30 + l * (BOX_W + GAP_X), y });
      y += boxHeight(t, keysOnly) + GAP_Y;
    }
  }
  return pos;
}

/** Mermaid erDiagram text (paste into docs, GitHub, etc.). */
export function mermaid(tables: Table[]): string {
  const id = (k: string) => k.replace(/[^A-Za-z0-9_]/g, "_");
  const type = (t: string) => t.replace(/\[\]/g, "_array").replace(/[^A-Za-z0-9_]/g, "_") || "unknown";
  const lines = ["erDiagram"];
  for (const e of edges(tables)) lines.push(`  ${id(e.to)} ||--o{ ${id(e.from)} : "${e.col}"`);
  for (const t of tables) {
    lines.push(`  ${id(tkey(t))} {`);
    for (const c of t.columns) lines.push(`    ${type(c.dataType)} ${id(c.name)}${c.pk ? " PK" : c.fk ? " FK" : ""}`);
    lines.push("  }");
  }
  return lines.join("\n");
}

export interface Box { x: number; y: number; w: number; h: number }
export type Pt = [number, number];
const CLEAR = 14; // distance kept from boxes; also the stub length the crow's-foot markers sit on
const BEND = 40; // a turn costs as much as 40px of line, so routes stay simple

/**
 * Orthogonal edge router. The grid lines are every box edge pushed out by CLEAR plus the row
 * heights the edges start and end on; A* over that grid finds the shortest route with few bends
 * that never enters a box. Build it once per layout, then call the returned function per edge.
 */
export function router(boxes: Box[], rowYs: number[]) {
  const uniq = (v: number[]) => [...new Set(v)].sort((a, b) => a - b);
  const xs = uniq(boxes.flatMap((o) => [o.x - CLEAR, o.x + o.w + CLEAR]));
  const ys = uniq([...boxes.flatMap((o) => [o.y - CLEAR, o.y + o.h + CLEAR]), ...rowYs]);
  const nx = xs.length, ny = ys.length;
  const xi = new Map(xs.map((v, i) => [v, i])), yi = new Map(ys.map((v, i) => [v, i]));
  // hBlock[j*nx+i]: segment (i,j)-(i+1,j) passes through a box; vBlock: (i,j)-(i,j+1)
  const hBlock = new Uint8Array(nx * ny), vBlock = new Uint8Array(nx * ny);
  for (const o of boxes) {
    const i0 = xi.get(o.x - CLEAR)!, i1 = xi.get(o.x + o.w + CLEAR)!, j0 = yi.get(o.y - CLEAR)!, j1 = yi.get(o.y + o.h + CLEAR)!;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      if (i < i1 && j > j0 && j < j1) hBlock[j * nx + i] = 1;
      if (j < j1 && i > i0 && i < i1) vBlock[j * nx + i] = 1;
    }
  }

  return (a: Box, ay: number, b: Box, by: number): Pt[] | null => {
    // ends: [point on the box edge, stub point CLEAR outside it]; a self reference loops on the right
    const sides = (o: Box, y: number) => (a === b ? [1] : [1, -1]).map((s) => ({ edge: [s > 0 ? o.x + o.w : o.x, y] as Pt, stub: [s > 0 ? o.x + o.w + CLEAR : o.x - CLEAR, y] as Pt }));
    const node = ([x, y]: Pt) => (xi.has(x) && yi.has(y) ? yi.get(y)! * nx + xi.get(x)! : -1);
    const S = sides(a, ay).map((e) => ({ ...e, n: node(e.stub) })).filter((e) => e.n >= 0);
    const T = sides(b, by).map((e) => ({ ...e, n: node(e.stub) })).filter((e) => e.n >= 0);
    if (!S.length || !T.length) return null;
    // state = node*2 + dir (0 moving horizontally, 1 vertically); stubs are horizontal
    const N = nx * ny * 2, g = new Float64Array(N).fill(Infinity), prev = new Int32Array(N).fill(-1), done = new Uint8Array(N);
    const h = (n: number) => Math.min(...T.map((t) => Math.abs(xs[n % nx] - t.stub[0]) + Math.abs(ys[(n / nx) | 0] - t.stub[1])));
    const heap: [number, number][] = [];
    const push = (f: number, s: number) => {
      heap.push([f, s]);
      for (let i = heap.length - 1; i > 0;) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; }
    };
    const pop = () => {
      const top = heap[0], last = heap.pop()!;
      if (heap.length) {
        heap[0] = last;
        for (let i = 0; ;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i], heap[m]]; i = m;
        }
      }
      return top[1];
    };
    const relax = (s: number, to: number, cost: number) => {
      if (g[s] + cost < g[to]) { g[to] = g[s] + cost; prev[to] = s; push(g[to] + h(to >> 1), to); }
    };
    for (const e of S) { g[e.n * 2] = 0; push(h(e.n), e.n * 2); }
    const goals = new Set(T.map((t) => t.n * 2));
    let end = -1;
    while (heap.length) {
      const s = pop();
      if (done[s]) continue;
      done[s] = 1;
      if (goals.has(s)) { end = s; break; }
      const n = s >> 1, dir = s & 1, i = n % nx, j = (n / nx) | 0;
      relax(s, n * 2 + (1 - dir), BEND);
      if (dir === 0) {
        if (i > 0 && !hBlock[n - 1]) relax(s, (n - 1) * 2, xs[i] - xs[i - 1]);
        if (i < nx - 1 && !hBlock[n]) relax(s, (n + 1) * 2, xs[i + 1] - xs[i]);
      } else {
        if (j > 0 && !vBlock[n - nx]) relax(s, (n - nx) * 2 + 1, ys[j] - ys[j - 1]);
        if (j < ny - 1 && !vBlock[n]) relax(s, (n + nx) * 2 + 1, ys[j + 1] - ys[j]);
      }
    }
    if (end < 0) return null;
    const pts: Pt[] = [];
    for (let s = end; s >= 0; s = prev[s]) { const n = s >> 1, p: Pt = [xs[n % nx], ys[(n / nx) | 0]]; if (!pts.length || pts[pts.length - 1][0] !== p[0] || pts[pts.length - 1][1] !== p[1]) pts.push(p); }
    pts.reverse();
    const start = S.find((e) => e.stub[0] === pts[0][0] && e.stub[1] === pts[0][1])!;
    const fin = T.find((t) => t.n * 2 === end)!;
    return simplify([start.edge, ...pts, fin.edge]);
  };
}

/** Drops points in the middle of a straight run. */
export function simplify(pts: Pt[]): Pt[] {
  return pts.filter((p, k) => {
    if (k === 0 || k === pts.length - 1) return true;
    const a = pts[k - 1], b = pts[k + 1];
    return !((a[0] === p[0] && p[0] === b[0]) || (a[1] === p[1] && p[1] === b[1]));
  });
}

export const svgPath = (pts: Pt[]) => pts.map(([x, y], k) => `${k ? "L" : "M"}${x} ${y}`).join(" ");
