import { useEffect, useRef, useState } from "react";
import { api, collect, errText, type Cell, type ColInfo, type Table } from "../lib/api";
import { literal, qualified, quoteIdent } from "../lib/sqlgen";
import { GuardDialog } from "./GuardDialog";
import { ResultGrid } from "./ResultGrid";
import type { TabConn } from "./QueryTab";
import { Icon } from "./Icons";

type Account = { name: string; host: string; info: string };
type Action =
  | { kind: "create" }
  | { kind: "password"; who: Account }
  | { kind: "grant" | "revoke"; who: Account }
  | { kind: "drop"; who: Account };

const PRIVS = ["SELECT", "INSERT", "UPDATE", "DELETE", "ALL PRIVILEGES"];
const MASK = "••••••";

// Database users and roles: list them, see what they may do, and create / change / drop them
// through reviewed SQL. Statements here are not written to the query history (they hold passwords).
export function UsersView({ conn, tables, onToast }: { conn: TabConn | null; tables: Table[]; onToast: (m: string) => void }) {
  const engine = conn?.engine ?? "postgres";
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<Account | null>(null);
  const [grants, setGrants] = useState<{ columns: ColInfo[]; rows: Cell[][] } | null>(null);
  const [action, setAction] = useState<Action | null>(null);
  const who = (a: Account) => (engine === "mysql" ? `${literal(engine, a.name)}@${literal(engine, a.host)}` : quoteIdent(engine, a.name));

  const load = async () => {
    if (!conn?.connected || engine === "sqlite") return;
    setError(null);
    try {
      if (engine === "postgres") {
        const r = await collect(conn.id, `SELECT rolname, concat_ws(', ', CASE WHEN rolsuper THEN 'superuser' END, CASE WHEN rolcanlogin THEN 'can log in' ELSE 'role (no login)' END, CASE WHEN rolcreatedb THEN 'create databases' END, CASE WHEN rolcreaterole THEN 'create roles' END, CASE WHEN rolreplication THEN 'replication' END, (SELECT 'member of ' || string_agg(b.rolname, ', ') FROM pg_auth_members m JOIN pg_roles b ON b.oid = m.roleid WHERE m.member = r.oid)) FROM pg_roles r WHERE rolname !~ '^pg_' ORDER BY 1`, 5000);
        setAccounts(r.rows.map((x) => ({ name: String(x[0]), host: "", info: String(x[1] ?? "") })));
      } else {
        const r = await collect(conn.id, "SELECT user, host FROM mysql.user ORDER BY 1, 2", 5000);
        setAccounts(r.rows.map((x) => ({ name: String(x[0]), host: String(x[1]), info: "" })));
      }
    } catch (e) {
      setError(`${errText(e)}${engine === "mysql" ? "\nListing users needs SELECT on mysql.user." : ""}`);
    }
  };
  useEffect(() => { load(); setSel(null); setGrants(null); }, [conn?.id, conn?.connected]); // deps chosen on purpose

  const picking = useRef<Account | null>(null);
  const pick = async (a: Account) => {
    picking.current = a;
    setSel(a);
    setGrants(null);
    if (!conn) return;
    try {
      const sql = engine === "postgres"
        ? `SELECT table_schema AS schema, table_name AS "table", string_agg(privilege_type, ', ' ORDER BY privilege_type) AS privileges FROM information_schema.role_table_grants WHERE grantee = ${literal(engine, a.name)} GROUP BY 1, 2 ORDER BY 1, 2`
        : `SHOW GRANTS FOR ${who(a)}`;
      const got = await collect(conn.id, sql, 5000);
      if (picking.current === a) setGrants(got);
    } catch (e) { if (picking.current === a) setGrants({ columns: [{ name: "error", dataType: "text" }], rows: [[errText(e)]] }); }
  };

  if (!conn?.connected) return <div className="rempty">Connect to a database to see its users and roles.</div>;
  if (engine === "sqlite") return <div className="rempty">SQLite has no users or roles: access is whoever can open the file.</div>;
  return (
    <div className="diffpane">
      <div className="qtool">
        <b>{engine === "postgres" ? "Roles" : "Users"}</b><span className="ty">{accounts.length}</span>
        <button className="btn" onClick={load}><Icon name="refresh" />Refresh</button>
        <button className="btn" onClick={() => setAction({ kind: "create" })} disabled={conn.readOnly}><Icon name="plus" />New {engine === "postgres" ? "role" : "user"}…</button>
        <span className="sp" />
        {sel && <>
          <span className="ty">{sel.name}{sel.host ? `@${sel.host}` : ""}</span>
          <button className="btn" onClick={() => setAction({ kind: "password", who: sel })} disabled={conn.readOnly}><Icon name="edit" />Password…</button>
          <button className="btn" onClick={() => setAction({ kind: "grant", who: sel })} disabled={conn.readOnly}><Icon name="check" />Grant…</button>
          <button className="btn" onClick={() => setAction({ kind: "revoke", who: sel })} disabled={conn.readOnly}><Icon name="x" />Revoke…</button>
          <button className="btn danger" onClick={() => setAction({ kind: "drop", who: sel })} disabled={conn.readOnly}><Icon name="trash" />Drop…</button>
        </>}
      </div>
      {error && <div className="tberr" role="alert">{error}</div>}
      <div className="copybody">
        <div className="copylist userlist" role="listbox" aria-label="Users">
          {accounts.map((a) => (
            <button key={`${a.name}@${a.host}`} role="option" aria-selected={sel === a} className={`uitem${sel === a ? " on" : ""}`} onClick={() => pick(a)}>
              <b>{a.name}</b>{a.host && <span className="ty">@{a.host}</span>}{a.info && <span className="ty">{a.info}</span>}
            </button>
          ))}
        </div>
        <div className="resbody">
          {!sel ? <div className="rempty">Pick a {engine === "postgres" ? "role" : "user"} to see its privileges.</div>
            : !grants ? <div className="rempty">Reading privileges…</div>
            : grants.rows.length ? <ResultGrid columns={grants.columns} rows={grants.rows} /> : <div className="rempty">No table privileges.</div>}
        </div>
      </div>
      {action && <AccountDialog action={action} engine={engine} conn={conn} tables={tables} who={who}
        onClose={() => setAction(null)} onDone={(m) => { setAction(null); onToast(m); load(); if (sel && action.kind !== "drop") pick(sel); else setSel(null); }} />}
    </div>
  );
}

function AccountDialog({ action, engine, conn, tables, who, onClose, onDone }: {
  action: Action; engine: "postgres" | "mysql" | "sqlite"; conn: TabConn; tables: Table[]; who: (a: Account) => string;
  onClose: () => void; onDone: (m: string) => void;
}) {
  const [name, setName] = useState("");
  const [host, setHost] = useState("%");
  const [pw, setPw] = useState("");
  const [login, setLogin] = useState(true);
  const [flags, setFlags] = useState<Set<string>>(new Set());
  const [privs, setPrivs] = useState<Set<string>>(new Set(["SELECT"]));
  const [on, setOn] = useState("*");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [guard, setGuard] = useState(false);
  const schemas = [...new Set(tables.map((t) => t.schema))];
  const target = (show: boolean) => {
    const p = privs.has("ALL PRIVILEGES") ? "ALL PRIVILEGES" : [...privs].join(", ");
    const t = tables.find((x) => `${x.schema}.${x.name}` === on);
    const obj = engine === "postgres"
      ? (t ? `TABLE ${qualified(engine, t)}` : `ALL TABLES IN SCHEMA ${quoteIdent(engine, on === "*" ? schemas[0] ?? "public" : on.slice(2))}`)
      : (t ? `${quoteIdent(engine, t.schema)}.${quoteIdent(engine, t.name)}` : `${quoteIdent(engine, on === "*" ? schemas[0] ?? "" : on.slice(2))}.*`);
    const a = "who" in action ? action.who : null;
    const pass = show ? literal(engine, pw) : `'${MASK}'`;
    switch (action.kind) {
      case "create":
        return engine === "postgres"
          ? `CREATE ROLE ${quoteIdent(engine, name)} WITH ${login ? "LOGIN" : "NOLOGIN"}${[...flags].map((f) => ` ${f}`).join("")}${pw ? ` PASSWORD ${pass}` : ""}`
          : `CREATE USER ${literal(engine, name)}@${literal(engine, host)}${pw ? ` IDENTIFIED BY ${pass}` : ""}`;
      case "password":
        return engine === "postgres" ? `ALTER ROLE ${who(a!)} WITH PASSWORD ${pass}` : `ALTER USER ${who(a!)} IDENTIFIED BY ${pass}`;
      case "grant": return `GRANT ${p} ON ${obj} TO ${who(a!)}`;
      case "revoke": return `REVOKE ${p} ON ${obj} FROM ${who(a!)}`;
      case "drop": return engine === "postgres" ? `DROP ROLE ${who(a!)}` : `DROP USER ${who(a!)}`;
    }
  };
  const valid = action.kind === "create" ? !!name.trim() : action.kind === "password" ? !!pw : action.kind === "grant" || action.kind === "revoke" ? privs.size > 0 : true;
  const run = async (confirmed = false) => {
    if (conn.prod && !confirmed) { setGuard(true); return; }
    setGuard(false); setBusy(true); setError(null);
    try {
      // straight to the server, not through the history: the statement may hold a password
      await api.runQuery(conn.id, crypto.randomUUID(), target(true), 1, () => {});
      onDone(action.kind === "create" ? `Created ${name}` : action.kind === "drop" ? `Dropped ${action.who.name}` : "Done");
    } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  };
  const title = { create: engine === "postgres" ? "New role" : "New user", password: "Change password", grant: "Grant privileges", revoke: "Revoke privileges", drop: "Drop" }[action.kind];
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="ac-title" onKeyDown={(e) => { if (e.key === "Escape" && !busy) onClose(); }}>
        <h3 id="ac-title">{title}{"who" in action ? `: ${action.who.name}` : ""}</h3>
        {action.kind === "create" && <>
          <div className="f"><label htmlFor="ac-name">Name</label><input id="ac-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} autoComplete="off" /></div>
          {engine === "mysql" && <div className="f"><label htmlFor="ac-host">Host</label><input id="ac-host" value={host} onChange={(e) => setHost(e.target.value)} spellCheck={false} /><span className="ty">% = any host</span></div>}
          {engine === "postgres" && <div className="frow">
            <label className="check"><input type="checkbox" checked={login} onChange={(e) => setLogin(e.target.checked)} /> Can log in</label>
            {["CREATEDB", "CREATEROLE", "SUPERUSER"].map((f) => <label key={f} className="check"><input type="checkbox" checked={flags.has(f)} onChange={(e) => setFlags((s) => { const n = new Set(s); if (e.target.checked) n.add(f); else n.delete(f); return n; })} /> {f.toLowerCase()}</label>)}
          </div>}
        </>}
        {(action.kind === "create" || action.kind === "password") && <div className="f"><label htmlFor="ac-pw">Password</label><input id="ac-pw" type="password" autoFocus={action.kind === "password"} value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" /></div>}
        {(action.kind === "grant" || action.kind === "revoke") && <>
          <div className="frow">{PRIVS.map((p) => <label key={p} className="check"><input type="checkbox" checked={privs.has(p)} onChange={(e) => setPrivs((s) => { const n = new Set(s); if (e.target.checked) n.add(p); else n.delete(p); return n; })} /> {p}</label>)}</div>
          <div className="f"><label htmlFor="ac-on">On</label>
            <select id="ac-on" value={on} onChange={(e) => setOn(e.target.value)}>
              {schemas.map((s) => <option key={s} value={s === schemas[0] ? "*" : `*.${s}`}>All tables in {s}</option>)}
              {tables.filter((t) => t.kind === "table").map((t) => <option key={`${t.schema}.${t.name}`} value={`${t.schema}.${t.name}`}>{t.schema}.{t.name}</option>)}
            </select></div>
        </>}
        {action.kind === "drop" && <p className="note">Removes {action.who.name}{action.who.host ? `@${action.who.host}` : ""}. {engine === "postgres" ? "It fails while the role still owns objects or holds privileges." : "Its privileges go with it."}</p>}
        <pre className="sqlprev">{valid ? `${target(false)};` : "-- fill in the fields above"}</pre>
        {error && <p className="note err">{error}</p>}
        <div className="acts"><button className="btn" onClick={onClose} disabled={busy}>Cancel</button><button className={`btn ${action.kind === "drop" ? "danger" : "pri"}`} onClick={() => run()} disabled={!valid || busy}>{busy ? "Running…" : "Run"}</button></div>
      </div>
      {guard && <GuardDialog connName={conn.name} prod risks={[{ statement: target(false), reason: "Changes accounts on a production server.", severe: action.kind === "drop" }]} onCancel={() => setGuard(false)} onRun={() => run(true)} />}
    </div>
  );
}
