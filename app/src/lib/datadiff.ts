// Row-level comparison of two result sets (two tables, or two query results) and the SQL that
// makes the target match the source.
import type { Cell, Engine } from "./api.ts";
import { literal, qualified, quoteIdent, type TableRef } from "./sqlgen.ts";
import { parsePgArray, portValue } from "./typemap.ts"; // portValue: offset times to UTC

export interface RowDiff {
  added: Cell[][]; // in the source only
  removed: Cell[][]; // in the target only
  changed: { from: Cell[]; to: Cell[]; cols: number[] }[]; // same key, other values (from = target, to = source)
  same: number;
}

/** How a column's values compare, from its type: numbers, booleans, times and arrays have several spellings. */
export type Kind = "num" | "bool" | "time" | "array" | "text";
export function kindOf(type: string): Kind {
  const t = type.toLowerCase();
  if (/^bool|tinyint\(1\)|^bit\(1\)$/.test(t)) return "bool";
  if (/\[\]$|json|^array/.test(t)) return "array";
  if (/int|numeric|decimal|real|double|float|money|serial|^bit/.test(t)) return "num";
  if (/date|time/.test(t)) return "time";
  return "text";
}

/** Comparable text for a value: engines return 1.50 / "1.5" / true / 1 for the same thing.
 *  Text columns compare exactly ("007" is not "7"). */
export function norm(v: Cell, kind: Kind = "text"): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "number") return String(v);
  if (typeof v === "object") return JSON.stringify(v);
  if (kind === "bool" && /^(t|f|true|false|0x0[01])$/i.test(v)) return /^(t|true|0x01)$/i.test(v) ? "1" : "0";
  if (kind === "num" && /^[+-]?\d+(\.\d+)?$/.test(v.trim())) {
    let s = v.trim().replace(/^\+/, "");
    if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
    s = s.replace(/^(-?)0+(?=\d)/, "$1");
    return s === "-0" ? "0" : s;
  }
  // times: "2024-01-05T10:00:00.000000", "2024-01-05 10:00:00" and "2024-01-05 13:00:00+03" are the same moment
  const dt = kind === "time" ? /^(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d)(\.\d+)?(Z|[+-]\d\d(?::?\d\d)?)?$/.exec(v) : null;
  if (dt) {
    const utc = dt[4] ? String(portValue(v, "", "postgres", "mysql")) : `${dt[1]} ${dt[2]}${dt[3] ?? ""}`;
    return utc.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, ""); // trailing zero fractions don't count
  }
  if (kind === "array" && v.startsWith("{") && v.endsWith("}")) { const a = parsePgArray(v); if (a) return JSON.stringify(a); }
  if (kind === "array" && /^[[{]/.test(v)) { try { return JSON.stringify(JSON.parse(v)); } catch { /* not JSON */ } } // PostgreSQL array text vs a JSON array
  return v;
}

const rowKey = (r: Cell[], idx: number[], kinds: Kind[]) => JSON.stringify(idx.map((i) => norm(r[i], kinds[i])));

/**
 * `keyIdx` are the primary-key positions (same column order in both). Without a key, rows are
 * compared whole, as multisets, so nothing can be "changed".
 */
export function diffRows(source: Cell[][], target: Cell[][], keyIdx: number[], kinds: Kind[] = []): RowDiff {
  const whole = (r: Cell[]) => JSON.stringify(r.map((v, i) => norm(v, kinds[i])));
  const out: RowDiff = { added: [], removed: [], changed: [], same: 0 };
  if (!keyIdx.length) {
    const left = new Map<string, Cell[][]>();
    for (const r of target) { const k = whole(r); left.set(k, [...(left.get(k) ?? []), r]); }
    for (const r of source) {
      const k = whole(r), hit = left.get(k);
      if (hit?.length) { hit.pop(); out.same++; } else out.added.push(r);
    }
    for (const rs of left.values()) out.removed.push(...rs);
    return out;
  }
  const byKey = new Map(target.map((r) => [rowKey(r, keyIdx, kinds), r]));
  for (const r of source) {
    const k = rowKey(r, keyIdx, kinds), t = byKey.get(k);
    if (!t) { out.added.push(r); continue; }
    byKey.delete(k);
    const cols = r.map((_, i) => i).filter((i) => norm(r[i], kinds[i]) !== norm(t[i], kinds[i]));
    if (cols.length) out.changed.push({ from: t, to: r, cols }); else out.same++;
  }
  out.removed.push(...byKey.values());
  return out;
}

/** INSERT / UPDATE / (optionally) DELETE statements that turn the target into the source.
 *  `lit` writes a source value as a target literal (column index given): conversions between engines, bytes. */
export function syncSql(engine: Engine, table: TableRef, cols: string[], keyIdx: number[], d: RowDiff, deletes: boolean, lit: (v: Cell, i: number) => string = (v) => literal(engine, v)): string[] {
  const t = qualified(engine, table), q = (c: string) => quoteIdent(engine, c);
  const where = (r: Cell[]) => keyIdx.map((i) => (r[i] === null ? `${q(cols[i])} IS NULL` : `${q(cols[i])} = ${literal(engine, r[i])}`)).join(" AND ");
  const out: string[] = [];
  if (deletes && keyIdx.length) for (const r of d.removed) out.push(`DELETE FROM ${t} WHERE ${where(r)};`);
  for (const c of d.changed) out.push(`UPDATE ${t} SET ${c.cols.map((i) => `${q(cols[i])} = ${lit(c.to[i], i)}`).join(", ")} WHERE ${where(c.from)};`);
  // PostgreSQL: the keys go in as they are, also into GENERATED ALWAYS identity columns
  const over = engine === "postgres" ? " OVERRIDING SYSTEM VALUE" : "";
  for (const r of d.added) out.push(`INSERT INTO ${t} (${cols.map(q).join(", ")})${over} VALUES (${r.map((v, i) => lit(v, i)).join(", ")});`);
  return out;
}
