// Query parameters: `:name` placeholders are asked for before a run and filled in as literals.
// Text inside strings, quoted names, comments and $$ bodies is left alone, as are PostgreSQL
// casts (::type) and MySQL assignments (:=).
import type { Engine } from "./api.ts";
import { literal } from "./sqlgen.ts";

/** Each placeholder occurrence: [start, end, name]. */
function scan(sql: string, backslashEscapes: boolean): [number, number, string][] {
  const out: [number, number, string][] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i], n = sql[i + 1];
    if (c === "-" && n === "-") { const e = sql.indexOf("\n", i); i = e < 0 ? sql.length : e; continue; }
    if (c === "/" && n === "*") { const e = sql.indexOf("*/", i + 2); i = e < 0 ? sql.length : e + 2; continue; }
    if (c === "'" || c === '"' || c === "`") {
      i++;
      while (i < sql.length) {
        if (backslashEscapes && sql[i] === "\\") { i += 2; continue; }
        if (sql[i] === c) { if (sql[i + 1] === c) { i += 2; continue; } break; }
        i++;
      }
      i++;
      continue;
    }
    if (c === "$") {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i))?.[0];
      if (tag) { const e = sql.indexOf(tag, i + tag.length); i = e < 0 ? sql.length : e + tag.length; continue; }
    }
    if (c === ":") {
      if (n === ":" ) { i += 2; while (/[A-Za-z0-9_]/.test(sql[i] ?? "")) i++; continue; } // ::cast
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(i + 1));
      if (m && sql[i - 1] !== ":" && !/[A-Za-z0-9_]/.test(sql[i - 1] ?? "")) { out.push([i, i + 1 + m[0].length, m[0]]); i += 1 + m[0].length; continue; }
    }
    i++;
  }
  return out;
}

/** Placeholder names in order of first use. */
export const findParams = (sql: string, backslashEscapes = false) => [...new Set(scan(sql, backslashEscapes).map((p) => p[2]))];

/** A value typed in the dialog: NULL and plain numbers go in as they are, anything else as a string literal. */
const toSql = (engine: Engine, v: string) => (/^null$/i.test(v.trim()) ? "NULL" : /^-?\d+(\.\d+)?$/.test(v.trim()) ? v.trim() : literal(engine, v));

export function fillParams(sql: string, values: Record<string, string>, engine: Engine): string {
  let out = "", last = 0;
  for (const [s, e, name] of scan(sql, engine === "mysql")) {
    out += sql.slice(last, s) + toSql(engine, values[name] ?? "");
    last = e;
  }
  return out + sql.slice(last);
}
