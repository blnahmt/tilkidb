// SQL text for the table view: identifiers, literals, filters, paging and row changes.
// Values are written as quoted literals (not typed parameters) so each database coerces them to
// the column's own type; what "Review SQL" shows is exactly what runs.
import type { Cell, Engine } from "./api.ts";

export type FilterOp = "=" | "!=" | "<" | ">" | "<=" | ">=" | "LIKE" | "NOT LIKE" | "ILIKE" | "IN" | "BETWEEN" | "IS NULL" | "IS NOT NULL";
export interface Filter {
  join: "AND" | "OR";
  col: string;
  op: FilterOp;
  val: string;
  val2?: string; // upper bound for BETWEEN
}
export interface Sort {
  col: string;
  dir: "ASC" | "DESC";
}
export interface TableRef {
  schema: string;
  name: string;
}
export interface Change {
  sql: string;
  expectOne: boolean;
}

const DEFAULT_SCHEMAS = ["public", "main", "dbo"];

export const quoteIdent = (engine: Engine, name: string) =>
  engine === "mysql" ? `\`${name.replace(/`/g, "``")}\`` : `"${name.replace(/"/g, '""')}"`;

export const qualified = (engine: Engine, t: TableRef) =>
  !t.schema || DEFAULT_SCHEMAS.includes(t.schema) ? quoteIdent(engine, t.name) : `${quoteIdent(engine, t.schema)}.${quoteIdent(engine, t.name)}`;

/** SQL literal. MySQL treats backslash as an escape inside strings, so it gets doubled there. */
export function literal(engine: Engine, v: Cell): string {
  if (v === null) return "NULL";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  let s = typeof v === "string" ? v : JSON.stringify(v);
  if (engine === "mysql") s = s.replace(/\\/g, "\\\\");
  return `'${s.replace(/'/g, "''")}'`;
}

export const needsValue = (op: FilterOp) => op !== "IS NULL" && op !== "IS NOT NULL";

/** WHERE body from builder rows; rows without a value (when one is needed) are skipped. */
export function buildWhere(engine: Engine, filters: Filter[]): string {
  const live = filters.filter((f) => f.col && (!needsValue(f.op) || (f.val !== "" && (f.op !== "BETWEEN" || (f.val2 ?? "") !== ""))));
  return live
    .map((f, i) => {
      const col = quoteIdent(engine, f.col);
      const op = f.op === "ILIKE" && engine !== "postgres" ? "LIKE" : f.op;
      const cond = !needsValue(f.op) ? `${col} ${f.op}`
        : f.op === "BETWEEN" ? `${col} BETWEEN ${literal(engine, f.val)} AND ${literal(engine, f.val2 ?? "")}`
        : f.op === "IN" ? `${col} IN (${f.val.split(",").map((x) => literal(engine, x.trim())).join(", ")})`
        : `${col} ${op} ${literal(engine, f.val)}`;
      return (i ? `${f.join} ` : "") + cond;
    })
    .join(" ");
}

export function buildSelect(engine: Engine, t: TableRef, where: string, sorts: Sort[], limit: number, offset: number): string {
  let sql = `SELECT * FROM ${qualified(engine, t)}`;
  if (where.trim()) sql += ` WHERE ${where.trim()}`;
  if (sorts.length) sql += ` ORDER BY ${sorts.map((s) => `${quoteIdent(engine, s.col)} ${s.dir}`).join(", ")}`;
  if (limit > 0) sql += ` LIMIT ${limit}`;
  if (offset > 0) sql += ` OFFSET ${offset}`;
  return sql;
}

export const buildCount = (engine: Engine, t: TableRef, where: string) =>
  `SELECT count(*) FROM ${qualified(engine, t)}${where.trim() ? ` WHERE ${where.trim()}` : ""}`;

/**
 * Statements for pending edits. `rows` are the loaded rows (original values), `inserted` the new
 * rows (index = rows.length + i in `edits`), `edits` maps row → column → new value.
 */
export function buildChanges(engine: Engine, t: TableRef, columns: string[], pk: number[], rows: Cell[][], edits: Map<number, Map<number, Cell>>, deleted: Set<number>, inserted: number): Change[] {
  const table = qualified(engine, t);
  const where = (r: number) => pk.map((c) => {
    const v = rows[r][c];
    return v === null ? `${quoteIdent(engine, columns[c])} IS NULL` : `${quoteIdent(engine, columns[c])} = ${literal(engine, v)}`;
  }).join(" AND ");
  const out: Change[] = [];
  for (const r of [...deleted].filter((r) => r < rows.length).sort((a, b) => a - b)) {
    out.push({ sql: `DELETE FROM ${table} WHERE ${where(r)}`, expectOne: true });
  }
  for (const [r, cells] of [...edits].sort((a, b) => a[0] - b[0])) {
    if (r >= rows.length || deleted.has(r) || cells.size === 0) continue;
    const set = [...cells].sort((a, b) => a[0] - b[0]).map(([c, v]) => `${quoteIdent(engine, columns[c])} = ${literal(engine, v)}`).join(", ");
    out.push({ sql: `UPDATE ${table} SET ${set} WHERE ${where(r)}`, expectOne: true });
  }
  for (let i = 0; i < inserted; i++) {
    const r = rows.length + i;
    if (deleted.has(r)) continue;
    const cells = [...(edits.get(r) ?? new Map<number, Cell>())].sort((a, b) => a[0] - b[0]);
    out.push({
      sql: cells.length
        ? `INSERT INTO ${table} (${cells.map(([c]) => quoteIdent(engine, columns[c])).join(", ")}) VALUES (${cells.map(([, v]) => literal(engine, v)).join(", ")})`
        : engine === "mysql" ? `INSERT INTO ${table} () VALUES ()` : `INSERT INTO ${table} DEFAULT VALUES`,
      expectOne: false,
    });
  }
  return out;
}
