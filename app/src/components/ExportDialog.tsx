import { useEffect, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { api, desktop, errText, type Cell, type ColInfo, type Engine, type ExportFormat } from "../lib/api";

const FORMATS: [ExportFormat, string, string, string][] = [
  ["csv", "CSV", "Comma separated", "csv"],
  ["xlsx", "Excel", ".xlsx workbook", "xlsx"],
  ["json", "JSON", "Array of objects", "json"],
  ["jsonl", "JSON Lines", "One object per line", "jsonl"],
  ["tsv", "TSV", "Tab separated", "tsv"],
  ["sql", "SQL INSERT", "Batched inserts", "sql"],
  ["markdown", "Markdown", "Table for docs", "md"],
];
const DELIMS: [string, string][] = [[",", "Comma ,"], [";", "Semicolon ;"], ["|", "Pipe |"]];

// Export the current result: rows already loaded, or every row (the query runs again and
// streams straight to the file, so size is not limited by memory).
export function ExportDialog({ title, columns, loaded, allSql, connId, session = null, engine, defaultName, insertTable, onClose, onDone }: {
  title: string;
  columns: ColInfo[];
  loaded: () => Cell[][];
  allSql: string | null; // null = only loaded rows can be exported
  connId: string | null;
  session?: string | null; // run "every row" in the query tab's own session (same USE / SET)
  engine: Engine;
  defaultName: string;
  insertTable: string;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const loadedCount = loaded().length;
  const [fmt, setFmt] = useState<ExportFormat>("csv");
  const [scope, setScope] = useState<"loaded" | "all">("loaded");
  const [header, setHeader] = useState(true);
  const [delimiter, setDelimiter] = useState(",");
  const [nullText, setNullText] = useState("");
  const [pretty, setPretty] = useState(false);
  const [table, setTable] = useState(insertTable);
  const [batch, setBatch] = useState(500);
  const [busy, setBusy] = useState<string | null>(null); // query id while exporting all rows
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const meta = FORMATS.find((f) => f[0] === fmt)!;

  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape" && !working) onClose(); };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [working, onClose]);

  const run = async () => {
    setError(null);
    const path = await save({ title: "Export to", defaultPath: `${defaultName}.${meta[3]}`, filters: [{ name: meta[1], extensions: [meta[3]] }] });
    if (!path) return;
    const opts = { format: fmt, header, delimiter, nullText, table: table.trim() || insertTable, engine, pretty, batch: Math.max(1, batch) };
    setWorking(true);
    try {
      if (scope === "loaded" || !allSql || !connId) {
        const n = await api.exportRows(columns, loaded(), path, opts);
        onDone(`Exported ${n.toLocaleString()} rows to ${path}`);
      } else {
        const qid = crypto.randomUUID();
        setBusy(qid);
        const s = await api.exportQuery(connId, qid, allSql, path, opts, session);
        onDone(s.cancelled ? "Export cancelled. No file was written." : `Exported ${s.rows.toLocaleString()} rows to ${path} in ${s.ms.toLocaleString()} ms`);
      }
    } catch (e) {
      setError(errText(e));
      setWorking(false);
      setBusy(null);
    }
  };

  const check = (label: string, value: boolean, set: (v: boolean) => void) => (
    <label className="check"><input type="checkbox" checked={value} onChange={(e) => set(e.target.checked)} /> {label}</label>
  );

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && !working && onClose()}>
      <div className="modal wide" role="dialog" aria-modal="true" aria-labelledby="ex-title">
        <h3 id="ex-title">Export {title}</h3>
        <p className="note">{columns.length} columns · {loadedCount.toLocaleString()} rows loaded</p>

        <h4 className="sech">Format</h4>
        <div className="fmts">
          {FORMATS.map(([k, label, desc]) => (
            <button key={k} className={`fmt${fmt === k ? " on" : ""}`} aria-pressed={fmt === k} onClick={() => setFmt(k)}><b>{label}</b><span>{desc}</span></button>
          ))}
        </div>

        <div className="xgrid">
          <div>
            <h4 className="sech">Rows</h4>
            <div className="checks">
              <label className="check"><input type="radio" name="scope" checked={scope === "loaded"} onChange={() => setScope("loaded")} /> Rows loaded <span className="ty">{loadedCount.toLocaleString()}</span></label>
              <label className="check" title={allSql ? "" : "Run a query first"}>
                <input type="radio" name="scope" checked={scope === "all"} disabled={!allSql} onChange={() => setScope("all")} /> Every row the query returns
              </label>
              {scope === "all" && <p className="note">Runs the query again without the row limit and writes rows to the file as they arrive.</p>}
            </div>
          </div>
          <div>
            <h4 className="sech">Options</h4>
            <div className="checks">
              {(fmt === "csv" || fmt === "tsv" || fmt === "xlsx") && check(fmt === "xlsx" ? "Bold, frozen header row" : "Header row with column names", header, setHeader)}
              {fmt === "csv" && (
                <div className="frow">
                  <span className="ty">Delimiter</span>
                  <select value={delimiter} onChange={(e) => setDelimiter(e.target.value)} aria-label="Delimiter">{DELIMS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
                </div>
              )}
              {(fmt === "csv" || fmt === "tsv" || fmt === "markdown") && (
                <div className="frow"><span className="ty">Write NULL as</span><input value={nullText} onChange={(e) => setNullText(e.target.value)} placeholder="(empty)" aria-label="Write NULL as" style={{ width: 110 }} /></div>
              )}
              {fmt === "json" && check("Pretty-print (indented)", pretty, setPretty)}
              {fmt === "sql" && (
                <>
                  <div className="frow"><span className="ty">Table</span><input value={table} onChange={(e) => setTable(e.target.value)} aria-label="Target table" style={{ flex: 1 }} /></div>
                  <div className="frow"><span className="ty">Rows per INSERT</span><input type="number" min={1} value={batch} onChange={(e) => setBatch(Number(e.target.value))} aria-label="Rows per INSERT" style={{ width: 90 }} /></div>
                </>
              )}
              {fmt === "xlsx" && <p className="note">Numbers stay numbers. Over 1,048,575 rows continue on a new sheet.</p>}
              {fmt === "jsonl" && <p className="note">One JSON object per line. Good for very large exports and log tools.</p>}
            </div>
          </div>
        </div>

        {error && <p className="testres err">{error}</p>}
        {!desktop && <p className="note">Exporting needs the desktop app.</p>}
        <div className="acts">
          <span className="note" style={{ marginRight: "auto", alignSelf: "center" }}>{working ? (busy ? "Exporting every row…" : "Writing the file…") : ""}</span>
          {busy
            ? <button className="btn danger" onClick={() => api.cancelQuery(busy)}>Cancel export</button>
            : <button className="btn" onClick={onClose} disabled={working}>Cancel</button>}
          <button className="btn pri" onClick={run} disabled={working || !desktop}>Export…</button>
        </div>
      </div>
    </div>
  );
}
