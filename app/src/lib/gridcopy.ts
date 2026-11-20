// Copying a cell range from the grid in several formats, and quick statistics for one column.
import type { Cell, Engine } from "./api.ts";
import { literal, quoteIdent } from "./sqlgen.ts";

export type CopyFormat = "tsv" | "csv" | "json" | "insert" | "markdown";

const plain = (v: Cell) => (v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

export function copyText(cols: string[], rows: Cell[][], fmt: CopyFormat, opts: { headers?: boolean; table?: string; engine?: Engine } = {}): string {
  const engine = opts.engine ?? "postgres";
  switch (fmt) {
    case "tsv": {
      // tabs / newlines inside a value would break the paste into a spreadsheet: flatten them
      const f = (v: Cell) => plain(v).replace(/[\t\r\n]+/g, " ");
      return [...(opts.headers ? [cols.join("\t")] : []), ...rows.map((r) => r.map(f).join("\t"))].join("\n");
    }
    case "csv": {
      const f = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
      return [cols.map(f).join(","), ...rows.map((r) => r.map((v) => f(plain(v))).join(","))].join("\r\n");
    }
    case "json":
      return JSON.stringify(rows.map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i] ?? null]))), null, 2);
    case "markdown": {
      const f = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
      return [`| ${cols.map(f).join(" | ")} |`, `| ${cols.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map((v) => f(v === null ? "NULL" : plain(v))).join(" | ")} |`)].join("\n");
    }
    case "insert": {
      const head = `INSERT INTO ${opts.table ?? quoteIdent(engine, "table_name")} (${cols.map((c) => quoteIdent(engine, c)).join(", ")}) VALUES`;
      return rows.length ? `${head}\n${rows.map((r) => `  (${r.map((v) => literal(engine, v)).join(", ")})`).join(",\n")};` : "";
    }
  }
}

export interface ColumnStats { count: number; nulls: number; distinct: number; min: string; max: string; avg: number | null; numeric: boolean }

export function columnStats(values: Cell[]): ColumnStats {
  const present = values.filter((v) => v !== null);
  const nums = present.map((v) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && !isNaN(Number(v)) ? Number(v) : NaN));
  const numeric = present.length > 0 && nums.every((n) => !isNaN(n));
  const texts = present.map(plain);
  let min = "", max = "";
  if (numeric) {
    const lo = Math.min(...nums), hi = Math.max(...nums);
    min = texts[nums.indexOf(lo)]; max = texts[nums.indexOf(hi)];
  } else if (texts.length) {
    min = texts.reduce((a, b) => (b < a ? b : a)); max = texts.reduce((a, b) => (b > a ? b : a));
  }
  return { count: values.length, nulls: values.length - present.length, distinct: new Set(texts).size, min, max, avg: numeric ? nums.reduce((a, b) => a + b, 0) / nums.length : null, numeric };
}

/**
 * Cells pasted from a spreadsheet or another grid: tab-separated rows; Excel quotes a cell that holds
 * tabs, newlines or quotes. Empty cells become NULL (that's how the grid copies NULL).
 */
export function parseClipboard(text: string): (string | null)[][] {
  const rows: (string | null)[][] = [];
  let row: (string | null)[] = [], cell = "", quoted = false, i = 0;
  const endCell = () => { row.push(cell === "" ? null : cell); cell = ""; };
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 2; continue; }
      if (ch === '"') { quoted = false; i++; continue; }
      cell += ch; i++; continue;
    }
    if (ch === '"' && cell === "") { quoted = true; i++; continue; }
    if (ch === "\t") { endCell(); i++; continue; }
    if (ch === "\r" || ch === "\n") { endCell(); rows.push(row); row = []; i += ch === "\r" && text[i + 1] === "\n" ? 2 : 1; continue; }
    cell += ch; i++;
  }
  if (cell !== "" || row.length) { endCell(); rows.push(row); }
  return rows;
}
