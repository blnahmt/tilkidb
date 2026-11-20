import { useCallback, useEffect, useMemo, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { api, desktop, errText, type Cell, type DumpOptions, type Engine, type ImportFormat, type ImportPreview, type JobProgress, type Table } from "../lib/api";
import { tkey } from "../lib/erd";
import type { Risk } from "../lib/sql";
import { GuardDialog } from "./GuardDialog";
import { Icon } from "./Icons";

// Database tools in the sidebar: SQL dump, .sql restore, CSV/JSON import. Each runs as a job in
// Rust with progress events; jobs live in App so they survive switching sidebar views.

type Kind = "dump" | "restore" | "import";
export interface Job {
  id: string;
  kind: Kind;
  title: string;
  detail: string; // file path
  state: "running" | "done" | "error" | "cancelled";
  p?: JobProgress;
  message?: string;
  errors?: string[];
}
type Outcome = { message: string; cancelled: boolean; errors?: string[] };
export type Jobs = ReturnType<typeof useJobs>;

export function useJobs(onToast: (m: string) => void, onChanged: () => void) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const patch = useCallback((id: string, p: Partial<Job>) => setJobs((js) => js.map((j) => (j.id === id ? { ...j, ...p } : j))), []);
  const start = useCallback((kind: Kind, title: string, detail: string, run: (id: string, onProgress: (p: JobProgress) => void) => Promise<Outcome>) => {
    const id = crypto.randomUUID();
    setJobs((js) => [{ id, kind, title, detail, state: "running" }, ...js]);
    run(id, (p) => patch(id, { p })).then(
      (r) => { patch(id, { state: r.cancelled ? "cancelled" : "done", message: r.message, errors: r.errors }); onToast(`${title}: ${r.message}`); if (kind !== "dump" && !r.cancelled) onChanged(); },
      (e) => { patch(id, { state: "error", message: errText(e) }); onToast(`${title} failed`); },
    );
  }, [patch, onToast, onChanged]);
  return { jobs, start, cancel: (id: string) => api.cancelQuery(id), clear: () => setJobs((js) => js.filter((j) => j.state === "running")) };
}

const dur = (ms: number) => (ms < 1000 ? `${ms} ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`);
const size = (b: number) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`);
const base = (p: string) => p.split(/[\\/]/).pop() ?? p;
const today = () => new Date().toISOString().slice(0, 10);

function useEscape(onClose: () => void) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [onClose]);
}

export type ToolConn = { id: string; name: string; engine: Engine; prod: boolean; readOnly: boolean; connected: boolean };

export function ToolsPanel({ jobs, conn, tables, onDiff, onActivity, onOpen }: { jobs: Jobs; conn: ToolConn | null; tables: Table[]; onDiff: () => void; onActivity: () => void; onOpen: (kind: "datadiff" | "copy" | "users") => void }) {
  const [dialog, setDialog] = useState<Kind | null>(null);
  const [guard, setGuard] = useState<{ risks: Risk[]; run: () => void } | null>(null);
  const close = useCallback(() => setDialog(null), []);
  const ready = !!conn?.connected && desktop;
  const writeBlocked = conn?.readOnly ? "This connection is read-only." : "";
  // writes to a production connection need the typed confirmation, like risky SQL does
  const guarded = (what: string, statement: string, run: () => void) => {
    setDialog(null);
    if (conn?.prod) setGuard({ risks: [{ reason: what, statement, severe: true }], run: () => { setGuard(null); run(); } });
    else run();
  };

  const tools: [Kind, string, string, string][] = [
    ["dump", "Dump to SQL", "Schema and data as a .sql file", ""],
    ["restore", "Restore a .sql file", "Run a script against this database", writeBlocked],
    ["import", "Import CSV or JSON", "Load rows from a file into a table", writeBlocked],
  ];
  const finished = jobs.jobs.some((j) => j.state !== "running");

  return (
    <div className="tools">
      {!conn?.connected && <p className="empty-side">Connect to a database to dump, restore or import.</p>}
      {conn?.connected && !desktop && <p className="empty-side">Database tools need the desktop app.</p>}
      <div className="tlist-tools">
        {tools.map(([k, title, desc, blocked]) => (
          <button key={k} className="tbtn" disabled={!ready || !!blocked} title={blocked} onClick={() => setDialog(k)}>
            <b>{title}</b><span>{blocked || desc}</span>
          </button>
        ))}
        <button className="tbtn" disabled={!conn?.connected} onClick={onActivity}><b>Server activity</b><span>Sessions, running queries, locks, table sizes</span></button>
        <button className="tbtn" disabled={!conn?.connected} onClick={onDiff}><b>Compare schemas</b><span>Diff with another connection, get migration SQL</span></button>
        <button className="tbtn" disabled={!conn?.connected} onClick={() => onOpen("datadiff")}><b>Compare data</b><span>Rows of a table against another connection, with sync SQL</span></button>
        <button className="tbtn" disabled={!conn?.connected} onClick={() => onOpen("copy")}><b>Copy tables</b><span>Structure and rows to another connection, any engine</span></button>
        <button className="tbtn" disabled={!conn?.connected || conn?.engine === "sqlite"} onClick={() => onOpen("users")}><b>Users and roles</b><span>Accounts, privileges, passwords</span></button>
      </div>
      <div className="shead sub"><span>Jobs</span>{finished && <button className="lnk" onClick={jobs.clear}>Clear finished</button>}</div>
      <div className="jobs">
        {jobs.jobs.length === 0 && <p className="empty-side">Dumps, restores and imports you start show up here with their progress.</p>}
        {jobs.jobs.map((j) => <JobRow key={j.id} j={j} onCancel={() => jobs.cancel(j.id)} />)}
      </div>

      {dialog === "dump" && conn && <DumpDialog conn={conn} tables={tables} onClose={close} onStart={(path, opts) => {
        setDialog(null);
        jobs.start("dump", `Dump ${conn.name}`, path, async (id, on) => {
          const s = await api.dumpDb(conn.id, id, path, opts, on);
          return { cancelled: s.cancelled, message: s.cancelled ? "Cancelled. The partial file was removed." : `${s.tables} tables, ${s.rows.toLocaleString()} rows, ${size(s.bytes)} in ${dur(s.ms)}` };
        });
      }} />}
      {dialog === "restore" && conn && <RestoreDialog conn={conn} onClose={close} onStart={(path, singleTx, stop) => guarded(
        `Runs every statement in ${base(path)} against this database.`, `-- ${path}`,
        () => jobs.start("restore", `Restore ${base(path)}`, path, async (id, on) => {
          const s = await api.restoreFile(conn.id, id, path, singleTx, stop, on);
          if (s.cancelled) return { cancelled: true, message: singleTx ? "Cancelled. Nothing was saved." : `Cancelled after ${s.statements.toLocaleString()} statements.` };
          return { cancelled: false, errors: s.errors, message: `${s.statements.toLocaleString()} statements in ${dur(s.ms)}${s.failed ? `, ${s.failed.toLocaleString()} failed` : ""}` };
        }),
      )} />}
      {dialog === "import" && conn && <ImportDialog conn={conn} tables={tables} onClose={close} onStart={(opts) => guarded(
        `Inserts rows from ${base(opts.source.path)} into ${opts.table}${opts.truncateFirst ? ", deleting every existing row first" : ""}.`,
        `${opts.truncateFirst ? `DELETE FROM ${opts.table};\n` : ""}INSERT INTO ${opts.table} (${opts.mapping.filter(Boolean).join(", ")}) VALUES …`,
        () => jobs.start("import", `Import into ${opts.table}`, opts.source.path, async (id, on) => {
          const s = await api.importFile(conn.id, id, opts, on);
          return { cancelled: s.cancelled, message: s.cancelled ? "Cancelled. Nothing was imported." : `${s.rows.toLocaleString()} rows in ${dur(s.ms)}` };
        }),
      )} />}
      {guard && conn && <GuardDialog connName={conn.name} prod={conn.prod} risks={guard.risks} onRun={guard.run} onCancel={() => setGuard(null)} />}
    </div>
  );
}

function JobRow({ j, onCancel }: { j: Job; onCancel: () => void }) {
  const p = j.p;
  const pct = p && p.total > 0 ? Math.min(100, (p.done / p.total) * 100) : null;
  const status = j.state !== "running" ? j.message
    : !p ? "Starting…"
    : j.kind === "dump" ? (p.done < p.total ? `Table ${p.done + 1} of ${p.total} · ${p.label}` : "Finishing…")
    : j.kind === "restore" ? `${p.done.toLocaleString()} of ${p.total.toLocaleString()} statements`
    : `${p.done.toLocaleString()} rows`;
  return (
    <div className={`job ${j.state}`}>
      <div className="jhead">
        <b>{j.title}</b>
        {j.state === "running" ? <button className="lnk" onClick={onCancel}>Cancel</button> : <span className="jst">{j.state === "done" ? "Done" : j.state === "error" ? "Failed" : "Cancelled"}</span>}
      </div>
      <code title={j.detail}>{j.detail}</code>
      {j.state === "running" && <div className={`jbar${pct === null ? " busy" : ""}`}><i style={pct === null ? undefined : { width: `${pct}%` }} /></div>}
      <small className={j.state === "error" ? "err" : undefined}>{status}</small>
      {!!j.errors?.length && (
        <details><summary>{j.errors.length === 50 ? "First 50 errors" : `${j.errors.length} errors`}</summary>{j.errors.map((e, i) => <p key={i}>{e}</p>)}</details>
      )}
    </div>
  );
}

function TableChecklist({ tables, sel, setSel }: { tables: Table[]; sel: Set<string>; setSel: (s: Set<string>) => void }) {
  const [filter, setFilter] = useState("");
  const multiSchema = new Set(tables.map((t) => t.schema)).size > 1;
  const shown = tables.filter((t) => `${t.schema}.${t.name}`.toLowerCase().includes(filter.toLowerCase()));
  const all = shown.every((t) => sel.has(tkey(t)));
  return (
    <>
      <div className="frow">
        <input placeholder="Filter tables" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter tables" style={{ flex: 1, minWidth: 0, width: "auto" }} />
        <button className="btn" onClick={() => { const s = new Set(sel); shown.forEach((t) => (all ? s.delete(tkey(t)) : s.add(tkey(t)))); setSel(s); }}>{all ? "None" : "All"}</button>
      </div>
      <div className="tcheck">
        {shown.map((t) => (
          <label key={tkey(t)} className="check">
            <input type="checkbox" checked={sel.has(tkey(t))} onChange={(e) => { const s = new Set(sel); if (e.target.checked) s.add(tkey(t)); else s.delete(tkey(t)); setSel(s); }} />
            <Icon name={t.kind === "view" ? "view" : "table"} /> {multiSchema ? `${t.schema}.${t.name}` : t.name}
            <span className="ty">{t.kind === "view" ? "view" : t.rows != null ? `${t.rows.toLocaleString()} rows` : ""}</span>
          </label>
        ))}
        {shown.length === 0 && <p className="note">No tables match.</p>}
      </div>
    </>
  );
}

const check = (label: string, value: boolean, set: (v: boolean) => void, disabled = false) => (
  <label className="check"><input type="checkbox" checked={value} disabled={disabled} onChange={(e) => set(e.target.checked)} /> {label}</label>
);

function DumpDialog({ conn, tables, onClose, onStart }: { conn: ToolConn; tables: Table[]; onClose: () => void; onStart: (path: string, o: DumpOptions) => void }) {
  useEscape(onClose);
  const [sel, setSel] = useState(() => new Set(tables.map(tkey)));
  const [o, setO] = useState({ schema: true, data: true, drop: true, ifNotExists: false, singleTransaction: true, batch: 500 });
  const set = <K extends keyof typeof o>(k: K) => (v: (typeof o)[K]) => setO((x) => ({ ...x, [k]: v }));
  const picked = tables.filter((t) => sel.has(tkey(t)));
  const go = async () => {
    const path = await save({ title: "Dump to", defaultPath: `${conn.name.replace(/[^\w.-]+/g, "_")}-${today()}.sql`, filters: [{ name: "SQL script", extensions: ["sql"] }] });
    if (path) onStart(path, { ...o, batch: Math.max(1, o.batch), tables: picked.map((t) => ({ schema: t.schema, name: t.name })) });
  };
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide" role="dialog" aria-modal="true" aria-labelledby="dp-title">
        <h3 id="dp-title">Dump {conn.name} to SQL</h3>
        <p className="note">A plain .sql script you can restore here or with the database's own tools.</p>
        <div className="xgrid">
          <div>
            <h4 className="sech">Tables <span className="ty">{picked.length} of {tables.length}</span></h4>
            <TableChecklist tables={tables} sel={sel} setSel={setSel} />
          </div>
          <div>
            <h4 className="sech">Include</h4>
            <div className="checks">
              {check("Schema (CREATE statements)", o.schema, set("schema"), !o.data)}
              {check("Data (INSERT statements)", o.data, set("data"), !o.schema)}
            </div>
            <h4 className="sech">Options</h4>
            <div className="checks">
              {check("DROP each table before creating it", o.drop, set("drop"), !o.schema)}
              {check("CREATE … IF NOT EXISTS", o.ifNotExists, set("ifNotExists"), !o.schema)}
              {check("Wrap in one transaction", o.singleTransaction, set("singleTransaction"))}
              <div className="frow"><span className="ty">Rows per INSERT</span><input type="number" min={1} value={o.batch} onChange={(e) => set("batch")(Number(e.target.value))} aria-label="Rows per INSERT" style={{ width: 90 }} /></div>
            </div>
            {conn.engine === "postgres" && <p className="note">Tables, constraints, indexes, sequences and views. For functions, triggers and types use pg_dump.</p>}
            {conn.engine === "mysql" && <p className="note">Tables and views. For routines and triggers use mysqldump.</p>}
          </div>
        </div>
        <div className="acts">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn pri" onClick={go} disabled={!picked.length}>Dump…</button>
        </div>
      </div>
    </div>
  );
}

function FilePick({ path, label, onPick }: { path: string | null; label: string; onPick: () => void }) {
  return (
    <div className="frow">
      <input readOnly value={path ?? ""} placeholder="No file chosen" aria-label={label} onClick={onPick} style={{ flex: 1, minWidth: 0, width: "auto" }} />
      <button className="btn" onClick={onPick}><Icon name="folder" /> Choose…</button>
    </div>
  );
}

function RestoreDialog({ conn, onClose, onStart }: { conn: ToolConn; onClose: () => void; onStart: (path: string, singleTx: boolean, stopOnError: boolean) => void }) {
  useEscape(onClose);
  const [path, setPath] = useState<string | null>(null);
  const [tx, setTx] = useState(true);
  const [stop, setStop] = useState(true);
  const pick = async () => {
    const p = await open({ title: "Restore from", multiple: false, filters: [{ name: "SQL script", extensions: ["sql"] }, { name: "All files", extensions: ["*"] }] });
    if (typeof p === "string") setPath(p);
  };
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal small" role="dialog" aria-modal="true" aria-labelledby="rs-title">
        <h3 id="rs-title">Restore into {conn.name}</h3>
        <p className="note">Runs a .sql script statement by statement, up to 512 MB.</p>
        <h4 className="sech">File</h4>
        <FilePick path={path} label="Script file" onPick={pick} />
        <h4 className="sech">If a statement fails</h4>
        <div className="checks">
          <label className="check"><input type="radio" name="rsmode" checked={tx} onChange={() => setTx(true)} /> Undo everything (one transaction)</label>
          <label className="check"><input type="radio" name="rsmode" checked={!tx} onChange={() => setTx(false)} /> Keep what ran before it</label>
          {!tx && <div style={{ paddingLeft: 22 }}>{check("Stop at the first error (otherwise skip it and go on)", stop, setStop)}</div>}
        </div>
        {tx && conn.engine === "mysql" && <p className="note">MySQL commits CREATE, DROP and ALTER on its own, so those can't be undone.</p>}
        <div className="acts">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn pri" disabled={!path} onClick={() => path && onStart(path, tx, tx || stop)}>Restore</button>
        </div>
      </div>
    </div>
  );
}

const formatOf = (p: string): ImportFormat => {
  const ext = p.split(".").pop()?.toLowerCase();
  return ext === "json" ? "json" : ext === "jsonl" || ext === "ndjson" ? "jsonl" : ext === "tsv" || ext === "tab" ? "tsv" : "csv";
};
const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, "");
/** Match file columns to table columns by name, ignoring case, spaces and underscores. */
export const autoMap = (fileCols: string[], tableCols: string[]) => fileCols.map((f) => tableCols.find((c) => norm(c) === norm(f)) ?? null);
const sample = (rows: Cell[][], i: number) => rows.slice(0, 3).map((r) => (r[i] == null ? "NULL" : typeof r[i] === "object" ? JSON.stringify(r[i]) : String(r[i]))).join(" · ");

function ImportDialog({ conn, tables, onClose, onStart }: { conn: ToolConn; tables: Table[]; onClose: () => void; onStart: (o: Parameters<typeof api.importFile>[2]) => void }) {
  useEscape(onClose);
  const targets = useMemo(() => tables.filter((t) => t.kind === "table"), [tables]);
  const [path, setPath] = useState<string | null>(null);
  const [format, setFormat] = useState<ImportFormat>("csv");
  const [header, setHeader] = useState(true);
  const [delimiter, setDelimiter] = useState(""); // "" = detect
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [target, setTarget] = useState(targets[0] ? tkey(targets[0]) : "");
  const [mapping, setMapping] = useState<(string | null)[]>([]);
  const [emptyAsNull, setEmptyAsNull] = useState(true);
  const [truncate, setTruncate] = useState(false);
  const table = targets.find((t) => tkey(t) === target) ?? null;
  const multiSchema = new Set(targets.map((t) => t.schema)).size > 1;

  const pick = async () => {
    const p = await open({ title: "Import from", multiple: false, filters: [{ name: "Data files", extensions: ["csv", "tsv", "txt", "json", "jsonl", "ndjson"] }, { name: "All files", extensions: ["*"] }] });
    if (typeof p !== "string") return;
    setPath(p);
    setFormat(formatOf(p));
    const stem = norm(base(p).replace(/\.[^.]+$/, ""));
    const match = targets.find((t) => norm(t.name) === stem);
    if (match) setTarget(tkey(match));
  };
  useEffect(() => {
    if (!path) return;
    let live = true;
    setErr(null);
    api.previewImport({ path, format, delimiter: delimiter || null, header }).then((pv) => { if (live) setPreview(pv); }, (e) => { if (live) { setPreview(null); setErr(errText(e)); } });
    return () => { live = false; };
  }, [path, format, delimiter, header]);
  useEffect(() => { if (preview && table) setMapping(autoMap(preview.columns, table.columns.map((c) => c.name))); }, [preview, table]);

  const mapped = mapping.filter(Boolean).length;
  const dupes = mapping.filter((m, i) => m && mapping.indexOf(m) !== i);
  const go = () => {
    if (!path || !table || !preview) return;
    onStart({ source: { path, format, delimiter: delimiter || null, header }, schema: table.schema, table: table.name, mapping, emptyAsNull, truncateFirst: truncate });
  };
  const csv = format === "csv" || format === "tsv";

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide" role="dialog" aria-modal="true" aria-labelledby="im-title">
        <h3 id="im-title">Import into {conn.name}</h3>
        <p className="note">CSV, TSV, a JSON array of objects, or JSON Lines. Everything goes in one transaction: if a row fails, nothing is imported.</p>
        <div className="xgrid">
          <div>
            <h4 className="sech">File</h4>
            <FilePick path={path} label="Data file" onPick={pick} />
            <div className="frow" style={{ marginTop: 8 }}>
              <div className="seg">
                {(["csv", "tsv", "json", "jsonl"] as ImportFormat[]).map((f) => <button key={f} className={format === f ? "on" : ""} aria-pressed={format === f} onClick={() => setFormat(f)}>{f === "jsonl" ? "JSON Lines" : f.toUpperCase()}</button>)}
              </div>
            </div>
            {csv && (
              <div className="checks" style={{ marginTop: 8 }}>
                {check("First row has column names", header, setHeader)}
                {format === "csv" && (
                  <div className="frow"><span className="ty">Delimiter</span>
                    <select value={delimiter} onChange={(e) => setDelimiter(e.target.value)} aria-label="Delimiter" style={{ width: 170 }}>
                      <option value="">Detect{preview?.delimiter && !delimiter ? ` (${preview.delimiter === "\t" ? "tab" : preview.delimiter})` : ""}</option>
                      <option value=",">Comma ,</option><option value=";">Semicolon ;</option><option value={"\t"}>Tab</option><option value="|">Pipe |</option>
                    </select>
                  </div>
                )}
              </div>
            )}
          </div>
          <div>
            <h4 className="sech">Into table</h4>
            <select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Target table">
              {targets.map((t) => <option key={tkey(t)} value={tkey(t)}>{multiSchema ? `${t.schema}.${t.name}` : t.name}</option>)}
            </select>
            <div className="checks" style={{ marginTop: 8 }}>
              {check("Empty values become NULL", emptyAsNull, setEmptyAsNull)}
              {check("Delete every existing row first", truncate, setTruncate)}
            </div>
          </div>
        </div>

        {err && <p className="testres err">{err}</p>}
        {preview && table && (
          <>
            <h4 className="sech">Columns <span className="ty">{mapped} of {preview.columns.length} mapped · samples from the first rows</span></h4>
            <div className="mapgrid">
              <div className="mh">File column</div><div className="mh">Sample</div><div className="mh">Table column</div>
              {preview.columns.map((c, i) => (
                <div key={i} className="mrow">
                  <div className="mc">{c}</div>
                  <div className="ms" title={sample(preview.rows, i)}>{sample(preview.rows, i) || <span className="ty">empty</span>}</div>
                  <select value={mapping[i] ?? ""} aria-label={`Target for ${c}`} onChange={(e) => setMapping((m) => m.map((x, j) => (j === i ? e.target.value || null : x)))}>
                    <option value="">Skip</option>
                    {table.columns.map((tc) => <option key={tc.name} value={tc.name}>{tc.name} · {tc.dataType}</option>)}
                  </select>
                </div>
              ))}
            </div>
            {dupes.length > 0 && <p className="testres err">{dupes[0]} is mapped twice.</p>}
            {preview.rows.length === 0 && <p className="note">The file has no data rows.</p>}
          </>
        )}
        {!targets.length && <p className="testres err">This database has no tables to import into.</p>}
        <div className="acts">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn pri" disabled={!preview || !table || !mapped || dupes.length > 0} onClick={go}>Import</button>
        </div>
      </div>
    </div>
  );
}
