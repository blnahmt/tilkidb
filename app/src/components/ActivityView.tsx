import { useEffect, useRef, useState } from "react";
import { api, errText, type Cell } from "../lib/api";
import { GuardDialog } from "./GuardDialog";
import type { TabConn } from "./QueryTab";

const SESSIONS = {
  postgres: `SELECT pid, usename, datname, coalesce(client_addr::text, 'local') AS client, state,
    coalesce(wait_event_type || ': ' || wait_event, '') AS waiting, coalesce(EXTRACT(EPOCH FROM now() - query_start)::bigint, 0) AS secs,
    array_to_string(pg_blocking_pids(pid), ', ') AS blocked_by, query
    FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND backend_type = 'client backend' ORDER BY state = 'active' DESC, query_start`,
  mysql: `SELECT id, user, db, host, command, coalesce(state, '') AS state, time AS secs, coalesce(info, '') AS query
    FROM information_schema.processlist WHERE id <> CONNECTION_ID() ORDER BY command <> 'Sleep' DESC, time DESC`,
};
const SIZES = {
  postgres: `SELECT n.nspname AS schema, c.relname AS name, pg_total_relation_size(c.oid) AS bytes, greatest(c.reltuples, 0)::bigint AS approx_rows
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r','m','p') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' ORDER BY 3 DESC LIMIT 100`,
  mysql: `SELECT table_schema AS \`schema\`, table_name AS name, coalesce(data_length + index_length, 0) AS bytes, coalesce(table_rows, 0) AS approx_rows
    FROM information_schema.tables WHERE table_schema NOT IN ('mysql','sys','performance_schema','information_schema') AND table_type = 'BASE TABLE' ORDER BY 3 DESC LIMIT 100`,
  sqlite: `SELECT 'main' AS schema, 'whole database file' AS name, page_count * page_size AS bytes, NULL AS approx_rows FROM pragma_page_count(), pragma_page_size()`,
};
const size = (b: number) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : b < 1073741824 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1073741824).toFixed(2)} GB`);
const dur = (s: number) => (s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`);

// Who is connected and what they run, what's blocked, and which tables are big. Stopping a
// query or a session asks first (typed confirmation on production connections).
export function ActivityView({ conn, onToast }: { conn: TabConn | null; onToast: (m: string) => void }) {
  const [view, setView] = useState<"sessions" | "sizes">(conn?.engine === "sqlite" ? "sizes" : "sessions");
  const [rows, setRows] = useState<{ cols: string[]; rows: Cell[][] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [auto, setAuto] = useState(true);
  const [armed, setArmed] = useState<string | null>(null); // "<kind>:<id>" waiting for the second click
  const [guard, setGuard] = useState<{ sql: string; label: string } | null>(null);
  const busy = useRef(false);

  const load = async () => {
    if (!conn?.connected || busy.current) return;
    if (view === "sessions" && conn.engine === "sqlite") { setRows(null); return; }
    busy.current = true;
    const sql = view === "sessions" ? SESSIONS[conn.engine as "postgres" | "mysql"] : SIZES[conn.engine];
    let cols: string[] = [];
    const got: Cell[][] = [];
    try {
      await api.runQuery(conn.id, crypto.randomUUID(), sql, 1000, (e) => { if (e.event === "columns") cols = e.columns.map((c) => c.name); else if (e.event === "rows") got.push(...e.rows); });
      setRows({ cols, rows: got });
      setError(null);
    } catch (e) { setError(errText(e)); } finally { busy.current = false; }
  };
  useEffect(() => { setRows(null); load(); }, [conn?.id, conn?.connected, view]);
  useEffect(() => {
    if (!auto || view !== "sessions") return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [auto, view, conn?.id, conn?.connected]);

  const stop = async (sql: string, label: string) => {
    if (!conn) return;
    setGuard(null); setArmed(null);
    try { await api.runQuery(conn.id, crypto.randomUUID(), sql, 1, () => {}); onToast(label); setTimeout(load, 300); }
    catch (e) { onToast(errText(e)); }
  };
  const ask = (key: string, sql: string, label: string) => {
    if (conn?.prod) { setGuard({ sql, label }); return; }
    if (armed === key) stop(sql, label); else setArmed(key);
  };

  if (!conn?.connected) return <div className="rempty">Connect to a database to see its activity.</div>;
  const pg = conn.engine === "postgres";
  const col = (r: Cell[], name: string) => (rows ? r[rows.cols.indexOf(name)] : null);

  return (
    <div className="activity">
      <div className="qtool">
        <div className="seg">
          <button className={view === "sessions" ? "on" : ""} aria-pressed={view === "sessions"} onClick={() => setView("sessions")} disabled={conn.engine === "sqlite"}>Sessions</button>
          <button className={view === "sizes" ? "on" : ""} aria-pressed={view === "sizes"} onClick={() => setView("sizes")}>Table sizes</button>
        </div>
        {view === "sessions" && <label className="check small"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Refresh every 3 s</label>}
        <span className="sp" />
        <span className="ty">{rows ? `${rows.rows.length} ${view === "sessions" ? "other sessions" : "tables"}` : ""}</span>
        <button className="btn" onClick={load}>Refresh</button>
      </div>
      {error && <div className="tberr" role="alert">{error}</div>}
      <div className="stbody">
        {view === "sessions" && conn.engine === "sqlite" && <p className="ty">SQLite is a file, not a server: there are no sessions to show.</p>}
        {view === "sessions" && rows && (
          <table className="sttab acttab">
            <thead><tr>{pg ? <><th>PID</th><th>User</th><th>Database</th><th>Client</th><th>State</th><th>Waiting</th><th>Blocked by</th></> : <><th>ID</th><th>User</th><th>Database</th><th>Host</th><th>Command</th><th>State</th></>}<th>Time</th><th>Query</th><th /></tr></thead>
            <tbody>
              {rows.rows.map((r) => {
                const id = String(col(r, pg ? "pid" : "id"));
                const secs = Number(col(r, "secs") ?? 0);
                const active = pg ? col(r, "state") === "active" : col(r, "command") !== "Sleep";
                const blocked = pg && String(col(r, "blocked_by") ?? "") !== "";
                return (
                  <tr key={id} className={blocked ? "blocked" : active && secs > 30 ? "slow" : ""}>
                    <td className="mono">{id}</td>
                    {(pg ? ["usename", "datname", "client", "state", "waiting", "blocked_by"] : ["user", "db", "host", "command", "state"]).map((k) => <td key={k} className={k === "blocked_by" ? "mono err" : ""}>{String(col(r, k) ?? "")}</td>)}
                    <td className="mono">{active ? dur(secs) : ""}</td>
                    <td className="mono actq" title={String(col(r, "query") ?? "")}>{String(col(r, "query") ?? "")}</td>
                    <td className="stacts">
                      {active && <button className={`linkbtn${armed === `q:${id}` ? " err" : ""}`} onBlur={() => setArmed(null)}
                        onClick={() => ask(`q:${id}`, pg ? `SELECT pg_cancel_backend(${Number(id)})` : `KILL QUERY ${Number(id)}`, `Stopped the query of session ${id}`)}>{armed === `q:${id}` ? "Click to confirm" : "Stop query"}</button>}
                      <button className={`linkbtn err${armed === `s:${id}` ? " on" : ""}`} onBlur={() => setArmed(null)}
                        onClick={() => ask(`s:${id}`, pg ? `SELECT pg_terminate_backend(${Number(id)})` : `KILL ${Number(id)}`, `Disconnected session ${id}`)}>{armed === `s:${id}` ? "Click to confirm" : "Disconnect"}</button>
                    </td>
                  </tr>
                );
              })}
              {rows.rows.length === 0 && <tr><td colSpan={10} className="ty">No other sessions.</td></tr>}
            </tbody>
          </table>
        )}
        {view === "sizes" && rows && (
          <table className="sttab acttab">
            <thead><tr><th>Schema</th><th>Table</th><th>Size</th><th>Rows (approx.)</th><th style={{ width: "30%" }} /></tr></thead>
            <tbody>
              {rows.rows.map((r, i) => {
                const b = Number(col(r, "bytes") ?? 0), max = Number(rows.rows[0] ? col(rows.rows[0], "bytes") : 1) || 1;
                return (
                  <tr key={i}><td className="ty">{String(col(r, "schema"))}</td><td className="mono">{String(col(r, "name"))}</td><td className="mono">{size(b)}</td>
                    <td className="mono">{col(r, "approx_rows") == null ? "" : Number(col(r, "approx_rows")).toLocaleString()}</td>
                    <td><div className="szbar"><i style={{ width: `${Math.max(1, (b / max) * 100)}%` }} /></div></td></tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {guard && <GuardDialog connName={conn.name} prod={conn.prod} risks={[{ statement: guard.sql, reason: "Stops work of another session on a production server.", severe: true }]} onRun={() => stop(guard.sql, guard.label)} onCancel={() => setGuard(null)} />}
    </div>
  );
}
