import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Cell, ColInfo } from "../lib/api";
import { aggregate, isNumeric, niceTicks, pieSlices } from "../lib/chart";
import { saveSvgImage } from "./svgExport";
import { Icon } from "./Icons";

/** Mouse position inside the chart's <svg> (offsetX is relative to whatever shape is under the mouse). */
const inSvg = (e: { clientX: number; clientY: number; currentTarget: Element }) => {
  const svg = e.currentTarget instanceof SVGSVGElement ? e.currentTarget : (e.currentTarget as SVGElement).ownerSVGElement!;
  const r = svg.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
};

const fmt = (v: number) => (Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : Math.abs(v) >= 1e4 ? `${(v / 1e3).toFixed(0)}k` : Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 2 }));
const MAX_SERIES = 4; // the validated categorical slots; past that, chart it in two goes
const color = (k: number, n: number) => (n === 1 ? "var(--accent)" : `var(--ser${k + 1})`);

// Quick chart of the loaded result: up to four series, grouped by an X column, summing number
// columns (or counting rows). Bar charts are horizontal so long category names stay readable.
export function ChartView({ columns, rows }: { columns: ColInfo[]; rows: Cell[][] }) {
  // rows is appended to in place, so its length stands in for "the data changed"
  const numericCols = useMemo(() => columns.map((_, i) => i).filter((i) => isNumeric(rows, i)), [columns, rows.length]);
  const [kind, setKind] = useState<"bar" | "line" | "pie">("bar");
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { if (!msg) return; const t = setTimeout(() => setMsg(null), 4000); return () => clearTimeout(t); }, [msg]);
  const [x, setX] = useState(() => Math.max(0, columns.findIndex((_, i) => !numericCols.includes(i))));
  // default Y: a number column that is not a key (summing ids means nothing); else Row count
  const firstMeasure = (xi: number) => numericCols.find((i) => i !== xi && !/(^|_)id$/i.test(columns[i].name));
  const [ys, setYs] = useState<number[]>(() => [firstMeasure(x) ?? -1]);
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(700);
  const [hover, setHover] = useState<{ i: number; left: number; top: number } | null>(null);

  useEffect(() => {
    const el = wrap.current!;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => { // a new result: pick a category column for X and a number column for Y
    const nx = Math.max(0, columns.findIndex((_, i) => !numericCols.includes(i)));
    setX(nx);
    setYs([firstMeasure(nx) ?? -1]);
  }, [columns]);
  useEffect(() => setHover(null), [kind, x, ys, columns]); // a stale hover would point at the wrong mark

  // categories come from the first series; the others are looked up by label ("Other" = the rest)
  const { labels, series } = useMemo(() => {
    if (x < 0 || x >= columns.length) return { labels: [] as string[], series: [] as number[][] };
    // a pie gets the four biggest slices plus "Other": one per categorical color
    const first = kind === "pie" ? aggregate(rows, x, ys[0], "bar", 5) : aggregate(rows, x, ys[0], kind);
    if (kind === "pie") return { labels: first.map((p) => p.label), series: [first.map((p) => p.value)] };
    const labels = first.map((p) => p.label);
    const series = ys.map((y, k) => {
      if (k === 0) return first.map((p) => p.value);
      const all = new Map(aggregate(rows, x, y, "line").map((p) => [p.label, p.value]));
      const shown = new Set(labels);
      const rest = [...all].filter(([l]) => !shown.has(l)).reduce((a, [, v]) => a + v, 0);
      return labels.map((l) => (l === "Other" && !all.has("Other") ? rest : all.get(l) ?? 0));
    });
    return { labels, series };
  }, [rows.length, x, ys, kind, columns]);
  const name = (y: number) => (y < 0 ? "Row count" : `Sum of ${columns[y]?.name}`);
  const title = `${ys.map(name).join(", ")} by ${columns[x]?.name ?? "?"}`;
  const flat = series.flat();
  const ticks = niceTicks(Math.min(0, ...flat), Math.max(0, ...flat));
  const lo = ticks[0], hi = ticks[ticks.length - 1];
  const n = ys.length;

  let chart: ReactNode = null;
  if (labels.length && kind === "pie") {
    const slices = pieSlices(labels.map((label, i) => ({ label, value: series[0][i] })));
    if ("error" in slices) chart = <p className="empty-side">{slices.error}</p>;
    else {
      const r = 120, cx = r + 12, cy = r + 12, H = 2 * r + 24, W = 2 * r + 48 + 320; // pie plus legend: the image has no empty right half
      const pt = (a: number) => `${cx + r * Math.sin(a)} ${cy - r * Math.cos(a)}`;
      const fill = (s: { label: string }, i: number) => (s.label === "Other" ? "var(--faint)" : `var(--ser${i + 1})`);
      chart = (
        <svg width={W} height={H} role="img" aria-label={title} onMouseLeave={() => setHover(null)}>
          {slices.map((s, i) => {
            const on = hover?.i === i;
            const props = { className: `slice${on ? " on" : ""}`, style: { fill: fill(s, i) }, onMouseMove: (e: React.MouseEvent<SVGElement>) => { const p = inSvg(e); setHover({ i, left: p.x, top: p.y }); } };
            return slices.length === 1 ? <circle key={i} cx={cx} cy={cy} r={r} {...props} />
              : <path key={i} d={`M${cx} ${cy} L${pt(s.start)} A${r} ${r} 0 ${s.end - s.start > Math.PI ? 1 : 0} 1 ${pt(s.end)} Z`} {...props} />;
          })}
          {slices.map((s, i) => (
            <g key={`l${i}`} transform={`translate(${2 * r + 48},${cy - (slices.length * 26) / 2 + i * 26})`}>
              <rect width={12} height={12} y={2} style={{ fill: fill(s, i) }} />
              <text x={20} y={12} className="lab">{s.label.length > 28 ? `${s.label.slice(0, 27)}…` : s.label}</text>
              <text x={20} y={12} dx={Math.min(28, s.label.length) * 7.4 + 10} className="val">{fmt(s.value)} · {(s.share * 100).toFixed(s.share < 0.1 ? 1 : 0)}%</text>
            </g>
          ))}
        </svg>
      );
    }
  } else if (labels.length && kind === "bar") {
    const labelW = Math.min(220, Math.max(60, ...labels.map((l) => l.length * 7.2 + 12)));
    const bh = n === 1 ? 20 : Math.max(9, Math.round(26 / n)), gap = 8, rowH = bh * n + 2 * (n - 1), top = 8, W = Math.max(320, width - 24), plotW = W - labelW - 70, H = top + labels.length * (rowH + gap) + 28;
    const sx = (v: number) => labelW + ((v - lo) / (hi - lo || 1)) * plotW;
    chart = (
      <svg width={W} height={H} role="img" aria-label={title} onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={sx(t)} x2={sx(t)} y1={top - 4} y2={H - 22} className={t === 0 ? "axis" : "gl"} />
            <text x={sx(t)} y={H - 6} textAnchor="middle" className="tick">{fmt(t)}</text>
          </g>
        ))}
        {labels.map((l, i) => {
          const y0 = top + i * (rowH + gap);
          return (
            <g key={l} onMouseMove={(e) => setHover({ i, left: inSvg(e).x, top: y0 })}>
              <rect x={0} y={y0 - gap / 2} width={W} height={rowH + gap} fill="transparent" />{/* hit target bigger than the bars */}
              <text x={labelW - 8} y={y0 + rowH / 2 + 4} textAnchor="end" className="lab">{l.length > 30 ? `${l.slice(0, 29)}…` : l}</text>
              {series.map((vals, k) => {
                const v = vals[i], yk = y0 + k * (bh + 2);
                return (
                  <g key={k}>
                    <rect x={sx(Math.min(0, v))} y={yk} width={Math.max(1, Math.abs(sx(v) - sx(0)))} height={bh} className={`bar${hover?.i === i ? " on" : ""}`} style={{ fill: color(k, n) }} />
                    {(n === 1 || bh >= 12) && <text x={sx(v) + (v < 0 ? -6 : 6)} y={yk + bh / 2 + 4} textAnchor={v < 0 ? "end" : "start"} className="val">{fmt(v)}</text>}
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>
    );
  } else if (labels.length) {
    const left = 56, top = 12, W = Math.max(320, width - 24), H = 320, plotW = W - left - 16, plotH = H - top - 40;
    const sx = (i: number) => left + (labels.length === 1 ? plotW / 2 : (i / (labels.length - 1)) * plotW);
    const sy = (v: number) => top + plotH - ((v - lo) / (hi - lo || 1)) * plotH;
    const step = Math.max(1, Math.ceil(labels.length / Math.max(2, Math.floor(plotW / 90))));
    chart = (
      <svg width={W} height={H} role="img" aria-label={title} onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const i = Math.max(0, Math.min(labels.length - 1, Math.round(((inSvg(e).x - left) / plotW) * (labels.length - 1))));
          setHover({ i, left: sx(i), top: sy(Math.max(...series.map((s) => s[i]))) });
        }}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={left} x2={W - 16} y1={sy(t)} y2={sy(t)} className={t === 0 ? "axis" : "gl"} />
            <text x={left - 8} y={sy(t) + 4} textAnchor="end" className="tick">{fmt(t)}</text>
          </g>
        ))}
        {labels.map((l, i) => (i % step === 0 ? <text key={l} x={sx(i)} y={H - 18} textAnchor="middle" className="tick">{l.length > 14 ? `${l.slice(0, 13)}…` : l}</text> : null))}
        {series.map((vals, k) => (
          <g key={k}>
            <polyline className="line" style={{ stroke: color(k, n) }} points={vals.map((v, i) => `${sx(i)},${sy(v)}`).join(" ")} />
            {labels.length <= 60 && vals.map((v, i) => <circle key={i} cx={sx(i)} cy={sy(v)} r={4} className="dot" style={{ fill: color(k, n) }} />)}
          </g>
        ))}
        {hover && <line x1={hover.left} x2={hover.left} y1={top} y2={top + plotH} className="cross" />}
        {hover && series.map((vals, k) => <circle key={k} cx={hover.left} cy={sy(vals[hover.i])} r={5} className="dot on" style={{ fill: color(k, n) }} />)}
      </svg>
    );
  }

  const setY = (k: number, v: number) => setYs(ys.map((y, j) => (j === k ? v : y)));
  return (
    <div className="chartv">
      <div className="frow chartbar">
        <div className="seg">
          <button className={kind === "bar" ? "on" : ""} aria-pressed={kind === "bar"} onClick={() => setKind("bar")}>Bar</button>
          <button className={kind === "line" ? "on" : ""} aria-pressed={kind === "line"} onClick={() => setKind("line")}>Line</button>
          <button className={kind === "pie" ? "on" : ""} aria-pressed={kind === "pie"} onClick={() => { setKind("pie"); setYs(ys.slice(0, 1)); }} title="One series: the four biggest parts, the rest as Other">Pie</button>
        </div>
        <label className="ty">X</label>
        <select value={x} onChange={(e) => setX(Number(e.target.value))} aria-label="X column">{columns.map((c, i) => <option key={i} value={i}>{c.name}</option>)}</select>
        {ys.map((y, k) => (
          <span key={k} className="frow serpick">
            {n > 1 && <span className="sw" style={{ background: color(k, n) }} />}
            <label className="ty">{k === 0 ? "Y" : ""}</label>
            <select value={y} onChange={(e) => setY(k, Number(e.target.value))} aria-label={`Series ${k + 1}`}>
              <option value={-1}>Row count</option>
              {numericCols.filter((i) => i !== x).map((i) => <option key={i} value={i}>Sum of {columns[i].name}</option>)}
            </select>
            {k > 0 && <button className="ibtn" aria-label={`Remove series ${k + 1}`} onClick={() => setYs(ys.filter((_, j) => j !== k))}>×</button>}
          </span>
        ))}
        {kind !== "pie" && n < MAX_SERIES && numericCols.some((i) => i !== x && !ys.includes(i)) && (
          <button className="btn" onClick={() => setYs([...ys, numericCols.find((i) => i !== x && !ys.includes(i))!])}>+ Series</button>
        )}
        <span className="sp" />
        <span className="ty">{msg ?? `From the ${rows.length.toLocaleString()} loaded rows`}</span>
        {(["png", "svg"] as const).map((f) => (
          <button key={f} className="btn" disabled={!chart} onClick={() => {
            const svg = wrap.current?.querySelector("svg");
            if (!svg) return;
            const legend = kind !== "pie" && n > 1 ? ys.map((y, k) => ({ label: name(y), color: getComputedStyle(document.body).getPropertyValue(`--ser${k + 1}`) })) : undefined;
            saveSvgImage(svg, svg.width.baseVal.value, svg.height.baseVal.value, f, title, { title, legend }).then((m) => m && setMsg(m));
          }}><Icon name="image" />Save {f.toUpperCase()}…</button>
        ))}
      </div>
      <h4 className="charth">{title}</h4>
      {n > 1 && <div className="legend">{ys.map((y, k) => <span key={k}><i style={{ background: color(k, n) }} />{name(y)}</span>)}</div>}
      <div className="chartbox" ref={wrap}>
        {chart ?? <p className="empty-side">Nothing to plot: pick a Y column with numbers, or use Row count.</p>}
        {hover && labels[hover.i] != null && (
          <div className="ctip" style={{ left: Math.min(hover.left + 14, width - 200), top: hover.top }}>
            <b>{labels[hover.i]}</b>
            {series.map((vals, k) => <span key={k}>{n > 1 && <i className="sw" style={{ background: color(k, n) }} />}{n > 1 ? `${name(ys[k])}: ` : ""}{fmt(vals[hover.i])}</span>)}
          </div>
        )}
      </div>
    </div>
  );
}
