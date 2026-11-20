import { useState } from "react";
import type { Plan, PlanNode } from "../lib/explain";

const ms = (v: number) => (v >= 100 ? Math.round(v).toLocaleString() : v.toFixed(v >= 10 ? 1 : 2));
const num = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e4 ? `${Math.round(v / 1e3)}k` : Math.round(v).toLocaleString());

function Row({ n, depth, metric }: { n: PlanNode; depth: number; metric: Plan["metric"] }) {
  return (
    <>
      <div className={`pnode${n.hot ? " hot" : ""}`} style={{ marginLeft: depth * 20 }}>
        <div className="pmain">
          <div className="pop">{depth > 0 && <span className="ty">└</span>}{n.label}{n.hot && <span className="key">SLOWEST</span>}{n.misestimate && <span className="key warn" title="Actual rows are far from the planner's estimate: statistics may be stale (ANALYZE the table)">estimate ×{n.misestimate}</span>}</div>
          {n.detail.map((d, i) => <div key={i} className="pdet">{d}</div>)}
        </div>
        {metric && (
          <div className="pbar" title={`${(n.share * 100).toFixed(1)}% of the total`}><i style={{ width: `${Math.max(1, n.share * 100)}%` }} /></div>
        )}
        <div className="pnum">
          {metric === "time" ? <b>{ms(n.self)} ms</b> : metric === "cost" ? <b>cost {num(n.self)}</b> : null}
          {(n.rows != null || n.actualRows != null) && (
            <span>{n.actualRows != null ? `${num(n.actualRows)} rows` : `~${num(n.rows!)} rows`}{n.actualRows != null && n.rows != null ? ` (est ${num(n.rows)})` : ""}</span>
          )}
        </div>
      </div>
      {n.children.map((c, i) => <Row key={i} n={c} depth={depth + 1} metric={metric} />)}
    </>
  );
}

// EXPLAIN as a tree: each step's own share as a bar, the slowest step marked, bad estimates flagged.
export function PlanView({ plan, raw, analyzed }: { plan: Plan; raw: string; analyzed: boolean }) {
  const [showRaw, setShowRaw] = useState(false);
  const all: PlanNode[] = [];
  const walk = (n: PlanNode) => { all.push(n); n.children.forEach(walk); };
  plan.roots.forEach(walk);
  const hot = all.find((n) => n.hot);
  return (
    <div className="plan">
      <div className="psum">
        {plan.metric === "time" && <span>Execution <b>{ms(plan.executionMs ?? plan.total)} ms</b></span>}
        {plan.planningMs != null && <span>Planning <b>{ms(plan.planningMs)} ms</b></span>}
        {plan.metric === "cost" && <span>Estimated cost <b>{num(plan.total)}</b></span>}
        {hot && <span>Slowest <b>{hot.label}</b> ({Math.round(hot.share * 100)}%)</span>}
        <span className="ty">{analyzed ? "Measured (ANALYZE ran the statement; writes were rolled back)" : plan.metric ? "Planner estimates — use Analyze for real timings" : "SQLite shows the plan's steps only"}</span>
        <span className="sp" />
        <button className="linkbtn" onClick={() => setShowRaw((s) => !s)}>{showRaw ? "Show tree" : "Show raw output"}</button>
      </div>
      {showRaw ? <pre className="sqlprev">{raw}</pre> : plan.roots.map((r, i) => <Row key={i} n={r} depth={0} metric={plan.metric} />)}
    </div>
  );
}
