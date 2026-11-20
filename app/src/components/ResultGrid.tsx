import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import type { Cell, ColInfo, Engine } from "../lib/api";
import { columnStats, copyText, parseClipboard, type ColumnStats, type CopyFormat } from "../lib/gridcopy";
import { CellEditor, JsonDialog, type CellEditorSpec } from "./CellEditors";
import { fitsPicker } from "../lib/celltypes";
import { getSettings } from "../lib/settings";
import { Icon, type IconName } from "./Icons";

/** Row height for the current density (matches --rh in app.css). */
export const rowHeight = () => ({ compact: 22, spacious: 30 } as Record<string, number>)[document.documentElement.dataset.density ?? ""] ?? 26;
export const HEAD = 38; // header height
const RN = 56; // row-number column
// Browsers cap an element's height (~33.5M device px; at 150% scaling 1M rows already pass it). Beyond
// this the scroll position maps proportionally onto the rows, so the last row is always reachable.
const MAX_BODY = 8_000_000;
const NUMERIC = /int|float|double|real|numeric|decimal|money|serial/i;

export const cellText = (v: Cell): string => (v === null ? getSettings().nullText : typeof v === "object" ? JSON.stringify(v) : String(v));

/** Editing hooks for the table view. Without them the grid is read-only. */
export interface GridEdit {
  value: (r: number, c: number) => Cell; // current value, including pending edits
  isEdited: (r: number, c: number) => boolean;
  rowState: (r: number) => "deleted" | "new" | null;
  onEdit: (r: number, c: number, v: Cell) => void;
  onToggleDelete: (r: number) => void;
  addRows?: (n: number) => void; // pasting past the last row adds new rows
  editor?: (c: number) => CellEditorSpec | null; // typed editors (foreign key, enum, date, JSON…)
  nullable?: (c: number) => boolean;
}

type Pos = { r: number; c: number }; // c = index into `columns`

// Virtualized result table: only the rows on screen are in the DOM. `rows` is appended to in place
// while a query streams; the parent re-renders on each batch.
// Selection: click, Shift+click / drag / Shift+arrows for a range, Ctrl+A for all; Ctrl+C copies it
// (Ctrl+Shift+C with headers); right-click for other formats, column stats, hide / pin / resize.
// Editing (when `edit` is given): double-click / Enter / F2 edits, Shift+Delete sets NULL,
// Ctrl+Delete marks the row for deletion.
export function ResultGrid({ columns, rows, edit, onSelect, engine, tableName, onHeaderFilter, filtered }: {
  columns: ColInfo[];
  rows: Cell[][];
  edit?: GridEdit;
  onSelect?: (r: number | null, c: number | null) => void;
  engine?: Engine; // for "Copy as INSERT"
  tableName?: string; // quoted INSERT target
  onHeaderFilter?: (c: number, at: { x: number; y: number }) => void; // table view: filter from a column header
  filtered?: Set<string>; // column names with an active filter
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const RH = rowHeight();
  const [top, setTop] = useState(0);
  const [height, setHeight] = useState(400);
  const [sel, setSel] = useState<Pos | null>(null);
  const [anchor, setAnchor] = useState<Pos | null>(null);
  const [editing, setEditing] = useState<Pos | null>(null);
  const editingRef = useRef<Pos | null>(null);
  editingRef.current = editing;
  const [jsonEdit, setJsonEdit] = useState<Pos | null>(null);
  const [bulk, setBulk] = useState<{ text: string; isNull: boolean } | null>(null);
  const [custom, setCustom] = useState<Record<number, number>>({}); // widths set by dragging
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const [pinned, setPinned] = useState(0); // leading visible columns that stay put when scrolling sideways
  const [menu, setMenu] = useState<{ x: number; y: number; col: number | null } | null>(null);
  const [stats, setStats] = useState<{ col: number; s: ColumnStats; x: number; y: number } | null>(null);
  const dragging = useRef(false);
  const sample = Math.min(rows.length, 200);
  const value = (r: number, c: number): Cell => (edit ? edit.value(r, c) : rows[r]?.[c] ?? null);

  useEffect(() => {
    const el = wrap.current!;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    const up = () => { dragging.current = false; };
    addEventListener("mouseup", up);
    return () => { ro.disconnect(); removeEventListener("mouseup", up); };
  }, []);
  useEffect(() => { setSel(null); setAnchor(null); setEditing(null); setCustom({}); setHidden(new Set()); setPinned(0); wrap.current?.scrollTo(0, 0); }, [columns]);
  useEffect(() => { onSelect?.(sel?.r ?? null, sel?.c ?? null); }, [sel?.r, sel?.c]); // only when the selection moves
  useEffect(() => {
    if (!menu && !stats) return;
    const close = () => { setMenu(null); setStats(null); };
    const esc = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") close(); };
    addEventListener("mousedown", close);
    addEventListener("keydown", esc);
    return () => { removeEventListener("mousedown", close); removeEventListener("keydown", esc); };
  }, [menu, stats]);

  // width from the header and the first rows' content, measured once enough rows have arrived
  const auto = useMemo(() => columns.map((c, i) => {
    let len = Math.max(c.name.length, c.dataType.length * 0.8);
    for (let r = 0; r < sample; r++) len = Math.max(len, Math.min(48, cellText(rows[r][i]).length));
    return Math.round(Math.min(380, Math.max(72, len * 7.4 + 22)));
  }), [columns, sample]); // rows is mutated in place; `sample` tells us when more have arrived
  const width = (i: number) => custom[i] ?? auto[i];
  const vis = useMemo(() => columns.map((_, i) => i).filter((i) => !hidden.has(i)), [columns, hidden]);
  const visPos = (c: number) => vis.indexOf(c);
  const left: Record<number, number> = {}; // sticky offsets of pinned columns
  { let x = RN; vis.slice(0, pinned).forEach((c) => { left[c] = x; x += width(c); }); }
  const pinStyle = (c: number, w: number): CSSProperties => (c in left ? { width: w, position: "sticky", left: left[c], zIndex: 2 } : { width: w });

  const total = RN + vis.reduce((a, c) => a + width(c), 0);
  const full = rows.length * RH, body = Math.min(full, MAX_BODY), view = Math.max(1, height - HEAD);
  const scale = full > body ? (full - view) / Math.max(1, body - view) : 1; // scroll px -> row px
  const vTop = top * scale;
  const start = Math.max(0, Math.floor(vTop / RH) - 6);
  const end = Math.min(rows.length, start + Math.ceil(height / RH) + 14);

  // the selected rectangle in row / visible-column space
  const range = sel && anchor ? { r0: Math.min(sel.r, anchor.r), r1: Math.max(sel.r, anchor.r), p0: Math.min(visPos(sel.c), visPos(anchor.c)), p1: Math.max(visPos(sel.c), visPos(anchor.c)) } : null;
  const inRange = (r: number, c: number) => !!range && r >= range.r0 && r <= range.r1 && visPos(c) >= range.p0 && visPos(c) <= range.p1;
  const multi = !!range && (range.r0 !== range.r1 || range.p0 !== range.p1);

  const scrollTo = (r: number) => {
    const el = wrap.current!;
    const at = el.scrollTop * scale;
    if (r * RH < at) el.scrollTop = (r * RH) / scale;
    else if ((r + 1) * RH > at + el.clientHeight - HEAD) el.scrollTop = ((r + 1) * RH - el.clientHeight + HEAD) / scale;
  };
  // sideways too: keep the column clear of the row numbers and pinned columns, which stay on the left
  const scrollToCol = (c: number) => {
    const el = wrap.current!;
    const p = visPos(c);
    if (p < 0 || p < pinned) return; // pinned columns are always on screen
    const x = RN + vis.slice(0, p).reduce((a, i) => a + width(i), 0), w = width(c);
    const covered = RN + vis.slice(0, pinned).reduce((a, i) => a + width(i), 0);
    if (x - covered < el.scrollLeft) el.scrollLeft = x - covered;
    else if (x + w > el.scrollLeft + el.clientWidth) el.scrollLeft = x + w - el.clientWidth;
  };
  const select = (r: number, c: number, extend = false) => {
    setSel({ r, c });
    if (!extend) setAnchor({ r, c });
    scrollTo(r);
    scrollToCol(c);
  };

  const copy = (fmt: CopyFormat, headers = false) => {
    if (!range) return;
    const cs = vis.slice(range.p0, range.p1 + 1);
    const data: Cell[][] = [];
    for (let r = range.r0; r <= range.r1; r++) data.push(cs.map((c) => value(r, c)));
    navigator.clipboard.writeText(copyText(cs.map((c) => columns[c].name), data, fmt, { headers, engine, table: tableName })).catch(() => {});
  };

  const startEdit = (r: number, c: number) => {
    if (!edit || edit.rowState(r) === "deleted") return;
    if (edit.editor?.(c)?.kind === "json") setJsonEdit({ r, c }); else setEditing({ r, c });
  };
  // typed editors hand back a value (undefined = unchanged)
  const finishValue = (v: Cell | undefined, move: [number, number] = [0, 0]) => {
    const e = editingRef.current;
    if (!e) return;
    editingRef.current = null;
    if (v !== undefined && JSON.stringify(v) !== JSON.stringify(value(e.r, e.c))) edit!.onEdit(e.r, e.c, v);
    setEditing(null);
    const p = Math.max(0, Math.min(vis.length - 1, visPos(e.c) + move[1]));
    select(Math.max(0, Math.min(rows.length - 1, e.r + move[0])), vis[p]);
    wrap.current?.focus();
  };
  // every editable cell in the selected rectangle
  const rangeCells = () => {
    const out: Pos[] = [];
    if (!range || !edit) return out;
    for (let r = range.r0; r <= range.r1; r++) if (edit.rowState(r) !== "deleted") for (const c of vis.slice(range.p0, range.p1 + 1)) out.push({ r, c });
    return out;
  };
  // Ctrl+V: a block of cells from a spreadsheet or the grid; one value fills the whole selection
  const paste = (text: string) => {
    if (!edit || !sel) return;
    const data = parseClipboard(text);
    if (!data.length) return;
    if (data.length === 1 && data[0].length === 1 && multi) { for (const p of rangeCells()) edit.onEdit(p.r, p.c, data[0][0]); return; }
    const r0 = range ? range.r0 : sel.r, p0 = range ? range.p0 : visPos(sel.c);
    const extra = r0 + data.length - rows.length;
    if (extra > 0) { if (!edit.addRows) return; edit.addRows(extra); }
    data.forEach((cells, i) => {
      const r = r0 + i;
      if (r < rows.length && edit.rowState(r) === "deleted") return;
      cells.forEach((v, j) => { const c = vis[p0 + j]; if (c !== undefined) edit.onEdit(r, c, v); });
    });
    setAnchor({ r: r0, c: vis[p0] }); setSel({ r: Math.min(r0 + data.length - 1, rows.length + Math.max(0, extra) - 1), c: vis[Math.min(vis.length - 1, p0 + Math.max(...data.map((d) => d.length)) - 1)] });
  };

  const finishEdit = (text: string | null, move: [number, number] = [0, 0]) => {
    if (!editing) return;
    const { r, c } = editing;
    const cur = value(r, c);
    // unchanged text is not an edit; a NULL cell left blank stays NULL (Shift+Delete sets NULL)
    const same = text === null || (cur === null ? text === "" : text === cellText(cur));
    if (!same) edit!.onEdit(r, c, text);
    setEditing(null);
    const p = Math.max(0, Math.min(vis.length - 1, visPos(c) + move[1]));
    select(Math.max(0, Math.min(rows.length - 1, r + move[0])), vis[p]);
    wrap.current?.focus();
  };

  const onKey = (e: KeyboardEvent) => {
    if (editing) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "a" && rows.length && vis.length) {
      e.preventDefault();
      setAnchor({ r: 0, c: vis[0] }); setSel({ r: rows.length - 1, c: vis[vis.length - 1] });
      return;
    }
    if (!sel) return;
    if (mod && e.key.toLowerCase() === "c") {
      e.preventDefault();
      copy("tsv", e.shiftKey);
    } else if (edit && (e.key === "Enter" || e.key === "F2")) {
      e.preventDefault();
      startEdit(sel.r, sel.c);
    } else if (edit && e.key === "Delete" && e.shiftKey) {
      e.preventDefault();
      if (edit.rowState(sel.r) !== "deleted") edit.onEdit(sel.r, sel.c, null);
    } else if (edit && e.key === "Delete" && mod) {
      e.preventDefault();
      edit.onToggleDelete(sel.r);
    } else {
      const move = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[e.key];
      if (move) {
        e.preventDefault();
        const p = Math.max(0, Math.min(vis.length - 1, visPos(sel.c) + move[1]));
        select(Math.max(0, Math.min(rows.length - 1, sel.r + move[0])), vis[p], e.shiftKey);
      }
    }
  };

  const startResize = (e: React.PointerEvent, c: number) => {
    e.preventDefault(); e.stopPropagation();
    const x0 = e.clientX, w0 = width(c);
    const move = (ev: PointerEvent) => setCustom((m) => ({ ...m, [c]: Math.max(40, Math.round(w0 + ev.clientX - x0)) }));
    const up = () => { removeEventListener("pointermove", move); removeEventListener("pointerup", up); };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  };
  const openMenu = (e: ReactMouseEvent, col: number | null) => {
    e.preventDefault();
    setStats(null);
    setMenu({ x: e.clientX, y: e.clientY, col });
  };
  const item = (label: string, run: () => void, disabled = false, icon?: IconName) => (
    <button key={label} className="mi" disabled={disabled} onMouseDown={(e) => e.stopPropagation()} onClick={() => { setMenu(null); run(); }}>{icon ? <Icon name={icon} /> : <span className="mis" />}{label}</button>
  );

  return (
    <div className="grid" ref={wrap} tabIndex={0} onScroll={(e) => setTop(e.currentTarget.scrollTop)} onKeyDown={onKey}
      onPaste={(e) => { if (edit && sel && !editing && !jsonEdit) { e.preventDefault(); paste(e.clipboardData.getData("text/plain")); } }} aria-label="Query results" role="grid" aria-rowcount={rows.length} aria-multiselectable="true">
      <div className="grid-in" style={{ width: total, height: HEAD + body }}>
        <div className="ghead" style={{ width: total }}>
          <div className="gh rn" style={{ width: RN }} title="Select all (Ctrl+A)" onClick={() => { if (rows.length && vis.length) { setAnchor({ r: 0, c: vis[0] }); setSel({ r: rows.length - 1, c: vis[vis.length - 1] }); } }}>#</div>
          {vis.map((i) => (
            <div key={i} className={`gh${i in left ? " pin" : ""}`} style={pinStyle(i, width(i))} title={`${columns[i].name} · ${columns[i].dataType}`} role="columnheader"
              onContextMenu={(e) => openMenu(e, i)}
              onClick={() => { if (rows.length) { setAnchor({ r: 0, c: i }); setSel({ r: rows.length - 1, c: i }); } }}>
              <b>{columns[i].name}</b><span>{columns[i].dataType}</span>
              {onHeaderFilter && (
                <button className={`gfil${filtered?.has(columns[i].name) ? " on" : ""}`} aria-label={`Filter ${columns[i].name}`} title={filtered?.has(columns[i].name) ? "Filtered · click to change" : "Filter this column"}
                  onClick={(e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); onHeaderFilter(i, { x: r.left, y: r.bottom }); }}>
                  <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M1 2h10L7 6.5V10L5 11V6.5Z" /></svg>
                </button>
              )}
              <span className="grz" onPointerDown={(e) => startResize(e, i)} onClick={(e) => e.stopPropagation()} onDoubleClick={() => setCustom((m) => { const n = { ...m }; delete n[i]; return n; })} title="Drag to resize · double-click to reset" />
            </div>
          ))}
        </div>
        <div className="grows" style={{ top: HEAD + top + (start * RH - vTop) }}>
          {rows.slice(start, end).map((_, k) => {
            const r = start + k;
            const state = edit?.rowState(r) ?? null;
            return (
              <div className={`gr${state ? ` ${state}` : ""}`} key={r} role="row">
                <div className="gc rn" style={{ width: RN }} title={state === "deleted" ? "Will be deleted" : state === "new" ? "New row" : "Select row"}
                  onMouseDown={(e) => { if (!vis.length) return; if (e.shiftKey && anchor) setSel({ r, c: vis[vis.length - 1] }); else { setAnchor({ r, c: vis[0] }); setSel({ r, c: vis[vis.length - 1] }); } }}>
                  {state === "new" ? "+" : (r + 1).toLocaleString()}
                </div>
                {vis.map((c) => {
                  const col = columns[c];
                  const v = value(r, c);
                  const typed = editing?.r === r && editing.c === c ? edit?.editor?.(c) : null;
                  // values a picker would mangle (fractional seconds, year 0) keep the plain text editor
                  const spec = typed && (typed.kind === "date" || typed.kind === "datetime") && !fitsPicker(typed.kind, v) ? null : typed;
                  if (spec && spec.kind !== "json") {
                    return <div key={c} className="gc editing" style={pinStyle(c, width(c))}><CellEditor spec={spec} value={v} nullable={edit?.nullable?.(c) ?? true} done={finishValue} /></div>;
                  }
                  if (editing?.r === r && editing.c === c) {
                    return (
                      <div key={c} className="gc editing" style={pinStyle(c, width(c))}>
                        <input autoFocus defaultValue={v === null ? "" : cellText(v)} aria-label={`Edit ${col.name}`} spellCheck={false}
                          onFocus={(e) => e.currentTarget.select()}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") { e.preventDefault(); finishEdit(e.currentTarget.value, [1, 0]); }
                            else if (e.key === "Tab") { e.preventDefault(); finishEdit(e.currentTarget.value, [0, e.shiftKey ? -1 : 1]); }
                            else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finishEdit(null); }
                          }}
                          onBlur={(e) => { if (editing) finishEdit(e.currentTarget.value); }} />
                      </div>
                    );
                  }
                  const num = typeof v === "number" || (typeof v === "string" && NUMERIC.test(col.dataType));
                  const cls = v === null ? " nul" : typeof v === "object" ? " js" : typeof v === "boolean" ? " bool" : num ? " num" : "";
                  const isSel = sel?.r === r && sel.c === c;
                  return (
                    <div key={c} role="gridcell" aria-selected={inRange(r, c)}
                      className={`gc${cls}${edit?.isEdited(r, c) ? " edited" : ""}${isSel ? " sel" : ""}${multi && inRange(r, c) ? " inrange" : ""}${c in left ? " pin" : ""}`} style={pinStyle(c, width(c))}
                      onMouseDown={(e) => { if (e.button !== 0) return; if (e.shiftKey && anchor) setSel({ r, c }); else { setSel({ r, c }); setAnchor({ r, c }); } dragging.current = true; }}
                      onMouseEnter={() => { if (dragging.current) setSel({ r, c }); }}
                      onContextMenu={(e) => { if (!inRange(r, c)) { setSel({ r, c }); setAnchor({ r, c }); } openMenu(e, c); }}
                      onDoubleClick={() => startEdit(r, c)}
                      title={v !== null && cellText(v).length > 40 ? cellText(v).slice(0, 2000) : undefined}>
                      {cellText(v)}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
      {menu && (
        <div className="gmenu" style={{ left: Math.min(menu.x, innerWidth - 230), top: Math.min(menu.y, innerHeight - 330) }} role="menu" onMouseDown={(e) => e.stopPropagation()}>
          {item(`Copy${multi ? " selection" : ""}  (Ctrl+C)`, () => copy("tsv"), !range, "copy")}
          {item("Copy with headers", () => copy("tsv", true), !range)}
          {item("Copy as CSV", () => copy("csv"), !range)}
          {item("Copy as JSON", () => copy("json"), !range)}
          {item("Copy as INSERT", () => copy("insert"), !range)}
          {item("Copy as Markdown table", () => copy("markdown"), !range)}
          <hr />
          {edit && range && item(`Set value in ${multi ? `${rangeCells().length} cells` : "this cell"}…`, () => setBulk({ text: "", isNull: false }), !rangeCells().length, "edit")}
          {menu.col != null && onHeaderFilter && item(`Filter by ${columns[menu.col].name}…`, () => onHeaderFilter(menu.col!, { x: menu.x, y: menu.y }), false, "filter")}
          {menu.col != null && item(`Column stats: ${columns[menu.col].name}`, () => setStats({ col: menu.col!, s: columnStats(rows.map((r) => r[menu.col!] ?? null)), x: menu.x, y: menu.y }), false, "chart")}
          {menu.col != null && item(visPos(menu.col) < pinned ? "Unpin columns" : "Pin columns up to here", () => setPinned(visPos(menu.col!) < pinned ? 0 : visPos(menu.col!) + 1), false, "pin")}
          {menu.col != null && item(`Hide ${columns[menu.col].name}`, () => { setHidden(new Set(hidden).add(menu.col!)); if (sel?.c === menu.col) { setSel(null); setAnchor(null); } }, vis.length <= 1)}
          {item(`Show all columns${hidden.size ? ` (${hidden.size} hidden)` : ""}`, () => setHidden(new Set()), !hidden.size)}
          {item("Reset column widths", () => setCustom({}), !Object.keys(custom).length, "fit")}
        </div>
      )}
      {jsonEdit && edit && (
        <JsonDialog column={columns[jsonEdit.c].name} value={value(jsonEdit.r, jsonEdit.c)} onClose={() => { setJsonEdit(null); wrap.current?.focus(); }}
          onSave={(v) => { if (v !== undefined) edit.onEdit(jsonEdit.r, jsonEdit.c, v); setJsonEdit(null); wrap.current?.focus(); }} />
      )}
      {bulk && edit && (
        <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && setBulk(null)}>
          <div className="modal small" role="dialog" aria-modal="true" aria-labelledby="bk-title" onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setBulk(null); } }}>
            <h3 id="bk-title">Set value</h3>
            <p className="note">Applies to {rangeCells().length.toLocaleString()} selected cell{rangeCells().length === 1 ? "" : "s"}. Nothing is written until you commit.</p>
            <div className="f"><label htmlFor="bk-v">Value</label>
              <input id="bk-v" autoFocus value={bulk.text} disabled={bulk.isNull} onChange={(e) => setBulk({ ...bulk, text: e.target.value })} spellCheck={false}
                onKeyDown={(e) => { if (e.key === "Enter") (e.currentTarget.closest(".modal")!.querySelector(".btn.pri") as HTMLButtonElement).click(); }} /></div>
            <label className="check"><input type="checkbox" checked={bulk.isNull} onChange={(e) => setBulk({ ...bulk, isNull: e.target.checked })} /> NULL</label>
            <div className="acts"><button className="btn" onClick={() => setBulk(null)}>Cancel</button>
              <button className="btn pri" onClick={() => { for (const p of rangeCells()) edit.onEdit(p.r, p.c, bulk.isNull ? null : bulk.text); setBulk(null); wrap.current?.focus(); }}>Apply</button></div>
          </div>
        </div>
      )}
      {stats && (
        <div className="gmenu gstats" style={{ left: Math.min(stats.x, innerWidth - 260), top: Math.min(stats.y, innerHeight - 220) }} onMouseDown={(e) => e.stopPropagation()}>
          <b>{columns[stats.col].name}</b><span className="ty">over {stats.s.count.toLocaleString()} loaded rows</span>
          <dl>
            <dt>NULL</dt><dd>{stats.s.nulls.toLocaleString()} ({stats.s.count ? Math.round((stats.s.nulls / stats.s.count) * 100) : 0}%)</dd>
            <dt>Distinct</dt><dd>{stats.s.distinct.toLocaleString()}</dd>
            <dt>Min</dt><dd className="mono" title={stats.s.min}>{stats.s.min}</dd>
            <dt>Max</dt><dd className="mono" title={stats.s.max}>{stats.s.max}</dd>
            {stats.s.avg != null && <><dt>Average</dt><dd className="mono">{stats.s.avg.toLocaleString(undefined, { maximumFractionDigits: 4 })}</dd></>}
          </dl>
        </div>
      )}
    </div>
  );
}
