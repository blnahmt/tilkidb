// Compare two schemas (as list_schema returns them) and write the SQL that makes the target
// look like the source. Covers tables, views (existence only) and columns (type, NULL, PK, FK).
// Indexes, defaults, triggers and view bodies are not in list_schema, so they aren't compared.
import type { Column, Engine, Table } from "./api.ts";
import { qualified, quoteIdent } from "./sqlgen.ts";

export interface ColDiff {
  name: string;
  kind: "added" | "removed" | "changed";
  source?: Column;
  target?: Column;
  what: string[]; // for "changed": "type", "null", "pk", "fk"
}
export interface TableDiff {
  name: string;
  kind: "added" | "removed" | "changed"; // added = only in source, removed = only in target
  view: boolean;
  source?: Table;
  target?: Table;
  cols: ColDiff[];
}

const normType = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim();

/** Tables pair up by schema + name, or by name alone when either side has a single schema. */
function keyer(a: Table[], b: Table[]) {
  const one = (ts: Table[]) => new Set(ts.map((t) => t.schema)).size <= 1;
  return one(a) || one(b) ? (t: Table) => t.name.toLowerCase() : (t: Table) => `${t.schema}.${t.name}`.toLowerCase();
}

export function diffSchemas(source: Table[], target: Table[]): TableDiff[] {
  const key = keyer(source, target);
  const tmap = new Map(target.map((t) => [key(t), t]));
  const smap = new Map(source.map((t) => [key(t), t]));
  const out: TableDiff[] = [];
  for (const s of source) {
    const t = tmap.get(key(s));
    if (!t) { out.push({ name: s.name, kind: "added", view: s.kind === "view", source: s, cols: [] }); continue; }
    const cols: ColDiff[] = [];
    const tcols = new Map(t.columns.map((c) => [c.name.toLowerCase(), c]));
    for (const sc of s.columns) {
      const tc = tcols.get(sc.name.toLowerCase());
      if (!tc) { cols.push({ name: sc.name, kind: "added", source: sc, what: [] }); continue; }
      const what = [
        normType(sc.dataType) !== normType(tc.dataType) && "type",
        sc.nullable !== tc.nullable && "null",
        sc.pk !== tc.pk && "pk",
        (sc.fk ?? "").toLowerCase() !== (tc.fk ?? "").toLowerCase() && "fk",
      ].filter((x): x is string => !!x);
      if (what.length) cols.push({ name: sc.name, kind: "changed", source: sc, target: tc, what });
    }
    const snames = new Set(s.columns.map((c) => c.name.toLowerCase()));
    for (const tc of t.columns) if (!snames.has(tc.name.toLowerCase())) cols.push({ name: tc.name, kind: "removed", target: tc, what: [] });
    if (cols.length && s.kind !== "view") out.push({ name: s.name, kind: "changed", view: false, source: s, target: t, cols });
  }
  for (const t of target) if (!smap.has(key(t))) out.push({ name: t.name, kind: "removed", view: t.kind === "view", target: t, cols: [] });
  return out;
}

const colDef = (e: Engine, c: Column) => `${quoteIdent(e, c.name)} ${c.dataType}${c.nullable ? "" : " NOT NULL"}`;

/** Migration for the target engine. Drops are written commented out unless `drops` is on. */
/** `sourceTables` lets MySQL foreign keys name the referenced primary key column. */
export function migration(diffs: TableDiff[], engine: Engine, drops: boolean, defaultSchema = "", sourceTables: Table[] = []): string {
  const out: string[] = [];
  const drop = (sql: string) => out.push(drops ? sql : `-- ${sql}`);
  const name = (d: TableDiff) => qualified(engine, { schema: d.target?.schema ?? defaultSchema, name: d.name });
  for (const d of diffs) {
    const q = name(d);
    if (d.view) {
      out.push(`-- View ${d.name} exists only in the ${d.kind === "added" ? "source" : "target"}; view definitions aren't compared.`);
      if (d.kind === "removed") drop(`DROP VIEW ${q};`);
      continue;
    }
    if (d.kind === "added") {
      const cols = d.source!.columns;
      const pk = cols.filter((c) => c.pk).map((c) => quoteIdent(engine, c.name));
      // REFERENCES <table> points at its primary key on PostgreSQL and SQLite; MySQL needs the column
      const ref = (c: Column) => (c.fk && engine !== "mysql" ? ` REFERENCES ${qualified(engine, { schema: d.source!.schema, name: c.fk })}` : "");
      const lines = cols.map((c) => `  ${colDef(engine, c)}${ref(c)}`);
      if (pk.length) lines.push(`  PRIMARY KEY (${pk.join(", ")})`);
      const handFks: Column[] = [];
      if (engine === "mysql") for (const c of cols.filter((x) => x.fk)) {
        const refPk = sourceTables.find((t) => t.name === c.fk)?.columns.filter((x) => x.pk) ?? [];
        if (refPk.length === 1) lines.push(`  FOREIGN KEY (${quoteIdent(engine, c.name)}) REFERENCES ${quoteIdent(engine, c.fk!)} (${quoteIdent(engine, refPk[0].name)})`);
        else handFks.push(c);
      }
      out.push(`CREATE TABLE ${q} (\n${lines.join(",\n")}\n);`);
      for (const c of handFks) out.push(`-- ${d.name}.${c.name} references ${c.fk}: add the FOREIGN KEY by hand.`);
      continue;
    }
    if (d.kind === "removed") { drop(`DROP TABLE ${q};`); continue; }
    for (const c of d.cols) {
      const col = quoteIdent(engine, c.name);
      if (c.kind === "added") {
        out.push(`ALTER TABLE ${q} ADD COLUMN ${colDef(engine, c.source!)};${c.source!.nullable ? "" : " -- NOT NULL needs a DEFAULT if the table has rows"}`);
      } else if (c.kind === "removed") {
        drop(`ALTER TABLE ${q} DROP COLUMN ${col};`);
      } else {
        const s = c.source!;
        if (c.what.includes("type") || c.what.includes("null")) {
          if (engine === "postgres") {
            if (c.what.includes("type")) out.push(`ALTER TABLE ${q} ALTER COLUMN ${col} TYPE ${s.dataType};`);
            if (c.what.includes("null")) out.push(`ALTER TABLE ${q} ALTER COLUMN ${col} ${s.nullable ? "DROP" : "SET"} NOT NULL;`);
          } else if (engine === "mysql") {
            out.push(`ALTER TABLE ${q} MODIFY COLUMN ${colDef(engine, s)};`);
          } else {
            out.push(`-- ${d.name}.${c.name}: SQLite can't change a column's ${c.what.filter((w) => w === "type" || w === "null").join(" or ")}; rebuild the table.`);
          }
        }
        if (c.what.includes("pk")) out.push(`-- ${d.name}.${c.name}: primary key differs (${s.pk ? "key in source" : "key in target"}); change it by hand.`);
        if (c.what.includes("fk")) out.push(`-- ${d.name}.${c.name}: foreign key differs (source → ${s.fk ?? "none"}, target → ${c.target!.fk ?? "none"}); change it by hand.`);
      }
    }
  }
  return out.join("\n");
}
