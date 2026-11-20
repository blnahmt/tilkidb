import { useMemo, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { api, ENGINES, errText, type ConnConfig, type Table } from "../lib/api";
import { diffSchemas, migration, type TableDiff } from "../lib/schemadiff";

const MARK = { added: "+", removed: "−", changed: "~" } as const;

// Compare the connected database with another saved connection and write the migration SQL.
// The other connection is opened just long enough to read its schema.
export function DiffView({ connections, active, connected, tables, onToast }: {
  connections: ConnConfig[];
  active: ConnConfig | null;
  connected: boolean;
  tables: Table[];
  onToast: (m: string) => void;
}) {
  const others = connections.filter((c) => c.id !== active?.id);
  const [otherId, setOtherId] = useState(others[0]?.id ?? "");
  const [other, setOther] = useState<{ id: string; tables: Table[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reverse, setReverse] = useState(false); // false: change the other DB to match this one
  const [drops, setDrops] = useState(false);
  const otherCfg = connections.find((c) => c.id === other?.id) ?? null;

  const compare = async () => {
    if (!otherId) return;
    setBusy(true);
    setError(null);
    try {
      await api.connect(otherId);
      try { setOther({ id: otherId, tables: await api.listSchema(otherId) }); }
      finally { await api.disconnect(otherId); }
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const [src, dst] = reverse ? [otherCfg, active] : [active, otherCfg];
  const diffs = useMemo(() => (other ? (reverse ? diffSchemas(other.tables, tables) : diffSchemas(tables, other.tables)) : []), [other, tables, reverse]);
  const sql = useMemo(() => {
    if (!other || !dst) return "";
    const body = migration(diffs, dst.engine, drops, "", reverse ? other.tables : tables);
    return `-- Makes ${dst.name} match ${src?.name ?? "the source"} (Tilki DB schema diff)\n-- Review before running on ${dst.name}. Indexes, defaults and triggers are not compared.\n\n${body || "-- No differences."}\n`;
  }, [diffs, drops, other, src, dst]);
  const cross = !!(src && dst && src.engine !== dst.engine);

  const saveSql = async () => {
    const path = await save({ title: "Save migration", defaultPath: `migrate-${(dst?.name ?? "db").replace(/[^\w.-]+/g, "_")}.sql`, filters: [{ name: "SQL script", extensions: ["sql"] }] });
    if (path) api.writeText(path, sql).then(() => onToast(`Saved ${path}`), (e) => onToast(errText(e)));
  };

  if (!active || !connected) return <div className="rempty">Connect to a database to compare its schema with another connection.</div>;

  return (
    <div className="diffpane">
      <div className="qtool">
        <span className="ty">Compare</span><b className="dname">{active.name}</b><span className="ty">with</span>
        <select value={otherId} onChange={(e) => setOtherId(e.target.value)} aria-label="Connection to compare with" className="dsel">
          {others.length === 0 && <option value="">No other saved connections</option>}
          {others.map((c) => <option key={c.id} value={c.id}>{c.name} · {ENGINES[c.engine].label}</option>)}
        </select>
        <button className="btn pri" onClick={compare} disabled={!otherId || busy}>{busy ? "Reading…" : other ? "Compare again" : "Compare"}</button>
        {other && otherCfg && (
          <div className="seg">
            <button className={reverse ? "" : "on"} aria-pressed={!reverse} onClick={() => setReverse(false)}>Change {otherCfg.name}</button>
            <button className={reverse ? "on" : ""} aria-pressed={reverse} onClick={() => setReverse(true)}>Change {active.name}</button>
          </div>
        )}
      </div>
      {error && <p className="testres err dpad">{error}</p>}
      {!other && !error && <div className="rempty">Pick a connection and press Compare. Nothing is changed: the SQL is only shown.</div>}
      {other && src && dst && (
        <div className="dsplit">
          <div className="dlist">
            <div className="dsum">
              {diffs.length === 0 ? "The schemas match." : `${diffs.filter((d) => d.kind === "added").length} to create · ${diffs.filter((d) => d.kind === "changed").length} to change · ${diffs.filter((d) => d.kind === "removed").length} only in ${dst.name}`}
            </div>
            {cross && <p className="note dpad">{src.name} is {ENGINES[src.engine].label} and {dst.name} is {ENGINES[dst.engine].label}: type names differ between engines, so expect type changes that aren't real.</p>}
            {diffs.map((d) => <DiffRow key={`${d.kind}-${d.name}`} d={d} dst={dst.name} />)}
          </div>
          <div className="dsql">
            <div className="qtool">
              <span className="ty">Migration for {dst.name} ({ENGINES[dst.engine].label})</span>
              <span className="sp" />
              <label className="check small"><input type="checkbox" checked={drops} onChange={(e) => setDrops(e.target.checked)} /> Include DROP statements</label>
              <button className="btn" onClick={() => navigator.clipboard.writeText(sql).then(() => onToast("Copied the migration SQL"), () => onToast("Clipboard is not available"))}>Copy</button>
              <button className="btn" onClick={saveSql}>Save .sql…</button>
            </div>
            <pre className="sqlprev dcode">{sql}</pre>
          </div>
        </div>
      )}
    </div>
  );
}

function DiffRow({ d, dst }: { d: TableDiff; dst: string }) {
  const what = d.kind === "added" ? `create in ${dst}` : d.kind === "removed" ? `only in ${dst}` : `${d.cols.length} column${d.cols.length === 1 ? "" : "s"}`;
  return (
    <div className={`drow ${d.kind}`}>
      <div className="dhead"><span className="dmark">{MARK[d.kind]}</span><b>{d.name}</b>{d.view && <span className="ty">view</span>}<span className="ty dwhat">{what}</span></div>
      {d.cols.map((c) => (
        <div key={c.name} className={`dcol ${c.kind}`}>
          <span className="dmark">{MARK[c.kind]}</span>{c.name}
          <span className="ty">
            {c.kind === "added" ? c.source!.dataType : c.kind === "removed" ? c.target!.dataType
              : c.what.map((w) => w === "type" ? `${c.target!.dataType} → ${c.source!.dataType}` : w === "null" ? (c.source!.nullable ? "allow NULL" : "NOT NULL") : w === "pk" ? "primary key" : "foreign key").join(" · ")}
          </span>
        </div>
      ))}
    </div>
  );
}
