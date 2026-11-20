import { useRef, useState } from "react";
import { api, collect, errText, type ConnConfig, type Table } from "../lib/api";
import { literal, qualified, quoteIdent } from "../lib/sqlgen";
import { copyTableDdl, readExpr, writeLiteral } from "../lib/typemap";
import { GuardDialog } from "./GuardDialog";
import { Icon } from "./Icons";

const PAGE = 1000, BATCH = 200; // rows read per query / rows per INSERT

type Line = { table: string; text: string; kind: "ok" | "err" | "warn" };

// Copy tables (structure and rows) from the connected database to another connection, any engine
// to any engine. Rows go in batches, each its own transaction.
export function CopyTable({ connections, active, connected, tables, onToast }: {
  connections: ConnConfig[];
  active: ConnConfig | null;
  connected: boolean;
  tables: Table[];
  onToast: (m: string) => void;
}) {
  const own = tables.filter((t) => t.kind === "table");
  const others = connections.filter((c) => c.id !== active?.id);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [find, setFind] = useState("");
  const [targetId, setTargetId] = useState(others[0]?.id ?? "");
  const [schema, setSchema] = useState("");
  const [create, setCreate] = useState(true);
  const [empty, setEmpty] = useState(false);
  const [log, setLog] = useState<Line[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number; label: string } | null>(null);
  const [guard, setGuard] = useState(false);
  const stop = useRef(false);
  // only ever another connection: if the title bar switches to the target, there is none until you pick again
  const target = others.find((c) => c.id === targetId) ?? null;
  const key = (t: Table) => `${t.schema}.${t.name}`;
  const shown = own.filter((t) => t.name.toLowerCase().includes(find.toLowerCase()));

  const start = async (confirmed = false) => {
    if (!active || !target || !picked.size || target.id === active.id) return;
    const names = own.filter((t) => picked.has(key(t))).map((t) => t.name.toLowerCase());
    const twice = names.find((n, i) => names.indexOf(n) !== i);
    if (twice) { setLog([{ table: twice, text: "Two picked tables have this name (in different schemas); they would land in the same target table. Copy them one at a time.", kind: "err" }]); return; }
    if (target.prod && !confirmed) { setGuard(true); return; }
    setGuard(false);
    stop.current = false;
    const out: Line[] = [];
    const say = (l: Line) => { out.push(l); setLog([...out]); };
    setLog([]);
    const list = own.filter((t) => picked.has(key(t)));
    setProgress({ done: 0, total: list.length, label: "Connecting…" });
    try {
      await api.connect(target.id);
      try {
        const theirs = await api.listSchema(target.id);
        const te = target.engine;
        for (const [i, t] of list.entries()) {
          if (stop.current) { say({ table: t.name, text: "Stopped before this table.", kind: "warn" }); break; }
          setProgress({ done: i, total: list.length, label: t.name });
          const ref = { schema: schema.trim() || (te === "postgres" ? "public" : te === "sqlite" ? "main" : target.database), name: t.name };
          try {
            let dest = theirs.find((x) => x.name.toLowerCase() === t.name.toLowerCase() && x.schema.toLowerCase() === ref.schema.toLowerCase());
            if (!dest) {
              if (!create) { say({ table: t.name, text: `Skipped: ${target.name} has no ${t.name} table.`, kind: "warn" }); continue; }
              await api.applyChanges(target.id, [{ sql: copyTableDdl(t, active.engine, te, ref.schema), expectOne: false }]);
              dest = t;
              say({ table: t.name, text: "Created the table (foreign keys and indexes are not copied).", kind: "ok" });
            } else if (empty) {
              await api.applyChanges(target.id, [{ sql: `DELETE FROM ${qualified(te, ref)}`, expectOne: false }]);
            }
            const cols = t.columns.map((c) => c.name).filter((n) => dest!.columns.some((c) => c.name.toLowerCase() === n.toLowerCase()));
            // a stable order for paging: the key, or else every column that can be sorted
            const hasKey = t.columns.some((x) => x.pk);
            const sortable = t.columns.filter((c) => (hasKey ? c.pk : !/json|\[\]|blob|bytea|binary|geometry/i.test(c.dataType)));
            const pk = sortable.map((c) => quoteIdent(active.engine, c.name));
            const into = `INSERT INTO ${qualified(te, ref)} (${cols.map((c) => quoteIdent(te, c)).join(", ")})${te === "postgres" ? " OVERRIDING SYSTEM VALUE" : ""} VALUES`;
            const types = cols.map((n) => t.columns.find((c) => c.name === n)!.dataType);
            let copied = 0;
            for (let off = 0; !stop.current; off += PAGE) {
              const page = await collect(active.id, `SELECT ${cols.map((c, k) => readExpr(active.engine, c, types[k])).join(", ")} FROM ${qualified(active.engine, t)}${pk.length ? ` ORDER BY ${pk.join(", ")}` : ""} LIMIT ${PAGE} OFFSET ${off}`, PAGE);
              const batches = [];
              for (let k = 0; k < page.rows.length; k += BATCH) {
                batches.push({ sql: `${into}\n${page.rows.slice(k, k + BATCH).map((r) => `(${r.map((v, k) => writeLiteral(te, v, types[k], active.engine)).join(", ")})`).join(",\n")}`, expectOne: false });
              }
              if (batches.length) await api.applyChanges(target.id, batches);
              copied += page.rows.length;
              setProgress({ done: i, total: list.length, label: `${t.name}: ${copied.toLocaleString()} rows` });
              if (page.rows.length < PAGE) break;
            }
            // identity / serial keys continue after the copied ids
            const pkCol = t.columns.filter((c) => c.pk);
            if (te === "postgres" && pkCol.length === 1 && copied > 0) {
              const tq = qualified(te, ref), c = quoteIdent(te, pkCol[0].name);
              await collect(target.id, `SELECT setval(s, (SELECT max(${c}) FROM ${tq})) FROM pg_get_serial_sequence(${literal(te, tq)}, ${literal(te, pkCol[0].name)}) s WHERE s IS NOT NULL`, 1).catch(() => {});
            }
            say({ table: t.name, text: `${stop.current ? "Stopped after" : "Copied"} ${copied.toLocaleString()} row${copied === 1 ? "" : "s"}.`, kind: stop.current ? "warn" : "ok" });
          } catch (e) {
            say({ table: t.name, text: errText(e), kind: "err" });
          }
        }
      } finally {
        await api.disconnect(target.id);
      }
      onToast(`Copy to ${target.name} finished`);
    } catch (e) {
      say({ table: "", text: errText(e), kind: "err" });
    } finally {
      setProgress(null);
    }
  };

  if (!active || !connected) return <div className="rempty">Connect to a database to copy its tables to another connection.</div>;
  if (!others.length) return <div className="rempty">Add a second connection to copy tables to it.</div>;
  return (
    <div className="diffpane copypane">
      <div className="qtool">
        <span className="ty">Copy from</span><b>{active.name}</b><span className="ty">to</span>
        <select value={target ? targetId : ""} onChange={(e) => setTargetId(e.target.value)} aria-label="Target connection" disabled={!!progress}>
          {!target && <option value="" disabled>Pick a connection…</option>}
          {others.map((c) =><option key={c.id} value={c.id}>{c.name}{c.prod ? " (production)" : ""}</option>)}
        </select>
        {target?.engine !== "sqlite" && <input className="fv" value={schema} onChange={(e) => setSchema(e.target.value)} placeholder={target?.engine === "postgres" ? "schema (public)" : "database (default)"} aria-label="Target schema" spellCheck={false} disabled={!!progress} />}
        <label className="check small"><input type="checkbox" checked={create} onChange={(e) => setCreate(e.target.checked)} disabled={!!progress} /> Create missing tables</label>
        <label className="check small" title="DELETE FROM each existing target table first"><input type="checkbox" checked={empty} onChange={(e) => setEmpty(e.target.checked)} disabled={!!progress} /> Empty target tables first</label>
        <span className="sp" />
        {progress ? <button className="btn danger" onClick={() => { stop.current = true; }}><Icon name="stop" />Stop</button>
          : <button className="btn pri" onClick={() => start()} disabled={!picked.size || !target || target.readOnly}><Icon name="copy" />Copy {picked.size || ""} table{picked.size === 1 ? "" : "s"}</button>}
      </div>
      <div className="copybody">
        <div className="copylist">
          <div className="frow"><input value={find} onChange={(e) => setFind(e.target.value)} placeholder="Filter tables" aria-label="Filter tables" spellCheck={false} />
            <button className="btn" onClick={() => setPicked(new Set(shown.map(key)))}>All</button><button className="btn" onClick={() => setPicked(new Set())}>None</button></div>
          {shown.map((t) => (
            <label key={key(t)} className="check"><input type="checkbox" checked={picked.has(key(t))} disabled={!!progress}
              onChange={(e) => setPicked((p) => { const n = new Set(p); if (e.target.checked) n.add(key(t)); else n.delete(key(t)); return n; })} />
              {t.name}{t.rows != null && <span className="ty">{t.rows.toLocaleString()}</span>}</label>
          ))}
        </div>
        <div className="msgs copylog">
          {progress && <div className="m"><span className="ok">{progress.label} · table {progress.done + 1} of {progress.total}</span></div>}
          {!log.length && !progress && <span className="ty">Rows are read {PAGE.toLocaleString()} at a time and inserted in batches of {BATCH}; each batch is its own transaction, so a stopped copy keeps what it wrote. Types are converted to the closest match on the target engine.</span>}
          {log.map((l, i) => <div key={i} className="m"><b>{l.table}</b><span className={l.kind}>{l.text}</span></div>)}
        </div>
      </div>
      {guard && target && <GuardDialog connName={target.name} prod risks={own.filter((t) => picked.has(key(t))).map((t) => ({ statement: `copy ${t.name}`, reason: "Writes to a production connection.", severe: empty }))} onCancel={() => setGuard(false)} onRun={() => start(true)} />}
    </div>
  );
}
