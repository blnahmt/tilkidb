import { useEffect, useState } from "react";
import { api, errText, type Table } from "../lib/api";
import { addColumn, addIndex, changeColumn, createTable, dropColumn, dropIndex, renameColumn, renameTable, TYPES, type ColSpec } from "../lib/ddl";
import { risks, type Risk } from "../lib/sql";
import { GuardDialog } from "./GuardDialog";
import type { TabConn } from "./QueryTab";
import { Icon } from "./Icons";

type Named = { name: string; def: string; unique: boolean };
type Structure = { ddl: string; indexes: Named[]; triggers: Named[]; defaults: Named[] };
type Form =
  | { kind: "column"; old?: { name: string; type: string; nullable: boolean; default: string }; c: ColSpec }
  | { kind: "rename-column"; from: string; to: string }
  | { kind: "rename-table"; to: string }
  | { kind: "index"; name: string; cols: string[]; unique: boolean };

/** Runs DDL after showing it: the guard for production / irreversible statements, then one script
 *  (PostgreSQL runs a multi-statement script as one transaction, so a failed step changes nothing). */
function useDdlRunner(conn: TabConn, onDone: (msg: string) => void) {
  const [pending, setPending] = useState<{ sql: string[]; title: string } | null>(null);
  const [guard, setGuard] = useState<Risk[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const exec = async () => {
    if (!pending) return;
    setGuard(null); setBusy(true); setError(null);
    try {
      await api.runQuery(conn.id, crypto.randomUUID(), pending.sql.map((s) => `${s};`).join("\n"), 1, () => {});
      onDone(`${pending.title}: done`);
      setPending(null);
    } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  };
  const confirm = () => {
    if (!pending) return;
    const found = conn.readOnly ? [] : risks(pending.sql.join(";\n"), { prod: conn.prod, backslashEscapes: conn.engine === "mysql" });
    if (found.length) setGuard(found); else exec();
  };
  const dialog = pending && (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && !busy && setPending(null)}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="ddl-title">
        <h3 id="ddl-title">{pending.title}</h3>
        <p className="note">This runs on <b>{conn.name}</b>.</p>
        <pre className="sqlprev">{pending.sql.map((s) => `${s};`).join("\n")}</pre>
        {error && <p className="testres err">{error}</p>}
        <div className="acts"><button className="btn" onClick={() => setPending(null)} disabled={busy}>Cancel</button><button className="btn pri" onClick={confirm} disabled={busy}>{busy ? "Running…" : "Run"}</button></div>
      </div>
      {guard && <GuardDialog connName={conn.name} prod={conn.prod} risks={guard} onRun={exec} onCancel={() => setGuard(null)} />}
    </div>
  );
  return { ask: (title: string, sql: string[]) => { setError(null); setPending({ title, sql }); }, dialog };
}

// The structure tab of a table: columns, indexes, triggers and the CREATE statement, with the
// common ALTER operations. Every statement is shown before it runs.
export function StructureView({ table, conn, readOnly, onChanged, onToast }: { table: Table; conn: TabConn; readOnly: boolean; onChanged: () => void; onToast: (m: string) => void }) {
  const [s, setS] = useState<Structure | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [inline, setInline] = useState<{ col: string; field: "name" | "type" | "default"; value: string } | null>(null);
  const ref = { schema: table.schema, name: table.name };
  const e = conn.engine;
  const load = () => api.tableStructure(conn.id, table.schema, table.name).then((x) => { setS(x); setError(null); }, (err) => setError(errText(err)));
  useEffect(() => { load(); }, [conn.id, table.schema, table.name, table.columns.length]);
  const runner = useDdlRunner(conn, (m) => { onToast(m); load(); onChanged(); });
  const editable = !readOnly && table.kind !== "view" && conn.connected;
  const why = table.kind === "view" ? "Views can't be altered here." : readOnly ? "This connection is read-only." : "";
  const dflt = (c: string) => s?.defaults.find((d) => d.name === c)?.def ?? "";

  const submit = () => {
    if (!form) return;
    if (form.kind === "column") {
      if (!form.c.name.trim() || !form.c.type.trim()) return;
      if (!form.old) runner.ask(`Add column ${form.c.name}`, [addColumn(e, ref, form.c)]);
      else {
        const sql = changeColumn(e, ref, form.c, form.old);
        if (sql) runner.ask(`Change column ${form.c.name}`, sql);
      }
    } else if (form.kind === "rename-column") {
      if (form.to.trim() && form.to !== form.from) runner.ask(`Rename column ${form.from}`, [renameColumn(e, ref, form.from, form.to.trim())]);
    } else if (form.kind === "rename-table") {
      if (form.to.trim() && form.to !== table.name) runner.ask(`Rename table ${table.name}`, [renameTable(e, ref, form.to.trim())]);
    } else if (form.name.trim() && form.cols.length) {
      runner.ask(`Add index ${form.name}`, [addIndex(e, ref, form.name.trim(), form.cols, form.unique)]);
    }
    setForm(null);
  };

  return (
    <div className="structure">
      <div className="qtool">
        <button className="btn" disabled={!editable} title={why} onClick={() => setForm({ kind: "column", c: { name: "", type: TYPES[e][0], nullable: true, default: "" } })}><Icon name="columnAdd" />Column</button>
        <button className="btn" disabled={!editable} title={why} onClick={() => setForm({ kind: "index", name: `idx_${table.name}_`, cols: [], unique: false })}><Icon name="bolt" />Index</button>
        <button className="btn" disabled={!editable} title={why} onClick={() => setForm({ kind: "rename-table", to: table.name })}>Rename table</button>
        <span className="sp" />
        <button className="btn" onClick={load}><Icon name="refresh" />Refresh</button>
      </div>
      {error && <div className="tberr" role="alert">{error}</div>}
      <div className="stbody">
        <h4 className="sech">Columns <span className="ty">{!editable ? why : e === "sqlite" ? "double-click a name to rename it (SQLite can't change a column's type in place)" : "double-click a name, type, null or default to change it"}</span></h4>
        <datalist id={`types-${e}`}>{TYPES[e].map((t) => <option key={t} value={t} />)}</datalist>
        <table className="sttab">
          <thead><tr><th>Name</th><th>Type</th><th>Null</th><th>Default</th><th>Key</th><th /></tr></thead>
          <tbody>
            {table.columns.map((c) => {
              const old = { name: c.name, type: c.dataType, nullable: c.nullable, default: dflt(c.name) };
              // SQLite can rename a column but not change its type, null or default in place
              const alter = editable && e !== "sqlite";
              const change = (patch: Partial<ColSpec>, what: string) => {
                const sql = changeColumn(e, ref, { ...old, ...patch }, old);
                if (sql) runner.ask(`${what} ${c.name}`, sql);
              };
              const cell = (field: "name" | "type" | "default", value: string, on: boolean, mono = true) => (
                <td className={`${mono ? "mono" : ""}${on ? " ed" : ""}${field === "default" ? " ty" : ""}`} title={on ? `Double-click to change the ${field}` : undefined}
                  onDoubleClick={() => on && setInline({ col: c.name, field, value })}>
                  {inline?.col === c.name && inline.field === field ? (
                    <InlineEdit value={inline.value} list={field === "type" ? `types-${e}` : undefined} onCancel={() => setInline(null)}
                      onDone={(v) => {
                        setInline(null);
                        if (v === value || (field !== "default" && !v.trim())) return;
                        if (field === "name") runner.ask(`Rename column ${c.name}`, [renameColumn(e, ref, c.name, v.trim())]);
                        else if (field === "type") change({ type: v.trim() }, "Change type of");
                        else change({ default: v }, "Change default of");
                      }} />
                  ) : value}
                </td>
              );
              return (
                <tr key={c.name}>
                  {cell("name", c.name, editable)}
                  {cell("type", c.dataType, alter)}
                  <td className={alter ? "ed" : ""} title={alter ? `Double-click to make it ${c.nullable ? "NOT NULL" : "nullable"}` : undefined}
                    onDoubleClick={() => alter && change({ nullable: !c.nullable }, c.nullable ? "Make NOT NULL:" : "Allow NULL in")}>{c.nullable ? "yes" : "no"}</td>
                  {cell("default", old.default, alter)}
                  <td>{c.pk ? <span className="kb">PK</span> : null}{c.fk ? <span className="kb fk" title={`references ${c.fk}`}>FK → {c.fk}</span> : null}</td>
                  <td className="stacts">
                    {editable && <button className="linkbtn err" onClick={() => runner.ask(`Drop column ${c.name}`, [dropColumn(e, ref, c.name)])}>Drop</button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <h4 className="sech">Indexes</h4>
        {!s ? <p className="ty">Loading…</p> : s.indexes.length === 0 ? <p className="ty">No indexes.</p> : (
          <table className="sttab"><tbody>
            {s.indexes.map((i) => (
              <tr key={i.name}><td className="mono">{i.name}{i.unique && <span className="kb">UNIQUE</span>}</td><td className="mono ty">{i.def}</td>
                <td className="stacts">{editable && !i.name.startsWith("sqlite_autoindex") && <button className="linkbtn err" onClick={() => runner.ask(`Drop index ${i.name}`, [dropIndex(e, ref, i.name)])}>Drop</button>}</td></tr>
            ))}
          </tbody></table>
        )}
        <h4 className="sech">Triggers</h4>
        {!s ? <p className="ty">Loading…</p> : s.triggers.length === 0 ? <p className="ty">No triggers.</p> : (
          <table className="sttab"><tbody>{s.triggers.map((t) => <tr key={t.name}><td className="mono">{t.name}</td><td className="mono ty">{t.def}</td></tr>)}</tbody></table>
        )}
        <h4 className="sech">CREATE statement <button className="linkbtn" disabled={!s} onClick={() => s && navigator.clipboard.writeText(s.ddl).then(() => onToast("Copied the CREATE statement"), () => onToast("Clipboard is not available"))}>Copy</button></h4>
        <pre className="sqlprev stddl">{s?.ddl ?? "…"}</pre>
      </div>

      {form && (
        <div className="scrim" onMouseDown={(ev) => ev.target === ev.currentTarget && setForm(null)}>
          <div className="modal small" role="dialog" aria-modal="true" aria-labelledby="stf-title" onKeyDown={(ev) => { if (ev.key === "Escape") setForm(null); if (ev.key === "Enter" && (ev.target as HTMLElement).tagName === "INPUT") submit(); }}>
            <h3 id="stf-title">{form.kind === "column" ? (form.old ? `Change ${form.old.name}` : "Add column") : form.kind === "index" ? "Add index" : form.kind === "rename-table" ? "Rename table" : `Rename ${form.from}`}</h3>
            {form.kind === "column" && <ColumnFields engine={e} c={form.c} lockName={!!form.old} onChange={(c) => setForm({ ...form, c })} />}
            {(form.kind === "rename-column" || form.kind === "rename-table") && (
              <div className="f"><label htmlFor="stf-to">New name</label><input id="stf-to" autoFocus value={form.to} onChange={(ev) => setForm({ ...form, to: ev.target.value })} /></div>
            )}
            {form.kind === "index" && (
              <>
                <div className="f"><label htmlFor="stf-ix">Name</label><input id="stf-ix" autoFocus value={form.name} onChange={(ev) => setForm({ ...form, name: ev.target.value })} /></div>
                <div className="checks">
                  <span className="ty">Columns, in order of ticking</span>
                  {table.columns.map((c) => (
                    <label key={c.name} className="check"><input type="checkbox" checked={form.cols.includes(c.name)} onChange={(ev) => setForm({ ...form, cols: ev.target.checked ? [...form.cols, c.name] : form.cols.filter((x) => x !== c.name) })} /> {c.name}
                      {form.cols.includes(c.name) && <span className="ty">{form.cols.indexOf(c.name) + 1}</span>}</label>
                  ))}
                  <label className="check"><input type="checkbox" checked={form.unique} onChange={(ev) => setForm({ ...form, unique: ev.target.checked })} /> Unique</label>
                </div>
              </>
            )}
            <div className="acts"><button className="btn" onClick={() => setForm(null)}>Cancel</button><button className="btn pri" onClick={submit}>Review SQL…</button></div>
          </div>
        </div>
      )}
      {runner.dialog}
    </div>
  );
}

function ColumnFields({ engine, c, lockName, onChange }: { engine: TabConn["engine"]; c: ColSpec; lockName?: boolean; onChange: (c: ColSpec) => void }) {
  return (
    <>
      <div className="f"><label htmlFor="cf-name">Name</label><input id="cf-name" autoFocus={!lockName} disabled={lockName} value={c.name} onChange={(e) => onChange({ ...c, name: e.target.value })} /></div>
      <div className="f"><label htmlFor="cf-type">Type</label><input id="cf-type" list="cf-types" value={c.type} onChange={(e) => onChange({ ...c, type: e.target.value })} autoFocus={lockName} />
        <datalist id="cf-types">{TYPES[engine].map((t) => <option key={t} value={t} />)}</datalist></div>
      <div className="f"><label htmlFor="cf-def">Default (SQL, optional)</label><input id="cf-def" value={c.default} placeholder="e.g. 0, 'new', now()" onChange={(e) => onChange({ ...c, default: e.target.value })} /></div>
      <label className="check"><input type="checkbox" checked={c.nullable} onChange={(e) => onChange({ ...c, nullable: e.target.checked })} /> Allow NULL</label>
    </>
  );
}

/** New table: a row per column, then CREATE TABLE after review. */
export function NewTableDialog({ conn, schemas, onClose, onCreated }: { conn: TabConn; schemas: string[]; onClose: () => void; onCreated: (schema: string, name: string) => void }) {
  const e = conn.engine;
  const [schema, setSchema] = useState(schemas.includes("public") ? "public" : schemas[0] ?? "");
  const [name, setName] = useState("");
  const [cols, setCols] = useState<ColSpec[]>([
    { name: "id", type: e === "postgres" ? "bigserial" : e === "mysql" ? "bigint AUTO_INCREMENT" : "INTEGER", nullable: false, default: "", pk: true },
    { name: "", type: TYPES[e][e === "sqlite" ? 2 : 7] ?? "text", nullable: true, default: "" },
  ]);
  const runner = useDdlRunner(conn, () => { onCreated(schema, name.trim()); onClose(); });
  const set = (i: number, c: Partial<ColSpec>) => setCols(cols.map((x, j) => (j === i ? { ...x, ...c } : x)));
  const ok = name.trim() && cols.some((c) => c.name.trim() && c.type.trim());
  return (
    <div className="scrim" onMouseDown={(ev) => ev.target === ev.currentTarget && onClose()}>
      <div className="modal wide" role="dialog" aria-modal="true" aria-labelledby="nt-title" onKeyDown={(ev) => { if (ev.key === "Escape") onClose(); }}>
        <h3 id="nt-title">New table on {conn.name}</h3>
        <div className="frow">
          {e !== "sqlite" && schemas.length > 1 && (
            <select value={schema} onChange={(ev) => setSchema(ev.target.value)} aria-label="Schema" style={{ width: 160 }}>{schemas.map((x) => <option key={x}>{x}</option>)}</select>
          )}
          <input autoFocus placeholder="Table name" value={name} onChange={(ev) => setName(ev.target.value)} aria-label="Table name" style={{ flex: 1, width: "auto" }} />
        </div>
        <table className="sttab ntcols">
          <thead><tr><th>Column</th><th>Type</th><th>Default</th><th>NULL</th><th>PK</th><th /></tr></thead>
          <tbody>
            {cols.map((c, i) => (
              <tr key={i}>
                <td><input value={c.name} onChange={(ev) => set(i, { name: ev.target.value })} aria-label="Column name" /></td>
                <td><input list="nt-types" value={c.type} onChange={(ev) => set(i, { type: ev.target.value })} aria-label="Type" /></td>
                <td><input value={c.default} placeholder="SQL" onChange={(ev) => set(i, { default: ev.target.value })} aria-label="Default" /></td>
                <td><input type="checkbox" checked={c.nullable && !c.pk} disabled={c.pk} onChange={(ev) => set(i, { nullable: ev.target.checked })} aria-label="Allow NULL" /></td>
                <td><input type="checkbox" checked={!!c.pk} onChange={(ev) => set(i, { pk: ev.target.checked })} aria-label="Primary key" /></td>
                <td><button className="ibtn" aria-label="Remove column" onClick={() => setCols(cols.filter((_, j) => j !== i))}>×</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <datalist id="nt-types">{TYPES[e].map((t) => <option key={t} value={t} />)}</datalist>
        <button className="btn" onClick={() => setCols([...cols, { name: "", type: TYPES[e][e === "sqlite" ? 2 : 7] ?? "text", nullable: true, default: "" }])}>+ Column</button>
        <div className="acts"><button className="btn" onClick={onClose}>Cancel</button><button className="btn pri" disabled={!ok} onClick={() => runner.ask(`Create table ${name.trim()}`, [createTable(e, { schema, name: name.trim() }, cols)])}>Review SQL…</button></div>
        {runner.dialog}
      </div>
    </div>
  );
}

// A cell's text box for a double-click edit: Enter keeps it, Esc or clicking away cancels.
function InlineEdit({ value, list, onDone, onCancel }: { value: string; list?: string; onDone: (v: string) => void; onCancel: () => void }) {
  const [v, setV] = useState(value);
  return (
    <input className="stin" autoFocus value={v} list={list} spellCheck={false} aria-label="New value" onFocus={(ev) => ev.currentTarget.select()}
      onChange={(ev) => setV(ev.target.value)} onBlur={onCancel}
      onKeyDown={(ev) => { if (ev.key === "Enter") { ev.preventDefault(); onDone(v); } else if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); onCancel(); } }} />
  );
}
