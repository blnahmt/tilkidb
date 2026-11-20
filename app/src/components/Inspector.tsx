import { useEffect, useState, type ReactNode } from "react";
import type { Cell, ColInfo } from "../lib/api";
import { cellText } from "./ResultGrid";

/** Pretty JSON when the value is (or contains) a JSON object/array, else null. */
function asJson(v: Cell): string | null {
  if (v !== null && typeof v === "object") return JSON.stringify(v, null, 2);
  if (typeof v === "string" && /^\s*[[{]/.test(v)) {
    try { return JSON.stringify(JSON.parse(v), null, 2); } catch { return null; }
  }
  return null;
}

const TOKENS = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

// JSON with colors, built as React nodes (no innerHTML, so values can't inject markup).
function JsonView({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKENS)) {
    if (m.index! > last) parts.push(text.slice(last, m.index));
    const cls = m[1] ? (m[2] ? "jk" : "js") : m[3] ? "jb" : "jn";
    parts.push(<span key={m.index} className={cls}>{m[1] ?? m[0]}</span>);
    if (m[2]) parts.push(m[2]);
    last = m.index! + m[0].length;
  }
  parts.push(text.slice(last));
  return <pre className="ival json">{parts}</pre>;
}

// Right-hand panel: the selected cell in full (JSON pretty-printed) and the whole row.
// In the table view the value can be edited here (handy for long text and JSON).
export function Inspector({ columns, row, col, onPick, onEdit }: {
  columns: ColInfo[];
  row: Cell[] | null;
  col: number | null;
  onPick: (c: number) => void;
  onEdit?: (c: number, v: Cell) => void;
}) {
  const v = row && col != null ? row[col] ?? null : null;
  const [draft, setDraft] = useState("");
  // objects are edited pretty-printed; text (even JSON-looking text) is edited exactly as stored
  const baseline = v === null ? "" : typeof v === "object" ? JSON.stringify(v, null, 2) : cellText(v);
  useEffect(() => { setDraft(baseline); }, [baseline, col]);

  if (!row || col == null) return <aside className="insp"><div className="shead">Inspector</div><p className="empty-side">Select a cell to see its full value and the whole row.</p></aside>;
  const c = columns[col];
  const json = asJson(v);
  const copy = () => navigator.clipboard.writeText(v === null ? "" : json ?? cellText(v)).catch(() => {});

  return (
    <aside className="insp" aria-label="Inspector">
      <div className="shead"><span>{c.name} <span className="ty">{c.dataType}</span></span><button className="linkbtn" onClick={copy}>Copy</button></div>
      <div className="isec">
        {onEdit ? (
          <>
            <textarea className="ival edit" value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} aria-label={`Value of ${c.name}`} />
            <div className="frow">
              <button className="btn" onClick={() => onEdit(col, null)} disabled={v === null}>Set NULL</button>
              <span className="sp" />
              {/* JSON values (objects) are saved compact; text columns keep exactly what was typed */}
              <button className="btn pri" onClick={() => onEdit(col, v !== null && typeof v === "object" ? JSON.stringify(JSON.parse(draft)) : draft)}
                disabled={draft === baseline || (v !== null && typeof v === "object" && !isJson(draft))}>Apply</button>
            </div>
            {v !== null && typeof v === "object" && !isJson(draft) && <p className="note err">Not valid JSON yet.</p>}
          </>
        ) : v === null ? <pre className="ival nul">NULL</pre> : json ? <JsonView text={json} /> : <pre className="ival">{cellText(v)}</pre>}
        <p className="note">{v === null ? "NULL" : `${(json ?? cellText(v)).length.toLocaleString()} characters`}</p>
      </div>
      <div className="shead">Row</div>
      <dl className="irow">
        {columns.map((cc, i) => (
          <div key={i} className={i === col ? "on" : ""} onClick={() => onPick(i)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") onPick(i); }}>
            <dt>{cc.name}</dt><dd className={row[i] === null ? "nul" : ""}>{cellText(row[i] ?? null)}</dd>
          </div>
        ))}
      </dl>
    </aside>
  );
}

function isJson(s: string): boolean {
  try { JSON.parse(s); return true; } catch { return false; }
}
