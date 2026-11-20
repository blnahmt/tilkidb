// SQL for the table editor (structure view) and the new-table dialog. The user always sees and
// confirms the statement before it runs. Type names and defaults are written as typed (SQL).
import type { Engine } from "./api.ts";
import { qualified, quoteIdent, type TableRef } from "./sqlgen.ts";

export interface ColSpec {
  name: string;
  type: string;
  nullable: boolean;
  default: string; // raw SQL expression, "" = none
  pk?: boolean;
}

const def = (e: Engine, c: ColSpec) => `${quoteIdent(e, c.name)} ${c.type.trim()}${c.nullable ? "" : " NOT NULL"}${c.default.trim() ? ` DEFAULT ${c.default.trim()}` : ""}`;

export const addColumn = (e: Engine, t: TableRef, c: ColSpec) => `ALTER TABLE ${qualified(e, t)} ADD COLUMN ${def(e, c)}`;
export const dropColumn = (e: Engine, t: TableRef, col: string) => `ALTER TABLE ${qualified(e, t)} DROP COLUMN ${quoteIdent(e, col)}`;
export const renameColumn = (e: Engine, t: TableRef, from: string, to: string) => `ALTER TABLE ${qualified(e, t)} RENAME COLUMN ${quoteIdent(e, from)} TO ${quoteIdent(e, to)}`;
export const renameTable = (e: Engine, t: TableRef, to: string) =>
  e === "mysql" ? `RENAME TABLE ${qualified(e, t)} TO ${quoteIdent(e, to)}` : `ALTER TABLE ${qualified(e, t)} RENAME TO ${quoteIdent(e, to)}`;

/** Type / NULL change. SQLite can't alter a column in place: null means "not possible here". */
export function changeColumn(e: Engine, t: TableRef, c: ColSpec, old: { type: string; nullable: boolean }): string[] | null {
  if (e === "sqlite") return null;
  if (e === "mysql") return [`ALTER TABLE ${qualified(e, t)} MODIFY COLUMN ${def(e, c)}`];
  const q = qualified(e, t), col = quoteIdent(e, c.name), out: string[] = [];
  if (c.type.trim() !== old.type) out.push(`ALTER TABLE ${q} ALTER COLUMN ${col} TYPE ${c.type.trim()}`);
  if (c.nullable !== old.nullable) out.push(`ALTER TABLE ${q} ALTER COLUMN ${col} ${c.nullable ? "DROP" : "SET"} NOT NULL`);
  out.push(c.default.trim() ? `ALTER TABLE ${q} ALTER COLUMN ${col} SET DEFAULT ${c.default.trim()}` : `ALTER TABLE ${q} ALTER COLUMN ${col} DROP DEFAULT`);
  return out;
}

export const addIndex = (e: Engine, t: TableRef, name: string, cols: string[], unique: boolean) =>
  `CREATE ${unique ? "UNIQUE " : ""}INDEX ${quoteIdent(e, name)} ON ${qualified(e, t)} (${cols.map((c) => quoteIdent(e, c)).join(", ")})`;

export function dropIndex(e: Engine, t: TableRef, name: string): string {
  if (e === "mysql") return name === "PRIMARY" ? `ALTER TABLE ${qualified(e, t)} DROP PRIMARY KEY` : `DROP INDEX ${quoteIdent(e, name)} ON ${qualified(e, t)}`;
  if (e === "postgres") return `DROP INDEX ${qualified(e, { schema: t.schema, name })}`; // PostgreSQL indexes live in the table's schema
  return `DROP INDEX ${quoteIdent(e, name)}`;
}

export function createTable(e: Engine, t: TableRef, cols: ColSpec[]): string {
  const pk = cols.filter((c) => c.pk).map((c) => quoteIdent(e, c.name));
  const lines = cols.filter((c) => c.name.trim()).map((c) => `  ${def(e, { ...c, nullable: c.nullable && !c.pk })}`);
  if (pk.length) lines.push(`  PRIMARY KEY (${pk.join(", ")})`);
  return `CREATE TABLE ${qualified(e, t)} (\n${lines.join(",\n")}\n)`;
}

/** Suggestions for the type field; any type the server knows can be typed. */
export const TYPES: Record<Engine, string[]> = {
  postgres: ["integer", "bigint", "serial", "bigserial", "numeric(12,2)", "double precision", "boolean", "text", "varchar(255)", "uuid", "date", "timestamp", "timestamptz", "jsonb", "bytea"],
  mysql: ["int", "bigint", "int AUTO_INCREMENT", "decimal(12,2)", "double", "tinyint(1)", "varchar(255)", "text", "datetime", "date", "timestamp", "json", "blob"],
  sqlite: ["INTEGER", "REAL", "TEXT", "BLOB", "NUMERIC"],
};
