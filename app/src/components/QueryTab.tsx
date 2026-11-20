import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { EditorView } from "@codemirror/view";
import { api, errText, type Cell, type Engine, type HistoryEntry, type Summary, type Table } from "../lib/api";
import { parseMyTable, parseMyTree, parsePg, parseSqlite, type Plan } from "../lib/explain";
import { endsTransaction, leavesTransactionOpen, risks, statementAt, topLevelWords, type Risk } from "../lib/sql";
import { explainPrompt, fixPrompt, systemPrompt, writePrompt } from "../lib/ai";
import { AiPane, useAi } from "./AiPane";
import { fillParams, findParams } from "../lib/params";
import { errorSpan } from "../lib/errpos";
import { getSettings } from "../lib/settings";
import { connectionLost, poolTimeout } from "../lib/reconnect";
import { ResultCompare, type ResultSet } from "./ResultCompare";
import { ChartView } from "./ChartView";
import { formatSql } from "./SqlEditor";
import { ExportDialog } from "./ExportDialog";
import { GuardDialog } from "./GuardDialog";
import { Inspector } from "./Inspector";
import { PlanView } from "./PlanView";
import { ResultGrid } from "./ResultGrid";
import { SqlEditor } from "./SqlEditor";
import { Icon } from "./Icons";

export interface QTab {
  id: string;
  title: string;
  kind?: "query" | "table" | "erd" | "diff" | "notebook" | "activity" | "datadiff" | "copy" | "users" | "settings";
  connId?: string; // the connection the tab belongs to; unset = joins the next connection opened
  notebookId?: string; // missing = query (tabs saved before tables existed)
  table?: { schema: string; name: string; jump?: { col: string; val: string; n: number } }; // jump: open filtered to one row
  sql: string;
  limit: number; // 0 = no limit
  autorun?: boolean;
  dirty?: boolean; // table tab with uncommitted edits
  savedId?: string; // the saved query this tab was opened from / saved as
}
export interface TabConn {
  id: string;
  name: string;
  engine: Engine;
  connected: boolean;
  prod: boolean;
  readOnly: boolean;
}
type Msg = { at: string; kind: "ok" | "err" | "warn"; text: string };
type PlanState = { plan: Plan; raw: string; analyzed: boolean } | { error: string };

const clock = () => new Date().toTimeString().slice(0, 8);
const LIMITS = [100, 1000, 10000, 100000];

/** The EXPLAIN statement for this engine. ANALYZE runs the query, so PostgreSQL undoes it: a rolled-back
 *  transaction, or inside the user's open transaction a savepoint (a ROLLBACK would throw away their work). */
function explainSql(engine: Engine, stmt: string, analyze: boolean, inTx = false): string {
  if (engine === "postgres" && analyze && inTx) return `SAVEPOINT tilki_explain;\nEXPLAIN (ANALYZE, FORMAT JSON) ${stmt};\nROLLBACK TO SAVEPOINT tilki_explain;`;
  if (engine === "postgres") return analyze ? `BEGIN;\nEXPLAIN (ANALYZE, FORMAT JSON) ${stmt};\nROLLBACK;` : `EXPLAIN (FORMAT JSON) ${stmt}`;
  if (engine === "mysql") return analyze ? `EXPLAIN ANALYZE ${stmt}` : `EXPLAIN FORMAT=TREE ${stmt}`;
  return `EXPLAIN QUERY PLAN ${stmt}`;
}

// One query tab: editor, toolbar, streamed results, plan and messages. Kept mounted while hidden,
// so a running query and its results survive switching tabs.
const NO_ROWS: Cell[][] = [];

export function QueryTab({ tab, conn, tables, inspector, ai, onChange, onRan, onToast, onSave, onOpenTable, keys, onReconnect }: {
  tab: QTab;
  conn: TabConn | null;
  tables: Table[];
  inspector: boolean;
  ai: { ready: boolean; setup: () => void; enabled: boolean }; // optional AI assistant (enabled: Settings › AI)
  onChange: (t: Partial<QTab>) => void;
  onRan: (e: HistoryEntry) => void;
  onToast: (msg: string) => void;
  onSave: (sql: string) => void; // Ctrl+S: update the saved query, or ask for a name
  onOpenTable?: (t: Table) => void; // Ctrl+click a table name in the editor
  keys?: Record<string, string>; // shortcut overrides
  onReconnect?: (error: string) => Promise<boolean | null>; // auto-reconnect on: reopen a dropped connection (null = it wasn't dropped)
}) {
  const view = useRef<EditorView | null>(null);
  // every result set of the last run, plus the pinned ones from earlier runs
  const sets = useRef<ResultSet[]>([]);
  const [cur, setCur] = useState(0);
  const [comparing, setComparing] = useState(false);
  const activeSet = sets.current[cur] ?? null;
  const all = activeSet?.rows ?? NO_ROWS;
  const columns = activeSet?.columns ?? [];
  const [version, setVersion] = useState(0);
  const [editorError, setEditorError] = useState<{ from: number; to: number; message: string } | null>(null);
  useEffect(() => {
    const lost = () => { setTxOpen((open) => { if (open) onToast("The connection was reopened: the open transaction in this tab was lost."); return false; }); };
    addEventListener("tilki:reconnected", lost);
    return () => removeEventListener("tilki:reconnected", lost);
  }, []); // deps chosen on purpose
  // quick filter over the rows already loaded (not a new query)
  const [find, setFind] = useState("");
  const shown = useMemo(() => {
    const q = find.trim().toLowerCase();
    if (!q) return all;
    return all.filter((r) => r.some((v) => v !== null && (typeof v === "object" ? JSON.stringify(v) : String(v)).toLowerCase().includes(q)));
  }, [find, version, cur, all]); // rows are appended to in place; version says when
  const [running, setRunning] = useState<string | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [pane, setPane] = useState<"results" | "chart" | "plan" | "messages" | "ai">("results");
  const [editorH, setEditorH] = useState(220);
  const [lastSql, setLastSql] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [guard, setGuard] = useState<{ sql: string; risks: Risk[]; from: number | null } | null>(null);
  const [plan, setPlan] = useState<PlanState | null>(null);
  const [analyze, setAnalyze] = useState(false);
  const [sel, setSel] = useState<{ r: number; c: number } | null>(null);
  const engine = conn?.engine ?? "postgres";
  useEffect(() => () => { api.endSession(tab.id); }, []); // the tab closed: close its session connection
  const assistant = useAi();
  // a manual transaction open in this tab's session (see run): blocks a quiet close, ends with the connection
  const [txOpen, setTxOpen] = useState(false);
  useEffect(() => { onChange({ dirty: txOpen }); }, [txOpen]); // the tab-close check treats it like unsaved edits
  const txConn = useRef(conn?.id);
  useEffect(() => {
    if (txConn.current !== conn?.id && txOpen) onToast("The open transaction was rolled back: the connection changed.");
    txConn.current = conn?.id;
    setTxOpen(false);
  }, [conn?.id]); // deps chosen on purpose
  const askAi = (label: string, prompt: string) => { setPane("ai"); assistant.ask(label, systemPrompt(engine, tables), prompt); };
  const short = (s: string) => (s.length > 120 ? `${s.slice(0, 120)}…` : s).replace(/\s+/g, " ");
  // AI answers go in on a new paragraph at the end and get selected, so Ctrl+Enter runs them
  const insertSql = (sql: string) => {
    const v = view.current;
    if (!v) return;
    const doc = v.state.doc.toString();
    const from = doc.trim() ? doc.length : 0, text = doc.trim() ? `\n\n${sql}` : sql;
    v.dispatch({ changes: { from, to: doc.length, insert: text }, selection: { anchor: from + text.length - sql.length, head: from + text.length } });
    v.focus();
  };
  const lastError = msgs.filter((m) => m.kind === "err").pop();

  // from: where sql starts in the editor text (to underline an error); null when the text was changed (parameters)
  const run = async (sql: string, confirmed = false, from: number | null = null) => {
    if (!sql.trim() || running) return;
    if (!conn?.connected) {
      setMsgs((m) => [...m, { at: clock(), kind: "err", text: "Not connected. Pick a connection in the title bar first." }]);
      setPane("messages");
      return;
    }
    // read-only connections are protected by the server; everything else gets a typed confirmation
    const found = conn.readOnly ? [] : risks(sql, { prod: conn.prod, backslashEscapes: engine === "mysql" });
    if (found.length && !confirmed) { setGuard({ sql, risks: found, from }); return; }
    const qid = crypto.randomUUID();
    const log: Msg[] = [];
    let hadColumns = false, timedOut = false;
    const limitS = getSettings().queryTimeout;
    const timer = limitS > 0 ? setTimeout(() => { timedOut = true; api.cancelQuery(qid); }, limitS * 1000) : null;
    sets.current = sets.current.filter((x) => x.pinned);
    const firstNew = sets.current.length;
    setCur(Math.max(0, firstNew - 1));
    setComparing(false);
    setEditorError(null);
    setSummary(null);
    setSel(null);
    setRunning(qid);
    setLastSql(sql);
    setPane("results");
    setMsgs(log);
    try {
      const s = await api.runQuery(conn.id, qid, sql, tab.limit || null, (e) => {
        if (e.event === "columns") {
          const k = sets.current.length - firstNew + 1;
          sets.current.push({ id: crypto.randomUUID(), label: `Result ${k}`, sql, columns: e.columns, rows: [], pinned: false });
          setCur(sets.current.length - 1); // show the newest result set as it arrives
          hadColumns = true;
          setVersion((v) => v + 1);
        } else if (e.event === "rows") {
          sets.current[sets.current.length - 1]?.rows.push(...e.rows);
          setVersion((v) => v + 1);
        } else {
          const n = e.affected.toLocaleString();
          log.push({ at: clock(), kind: "ok", text: `Statement ${e.index + 1}: ${n} row${e.affected === 1 ? "" : "s"} ${hadColumns ? "returned" : "affected"}` });
          hadColumns = false;
          setMsgs([...log]);
        }
      }, tab.id, true);
      const open = engine === "postgres" && s.inTransaction != null ? s.inTransaction
        : !!s.inTransaction || leavesTransactionOpen(sql) || (txOpen && !endsTransaction(sql, engine === "mysql"));
      setTxOpen(open);
      if (s.truncated) log.push({ at: clock(), kind: "warn", text: `Stopped at ${s.rows.toLocaleString()} rows (the row limit). Raise the limit to fetch more.` });
      if (s.cancelled) log.push({ at: clock(), kind: "warn", text: timedOut ? `Stopped by the ${limitS} s query timeout (Settings › Connections & safety).` : `Cancelled after ${s.rows.toLocaleString()} rows.` });
      if (open && !txOpen) log.push({ at: clock(), kind: "warn", text: "A transaction is open in this tab. Commit or roll it back with the buttons above; closing the tab rolls it back. Other tabs don't see its changes until you commit." });
      log.push({ at: clock(), kind: "ok", text: `Finished in ${s.ms.toLocaleString()} ms` });
      setSummary(s);
      onRan({ connId: conn.id, connName: conn.name, sql, at: Date.now(), rows: s.rows, ms: s.ms, error: null });
    } catch (e) {
      const text = errText(e);
      log.push({ at: clock(), kind: "err", text });
      const span = from != null ? errorSpan(engine, text, sql) : null;
      if (span) setEditorError({ from: from! + span.from, to: from! + span.to, message: text.replace(/\nAt character \d+\.$/, "") });
      // auto-reconnect (when on): reopen a dropped connection. Nothing is run again by itself: even a
      // SELECT can have side effects (nextval, functions) and may have reached the server already.
      if (onReconnect && (connectionLost(text) || poolTimeout(text))) {
        const back = await onReconnect(text);
        if (back != null) log.push({ at: clock(), kind: back ? "warn" : "err", text: back ? "The connection had dropped and was reopened. Check whether the statement ran, then run it again." : "The connection dropped and could not be reopened." });
      }
      const stillOpen = text.includes("transaction is still open") || (txOpen && !endsTransaction(sql, engine === "mysql") && engine !== "postgres");
      setTxOpen(stillOpen);
      if (stillOpen) {
        log.push({ at: clock(), kind: "warn", text: engine === "postgres" ? "PostgreSQL aborted the open transaction: roll it back to continue." : "The transaction is still open; the failed statement changed nothing." });
      } else if (log.some((m) => m.text.startsWith("Statement "))) { // the "Statement N" lines don't say whether those changes were kept
        log.push({ at: clock(), kind: "warn", text: engine === "postgres"
          ? "PostgreSQL ran this script as one transaction, so the statements before the error were rolled back too (unless the script itself committed them). Nothing after it ran."
          : "The statements before the error were saved (each one commits on its own unless the script opened a transaction). Nothing after it ran." });
      }
      if (!sets.current.slice(firstNew).some((x) => x.rows.length)) setPane("messages");
      onRan({ connId: conn.id, connName: conn.name, sql, at: Date.now(), rows: null, ms: null, error: text });
    } finally {
      setMsgs([...log]);
      if (timer) clearTimeout(timer);
      setVersion((v) => v + 1);
      setRunning(null);
    }
  };

  // the selection or the statement under the cursor, and where it starts in the editor
  const currentAt = (): { text: string; from: number } => {
    const v = view.current;
    if (!v) return { text: "", from: 0 };
    const { from, to, head } = v.state.selection.main;
    const doc = v.state.doc.toString();
    const stmt = from !== to ? null : statementAt(doc, head, engine === "mysql");
    const text = stmt ? stmt.text : doc.slice(from, to).trim().replace(/;\s*$/, "");
    return { text, from: Math.max(0, doc.indexOf(text, stmt ? stmt.from : from)) };
  };
  const current = () => currentAt().text;
  // :name parameters: ask for values first (remembered per tab), then run the filled-in SQL
  const [paramAsk, setParamAsk] = useState<{ names: string[]; then: (vals: Record<string, string>) => void } | null>(null);
  const paramVals = useRef<Record<string, string>>({});
  const withParams = (sql: string, go: (filled: string) => void) => {
    const names = findParams(sql, engine === "mysql");
    if (!names.length) { go(sql); return; }
    setParamAsk({ names, then: (vals) => { paramVals.current = { ...paramVals.current, ...vals }; setParamAsk(null); go(fillParams(sql, vals, engine)); } });
  };
  const runCurrent = () => { const c = currentAt(); withParams(c.text, (s) => run(s, false, s === c.text ? c.from : null)); };
  const runAll = () => { const doc = view.current?.state.doc.toString() ?? ""; withParams(doc, (s) => run(s, false, s === doc ? 0 : null)); };
  const explainCurrent = () => withParams(current(), (s) => explain(s));
  const cancel = () => { if (running) api.cancelQuery(running); };

  const explain = async (given?: string) => {
    const stmt = given ?? current();
    if (!stmt || running || !conn?.connected) return;
    const doAnalyze = analyze && engine !== "sqlite";
    if (doAnalyze && engine === "mysql" && topLevelWords(stmt).find((w) => w !== "with" && w !== "explain") !== "select") {
      setPlan({ error: "MySQL can only ANALYZE SELECT statements. Turn off Analyze to see the estimated plan." });
      setPane("plan");
      return;
    }
    const qid = crypto.randomUUID();
    const got: Cell[][] = [];
    setRunning(qid);
    setPane("plan");
    setPlan(null);
    try {
      let cols: string[] = [];
      const ask = (sql: string) => api.runQuery(conn.id, qid, sql, null, (e) => { if (e.event === "columns") cols = e.columns.map((c) => c.name); else if (e.event === "rows") got.push(...e.rows); }, tab.id, true);
      // MariaDB (and MySQL before 8.0.16) reject FORMAT=TREE / EXPLAIN ANALYZE: fall back to the classic table
      let classic = false;
      try {
        await ask(explainSql(engine, stmt, doAnalyze, txOpen));
      } catch (err) {
        if (engine !== "mysql" || !/syntax|format name/i.test(errText(err))) throw err; // MariaDB: "Unknown EXPLAIN/ANALYZE format name"
        classic = true;
        got.length = 0;
        await ask(doAnalyze ? `ANALYZE ${stmt}` : `EXPLAIN ${stmt}`);
      }
      if (!got.length) throw new Error("EXPLAIN returned nothing.");
      const p = engine === "postgres" ? parsePg(got[0][0]) : classic ? parseMyTable(cols, got) : engine === "mysql" ? parseMyTree(String(got[0][0])) : parseSqlite(got);
      const raw = engine === "postgres" ? JSON.stringify(typeof got[0][0] === "string" ? JSON.parse(got[0][0]) : got[0][0], null, 2)
        : classic ? [cols, ...got].map((r) => r.map((v) => v ?? "NULL").join("\t")).join("\n")
        : engine === "mysql" ? String(got[0][0]) : got.map((r) => `${r[0]}\t${r[1]}\t${r[3]}`).join("\n");
      setPlan({ plan: p, raw, analyzed: doAnalyze });
    } catch (e) {
      setPlan({ error: errText(e) });
    } finally {
      setRunning(null);
    }
  };

  // tabs opened from the history run their query right away — once, even if effects run twice
  const autoran = useRef(false);
  useEffect(() => {
    if (tab.autorun && conn?.connected && !autoran.current) { autoran.current = true; onChange({ autorun: false }); runAll(); }
  }, [tab.autorun, conn?.connected]); // runs once per autorun request, not on every render

  const startResize = (e: ReactPointerEvent) => {
    const y0 = e.clientY, h0 = editorH;
    const move = (ev: PointerEvent) => setEditorH(Math.max(80, Math.min(innerHeight - 260, h0 + ev.clientY - y0)));
    const up = () => { removeEventListener("pointermove", move); removeEventListener("pointerup", up); };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  };

  const n = all.length;
  const togglePin = () => { if (activeSet) { activeSet.pinned = !activeSet.pinned; setVersion((v) => v + 1); } };
  const status = running ? (pane === "plan" ? "Explaining…" : `Running… ${n.toLocaleString()} rows`)
    : summary ? `${summary.rows.toLocaleString()} rows · ${summary.ms.toLocaleString()} ms${summary.ms > 0 && summary.rows > 1000 ? ` · ${Math.round(summary.rows / (summary.ms / 1000)).toLocaleString()} rows/s` : ""}${summary.truncated ? " · limit reached" : ""}${summary.cancelled ? " · cancelled" : ""}`
    : "";

  return (
    <div className="qtab" onKeyDown={(e) => { if (e.key === "Escape" && running && !guard) { e.preventDefault(); cancel(); } }}>
      <div className="qtool">
        {running
          ? <button className="btn danger" onClick={cancel}><Icon name="stop" />Cancel <kbd>Esc</kbd></button>
          : <button className="btn pri" onClick={runCurrent} disabled={!conn?.connected} title={conn?.connected ? "" : "Connect first"}><Icon name="play" />Run <kbd>Ctrl ↵</kbd></button>}
        <button className="btn" onClick={runAll} disabled={!!running || !conn?.connected}><Icon name="playAll" />Run all <kbd>Ctrl ⇧ ↵</kbd></button>
        <button className="btn" onClick={explainCurrent} disabled={!!running || !conn?.connected} title="Show the query plan for the statement under the cursor"><Icon name="explain" />Explain <kbd>Ctrl ⇧ E</kbd></button>
        <button className="btn" onClick={() => onSave(view.current?.state.doc.toString() ?? tab.sql)} title={tab.savedId ? "Update the saved query" : "Save this query"}><Icon name="save" />{tab.savedId ? "Save" : "Save…"} <kbd>Ctrl S</kbd></button>
        <button className="btn" onClick={() => { const v = view.current; if (v) { const err = formatSql(v, engine); if (err) onToast(err); v.focus(); } }} title="Format the selection or the whole text (Ctrl+Shift+F)"><Icon name="format" />Format</button>
        {engine !== "sqlite" && (
          <label className="check small" title="Runs the statement to measure real timings. Writes are rolled back on PostgreSQL; MySQL only analyzes SELECT.">
            <input type="checkbox" checked={analyze} onChange={(e) => setAnalyze(e.target.checked)} /> Analyze
          </label>
        )}
        <label className="limit" title="Most rows to fetch. A LIMIT in the SQL still applies.">
          <span>Limit</span>
          <select value={tab.limit} onChange={(e) => onChange({ limit: Number(e.target.value) })} aria-label="Row limit">
            {LIMITS.map((l) => <option key={l} value={l}>{l.toLocaleString()}</option>)}
            <option value={0}>No limit</option>
          </select>
        </label>
        <span className="sp" />
        {txOpen && (
          <span className="txbar" role="status">
            <span className="txdot" />Transaction open
            <button className="btn" onClick={() => run("COMMIT", true)} disabled={!!running}><Icon name="check" />Commit</button>
            <button className="btn" onClick={() => run("ROLLBACK", true)} disabled={!!running}><Icon name="x" />Roll back</button>
          </span>
        )}
        {conn?.prod && <span className="ro" title={conn.readOnly ? "The server refuses writes" : "Writes ask for the connection name first"}>{conn.readOnly ? "PRODUCTION · READ-ONLY" : "PRODUCTION · GUARDED"}</span>}
        <span className={`qstatus${running ? " live" : ""}`}>{status}</span>
      </div>
      <div style={{ height: editorH }} className="editor-wrap">
        <SqlEditor value={tab.sql} onChange={(sql) => onChange({ sql })} engine={conn?.engine ?? null} tables={tables} onRun={runCurrent} onRunAll={runAll} onExplain={explainCurrent} onSave={() => onSave(view.current?.state.doc.toString() ?? tab.sql)} onError={onToast} viewRef={view}
          onOpenTable={onOpenTable} error={editorError} keys={keys} />
      </div>
      <div className={`progress${running ? " on" : ""}`} />
      <div className="split" onPointerDown={startResize} title="Drag to resize" />
      <div className="rhead">
        <button className={`rt${pane === "results" ? " on" : ""}`} onClick={() => setPane("results")}><Icon name="table" />Results</button>
        <button className={`rt${pane === "chart" ? " on" : ""}`} onClick={() => setPane("chart")}><Icon name="chart" />Chart</button>
        <button className={`rt${pane === "plan" ? " on" : ""}`} onClick={() => setPane("plan")}><Icon name="explain" />Plan</button>
        <button className={`rt${pane === "messages" ? " on" : ""}`} onClick={() => setPane("messages")}>
          Messages{msgs.some((m) => m.kind === "err") ? <span className="ct err">!</span> : msgs.length ? <span className="ct">{msgs.length}</span> : null}
        </button>
        {ai.enabled && <button className={`rt${pane === "ai" ? " on" : ""}`} onClick={() => setPane("ai")}>AI{assistant.ai?.job && <span className="ct">…</span>}</button>}
        <span className="sp" />
        {columns.length > 0 && pane === "results" && (
          <label className="gfind"><input value={find} onChange={(e) => { setFind(e.target.value); setSel(null); }} placeholder="Filter loaded rows" aria-label="Filter loaded rows" spellCheck={false} />
            {find && <span className="ty">{shown.length.toLocaleString()} of {all.length.toLocaleString()}</span>}</label>
        )}
        {activeSet && !running && pane === "results" && (
          <button className={`btn rbtn-x${activeSet.pinned ? " on" : ""}`} onClick={togglePin} aria-pressed={activeSet.pinned} title="A pinned result stays when you run again, so you can compare"><Icon name="pin" />{activeSet.pinned ? "Unpin" : "Pin"}</button>
        )}
        {sets.current.length > 1 && !running && pane === "results" && <button className={`btn rbtn-x${comparing ? " on" : ""}`} onClick={() => setComparing((c) => !c)}><Icon name="diff" />Compare…</button>}
        {columns.length > 0 && !running && pane === "results" && <button className="btn rbtn-x" onClick={() => setExporting(true)}><Icon name="download" />Export…</button>}
      </div>
      {pane === "results" && sets.current.length > 1 && (
        <div className="rsets" role="tablist" aria-label="Result sets">
          {sets.current.map((x, i) => (
            <button key={x.id} role="tab" aria-selected={i === cur} className={`rt${i === cur ? " on" : ""}`} title={x.sql.slice(0, 300)} onClick={() => { setCur(i); setSel(null); setFind(""); }}>
              {x.pinned && <span className="pinmark" aria-label="pinned">■</span>}{x.label}<span className="ct">{x.rows.length.toLocaleString()}</span>
            </button>
          ))}
        </div>
      )}
      {pane === "results" && comparing && sets.current.length > 1 ? (
        <ResultCompare sets={sets.current} a={cur} onClose={() => setComparing(false)} />
      ) : pane === "results" ? (
        <div className="resbody">
          {columns.length ? <ResultGrid columns={columns} rows={shown} engine={engine} onSelect={(r, c) => setSel(r != null && c != null ? { r, c } : null)} />
            : <div className="rempty">{running ? "Waiting for the first rows…" : summary ? "The statement returned no rows. See Messages." : "Run a query to see results here."}</div>}
          {inspector && <Inspector columns={columns} row={sel ? shown[sel.r] ?? null : null} col={sel?.c ?? null} onPick={(c) => sel && setSel({ ...sel, c })} />}
        </div>
      ) : pane === "chart" ? (
        columns.length ? <ChartView columns={columns} rows={all} /> : <div className="rempty">Run a query, then chart its rows here.</div>
      ) : pane === "plan" ? (
        !plan ? <div className="rempty">{running ? "Explaining…" : "Put the cursor in a statement and press Explain (Ctrl+Shift+E)."}</div>
          : "error" in plan ? <div className="msgs"><span className="err">{plan.error}</span></div>
          : <PlanView plan={plan.plan} raw={plan.raw} analyzed={plan.analyzed} />
      ) : pane === "ai" ? (
        <AiPane ready={ai.ready} ai={assistant.ai} busy={!!assistant.ai?.job} onSetup={ai.setup} onCancel={assistant.cancel} onInsert={insertSql} onToast={onToast}
          onWrite={(req) => askAi(`Write: ${short(req)}`, writePrompt(req, view.current?.state.doc.toString() ?? tab.sql))}
          onExplain={() => { const s = current(); if (s) askAi(`Explain: ${short(s)}`, explainPrompt(s)); else onToast("Put the cursor in a statement first."); }} />
      ) : (
        <div className="msgs">
          {msgs.length === 0 && <span className="ty">No messages yet.</span>}
          {msgs.map((m, i) => <div key={i} className="m"><time>{m.at}</time><span className={m.kind}>{m.text}</span></div>)}
          {lastError && lastSql && ai.ready && ai.enabled && !running && (
            <button className="btn aifix" disabled={!!assistant.ai?.job} onClick={() => askAi(`Fix: ${short(lastSql)}`, fixPrompt(lastSql, lastError.text))}>Ask AI to fix this error</button>
          )}
        </div>
      )}
      {exporting && conn && (
        <ExportDialog title="result" columns={columns} loaded={() => all} allSql={lastSql} connId={conn.id} session={tab.id} engine={conn.engine}
          defaultName={tab.title.replace(/[^\w.-]+/g, "_")} insertTable="exported_rows"
          onClose={() => setExporting(false)} onDone={(m) => { setExporting(false); onToast(m); }} />
      )}
      {paramAsk && <ParamDialog names={paramAsk.names} initial={paramVals.current} onRun={paramAsk.then} onCancel={() => setParamAsk(null)} />}
      {guard && conn && (
        <GuardDialog connName={conn.name} prod={conn.prod} risks={guard.risks} onCancel={() => setGuard(null)}
          onRun={() => { const g = guard; setGuard(null); run(g.sql, true, g.from); }} />
      )}
    </div>
  );
}

function ParamDialog({ names, initial, onRun, onCancel }: { names: string[]; initial: Record<string, string>; onRun: (v: Record<string, string>) => void; onCancel: () => void }) {
  const [vals, setVals] = useState(() => Object.fromEntries(names.map((n) => [n, initial[n] ?? ""])));
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal small" role="dialog" aria-modal="true" aria-labelledby="pm-title" onKeyDown={(e) => { if (e.key === "Escape") onCancel(); if (e.key === "Enter") onRun(vals); }}>
        <h3 id="pm-title">Query parameters</h3>
        <p className="note">Numbers and NULL go in as they are; anything else is quoted as text.</p>
        {names.map((n, i) => (
          <div className="f" key={n}><label htmlFor={`pm-${n}`} className="mono">:{n}</label>
            <input id={`pm-${n}`} autoFocus={i === 0} value={vals[n]} onChange={(e) => setVals({ ...vals, [n]: e.target.value })} spellCheck={false} /></div>
        ))}
        <div className="acts"><button className="btn" onClick={onCancel}>Cancel</button><button className="btn pri" onClick={() => onRun(vals)}>Run</button></div>
      </div>
    </div>
  );
}
