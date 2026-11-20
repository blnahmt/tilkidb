import { useState } from "react";
import type { HistoryEntry } from "../lib/api";
import { Icon } from "./Icons";

const when = (at: number) => {
  const d = new Date(at);
  return d.toDateString() === new Date().toDateString() ? d.toTimeString().slice(0, 5) : d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
};

// Sidebar list of past queries: click one to open it in a new tab on the connection it ran on;
// the play button opens it there and runs it.
export function HistoryList({ entries, connId, onOpen }: { entries: HistoryEntry[]; connId: string | null; onOpen: (e: HistoryEntry, run: boolean) => void }) {
  const [all, setAll] = useState(false);
  const shown = !all && connId ? entries.filter((e) => e.connId === connId) : entries;
  return (
    <>
      {connId && (
        <div className="pad-side">
          <div className="seg">
            <button className={all ? "" : "on"} aria-pressed={!all} onClick={() => setAll(false)}>This connection</button>
            <button className={all ? "on" : ""} aria-pressed={all} onClick={() => setAll(true)}>All</button>
          </div>
        </div>
      )}
      <div className="hlist">
        {shown.length === 0 && <p className="empty-side">Queries you run will be listed here, newest first.</p>}
        {shown.map((e) => (
          <div key={`${e.at}-${e.sql.length}`} className="hist" role="button" tabIndex={0} onClick={() => onOpen(e, false)} onKeyDown={(k) => { if (k.key === "Enter") onOpen(e, false); }}
            title={e.connId === connId ? "Open in a new tab" : `Open on ${e.connName} (connects to it)`}>
            <button className="ibtn hrun" aria-label={`Run on ${e.connName}`} title={`Run on ${e.connName}`} onClick={(ev) => { ev.stopPropagation(); onOpen(e, true); }}><Icon name="play" /></button>
            <code>{e.sql.length > 300 ? `${e.sql.slice(0, 300)}…` : e.sql}</code>
            <small>
              <span>{when(e.at)}</span>
              {(all || !connId) && <span>{e.connName}</span>}
              {e.error ? <span className="err">failed</span> : <><span>{(e.rows ?? 0).toLocaleString()} rows</span><span>{e.ms} ms</span></>}
            </small>
          </div>
        ))}
      </div>
    </>
  );
}
