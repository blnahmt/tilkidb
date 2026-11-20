import { useEffect, useMemo, useRef, useState } from "react";
import type { Table } from "../lib/api";
import { BOX_W, boxHeight, edges, HEAD_H, layout, mermaid, router, ROW_H, svgPath, tkey, type Box } from "../lib/erd";
import { saveSvgImage } from "./svgExport";
import { Icon } from "./Icons";

const short = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : String(n));

// Entity-relationship diagram of the connected schema. Orthogonal connectors with crow's-foot
// ends; drag tables, click to trace relations, double-click to open the table.
export function ErdView({ tables, onOpen, onToast }: { tables: Table[]; onOpen: (t: Table) => void; onToast: (m: string) => void }) {
  const [keysOnly, setKeysOnly] = useState(false);
  const [zoom, setZoom] = useState(0.85);
  const [focus, setFocus] = useState<string | null>(null);
  const [pos, setPos] = useState(() => layout(tables, false));
  const wrap = useRef<HTMLDivElement>(null);
  const drag = useRef<{ key: string; x: number; y: number; px: number; py: number; moved: boolean } | null>(null);
  const lastClick = useRef<{ key: string; t: number } | null>(null);
  const es = useMemo(() => edges(tables), [tables]);
  const byKey = useMemo(() => new Map(tables.map((t) => [tkey(t), t])), [tables]);

  useEffect(() => { setPos(layout(tables, keysOnly)); }, [tables, keysOnly]);

  const colsOf = (t: Table) => (keysOnly ? t.columns.filter((c) => c.pk || c.fk) : t.columns);
  const rowY = (t: Table, col: string) => {
    const p = pos.get(tkey(t))!;
    const cols = colsOf(t);
    const i = Math.max(0, cols.findIndex((c) => c.name === col));
    return p.y + HEAD_H + i * ROW_H + ROW_H / 2 + 3;
  };
  const pkCol = (t: Table) => t.columns.find((c) => c.pk)?.name ?? t.columns[0]?.name ?? "";
  const W = Math.max(600, ...[...pos.values()].map((p) => p.x + BOX_W + 60));
  const H = Math.max(400, ...tables.map((t) => (pos.get(tkey(t))?.y ?? 0) + boxHeight(t, keysOnly) + 60));

  // simple orthogonal path, used only when the router finds no way (boxes dragged on top of each other)
  const fallback = (from: Table, col: string, to: Table) => {
    const a = pos.get(tkey(from))!, b = pos.get(tkey(to))!;
    const sy = rowY(from, col), ty = rowY(to, pkCol(to));
    if (from === to) { const x = a.x + BOX_W; return `M${x} ${sy} H${x + 28} V${ty} H${x}`; } // self reference: loop on the right
    if (Math.abs(a.x - b.x) < BOX_W + 20) { const lx = Math.max(6, Math.min(a.x, b.x) - 28); return `M${a.x} ${sy} H${lx} V${ty} H${b.x}`; }
    const sx = b.x > a.x ? a.x + BOX_W : a.x, tx = b.x > a.x ? b.x : b.x + BOX_W, mx = Math.round((sx + tx) / 2);
    return `M${sx} ${sy} H${mx} V${ty} H${tx}`;
  };

  // edges routed around every table, recomputed when the layout changes
  const paths = useMemo(() => {
    const boxes = new Map<string, Box>();
    for (const t of tables) { const p = pos.get(tkey(t)); if (p) boxes.set(tkey(t), { x: p.x, y: p.y, w: BOX_W, h: boxHeight(t, keysOnly) }); }
    const ends = es.map((e) => { const from = byKey.get(e.from), to = byKey.get(e.to); return from && to && boxes.has(e.from) && boxes.has(e.to) ? { e, from, to, sy: rowY(from, e.col), ty: rowY(to, pkCol(to)) } : null; });
    const route = router([...boxes.values()], ends.flatMap((x) => (x ? [x.sy, x.ty] : [])));
    return ends.map((x) => {
      if (!x) return null;
      const pts = route(boxes.get(x.e.from)!, x.sy, boxes.get(x.e.to)!, x.ty);
      return pts ? svgPath(pts) : fallback(x.from, x.e.col, x.to);
    });
  }, [pos, keysOnly, es, byKey, tables]); // rowY/pkCol/fallback only read pos and keysOnly

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const dx = (e.clientX - d.x) / zoom, dy = (e.clientY - d.y) / zoom;
      if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
      if (d.moved) setPos((p) => new Map(p).set(d.key, { x: Math.max(0, Math.round(d.px + dx)), y: Math.max(0, Math.round(d.py + dy)) }));
    };
    const up = () => {
      const d = drag.current;
      drag.current = null;
      if (!d || d.moved) return;
      const now = Date.now();
      if (lastClick.current?.key === d.key && now - lastClick.current.t < 400) { lastClick.current = null; const t = byKey.get(d.key); if (t) onOpen(t); return; }
      lastClick.current = { key: d.key, t: now };
      setFocus((f) => (f === d.key ? null : d.key));
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
    return () => { removeEventListener("pointermove", move); removeEventListener("pointerup", up); };
  }, [zoom, byKey, onOpen]);

  const touches = (k: string) => !focus || k === focus || es.some((e) => (e.from === focus && e.to === k) || (e.to === focus && e.from === k));
  const fit = () => setZoom(Math.max(0.3, Math.min(1.5, +(((wrap.current?.clientWidth ?? 800) - 20) / W).toFixed(2))));
  const marker = (id: string, on: boolean) => (
    <marker id={id} viewBox="0 0 14 14" refX="13" refY="7" markerWidth="14" markerHeight="14" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
      <path className={`mk${on ? " on" : ""}`} d={id.startsWith("many") ? "M0 7 L13 1 M0 7 L13 13 M0 7 L13 7" : "M6 1 L6 13 M9.5 1 L9.5 13 M0 7 L13 7"} />
    </marker>
  );

  const exportAs = async (fmt: "svg" | "png") => {
    const svg = wrap.current?.querySelector("svg.erd") as SVGSVGElement | null;
    if (svg) saveSvgImage(svg, W, H, fmt, "diagram").then((m) => m && onToast(m));
  };

  if (!tables.length) return <div className="rempty">Connect to a database to see its diagram.</div>;

  return (
    <div className="erdpane">
      <div className="qtool">
        <div className="seg">
          <button className={keysOnly ? "" : "on"} aria-pressed={!keysOnly} onClick={() => setKeysOnly(false)}>All columns</button>
          <button className={keysOnly ? "on" : ""} aria-pressed={keysOnly} onClick={() => setKeysOnly(true)}>Keys only</button>
        </div>
        <button className="ibtn" onClick={() => setZoom((z) => Math.max(0.3, +(z - 0.1).toFixed(2)))} aria-label="Zoom out" title="Zoom out">−</button>
        <span className="ty zoomv">{Math.round(zoom * 100)}%</span>
        <button className="ibtn" onClick={() => setZoom((z) => Math.min(2, +(z + 0.1).toFixed(2)))} aria-label="Zoom in" title="Zoom in">+</button>
        <button className="btn" onClick={fit}><Icon name="fit" />Fit</button>
        <span className="sp" />
        <span className="ty">{tables.length} tables · {es.length} relations · drag to arrange · click to trace · double-click to open</span>
        <button className="btn" onClick={() => { setPos(layout(tables, keysOnly)); setFocus(null); }}><Icon name="refresh" />Reset layout</button>
        <button className="btn" onClick={() => navigator.clipboard.writeText(mermaid(tables)).then(() => onToast("Copied the diagram as Mermaid"), () => onToast("Clipboard is not available"))}><Icon name="code" />Copy as Mermaid</button>
        <button className="btn" onClick={() => exportAs("svg")}><Icon name="image" />Export SVG…</button>
        <button className="btn" onClick={() => exportAs("png")}><Icon name="image" />Export PNG…</button>
      </div>
      <div className="erdwrap" ref={wrap} onPointerDown={(e) => { if (e.target === e.currentTarget || (e.target as Element).tagName === "svg") setFocus(null); }}>
        <svg className="erd" viewBox={`0 0 ${W} ${H}`} width={Math.round(W * zoom)} height={Math.round(H * zoom)} role="img" aria-label="Entity relationship diagram">
          <defs>{marker("many", false)}{marker("one", false)}{marker("manyOn", true)}{marker("oneOn", true)}</defs>
          {es.map((e, i) => {
            const from = byKey.get(e.from)!, to = byKey.get(e.to)!, d = paths[i];
            if (!d) return null;
            const on = !!focus && (e.from === focus || e.to === focus);
            return (
              <path key={i} className={`edge${on ? " on" : ""}${focus && !on ? " dim" : ""}`} d={d} markerStart={`url(#${on ? "manyOn" : "many"})`} markerEnd={`url(#${on ? "oneOn" : "one"})`}>
                <title>{`${from.name}.${e.col} → ${to.name} (many to one)`}</title>
              </path>
            );
          })}
          {tables.map((t) => {
            const k = tkey(t), p = pos.get(k);
            if (!p) return null;
            return (
              <g key={k} className={`tbl${focus === k ? " on" : ""}${touches(k) ? "" : " dim"}`} transform={`translate(${p.x},${p.y})`}
                onPointerDown={(e) => { e.preventDefault(); drag.current = { key: k, x: e.clientX, y: e.clientY, px: p.x, py: p.y, moved: false }; }}>
                <rect className="box" x={0.5} y={0.5} width={BOX_W} height={boxHeight(t, keysOnly)} />
                <rect className="hd" x={1} y={1} width={BOX_W - 1} height={HEAD_H} />
                <text className="tn" x={12} y={22}>{t.name.length > 24 ? `${t.name.slice(0, 23)}…` : t.name}</text>
                <text className="rc" x={BOX_W - 12} y={22} textAnchor="end">{t.kind === "view" ? "view" : t.rows != null ? `${short(t.rows)} rows` : ""}</text>
                {colsOf(t).map((c, i) => {
                  const y = HEAD_H + i * ROW_H + ROW_H / 2 + 7;
                  return (
                    <g key={c.name}>
                      {(c.pk || c.fk) && <text className={`kb${c.pk ? "" : " fk"}`} x={12} y={y}>{c.pk ? "PK" : "FK"}</text>}
                      <text className="cn" x={38} y={y}>{c.name.length > 20 ? `${c.name.slice(0, 19)}…` : c.name}</text>
                      <text className="ct" x={BOX_W - 12} y={y} textAnchor="end">{c.dataType.length > 14 ? `${c.dataType.slice(0, 13)}…` : c.dataType}</text>
                    </g>
                  );
                })}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
