import { useEffect, useMemo, useRef, useState } from "react";
import { api, errText, type Cell, type ColInfo, type Table } from "../lib/api";
import { buildChanges, buildCount, buildSelect, buildWhere, literal, needsValue, qualified, quoteIdent, type Filter, type FilterOp, type Sort } from "../lib/sqlgen";
import { editorKind, enumValues } from "../lib/celltypes";
import { fakeRows } from "../lib/fakedata";
import { getSettings } from "../lib/settings";
import type { CellEditorSpec } from "./CellEditors";
import { ExportDialog } from "./ExportDialog";
import { GuardDialog } from "./GuardDialog";
import { Inspector } from "./Inspector";
import { StructureView } from "./StructureView";
import { ChartView } from "./ChartView";
import { ResultGrid, type GridEdit } from "./ResultGrid";
import type { TabConn } from "./QueryTab";
import { Icon } from "./Icons";

const PAGE_SIZES = [100, 500, 1000, 5000];

// Browse one table: server-side filters, sorting and paging; inline edits collected in a tray
// and committed in one transaction.
/** the column people recognise a row by: name, title, email… else the first text column */
export function labelColumn(t: Table): string | null {
  const text = t.columns.filter((c) => !c.pk && !c.fk && /char|text|string/i.test(c.dataType));
  const pref = ["name", "full_name", "title", "label", "email", "username", "code", "sku", "description"];
  return (pref.map((p) => text.find((c) => c.name.toLowerCase() === p)).find(Boolean) ?? text.find((c) => /name|title/i.test(c.name)) ?? text[0])?.name ?? null;
}

export function TableTab({ table, tables, conn, readOnly, inspector, onDirty, onToast, onSchemaChanged, jump, onJump, onOpenRefs }: {
  table: Table | null; // schema metadata (columns, primary key); null while the schema loads
  conn: TabConn | null;
  readOnly: boolean;
  inspector: boolean;
  onDirty: (dirty: boolean) => void;
  onToast: (msg: string) => void;
  onSchemaChanged: () => void; // the structure view altered the table
  jump?: { col: string; val: string; n: number }; // show just this row (opened from a foreign key)
  onJump: (fkTable: string, value: string) => void;
  tables: Table[]; // the whole schema: foreign-key lookups and "referenced by"
  onOpenRefs: (child: Table, col: string, value: string) => void; // open the rows that point at this one
}) {
  const engine = conn?.engine ?? "postgres";
  const [view, setView] = useState<"data" | "structure" | "chart">("data");
  const cols = table?.columns ?? [];
  const pkNames = cols.filter((c) => c.pk).map((c) => c.name);
  const ops: FilterOp[] = ["=", "!=", "<", ">", "<=", ">=", "LIKE", "NOT LIKE", ...(engine === "postgres" ? ["ILIKE" as FilterOp] : []), "IN", "IS NULL", "IS NOT NULL"];
  const blankFilter = (): Filter => ({ join: "AND", col: cols.find((c) => !c.pk)?.name ?? cols[0]?.name ?? "", op: "=", val: "" });

  const [mode, setMode] = useState<"builder" | "sql">("builder");
  const [filters, setFilters] = useState<Filter[]>(() => (jump ? [{ join: "AND", col: jump.col, op: "=", val: jump.val }] : []));
  const [rawWhere, setRawWhere] = useState("");
  const [sorts, setSorts] = useState<Sort[]>([]);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(() => getSettings().pageSize);
  const [total, setTotal] = useState<{ n: number; approx: boolean } | null>(null);
  const [applied, setApplied] = useState({ where: "", sql: "" });
  const rows = useRef<Cell[][]>([]);
  const [columns, setColumns] = useState<ColInfo[]>([]);
  const [, setVersion] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [edits, setEdits] = useState<Map<number, Map<number, Cell>>>(new Map());
  const [deleted, setDeleted] = useState<Set<number>>(new Set());
  const [inserted, setInserted] = useState(0);
  const [sel, setSel] = useState<{ r: number; c: number } | null>(null);
  const selRow = sel?.r ?? null;
  const [guard, setGuard] = useState(false);
  const [review, setReview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);

  const ref = useMemo(() => (table ? { schema: table.schema, name: table.name } : null), [table]);
  const pkIdx = columns.map((c, i) => (pkNames.includes(c.name) ? i : -1)).filter((i) => i >= 0);
  const why = !table ? "" : table.kind === "view" ? "Views are read-only." : readOnly ? "This connection is read-only." : !pkNames.length ? "This table has no primary key, so rows can't be edited safely." : "";
  const editable = !why && pkIdx.length === pkNames.length && columns.length > 0;
  const pending = deleted.size + inserted + [...edits].reduce((a, [r, m]) => a + (deleted.has(r) ? 0 : m.size), 0);

  useEffect(() => onDirty(pending > 0), [pending > 0]); // deps chosen on purpose

  const resetPending = () => { setEdits(new Map()); setDeleted(new Set()); setInserted(0); };

  // `q` overrides the current filter state (needed right after changing it, before React re-renders)
  const load = async (toPage = 0, size = pageSize, q?: { filters: Filter[]; rawWhere: string; sorts: Sort[]; mode?: "builder" | "sql" }) => {
    if (!conn?.connected || !ref) return;
    const f = q ?? { filters, rawWhere, sorts };
    const where = (q?.mode ?? mode) === "sql" ? f.rawWhere.trim() : buildWhere(engine, f.filters);
    const order = f.sorts.length ? f.sorts : pkNames.map((c) => ({ col: c, dir: "ASC" as const })); // stable pages
    const sql = buildSelect(engine, ref, where, order, size, toPage * size);
    setLoading(true);
    setError(null);
    resetPending();
    rows.current = [];
    setPage(toPage);
    try {
      await api.runQuery(conn.id, crypto.randomUUID(), sql, size, (e) => {
        if (e.event === "columns") { rows.current = []; setColumns(e.columns); }
        else if (e.event === "rows") { rows.current.push(...e.rows); setVersion((v) => v + 1); }
      });
      setApplied({ where, sql });
      // big unfiltered tables: the planner's estimate instead of a slow count(*)
      if (!where && table?.rows != null && table.rows > 1_000_000) setTotal({ n: table.rows, approx: true });
      else {
        setTotal(null);
        api.runQuery(conn.id, crypto.randomUUID(), buildCount(engine, ref, where), 1, (e) => {
          if (e.event === "rows" && e.rows[0]) setTotal({ n: Number(e.rows[0][0]), approx: false });
        }).catch(() => setTotal(null));
      }
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
      setVersion((v) => v + 1);
    }
  };

  // Rows belong to one connection. When it changes, drop them (and any pending edits, whose keys
  // came from the old server) at once, then load from the new connection when it's ready.
  const loadedFor = useRef<string | null>(null);
  const shownFor = useRef(conn?.id ?? null);
  useEffect(() => {
    if (shownFor.current === (conn?.id ?? null)) return;
    shownFor.current = conn?.id ?? null;
    loadedFor.current = null; // coming back to a connection loads again: its rows were dropped here
    if (pending > 0 && table) onToast(`Discarded ${pending} uncommitted change${pending === 1 ? "" : "s"} in ${table.name}: the connection changed.`);
    resetPending();
    rows.current = [];
    setColumns([]);
    setTotal(null);
    setVersion((v) => v + 1);
  }, [conn?.id]); // deps chosen on purpose
  useEffect(() => {
    if (conn?.connected && ref && loadedFor.current !== conn.id) { loadedFor.current = conn.id; load(0); }
  }, [conn?.id, conn?.connected, ref]); // deps chosen on purpose

  const allRows = useMemo(() => [...rows.current, ...Array.from({ length: inserted }, () => columns.map(() => null as Cell))],
    [rows.current.length, inserted, columns]); // deps chosen on purpose

  const edit: GridEdit | undefined = editable ? {
    value: (r, c) => { const m = edits.get(r); return m?.has(c) ? m.get(c)! : allRows[r]?.[c] ?? null; },
    isEdited: (r, c) => !!edits.get(r)?.has(c),
    rowState: (r) => (deleted.has(r) ? "deleted" : r >= rows.current.length ? "new" : null),
    onEdit: (r, c, v) => setEdits((prev) => {
      const next = new Map(prev);
      const m = new Map(next.get(r) ?? []);
      if (r < rows.current.length && JSON.stringify(rows.current[r][c]) === JSON.stringify(v)) m.delete(c); else m.set(c, v); // typing the original value back undoes the edit
      if (m.size) next.set(r, m); else next.delete(r);
      return next;
    }),
    onToggleDelete: (r) => setDeleted((prev) => { const n = new Set(prev); if (n.has(r)) n.delete(r); else n.add(r); return n; }),
    addRows: (n) => setInserted((k) => k + n),
    editor: (c) => editorFor(c),
    nullable: (c) => cols.find((x) => x.name === columns[c]?.name)?.nullable ?? true,
  } : undefined;

  // --- typed cell editors: foreign-key search, enums, booleans, dates, JSON ---
  const findTable = (name: string) => tables.find((x) => x.name === name && x.schema === table?.schema) ?? tables.find((x) => x.name === name);
  const [pgEnums, setPgEnums] = useState<Map<string, string[]>>(new Map());
  useEffect(() => {
    if (engine !== "postgres" || !conn?.connected || !columns.length) return;
    const found = new Map<string, string[]>();
    api.runQuery(conn.id, crypto.randomUUID(), "SELECT t.typname, e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid ORDER BY t.typname, e.enumsortorder", 5000, (e) => {
      if (e.event === "rows") for (const [ty, label] of e.rows) found.set(String(ty), [...(found.get(String(ty)) ?? []), String(label)]);
    }).then(() => setPgEnums(found), () => {});
  }, [conn?.id, conn?.connected, engine, columns]); // deps chosen on purpose
  const quick = (sql: string, limit: number) => {
    const out: Cell[][] = [];
    return api.runQuery(conn!.id, crypto.randomUUID(), sql, limit, (e) => { if (e.event === "rows") out.push(...e.rows); }).then(() => out);
  };
  const asText = (col: string) => `CAST(${quoteIdent(engine, col)} AS ${engine === "mysql" ? "CHAR" : "TEXT"})`;
  const editorFor = (c: number): CellEditorSpec | null => {
    const meta = cols.find((x) => x.name === columns[c]?.name);
    if (!meta) return null;
    const parent = meta.fk ? findTable(meta.fk) : undefined;
    const ppk = parent?.columns.filter((x) => x.pk) ?? [];
    if (parent && ppk.length === 1 && conn) {
      const label = labelColumn(parent), key = ppk[0].name;
      return {
        kind: "fk", table: parent.name,
        search: async (q) => {
          const like = (col: string, pat: string) => `${engine === "postgres" ? asText(col) : quoteIdent(engine, col)} ${engine === "postgres" ? "ILIKE" : "LIKE"} ${literal(engine, pat)}`;
          const where = q.trim() ? ` WHERE ${asText(key)} LIKE ${literal(engine, `${q.trim()}%`)}${label ? ` OR ${like(label, `%${q.trim()}%`)}` : ""}` : "";
          const sql = `SELECT ${quoteIdent(engine, key)}${label ? `, ${quoteIdent(engine, label)}` : ""} FROM ${qualified(engine, parent)}${where} ORDER BY ${quoteIdent(engine, key)} LIMIT 20`;
          return (await quick(sql, 20)).map((r) => ({ value: r[0], label: label && r[1] != null ? String(r[1]) : "" }));
        },
      };
    }
    const pgEnum = engine === "postgres" ? pgEnums.get(meta.dataType) : undefined;
    const kind = editorKind(meta.dataType, !!pgEnum);
    if (kind === "enum") return { kind, options: pgEnum ?? enumValues(meta.dataType) ?? [] };
    return kind ? { kind } : null;
  };

  // --- header filters ---
  const [hf, setHf] = useState<{ col: string; x: number; y: number; op: string; val: string; val2: string } | null>(null);
  const HF_OPS = ["=", "!=", "contains", "starts with", ">", "<", ">=", "<=", "between", "in", "is null", "is not null"];
  const openHeaderFilter = (c: number, at: { x: number; y: number }) => {
    const name = columns[c].name, f = filters.find((x) => x.col === name);
    const op = !f ? "=" : f.op === "BETWEEN" ? "between" : f.op === "IN" ? "in" : f.op === "IS NULL" ? "is null" : f.op === "IS NOT NULL" ? "is not null"
      : /LIKE/.test(f.op) && /^%.*%$/.test(f.val) ? "contains" : /LIKE/.test(f.op) && f.val.endsWith("%") ? "starts with" : f.op;
    setHf({ col: name, x: Math.min(at.x, innerWidth - 300), y: Math.min(at.y, innerHeight - 220), op, val: f ? f.val.replace(/^%|%$/g, "") : "", val2: f?.val2 ?? "" });
  };
  const applyHeaderFilter = (clear = false) => {
    if (!hf) return;
    const like: FilterOp = engine === "postgres" ? "ILIKE" : "LIKE";
    const next: Filter[] = filters.filter((f) => f.col !== hf.col);
    if (!clear) {
      const m: Record<string, [FilterOp, string]> = { contains: [like, `%${hf.val}%`], "starts with": [like, `${hf.val}%`], between: ["BETWEEN", hf.val], in: ["IN", hf.val], "is null": ["IS NULL", ""], "is not null": ["IS NOT NULL", ""] };
      const [op, val] = m[hf.op] ?? [hf.op as FilterOp, hf.val];
      next.push({ join: "AND", col: hf.col, op, val, val2: hf.val2 });
    }
    setFilters(next);
    setMode("builder");
    setHf(null);
    load(0, pageSize, { filters: next, rawWhere: "", sorts, mode: "builder" });
  };
  const filteredCols = useMemo(() => new Set(mode === "builder" && applied.where ? filters.filter((f) => !needsValue(f.op) || f.val !== "").map((f) => f.col) : []), [filters, applied, mode]);

  // --- duplicate a row / sample data: both become new rows, reviewed and committed like any edit ---
  const addFilledRows = (values: (Cell | undefined)[][]) => {
    const base = rows.current.length + inserted;
    setInserted((n) => n + values.length);
    setEdits((prev) => {
      const next = new Map(prev);
      values.forEach((vals, i) => {
        const m = new Map<number, Cell>();
        vals.forEach((v, c) => { if (v !== undefined) m.set(c, v); });
        if (m.size) next.set(base + i, m);
      });
      return next;
    });
  };
  const duplicate = () => {
    if (selRow == null || !edit) return;
    // a single integer key is left out so the database assigns a new one; other keys (composite,
    // text, uuid) are copied too, so the insert fails on the duplicate until you change them
    // (SQLite would otherwise accept NULL keys)
    const keyMeta = cols.filter((c) => c.pk);
    const auto = keyMeta.length === 1 && /int|serial/i.test(keyMeta[0].dataType) ? keyMeta[0].name : null;
    addFilledRows([columns.map((c, i) => (c.name === auto ? undefined : edit.value(selRow, i) ?? undefined))]);
  };
  const [sample, setSample] = useState<{ n: number; busy: boolean } | null>(null);
  const makeSample = async () => {
    if (!sample || !conn) return;
    setSample({ ...sample, busy: true });
    try {
      // PostgreSQL enums are named types: hand their labels over in the MySQL enum(...) form the generator reads
      const metas = columns.map((c) => cols.find((x) => x.name === c.name) ?? { name: c.name, dataType: c.dataType, nullable: true, pk: false, fk: null })
        .map((m) => { const labels = engine === "postgres" ? pgEnums.get(m.dataType) : undefined; return labels ? { ...m, dataType: `enum(${labels.map((l) => `'${l.replace(/'/g, "''")}'`).join(",")})` } : m; });
      const fkValues: Record<string, Cell[]> = {};
      for (const m of metas) {
        const p = m.fk ? findTable(m.fk) : undefined, pk = p?.columns.filter((x) => x.pk) ?? [];
        if (p && pk.length === 1) fkValues[m.name] = (await quick(`SELECT ${quoteIdent(engine, pk[0].name)} FROM ${qualified(engine, p)} LIMIT 500`, 500)).map((r) => r[0]);
      }
      addFilledRows(fakeRows(metas, Math.min(1000, Math.max(1, sample.n)), Date.now() % 100000, fkValues));
      setSample(null);
    } catch (e) {
      setError(errText(e));
      setSample(null);
    }
  };

  // --- rows elsewhere that point at the selected row ---
  const [refs, setRefs] = useState<{ x: number; y: number; items: { t: Table; col: string; n: number | null }[] } | null>(null);
  const children = table ? tables.flatMap((t) => t.columns.filter((c) => c.fk === table.name && (t.schema === table.schema || !tables.some((x) => x.name === table.name && x.schema === t.schema))).map((c) => ({ t, col: c.name }))) : [];
  const selPk = selRow != null && pkIdx.length === 1 && selRow < rows.current.length ? rows.current[selRow][pkIdx[0]] : null;
  const openRefs = (el: HTMLElement) => {
    if (selPk == null || !conn) return;
    const r = el.getBoundingClientRect();
    const items = children.map((x) => ({ ...x, n: null as number | null }));
    setRefs({ x: r.left, y: r.bottom, items });
    const sql = children.map((x, i) => `SELECT ${i} AS k, count(*) AS n FROM ${qualified(engine, x.t)} WHERE ${quoteIdent(engine, x.col)} = ${literal(engine, selPk)}`).join(" UNION ALL ");
    quick(sql, children.length).then((res) => setRefs((cur) => cur && { ...cur, items: cur.items.map((it, i) => ({ ...it, n: Number(res.find((row) => Number(row[0]) === i)?.[1] ?? 0) })) }), () => {});
  };

  const changes = () => (ref ? buildChanges(engine, ref, columns.map((c) => c.name), pkIdx, rows.current, edits, deleted, inserted) : []);

  const commit = async (confirmed = false) => {
    if (!conn) return;
    if (conn.prod && !confirmed) { setReview(false); setGuard(true); return; } // production: type the name first
    setSaving(true);
    try {
      const n = await api.applyChanges(conn.id, changes());
      setReview(false);
      onToast(`Saved: ${n.toLocaleString()} row${n === 1 ? "" : "s"} changed`);
      await load(page);
    } catch (e) {
      setError(errText(e));
      setReview(false);
    } finally {
      setSaving(false);
    }
  };

  const setFilter = (i: number, patch: Partial<Filter>) => setFilters((fs) => fs.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const totalN = total?.n ?? null;
  const from = rows.current.length ? page * pageSize + 1 : 0;
  const to = page * pageSize + rows.current.length;
  const hasNext = totalN != null ? to < totalN : rows.current.length === pageSize;

  // a cell in a foreign-key column: offer to open the row it points to
  const fkCol = sel ? cols.find((c) => c.name === columns[sel.c]?.name) : undefined;
  const fkRaw = sel && fkCol?.fk ? (edit ? edit.value(sel.r, sel.c) : allRows[sel.r]?.[sel.c]) : null;
  const fkVal = fkRaw == null ? null : typeof fkRaw === "object" ? JSON.stringify(fkRaw) : String(fkRaw);
  // jumped to again from another foreign key while open: show that row
  const jumped = useRef(jump?.n);
  useEffect(() => {
    if (!jump || jump.n === jumped.current) return;
    jumped.current = jump.n;
    const f: Filter[] = [{ join: "AND", col: jump.col, op: "=", val: jump.val }];
    setFilters(f);
    setMode("builder");
    load(0, pageSize, { filters: f, rawWhere: "", sorts, mode: "builder" });
  }, [jump?.n]); // deps chosen on purpose

  if (!table) return <div className="rempty">Loading the table's columns…</div>;
  const switcher = (
    <div className="rhead viewsw">
      <button className={`rt${view === "data" ? " on" : ""}`} onClick={() => setView("data")}><Icon name="table" />Data</button>
      <button className={`rt${view === "structure" ? " on" : ""}`} onClick={() => setView("structure")}><Icon name="columns" />Structure</button>
      <button className={`rt${view === "chart" ? " on" : ""}`} onClick={() => setView("chart")}><Icon name="chart" />Chart</button>
      {view === "chart" && rows.current.length > 0 && <><span className="sp" /><span className="ty chartnote">{applied.where ? "Filtered rows of this page" : "This page's rows"} · filters and page size are set in Data</span></>}
    </div>
  );
  if (view === "structure" && conn) return <div className="qtab">{switcher}<StructureView table={table} conn={conn} readOnly={readOnly} onChanged={onSchemaChanged} onToast={onToast} /></div>;
  if (view === "chart") return <div className="qtab">{switcher}{columns.length ? <ChartView columns={columns} rows={rows.current} /> : <div className="rempty">{loading ? "Loading rows…" : "No rows to chart."}</div>}</div>;

  return (
    <div className="qtab" onKeyDown={(e) => { if (e.key === "Enter" && (e.target as HTMLElement).closest(".tbar input")) { e.preventDefault(); load(0); } }}>
      {switcher}
      <div className="tbar">
        <div className="frow">
          <div className="seg" role="tablist" aria-label="Filter mode">
            <button className={mode === "builder" ? "on" : ""} aria-pressed={mode === "builder"} onClick={() => setMode("builder")}>Filters</button>
            <button className={mode === "sql" ? "on" : ""} aria-pressed={mode === "sql"} onClick={() => { if (mode !== "sql" && !rawWhere) setRawWhere(buildWhere(engine, filters)); setMode("sql"); }}>SQL</button>
          </div>
          {applied.where && <span className="ty applied" title={applied.where}>Applied: {applied.where}</span>}
          <span className="sp" />
          <span className="pager">
            <button className="ibtn" onClick={() => load(page - 1)} disabled={page === 0 || loading} aria-label="Previous page">‹</button>
            <span>{from.toLocaleString()}–{to.toLocaleString()}{totalN != null ? ` of ${total!.approx ? "~" : ""}${totalN.toLocaleString()}` : ""}</span>
            <button className="ibtn" onClick={() => load(page + 1)} disabled={!hasNext || loading} aria-label="Next page">›</button>
            <select value={pageSize} onChange={(e) => { const s = Number(e.target.value); setPageSize(s); load(0, s); }} aria-label="Rows per page">
              {PAGE_SIZES.map((s) => <option key={s} value={s}>{s} / page</option>)}
            </select>
          </span>
        </div>
        {mode === "sql" ? (
          <div className="frow"><span className="lbl2">WHERE</span><input className="wherein" value={rawWhere} onChange={(e) => setRawWhere(e.target.value)} placeholder={`${pkNames[0] ?? "id"} > 100 AND …`} aria-label="WHERE clause" spellCheck={false} /></div>
        ) : (
          <>
            {filters.map((f, i) => (
              <div className="frow" key={i}>
                {i === 0 ? <span className="lbl2">WHERE</span> : (
                  <select className="jn" value={f.join} onChange={(e) => setFilter(i, { join: e.target.value as Filter["join"] })} aria-label="AND or OR"><option>AND</option><option>OR</option></select>
                )}
                <select value={f.col} onChange={(e) => setFilter(i, { col: e.target.value })} aria-label="Column">{cols.map((c) => <option key={c.name}>{c.name}</option>)}</select>
                <select value={f.op} onChange={(e) => setFilter(i, { op: e.target.value as FilterOp })} aria-label="Operator">{ops.map((o) => <option key={o}>{o}</option>)}</select>
                {needsValue(f.op) && <input className="fv" value={f.val} onChange={(e) => setFilter(i, { val: e.target.value })} placeholder={f.op === "IN" ? "a, b, c" : f.op.includes("LIKE") ? "%text%" : cols.find((c) => c.name === f.col)?.dataType ?? "value"} aria-label="Value" />}
                <button className="ibtn" onClick={() => setFilters((fs) => fs.filter((_, j) => j !== i))} aria-label="Remove filter" title="Remove filter">×</button>
              </div>
            ))}
          </>
        )}
        <div className="frow">
          {mode === "builder" && <button className="btn" onClick={() => setFilters((fs) => [...fs, blankFilter()])}><Icon name="filter" />Filter</button>}
          <span className="lbl2">ORDER BY</span>
          {sorts.map((s, i) => (
            <span className="frow sortc" key={i}>
              <select value={s.col} onChange={(e) => setSorts((ss) => ss.map((x, j) => (j === i ? { ...x, col: e.target.value } : x)))} aria-label="Sort column">{cols.map((c) => <option key={c.name}>{c.name}</option>)}</select>
              <select value={s.dir} onChange={(e) => setSorts((ss) => ss.map((x, j) => (j === i ? { ...x, dir: e.target.value as Sort["dir"] } : x)))} aria-label="Direction"><option>ASC</option><option>DESC</option></select>
              <button className="ibtn" onClick={() => setSorts((ss) => ss.filter((_, j) => j !== i))} aria-label="Remove sort">×</button>
            </span>
          ))}
          {sorts.length === 0 && <span className="ty">{pkNames.length ? `${pkNames.join(", ")} (primary key)` : "none"}</span>}
          <button className="btn" onClick={() => setSorts((ss) => [...ss, { col: cols.find((c) => !ss.some((s) => s.col === c.name))?.name ?? cols[0].name, dir: "ASC" }])}><Icon name="sort" />Sort</button>
          <span className="sp" />
          <button className="btn" onClick={() => { setFilters([]); setRawWhere(""); setSorts([]); load(0, pageSize, { filters: [], rawWhere: "", sorts: [] }); }} disabled={loading}><Icon name="x" />Clear</button>
          <button className="btn pri" onClick={() => load(0)} disabled={loading || !conn?.connected}><Icon name="check" />Apply <kbd>↵</kbd></button>
        </div>
      </div>
      <div className="qtool">
        <button className="btn" onClick={() => { setInserted((n) => n + 1); }} disabled={!editable} title={why || "Add a row (filled in, then committed)"}><Icon name="plus" />Row</button>
        <button className="btn" onClick={() => selRow != null && edit?.onToggleDelete(selRow)} disabled={!editable || selRow == null} title={why || "Mark the selected row for deletion (Ctrl+Delete)"}><Icon name="trash" />
          {selRow != null && deleted.has(selRow) ? "Undo delete" : "Delete row"}
        </button>
        <button className="btn" onClick={duplicate} disabled={!editable || selRow == null} title={why || "Copy the selected row into a new row (an auto-increment key is left for the database)"}><Icon name="duplicate" />Duplicate</button>
        <button className="btn" onClick={() => setSample({ n: 20, busy: false })} disabled={!editable} title={why || "Add rows of generated sample data, to review and commit"}><Icon name="sparkle" />Sample data…</button>
        <button className="btn" onClick={() => load(page)} disabled={loading || pending > 0} title={pending ? "Commit or discard your changes first" : "Reload this page"}><Icon name="refresh" />Refresh</button>
        <button className="btn" onClick={() => setExporting(true)} disabled={!columns.length}><Icon name="download" />Export…</button>
        {fkCol?.fk && <button className="btn" disabled={fkVal == null} onClick={() => fkVal != null && onJump(fkCol.fk!, fkVal)} title={`Open the ${fkCol.fk} row this value points to`}><Icon name="arrowRight" />{fkCol.fk}{fkVal != null ? ` #${fkVal.length > 20 ? `${fkVal.slice(0, 19)}…` : fkVal}` : ""}</button>}
        {children.length > 0 && <button className="btn" disabled={selPk == null} onClick={(e) => openRefs(e.currentTarget)} title={selPk == null ? "Select a row first" : "Rows in other tables that point at this one"}><Icon name="arrowLeft" />Referenced by ▾</button>}
        <span className="sp" />
        <span className="qstatus">{loading ? "Loading…" : why || "Double-click a cell to edit · Shift+Del sets NULL"}</span>
      </div>
      <div className={`progress${loading ? " on" : ""}`} />
      {error && <div className="tberr" role="alert">{error}</div>}
      <div className="resbody">
        {columns.length ? <ResultGrid columns={columns} rows={allRows} edit={edit} engine={engine} tableName={ref ? qualified(engine, ref) : undefined} onSelect={(r, c) => setSel(r != null && c != null ? { r, c } : null)}
          onHeaderFilter={openHeaderFilter} filtered={filteredCols} />
          : <div className="rempty">{loading ? "Loading rows…" : "No rows."}</div>}
        {inspector && (
          <Inspector columns={columns} row={sel && edit ? columns.map((_, c) => edit.value(sel.r, c)) : sel ? allRows[sel.r] ?? null : null} col={sel?.c ?? null}
            onPick={(c) => sel && setSel({ ...sel, c })}
            onEdit={edit && sel && edit.rowState(sel.r) !== "deleted" ? (c, v) => edit.onEdit(sel.r, c, v) : undefined} />
        )}
      </div>
      {pending > 0 && (
        <div className="tray">
          <b>{pending} pending change{pending === 1 ? "" : "s"}</b>
          <span className="ty">nothing is written until you commit</span>
          <span className="sp" />
          <button className="btn" onClick={() => { resetPending(); setError(null); }} disabled={saving}><Icon name="x" />Discard</button>
          <button className="btn" onClick={() => setReview(true)} disabled={saving}><Icon name="view" />Review SQL</button>
          <button className="btn pri" onClick={() => commit()} disabled={saving}><Icon name="check" />{saving ? "Saving…" : "Commit"}</button>
        </div>
      )}
      {review && (
        <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && !saving && setReview(false)}>
          <div className="modal wide" role="dialog" aria-modal="true" aria-labelledby="rv-title">
            <h3 id="rv-title">Review changes</h3>
            <p className="note">These run in one transaction on <b>{conn?.name}</b>. If any UPDATE or DELETE doesn't match exactly one row, nothing is saved.</p>
            <pre className="sqlprev">{changes().map((c) => `${c.sql};`).join("\n")}</pre>
            <div className="acts"><button className="btn" onClick={() => setReview(false)} disabled={saving}>Close</button><button className="btn pri" onClick={() => commit()} disabled={saving}><Icon name="check" />{saving ? "Saving…" : "Commit"}</button></div>
          </div>
        </div>
      )}
      {guard && conn && (
        <GuardDialog connName={conn.name} prod risks={changes().map((c) => ({ statement: c.sql, reason: "Writes to a production connection.", severe: false }))}
          onCancel={() => setGuard(false)} onRun={() => { setGuard(false); commit(true); }} />
      )}
      {hf && (
        <div className="scrim clear" onMouseDown={(e) => e.target === e.currentTarget && setHf(null)}>
          <div className="gmenu hfpop" style={{ left: hf.x, top: hf.y }} role="dialog" aria-label={`Filter ${hf.col}`}
            onKeyDown={(e) => { if (e.key === "Escape") setHf(null); if (e.key === "Enter") applyHeaderFilter(); }}>
            <b>{hf.col}</b>
            <select value={hf.op} onChange={(e) => setHf({ ...hf, op: e.target.value })} aria-label="Condition">{HF_OPS.map((o) => <option key={o}>{o}</option>)}</select>
            {!hf.op.startsWith("is ") && <input autoFocus value={hf.val} onChange={(e) => setHf({ ...hf, val: e.target.value })} placeholder={hf.op === "in" ? "a, b, c" : hf.op === "between" ? "from" : "value"} aria-label="Value" spellCheck={false} />}
            {hf.op === "between" && <input value={hf.val2} onChange={(e) => setHf({ ...hf, val2: e.target.value })} placeholder="to" aria-label="Upper bound" spellCheck={false} />}
            <div className="frow"><button className="btn" onClick={() => applyHeaderFilter(true)} disabled={!filters.some((f) => f.col === hf.col)}>Clear</button><span className="sp" /><button className="btn pri" onClick={() => applyHeaderFilter()}>Apply</button></div>
          </div>
        </div>
      )}
      {refs && (
        <div className="scrim clear" onMouseDown={(e) => e.target === e.currentTarget && setRefs(null)}>
          <div className="gmenu" style={{ left: Math.min(refs.x, innerWidth - 280), top: refs.y }} role="menu">
            {refs.items.map((it) => (
              <button key={`${it.t.schema}.${it.t.name}.${it.col}`} className="mi" role="menuitem" disabled={it.n === 0}
                onClick={() => { setRefs(null); onOpenRefs(it.t, it.col, typeof selPk === "object" ? JSON.stringify(selPk) : String(selPk)); }}>
                {it.t.name}.{it.col}<span className="sp" /><span className="ty">{it.n == null ? "…" : it.n.toLocaleString()}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {sample && (
        <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && !sample.busy && setSample(null)}>
          <div className="modal small" role="dialog" aria-modal="true" aria-labelledby="sd-title" onKeyDown={(e) => { if (e.key === "Escape" && !sample.busy) setSample(null); if (e.key === "Enter") makeSample(); }}>
            <h3 id="sd-title">Sample data</h3>
            <p className="note">Adds generated rows to {table.name}, picked from each column's name and type; foreign keys use existing parent rows. They show up as new rows to review, and nothing is written until you commit.</p>
            <div className="f"><label htmlFor="sd-n">Rows</label><input id="sd-n" type="number" min={1} max={1000} autoFocus value={sample.n} onChange={(e) => setSample({ ...sample, n: Number(e.target.value) })} /></div>
            <div className="acts"><button className="btn" onClick={() => setSample(null)} disabled={sample.busy}>Cancel</button><button className="btn pri" onClick={makeSample} disabled={sample.busy || !(sample.n >= 1)}>{sample.busy ? "Generating…" : "Add rows"}</button></div>
          </div>
        </div>
      )}
      {exporting && conn && (
        <ExportDialog title={table.name} columns={columns} loaded={() => rows.current} connId={conn.id} engine={engine}
          allSql={ref ? buildSelect(engine, ref, applied.where, sorts, 0, 0) : null} defaultName={table.name} insertTable={qualified(engine, ref!)}
          onClose={() => setExporting(false)} onDone={(m) => { setExporting(false); onToast(m); }} />
      )}
    </div>
  );
}
