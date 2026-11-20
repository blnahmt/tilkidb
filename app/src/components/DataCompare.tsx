import { useMemo, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { api, collect, errText, type Cell, type ColInfo, type ConnConfig, type Table } from "../lib/api";
import { diffRows, kindOf, syncSql, type RowDiff } from "../lib/datadiff";
import { qualified, quoteIdent } from "../lib/sqlgen";
import { readExpr, writeLiteral } from "../lib/typemap";
import { GuardDialog } from "./GuardDialog";
import { cellText, ResultGrid } from "./ResultGrid";
import { Icon } from "./Icons";

const CAP = 200_000; // rows read from each side

type Result = { cols: ColInfo[]; key: number[]; diff: RowDiff; target: { connId: string; table: Table }; missing: string[]; truncated: boolean };

// Compare the rows of a table here with a table on another connection (or another table here),
// matched by primary key, and write the SQL that makes the target match.
export function DataCompare({ connections, active, connected, tables, onToast }: {
  connections: ConnConfig[];
  active: ConnConfig | null;
  connected: boolean;
  tables: Table[];
  onToast: (m: string) => void;
}) {
  const own = tables.filter((t) => t.kind === "table");
  const [srcKey, setSrcKey] = useState(own[0] ? `${own[0].schema}.${own[0].name}` : "");
  const [otherId, setOtherId] = useState(connections.find((c) => c.id !== active?.id)?.id ?? active?.id ?? "");
  const [targetName, setTargetName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [res, setRes] = useState<Result | null>(null);
  const [view, setView] = useState<"changed" | "added" | "removed">("changed");
  const [deletes, setDeletes] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const src = own.find((t) => `${t.schema}.${t.name}` === srcKey) ?? null;
  const other = connections.find((c) => c.id === otherId) ?? null;
  const same = otherId === active?.id;

  const compare = async () => {
    if (!src || !other || !active) return;
    setBusy(true); setError(null); setRes(null);
    try {
      if (!same) await api.connect(other.id);
      try {
        const theirs = same ? tables : await api.listSchema(other.id);
        const want = (targetName.trim() || src.name).toLowerCase();
        const tgt = theirs.find((t) => t.name.toLowerCase() === want && (same ? `${t.schema}.${t.name}` !== srcKey : true));
        if (!tgt) throw new Error(`${other.name} has no table named ${targetName.trim() || src.name}.`);
        const pk = src.columns.filter((c) => c.pk).map((c) => c.name);
        const cols = src.columns.map((c) => c.name).filter((n) => tgt.columns.some((c) => c.name === n));
        const missing = src.columns.map((c) => c.name).filter((n) => !cols.includes(n));
        if (pk.some((k) => !cols.includes(k))) throw new Error("The target table is missing a primary key column, so rows can't be matched.");
        const typeOf = (n: string) => src.columns.find((c) => c.name === n)!.dataType;
        const sel = (engine: ConnConfig["engine"], t: Table) => `SELECT ${cols.map((c) => readExpr(engine, c, (t === src ? src : t).columns.find((x) => x.name === c)?.dataType ?? typeOf(c))).join(", ")} FROM ${qualified(engine, t)}${pk.length ? ` ORDER BY ${pk.map((c) => quoteIdent(engine, c)).join(", ")}` : ""}`;
        const [a, b] = await Promise.all([collect(active.id, sel(active.engine, src), CAP), collect(other.id, sel(other.engine, tgt), CAP)]);
        const key = pk.map((k) => cols.indexOf(k));
        setRes({ cols: a.columns, key, diff: diffRows(a.rows, b.rows, key, cols.map((c) => kindOf(typeOf(c)))), target: { connId: other.id, table: tgt }, missing, truncated: a.truncated || b.truncated });
        setView(pk.length ? "changed" : "added");
      } finally {
        if (!same) await api.disconnect(other.id);
      }
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const sql = useMemo(() => {
    if (!res || !other || !active) return [];
    if (res.truncated) return []; // rows past the cap would look missing: no sync from a partial read
    const types = res.cols.map((c) => src?.columns.find((x) => x.name === c.name)?.dataType ?? c.dataType);
    return syncSql(other.engine, res.target.table, res.cols.map((c) => c.name), res.key, res.diff, deletes, (v, i) => writeLiteral(other.engine, v, types[i], active.engine));
  }, [res, other, deletes, active, src]);
  const apply = async () => {
    if (!res || !other) return;
    setConfirm(false); setBusy(true);
    try {
      if (!same) await api.connect(other.id);
      try {
        const n = await api.applyChanges(other.id, sql.map((s) => ({ sql: s.replace(/;$/, ""), expectOne: !s.startsWith("INSERT") })));
        onToast(`${other.name}: ${n.toLocaleString()} row${n === 1 ? "" : "s"} changed`);
        setRes(null);
      } finally { if (!same) await api.disconnect(other.id); }
    } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  };
  const saveSql = async () => {
    const path = await save({ title: "Save sync script", defaultPath: `sync-${res?.target.table.name ?? "table"}.sql`, filters: [{ name: "SQL script", extensions: ["sql"] }] });
    if (path) api.writeText(path, `${sql.join("\n")}\n`).then(() => onToast(`Saved ${path}`), (e) => onToast(errText(e)));
  };

  if (!active || !connected) return <div className="rempty">Connect to a database to compare a table's rows with another connection.</div>;
  const d = res?.diff;
  const rows: Cell[][] = !d ? [] : view === "added" ? d.added : view === "removed" ? d.removed
    : d.changed.map((c) => c.to.map((v, i) => (c.cols.includes(i) ? `${cellText(c.from[i])} → ${cellText(v)}` : v)));

  return (
    <div className="diffpane">
      <div className="qtool">
        <span className="ty">Table</span>
        <select value={srcKey} onChange={(e) => { setSrcKey(e.target.value); setRes(null); }} aria-label="Source table">
          {own.map((t) => <option key={`${t.schema}.${t.name}`} value={`${t.schema}.${t.name}`}>{t.name}</option>)}
        </select>
        <span className="ty">in {active.name} with</span>
        <select value={otherId} onChange={(e) => { setOtherId(e.target.value); setRes(null); }} aria-label="Target connection">
          {connections.map((c) => <option key={c.id} value={c.id}>{c.id === active.id ? `${c.name} (this connection)` : c.name}</option>)}
        </select>
        <input className="fv" value={targetName} onChange={(e) => setTargetName(e.target.value)} placeholder={same ? "other table name" : src?.name ?? "table"} aria-label="Target table" spellCheck={false} />
        <button className="btn pri" onClick={compare} disabled={busy || !src || !other || (same && !targetName.trim())}><Icon name="diff" />{busy ? "Comparing…" : "Compare rows"}</button>
        <span className="sp" />
        {src && !src.columns.some((c) => c.pk) && <span className="ty">No primary key: rows are matched whole</span>}
      </div>
      {error && <div className="tberr" role="alert">{error}</div>}
      {!res ? <div className="rempty">{busy ? "Reading both tables…" : `Pick a table and a connection. Rows are matched by primary key (up to ${CAP.toLocaleString()} per side).`}</div> : (
        <>
          <div className="rhead">
            {res.key.length > 0 && <button className={`rt${view === "changed" ? " on" : ""}`} onClick={() => setView("changed")}>Changed <span className="ct">{d!.changed.length.toLocaleString()}</span></button>}
            <button className={`rt${view === "added" ? " on" : ""}`} onClick={() => setView("added")}>Missing in target <span className="ct">{d!.added.length.toLocaleString()}</span></button>
            <button className={`rt${view === "removed" ? " on" : ""}`} onClick={() => setView("removed")}>Only in target <span className="ct">{d!.removed.length.toLocaleString()}</span></button>
            <span className="sp" />
            <span className="ty">{d!.same.toLocaleString()} identical{res.truncated ? ` · stopped at ${CAP.toLocaleString()} rows` : ""}{res.missing.length ? ` · not in target: ${res.missing.join(", ")}` : ""}</span>
          </div>
          <div className="resbody">{rows.length ? <ResultGrid columns={res.cols} rows={rows} /> : <div className="rempty">Nothing here.</div>}</div>
          <div className="tray">
            <b>{sql.length.toLocaleString()} statement{sql.length === 1 ? "" : "s"}</b>
            <span className="ty">{res.truncated ? `More than ${CAP.toLocaleString()} rows on a side: no sync SQL from a partial comparison. Compare smaller tables, or copy the table instead.` : `make ${other?.name}.${res.target.table.name} match ${src?.name}`}</span>
            <label className="check small"><input type="checkbox" checked={deletes} onChange={(e) => setDeletes(e.target.checked)} disabled={!res.key.length} /> Delete rows only in the target</label>
            <span className="sp" />
            <button className="btn" onClick={() => navigator.clipboard.writeText(sql.join("\n")).then(() => onToast("Copied the sync SQL"), () => onToast("Clipboard is not available"))} disabled={!sql.length}><Icon name="copy" />Copy SQL</button>
            <button className="btn" onClick={saveSql} disabled={!sql.length}><Icon name="download" />Save SQL…</button>
            <button className="btn pri" onClick={() => setConfirm(true)} disabled={!sql.length || busy || other?.readOnly}><Icon name="check" />Apply to {other?.name}…</button>
          </div>
        </>
      )}
      {confirm && other && (
        other.prod ? <GuardDialog connName={other.name} prod risks={sql.slice(0, 50).map((s) => ({ statement: s.replace(/;$/, ""), reason: "Writes to a production connection.", severe: s.startsWith("DELETE") }))} onCancel={() => setConfirm(false)} onRun={apply} />
          : (
            <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && setConfirm(false)}>
              <div className="modal wide" role="dialog" aria-modal="true" aria-labelledby="dc-title">
                <h3 id="dc-title">Apply to {other.name}</h3>
                <p className="note">Runs in one transaction. If any UPDATE or DELETE doesn't match exactly one row, nothing is saved.</p>
                <pre className="sqlprev">{sql.slice(0, 200).join("\n")}{sql.length > 200 ? `\n-- … and ${(sql.length - 200).toLocaleString()} more` : ""}</pre>
                <div className="acts"><button className="btn" onClick={() => setConfirm(false)}>Cancel</button><button className="btn pri" onClick={apply}>Apply</button></div>
              </div>
            </div>
          )
      )}
    </div>
  );
}
