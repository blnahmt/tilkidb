import { useMemo, useState } from "react";
import type { Table } from "../lib/api";
import { fuzzyMatch } from "../lib/fuzzy";
import { Highlight } from "./CommandPalette";
import { Icon } from "./Icons";

const short = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : String(n));

// Sidebar tree: schema → tables and views → columns (PK/FK, type). Filter matches table names.
// Double-click (or Enter on) a table to query it in a new tab.
export function SchemaTree({ tables, onOpen }: { tables: Table[]; onOpen: (t: Table) => void }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const toggle = (k: string, def = false) => setOpen((o) => ({ ...o, [k]: !(o[k] ?? def) }));

  const bySchema = useMemo(() => {
    const m = new Map<string, { t: Table; hit: number[] }[]>();
    for (const t of tables) {
      const hit = fuzzyMatch(q, t.name);
      if (hit) m.set(t.schema, [...(m.get(t.schema) ?? []), { t, hit: hit.indices }]);
    }
    return m;
  }, [tables, q]);
  const multi = new Set(tables.map((t) => t.schema)).size > 1;

  return (
    <>
      <label className="filter">
        <Icon name="search" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Filter ${tables.length} tables`} aria-label="Filter tables" />
      </label>
      <div className="tree" role="tree">
        {bySchema.size === 0 && <p className="empty-side">{tables.length ? "No tables match." : "This database has no tables yet."}</p>}
        {[...bySchema].map(([schema, items]) => {
          const sOpen = q !== "" || (open[`s:${schema}`] ?? (!multi || ["public", "main", "dbo"].includes(schema)));
          return (
            <div key={schema} role="group">
              {multi && (
                <button className={`tn${sOpen ? " open" : ""}`} role="treeitem" aria-expanded={sOpen} onClick={() => toggle(`s:${schema}`, sOpen)}>
                  <span className="car">▶</span><Icon name="folder" /><span className="lbl">{schema}</span><span className="meta">{items.length}</span>
                </button>
              )}
              {sOpen && items.map(({ t, hit }) => {
                const key = `${t.schema}.${t.name}`;
                const tOpen = !!open[key];
                return (
                  <div key={key}>
                    <button className={`tn${tOpen ? " open" : ""}${multi ? " in" : ""}`} role="treeitem" aria-expanded={tOpen} onClick={() => toggle(key)}
                      onDoubleClick={() => onOpen(t)} onKeyDown={(e) => { if (e.key === "Enter" && e.shiftKey) { e.preventDefault(); onOpen(t); } }}
                      title={`${key} · ${t.columns.length} columns${t.rows != null ? ` · about ${t.rows.toLocaleString()} rows` : ""}\nDouble-click to query`}>
                      <span className="car">▶</span><Icon name={t.kind === "view" ? "view" : "table"} />
                      <span className="lbl"><Highlight text={t.name} indices={hit} /></span>
                      {t.rows != null && <span className="meta">{short(t.rows)}</span>}
                    </button>
                    {tOpen && t.columns.map((c) => (
                      <div key={c.name} className={`col${multi ? " in" : ""}`} title={`${c.name} ${c.dataType}${c.nullable ? "" : " NOT NULL"}${c.fk ? ` → ${c.fk}` : ""}`}>
                        {c.pk ? <span className="key">PK</span> : c.fk ? <span className="key fk">FK</span> : <span className="key none" />}
                        <b>{c.name}</b><span className="ty">{c.dataType}</span>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </>
  );
}
