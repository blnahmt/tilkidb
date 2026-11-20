// JOIN suggestions from foreign keys: after "FROM customers c JOIN", offer
// "orders o ON o.customer_id = c.id" for every table related to one already in the query.
import type { Engine, Table } from "./api.ts";

export interface JoinHint { label: string; table: string }

const NOT_ALIAS = new Set(["on", "where", "join", "left", "right", "inner", "outer", "full", "cross", "natural", "group", "order", "limit", "having", "union", "using", "set", "values", "as", "lateral"]);
const RESERVED = new Set([...NOT_ALIAS, "select", "from", "table", "user", "key", "default", "check", "primary", "references", "desc", "asc", "by", "and", "or", "not", "null", "in", "is", "case", "when", "then", "end"]);

// one name part: "quoted", `quoted`, [quoted] or bare
const PART = /"[^"]+"|`[^`]+`|\[[^\]]+\]|[\w$]+/.source;
const unquote = (p: string) => p.replace(/^["`[]|["`\]]$/g, "");

/** [schema, name] from a possibly qualified, possibly quoted table name. */
function splitName(name: string): [string | null, string] {
  const parts = name.match(new RegExp(PART, "g")) ?? [name];
  const n = unquote(parts[parts.length - 1]);
  return [parts.length > 1 ? unquote(parts[parts.length - 2]) : null, n];
}

/** Short alias from a table name: order_items -> oi, "Order Items" -> oi, customers -> c; a number is added on a clash. */
export function aliasFor(name: string, used: Set<string>): string {
  const base = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map((w) => w[0]).join("") || "t";
  let a = /^\d/.test(base) ? `t${base}` : base, n = 2;
  const first = a;
  while (used.has(a) || NOT_ALIAS.has(a)) a = `${first}${n++}`;
  return a;
}

const find = (tables: Table[], schema: string | null, name: string) =>
  tables.find((t) => t.name.toLowerCase() === name.toLowerCase() && (!schema || t.schema.toLowerCase() === schema.toLowerCase()));

/** Tables already in the FROM / JOIN clauses before the cursor, with their aliases (or names as written). */
export function tablesInScope(before: string, tables: Table[]): { table: Table; alias: string }[] {
  const out: { table: Table; alias: string }[] = [];
  const re = new RegExp(`\\b(?:from|join)\\s+((?:${PART})(?:\\.(?:${PART}))?)(?:\\s+(?:as\\s+)?(\\w+))?`, "gi");
  for (let m; (m = re.exec(before));) {
    const [schema, name] = splitName(m[1]);
    const t = find(tables, schema, name);
    if (!t) continue;
    const alias = m[2] && !NOT_ALIAS.has(m[2].toLowerCase()) ? m[2] : m[1];
    out.push({ table: t, alias });
  }
  return out;
}

const pkOf = (t: Table) => {
  const pk = t.columns.filter((c) => c.pk);
  return pk.length === 1 ? pk[0].name : null;
};

/** An identifier as it must be typed: quoted when it has capitals, spaces or is a keyword. */
export function ident(engine: Engine, name: string): string {
  const plain = engine === "mysql" ? /^[A-Za-z_][\w$]*$/.test(name) : /^[a-z_][a-z0-9_$]*$/.test(name);
  if (plain && !RESERVED.has(name.toLowerCase())) return name;
  return engine === "mysql" ? `\`${name.replace(/`/g, "``")}\`` : `"${name.replace(/"/g, '""')}"`;
}

/** JOIN targets for the text before the cursor (which ends right after "JOIN "). */
export function joinHints(before: string, tables: Table[], engine: Engine = "postgres"): JoinHint[] {
  const scope = tablesInScope(before, tables);
  if (!scope.length) return [];
  const used = new Set(scope.map((s) => s.alias.toLowerCase()));
  const inScope = new Set(scope.map((s) => s.table));
  const several = new Set(tables.map((t) => t.schema)).size > 1;
  const ref = (t: Table) => (several && !["public", "main", "dbo"].includes(t.schema) ? `${ident(engine, t.schema)}.` : "") + ident(engine, t.name);
  // a foreign key names its parent table only: prefer the one in the child's schema
  const parentOf = (child: Table, fk: string) => find(tables, child.schema, fk) ?? find(tables, null, fk);
  const out: JoinHint[] = [];
  const seen = new Set<string>();
  const add = (target: Table, on: (a: string) => string) => {
    const a = aliasFor(target.name, used);
    const label = `${ref(target)} ${a} ON ${on(a)}`;
    if (!seen.has(label)) { seen.add(label); out.push({ label, table: target.name }); }
  };
  const col = (c: string) => ident(engine, c);
  for (const { table: s, alias } of scope) {
    // s references a parent through one of its columns
    for (const c of s.columns) {
      const p = c.fk ? parentOf(s, c.fk) : undefined;
      const pk = p && pkOf(p);
      if (p && pk && (!inScope.has(p) || p === s)) add(p, (a) => `${a}.${col(pk)} = ${alias}.${col(c.name)}`);
    }
    // other tables reference s
    const spk = pkOf(s);
    if (!spk) continue;
    for (const t of tables) {
      if (inScope.has(t)) continue;
      for (const c of t.columns) if (c.fk && parentOf(t, c.fk) === s) add(t, (a) => `${a}.${col(c.name)} = ${alias}.${col(spk)}`);
    }
  }
  return out;
}
