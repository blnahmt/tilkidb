import { useEffect, useState } from "react";
import type { Risk } from "../lib/sql";

// Typed confirmation before risky SQL: the user must type the connection name to go ahead.
export function GuardDialog({ connName, prod, risks, onRun, onCancel }: {
  connName: string;
  prod: boolean;
  risks: Risk[];
  onRun: () => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState("");
  const ok = typed === connName;

  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onCancel(); } };
    addEventListener("keydown", key, true);
    return () => removeEventListener("keydown", key, true);
  }, [onCancel]);

  const PROD_WRITE = "Writes to a production connection.";
  const reasons = [...new Set(risks.map((r) => r.reason))].filter((r) => !(prod && r === PROD_WRITE)); // said once in the first line
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal guard" role="alertdialog" aria-modal="true" aria-labelledby="gd-title" aria-describedby="gd-why">
        <h3 id="gd-title"><span className="gdot" />Check before running on {connName}</h3>
        <ul id="gd-why" className="gwhy">
          {prod && <li><b>{connName}</b> is a production connection, so writes need confirmation.</li>}
          {reasons.map((r) => <li key={r}>{r}</li>)}
        </ul>
        <pre className="sqlprev">{risks.map((r) => (r.statement.length > 400 ? `${r.statement.slice(0, 400)}…` : r.statement) + ";").join("\n\n")}</pre>
        <label className="glabel" htmlFor="gd-in">Type <code>{connName}</code> to run it anyway</label>
        <input id="gd-in" autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false}
          onKeyDown={(e) => { if (e.key === "Enter" && ok) onRun(); }} />
        <div className="acts">
          <button className="btn" onClick={onCancel}>Cancel</button>
          <button className="btn danger" disabled={!ok} onClick={onRun}>Run on {connName}</button>
        </div>
      </div>
    </div>
  );
}
