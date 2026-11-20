import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Cell } from "../lib/api";
import { fromInputDateTime, toInputDateTime } from "../lib/celltypes";

export type CellEditorSpec =
  | { kind: "fk"; table: string; search: (q: string) => Promise<{ value: Cell; label: string }[]> }
  | { kind: "enum"; options: string[] }
  | { kind: "bool" }
  | { kind: "date" }
  | { kind: "datetime" }
  | { kind: "json" };

const text = (v: Cell) => (v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

/**
 * The editor inside a grid cell for a typed column. `done(value)` commits (undefined = no change),
 * `move` says where the selection goes next. Plain text columns keep the grid's own input.
 */
export function CellEditor({ spec, value, nullable, done }: {
  spec: Exclude<CellEditorSpec, { kind: "json" }>;
  value: Cell;
  nullable: boolean;
  done: (v: Cell | undefined, move?: [number, number]) => void;
}) {
  const keys = (e: React.KeyboardEvent<HTMLInputElement | HTMLSelectElement>, commit: () => Cell | undefined) => {
    if (e.key === "Enter") { e.preventDefault(); done(commit(), [1, 0]); }
    else if (e.key === "Tab") { e.preventDefault(); done(commit(), [0, e.shiftKey ? -1 : 1]); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(undefined); }
  };
  if (spec.kind === "fk") return <FkEditor spec={spec} value={value} done={done} />;
  if (spec.kind === "enum" || spec.kind === "bool") {
    const NULL = "\u0000null";
    const cur = value === null ? NULL : spec.kind === "bool" ? (value === true || value === 1 || value === "1" || value === "t" || value === "true" || value === "0x01" ? "true" : "false") : text(value);
    const opts = spec.kind === "bool" ? ["true", "false"] : spec.options;
    const pick = (s: string): Cell => (s === NULL ? null : spec.kind === "bool" ? s === "true" : s);
    return (
      <select autoFocus defaultValue={cur} aria-label="Value" onKeyDown={(e) => keys(e, () => pick(e.currentTarget.value))}
        onChange={(e) => done(pick(e.currentTarget.value), [0, 0])} onBlur={() => done(undefined)}>
        {nullable && <option value={NULL}>NULL</option>}
        {!opts.includes(cur) && cur !== NULL && <option value={cur}>{cur}</option>}
        {opts.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }
  return <DateEditor dt={spec.kind === "datetime"} value={value} nullable={nullable} keys={keys} done={done} />;
}

// Date / datetime picker: commits only when the value was actually changed.
function DateEditor({ dt, value, nullable, keys, done }: {
  dt: boolean; value: Cell; nullable: boolean;
  keys: (e: React.KeyboardEvent<HTMLInputElement>, commit: () => Cell | undefined) => void;
  done: (v: Cell | undefined, move?: [number, number]) => void;
}) {
  const changed = useRef(false);
  const toVal = (s: string): Cell | undefined => (!changed.current ? undefined : s === "" ? (nullable ? null : undefined) : dt ? fromInputDateTime(s) : s);
  return (
    <input autoFocus type={dt ? "datetime-local" : "date"} step={dt ? 1 : undefined} aria-label="Value"
      defaultValue={value === null ? "" : dt ? toInputDateTime(text(value)) : text(value).slice(0, 10)}
      onChange={() => { changed.current = true; }}
      onKeyDown={(e) => keys(e, () => toVal(e.currentTarget.value))} onBlur={(e) => done(toVal(e.currentTarget.value))} />
  );
}

// Foreign key: type to search the parent table (by key or a label column) and pick a row.
function FkEditor({ spec, value, done }: { spec: Extract<CellEditorSpec, { kind: "fk" }>; value: Cell; done: (v: Cell | undefined, move?: [number, number]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState(text(value));
  const [items, setItems] = useState<{ value: Cell; label: string }[] | null>(null);
  const [hi, setHi] = useState(-1);
  const [box, setBox] = useState<{ left: number; top: number; width: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useLayoutEffect(() => {
    const r = input.current!.getBoundingClientRect();
    setBox({ left: r.left, top: r.bottom, width: Math.max(260, r.width) });
    input.current!.select();
  }, []);
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      // the current value matches itself: search from empty so the list shows neighbours
      spec.search(q === text(value) ? "" : q).then((r) => { if (live) { setItems(r); setErr(null); setHi(-1); } }, (e) => { if (live) setErr(String(e)); });
    }, 180);
    return () => { live = false; clearTimeout(t); };
  }, [q]); // deps chosen on purpose
  const commit = (): Cell | undefined => (hi >= 0 && items?.[hi] ? items[hi].value : q === text(value) ? undefined : q);
  return (
    <>
      <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} aria-label={`Value (search ${spec.table})`} spellCheck={false} role="combobox" aria-expanded={!!items?.length}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => Math.min((items?.length ?? 0) - 1, h + 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(-1, h - 1)); }
          else if (e.key === "Enter") { e.preventDefault(); done(commit(), [1, 0]); }
          else if (e.key === "Tab") { e.preventDefault(); done(commit(), [0, e.shiftKey ? -1 : 1]); }
          else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(undefined); }
        }}
        onBlur={() => done(q === text(value) ? undefined : q)} />
      {box && (
        <div className="fkpick" style={{ left: box.left, top: box.top, width: box.width }} role="listbox" onMouseDown={(e) => e.preventDefault()}>
          <div className="fkhead">{spec.table}{items ? ` · ${items.length}${items.length === 20 ? "+" : ""} match${items.length === 1 ? "" : "es"}` : " · searching…"}</div>
          {err && <div className="fkerr">{err}</div>}
          {items?.map((it, i) => (
            <button key={i} role="option" aria-selected={i === hi} className={i === hi ? "on" : ""} onMouseEnter={() => setHi(i)} onClick={() => done(it.value, [0, 0])}>
              <b>{text(it.value)}</b>{it.label && <span>{it.label}</span>}
            </button>
          ))}
          {items && !items.length && <div className="fkerr">No rows match. Enter keeps what you typed.</div>}
        </div>
      )}
    </>
  );
}

// JSON: a dialog with a bigger editor, formatting and a validity check.
export function JsonDialog({ column, value, onSave, onClose }: { column: string; value: Cell; onSave: (v: string | null | undefined) => void; onClose: () => void }) {
  const [initial] = useState(() => { const t = text(value); try { return t ? JSON.stringify(JSON.parse(t), null, 2) : ""; } catch { return t; } });
  const [src, setSrc] = useState(initial);
  let error: string | null = null;
  try { if (src.trim()) JSON.parse(src); } catch (e) { error = e instanceof Error ? e.message : String(e); }
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide" role="dialog" aria-modal="true" aria-labelledby="js-title" onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}>
        <h3 id="js-title">Edit {column}</h3>
        <textarea className="jsonedit mono" autoFocus value={src} onChange={(e) => setSrc(e.target.value)} spellCheck={false} aria-label="JSON value" />
        <p className={`note${error ? " err" : ""}`}>{error ? `Not valid JSON: ${error}` : src.trim() ? "Valid JSON." : "Empty: saves NULL."}</p>
        <div className="acts">
          <button className="btn" onClick={() => { try { setSrc(JSON.stringify(JSON.parse(src), null, 2)); } catch { /* shown above */ } }} disabled={!!error || !src.trim()}>Format</button>
          <button className="btn" onClick={() => { try { setSrc(JSON.stringify(JSON.parse(src))); } catch { /* shown above */ } }} disabled={!!error || !src.trim()}>Compact</button>
          <span className="sp" />
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn pri" disabled={!!error} onClick={() => onSave(src === initial ? undefined : src.trim() ? src.trim() : null)}>Apply</button>
        </div>
      </div>
    </div>
  );
}
