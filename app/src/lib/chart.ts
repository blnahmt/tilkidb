// Data shaping for the quick chart: group rows by one column and sum another (or count rows).
import type { Cell } from "./api.ts";

export interface Point {
  label: string;
  value: number;
}

const toNum = (v: Cell): number | null => {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  return null;
};
const keyOf = (v: Cell) => (v === null ? "NULL" : typeof v === "object" ? JSON.stringify(v) : String(v));

/** True when every non-null value in the first rows reads as a number. */
export function isNumeric(rows: Cell[][], col: number): boolean {
  let seen = 0;
  for (const r of rows.slice(0, 500)) {
    if (r[col] === null) continue;
    if (toNum(r[col]) === null) return false;
    seen++;
  }
  return seen > 0;
}

/**
 * Bar: categories by value, biggest first; beyond `maxBars` the rest fold into "Other".
 * Line: points in x order (numbers or dates sort naturally; otherwise first-seen order).
 * y = -1 counts rows instead of summing a column.
 */
export function aggregate(rows: Cell[][], x: number, y: number, kind: "bar" | "line", maxBars = 25): Point[] {
  const sums = new Map<string, number>();
  const raw = new Map<string, Cell>();
  for (const r of rows) {
    const k = keyOf(r[x] ?? null);
    const add = y < 0 ? 1 : toNum(r[y] ?? null);
    if (add === null) continue;
    sums.set(k, (sums.get(k) ?? 0) + add);
    if (!raw.has(k)) raw.set(k, r[x] ?? null);
  }
  let pts = [...sums].map(([label, value]) => ({ label, value }));
  if (kind === "bar") {
    pts.sort((a, b) => b.value - a.value);
    if (pts.length > maxBars) {
      const rest = pts.slice(maxBars - 1).reduce((a, p) => a + p.value, 0);
      pts = [...pts.slice(0, maxBars - 1), { label: "Other", value: rest }];
    }
    return pts;
  }
  const xs = [...raw.values()];
  const numeric = xs.every((v) => v === null || toNum(v) !== null);
  const dates = !numeric && xs.every((v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v));
  if (numeric) pts.sort((a, b) => Number(a.label) - Number(b.label));
  else if (dates) pts.sort((a, b) => a.label.localeCompare(b.label));
  return pts;
}

/** Round axis ticks from 0 (or a negative minimum) to just past the maximum. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  const lo = Math.min(0, min), hi = Math.max(0, max);
  const span = hi - lo || 1;
  let step = 10 ** Math.floor(Math.log10(span / count));
  const err = span / count / step;
  step *= err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1;
  const out: number[] = [];
  for (let v = Math.floor(lo / step) * step; v <= hi + step * 0.999; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

export interface Slice { label: string; value: number; share: number; start: number; end: number }

/**
 * Pie slices (angles in radians, clockwise from 12 o'clock) for points from aggregate(..., "bar", 5):
 * the four biggest plus "Other". A pie can't show negative parts, so any negative value is an error.
 */
export function pieSlices(points: Point[]): Slice[] | { error: string } {
  if (points.some((p) => p.value < 0)) return { error: "A pie can't show negative values. Use Bar instead." };
  const total = points.reduce((a, p) => a + p.value, 0);
  if (total <= 0) return { error: "Nothing to show: every value is zero." };
  let at = 0;
  return points.filter((p) => p.value > 0).map((p) => {
    const share = p.value / total, start = at;
    at += share * 2 * Math.PI;
    return { label: p.label, value: p.value, share, start, end: at };
  });
}
