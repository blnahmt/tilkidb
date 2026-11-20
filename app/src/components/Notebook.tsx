import { useEffect, useRef, useState, type ReactNode } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import type { EditorView } from "@codemirror/view";
import { api, errText, type Cell, type ColInfo, type HistoryEntry, type Notebook, type NotebookCell, type Table } from "../lib/api";
import { newCell, toFile } from "../lib/notebook";
import { risks, type Risk } from "../lib/sql";
import { GuardDialog } from "./GuardDialog";
import { Markdown } from "./Markdown";
import type { TabConn } from "./QueryTab";
import { HEAD, ResultGrid, rowHeight } from "./ResultGrid";
import { SqlEditor } from "./SqlEditor";
import { Icon } from "./Icons";

const LIMIT = 1000; // rows per cell result

// A notebook: Markdown notes and SQL cells that run on the connected database. Edits are
// saved shortly after you stop typing; results stay on screen only.
export function NotebookView({ nb, conn, tables, onChange, onRan, onToast }: {
  nb: Notebook;
  conn: TabConn | null;
  tables: Table[];
  onChange: (nb: Notebook) => void;
  onRan: (e: HistoryEntry) => void;
  onToast: (m: string) => void;
}) {
  const [name, setName] = useState(nb.name);
  const [cells, setCells] = useState(nb.cells);
  const [guard, setGuard] = useState<{ risks: Risk[]; resolve: (ok: boolean) => void } | null>(null);
  const [runningAll, setRunningAll] = useState(false);
  const runners = useRef(new Map<string, () => Promise<boolean>>());
  const dirty = useRef(false);
  const latest = useRef({ nb, name, cells, onChange });
  latest.current = { nb, name, cells, onChange };

  const flush = () => {
    if (!dirty.current) return;
    dirty.current = false;
    const l = latest.current;
    l.onChange({ ...l.nb, name: l.name.trim() || "Untitled notebook", cells: l.cells, updated: Date.now() });
  };
  useEffect(() => { if (!dirty.current) return; const t = setTimeout(flush, 500); return () => clearTimeout(t); }, [name, cells]);
  useEffect(() => () => { flush(); api.endSession(nb.id); }, []); // closing the tab saves pending edits and ends its session
  useEffect(() => { if (!dirty.current) setName(nb.name); }, [nb.name]); // renamed from the sidebar

  // functional updates: two edits before a re-render (type, then add a cell) must not drop one
  const edit = (f: (cs: NotebookCell[]) => NotebookCell[]) => { dirty.current = true; setCells(f); };
  const insert = (at: number, kind: NotebookCell["kind"]) => edit((cs) => [...cs.slice(0, at), newCell(kind), ...cs.slice(at)]);
  const move = (i: number, d: -1 | 1) => edit((cs) => { const c = [...cs]; [c[i], c[i + d]] = [c[i + d], c[i]]; return c; });
  const setSrc = (id: string, src: string) => edit((cs) => cs.map((x) => (x.id === id ? { ...x, src } : x)));
  const confirm = (found: Risk[]) => new Promise<boolean>((resolve) => setGuard({ risks: found, resolve }));
  const runAll = async () => {
    setRunningAll(true);
    try {
      for (const c of latest.current.cells) {
        const run = c.kind === "sql" ? runners.current.get(c.id) : undefined;
        if (run && !(await run())) break; // stop at the first failing cell
      }
    } finally { setRunningAll(false); }
  };
  const exportFile = async () => {
    flush();
    const path = await save({ title: "Export notebook", defaultPath: `${name.replace(/[^\w.-]+/g, "_") || "notebook"}.tilkinb`, filters: [{ name: "Tilki DB notebook", extensions: ["tilkinb"] }] });
    if (path) api.writeText(path, toFile({ ...nb, name, cells })).then(() => onToast(`Exported to ${path}`), (e) => onToast(errText(e)));
  };

  const tools = (i: number) => (
    <span className="nbtools">
      <button className="ibtn" title="Move up" aria-label="Move cell up" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
      <button className="ibtn" title="Move down" aria-label="Move cell down" disabled={i === cells.length - 1} onClick={() => move(i, 1)}>↓</button>
      <button className="ibtn" title="Delete cell" aria-label="Delete cell" onClick={() => edit((cs) => cs.filter((_, j) => j !== i))}>×</button>
    </span>
  );
  const adder = (at: number) => (
    <div className="nbadd"><button className="lnk" onClick={() => insert(at, "sql")}>+ SQL</button><button className="lnk" onClick={() => insert(at, "md")}>+ Text</button></div>
  );

  return (
    <div className="nbpane">
      <div className="qtool">
        <input className="nbname" value={name} onChange={(e) => { dirty.current = true; setName(e.target.value); }} onBlur={flush} aria-label="Notebook name" />
        <button className="btn pri" onClick={runAll} disabled={runningAll || !conn?.connected}>{runningAll ? "Running…" : "Run all"}</button>
        <button className="btn" onClick={() => insert(cells.length, "sql")}>+ SQL</button>
        <button className="btn" onClick={() => insert(cells.length, "md")}>+ Text</button>
        <span className="sp" />
        <span className="ty">{conn ? `Runs on ${conn.name}${conn.connected ? "" : " (not connected)"}` : "Not connected"}</span>
        <button className="btn" onClick={exportFile}><Icon name="download" />Export…</button>
      </div>
      <div className="nbcells">
        {cells.length === 0 && <div className="rempty">Empty notebook. Add a SQL or text cell.</div>}
        {cells.map((c, i) => (
          <div key={c.id}>
            {c.kind === "sql"
              ? <SqlCell cell={c} index={i} session={nb.id} conn={conn} tables={tables} tools={tools(i)} onSrc={(src) => setSrc(c.id, src)}
                  register={(run) => { if (run) runners.current.set(c.id, run); else runners.current.delete(c.id); }} onRunAll={runAll} onSave={() => { flush(); onToast("Notebook saved"); }} confirm={confirm} onRan={onRan} />
              : <MdCell cell={c} tools={tools(i)} onSrc={(src) => setSrc(c.id, src)} onToast={onToast} />}
            {adder(i + 1)}
          </div>
        ))}
      </div>
      {guard && conn && <GuardDialog connName={conn.name} prod={conn.prod} risks={guard.risks} onRun={() => { guard.resolve(true); setGuard(null); }} onCancel={() => { guard.resolve(false); setGuard(null); }} />}
    </div>
  );
}

type Result = { columns: ColInfo[]; rows: Cell[][]; note: string; error?: string };

function SqlCell({ cell, index, session, conn, tables, tools, onSrc, register, onRunAll, onSave, confirm, onRan }: {
  cell: NotebookCell;
  index: number;
  session: string; // all cells of a notebook share one connection
  conn: TabConn | null;
  tables: Table[];
  tools: ReactNode;
  onSrc: (src: string) => void;
  register: (run: (() => Promise<boolean>) | null) => void;
  onRunAll: () => void;
  onSave: () => void;
  confirm: (r: Risk[]) => Promise<boolean>;
  onRan: (e: HistoryEntry) => void;
}) {
  const view = useRef<EditorView | null>(null);
  const [res, setRes] = useState<Result | null>(null);
  const [running, setRunning] = useState<string | null>(null);

  const run = async (): Promise<boolean> => {
    const sql = cell.src.trim();
    if (!sql) return true;
    if (!conn?.connected) { setRes({ columns: [], rows: [], note: "", error: "Not connected. Pick a connection in the title bar first." }); return false; }
    const found = conn.readOnly ? [] : risks(sql, { prod: conn.prod, backslashEscapes: conn.engine === "mysql" });
    if (found.length && !(await confirm(found))) return false;
    const qid = crypto.randomUUID();
    let columns: ColInfo[] = [];
    let rows: Cell[][] = [];
    const notes: string[] = [];
    let hadColumns = false;
    setRunning(qid);
    try {
      const s = await api.runQuery(conn.id, qid, sql, LIMIT, (e) => {
        if (e.event === "columns") { columns = e.columns; rows = []; hadColumns = true; }
        else if (e.event === "rows") rows.push(...e.rows);
        else { if (!hadColumns) notes.push(`${e.affected.toLocaleString()} row${e.affected === 1 ? "" : "s"} affected`); hadColumns = false; }
      }, session);
      const head = columns.length ? `${rows.length.toLocaleString()} row${rows.length === 1 ? "" : "s"}${s.truncated ? ` (first ${LIMIT.toLocaleString()})` : ""}` : notes[notes.length - 1] ?? "Done";
      setRes({ columns, rows, note: `${s.cancelled ? "Cancelled · " : ""}${head} · ${s.ms.toLocaleString()} ms` });
      onRan({ connId: conn.id, connName: conn.name, sql, at: Date.now(), rows: s.rows, ms: s.ms, error: null });
      return !s.cancelled;
    } catch (e) {
      const text = errText(e);
      setRes({ columns: [], rows: [], note: "", error: text });
      onRan({ connId: conn.id, connName: conn.name, sql, at: Date.now(), rows: null, ms: null, error: text });
      return false;
    } finally {
      setRunning(null);
    }
  };
  useEffect(() => { register(run); });
  useEffect(() => () => register(null), []);

  const h = res?.columns.length ? Math.min(320, HEAD + res.rows.length * rowHeight() + 14) : 0;
  return (
    <div className="nbcell sql">
      <div className="nbhead">
        <span className="nbkind">SQL</span><span className="ty">[{index + 1}]</span>
        {running ? <button className="btn danger" onClick={() => api.cancelQuery(running)}>Cancel</button> : <button className="btn" onClick={run} title="Run cell (Ctrl+Enter)"><Icon name="play" />Run</button>}
        <span className="sp" />{tools}
      </div>
      <div className="nbsql">
        <SqlEditor value={cell.src} onChange={onSrc} engine={conn?.engine ?? null} tables={tables} onRun={run} onRunAll={onRunAll} onExplain={() => {}} onSave={onSave} viewRef={view} />
      </div>
      {res && (
        <div className="nbres">
          {res.error ? <p className="nberr">{res.error}</p> : <>
            {h > 0 && <div className="nbgrid" style={{ height: h }}><ResultGrid columns={res.columns} rows={res.rows} /></div>}
            <small className="ty">{res.note}</small>
          </>}
        </div>
      )}
    </div>
  );
}

function MdCell({ cell, tools, onSrc, onToast }: { cell: NotebookCell; tools: ReactNode; onSrc: (src: string) => void; onToast: (m: string) => void }) {
  const [editing, setEditing] = useState(!cell.src);
  return (
    <div className="nbcell md">
      <div className="nbhead">
        <span className="nbkind">Text</span>
        <button className="lnk" onClick={() => setEditing((e) => !e)}>{editing ? "Done" : "Edit"}</button>
        <span className="sp" />{tools}
      </div>
      {editing
        ? <textarea className="nbtext" autoFocus value={cell.src} onChange={(e) => onSrc(e.target.value)} onBlur={() => cell.src && setEditing(false)}
            onKeyDown={(e) => { if (e.key === "Escape" || ((e.ctrlKey || e.metaKey) && e.key === "Enter")) { e.preventDefault(); setEditing(false); } }}
            rows={Math.max(3, cell.src.split("\n").length + 1)} placeholder="Notes in Markdown: # heading, **bold**, `code`, - list" aria-label="Text cell" />
        : <div className="md" onDoubleClick={() => setEditing(true)} title="Double-click to edit"><Markdown src={cell.src} onToast={onToast} /></div>}
    </div>
  );
}

export function NotebookList({ notebooks, onOpen, onNew, onImport, onRename, onDelete }: {
  notebooks: Notebook[];
  onOpen: (nb: Notebook) => void;
  onNew: () => void;
  onImport: () => void;
  onRename: (nb: Notebook, name: string) => void;
  onDelete: (nb: Notebook) => void;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const sorted = [...notebooks].sort((a, b) => b.updated - a.updated);
  return (
    <>
      <div className="pad-side frow"><button className="btn pri" onClick={onNew}>New notebook</button><button className="btn" onClick={onImport}>Open file…</button></div>
      <div className="hlist">
        {notebooks.length === 0 && <p className="empty-side">Notebooks mix notes and SQL cells you can run one by one or all at once. Good for reports and runbooks.</p>}
        {sorted.map((nb) => (
          <div key={nb.id} className="hist saved" role="button" tabIndex={0} onClick={() => renaming !== nb.id && onOpen(nb)} onKeyDown={(e) => { if (e.key === "Enter" && renaming !== nb.id) onOpen(nb); }} title="Open notebook">
            {renaming === nb.id ? (
              <input autoFocus defaultValue={nb.name} aria-label="New name" onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter" && e.currentTarget.value.trim()) { onRename(nb, e.currentTarget.value.trim()); setRenaming(null); }
                  if (e.key === "Escape") setRenaming(null);
                }}
                onBlur={() => setRenaming(null)} />
            ) : <b>{nb.name}</b>}
            <small>
              <span>{nb.cells.filter((c) => c.kind === "sql").length} SQL · {nb.cells.filter((c) => c.kind === "md").length} text</span>
              <span>{new Date(nb.updated).toLocaleDateString(undefined, { day: "numeric", month: "short" })}</span>
              <span className="sp" />
              <button className="linkbtn" onClick={(e) => { e.stopPropagation(); setRenaming(nb.id); }}>Rename</button>
              <button className={`linkbtn${confirmDel === nb.id ? " err" : ""}`} onBlur={() => setConfirmDel(null)}
                onClick={(e) => { e.stopPropagation(); if (confirmDel === nb.id) { onDelete(nb); setConfirmDel(null); } else setConfirmDel(nb.id); }}>
                {confirmDel === nb.id ? "Click again to delete" : "Delete"}
              </button>
            </small>
          </div>
        ))}
      </div>
    </>
  );
}
