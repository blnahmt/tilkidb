import { useMemo, useState } from "react";
import type { Cell, ColInfo } from "../lib/api";
import { diffRows, kindOf } from "../lib/datadiff";
import { cellText, ResultGrid } from "./ResultGrid";

export interface ResultSet { id: string; label: string; sql: string; columns: ColInfo[]; rows: Cell[][]; pinned: boolean }

// Two result sets side by side as a diff: rows only in A, only in B, and (matched by the first
// column) rows whose values changed.
export function ResultCompare({ sets, a, onClose }: { sets: ResultSet[]; a: number; onClose: () => void }) {
  const [b, setB] = useState(() => sets.findIndex((_, i) => i !== a));
  const [byKey, setByKey] = useState(true);
  const [pick, setView] = useState<"added" | "removed" | "changed">("changed");
  const A = sets[a], B = sets[b];
  const sameCols = !!A && !!B && A.columns.length === B.columns.length && A.columns.every((c, i) => c.name === B.columns[i].name);
  const d = useMemo(() => (sameCols ? diffRows(A.rows, B.rows, byKey ? [0] : [], A.columns.map((c) => kindOf(c.dataType))) : null), [A, B, byKey, sameCols]);
  const view = !byKey && pick === "changed" ? "added" : pick;
  const rows = !d ? [] : view === "added" ? d.added : view === "removed" ? d.removed
    : d.changed.map((c) => c.to.map((v, i) => (c.cols.includes(i) ? `${cellText(c.from[i])} → ${cellText(v)}` : v)));
  return (
    <div className="cmpwrap">
      <div className="qtool">
        <span className="ty">Compare</span><b>{A?.label}</b><span className="ty">with</span>
        <select value={b} onChange={(e) => setB(Number(e.target.value))} aria-label="Result to compare with">
          {sets.map((s, i) => i !== a && <option key={s.id} value={i}>{s.label}{s.pinned ? " (pinned)" : ""}</option>)}
        </select>
        <label className="check small" title="Rows with the same first-column value are the same row; otherwise whole rows are compared">
          <input type="checkbox" checked={byKey} onChange={(e) => setByKey(e.target.checked)} /> Match rows by {A?.columns[0]?.name ?? "the first column"}
        </label>
        <span className="sp" />
        <button className="btn" onClick={onClose}>Close</button>
      </div>
      {!sameCols ? <div className="rempty">These results have different columns, so their rows can't be compared.</div> : (
        <>
          <div className="rhead">
            {byKey && <button className={`rt${view === "changed" ? " on" : ""}`} onClick={() => setView("changed")}>Changed <span className="ct">{d!.changed.length}</span></button>}
            <button className={`rt${view === "added" ? " on" : ""}`} onClick={() => setView("added")}>Only in {A.label} <span className="ct">{d!.added.length}</span></button>
            <button className={`rt${view === "removed" ? " on" : ""}`} onClick={() => setView("removed")}>Only in {B.label} <span className="ct">{d!.removed.length}</span></button>
            <span className="sp" /><span className="ty">{d!.same.toLocaleString()} identical row{d!.same === 1 ? "" : "s"}</span>
          </div>
          <div className="resbody">
            {rows.length ? <ResultGrid columns={A.columns} rows={rows} /> : <div className="rempty">Nothing here.</div>}
          </div>
        </>
      )}
    </div>
  );
}
