import { useEffect, useRef, type MutableRefObject } from "react";
import { basicSetup } from "codemirror";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import { EditorView, hoverTooltip, keymap, placeholder } from "@codemirror/view";
import { setDiagnostics } from "@codemirror/lint";
import { MySQL, PostgreSQL, SQLite, StandardSQL, sql } from "@codemirror/lang-sql";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { autocompletion, completeFromList, snippetCompletion as snip, type CompletionContext } from "@codemirror/autocomplete";
import { indentUnit } from "@codemirror/language";
import { getSettings } from "../lib/settings";
import { format } from "sql-formatter";
import type { Engine, Table } from "../lib/api";
import { joinHints } from "../lib/joins";
import { loadKeys } from "../lib/keymap";

// Colors come from the theme tokens, so light/dark and palette changes apply without reconfiguring.
const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "var(--editor-size, 13px)", backgroundColor: "var(--bg)", color: "var(--fg)" },
  ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "20px" },
  ".cm-content": { caretColor: "var(--accent)", padding: "8px 0" },
  ".cm-gutters": { backgroundColor: "var(--bg)", color: "var(--faint)", border: "none" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--muted)" },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--panel2) 55%, transparent)" },
  "&.cm-focused .cm-cursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "var(--accent-soft) !important" },
  ".cm-matchingBracket": { backgroundColor: "var(--panel2)", outline: "1px solid var(--line)" },
  ".cm-tooltip": { backgroundColor: "var(--panel)", border: "1px solid var(--line)", color: "var(--fg)" },
  ".cm-tooltip-autocomplete ul li": { fontFamily: "var(--mono)", padding: "2px 8px" },
  ".cm-tooltip-autocomplete ul li[aria-selected]": { backgroundColor: "var(--accent-soft)", color: "var(--fg)" },
  ".cm-completionDetail": { color: "var(--muted)" },
  ".cm-searchMatch": { backgroundColor: "var(--accent-soft)" },
  ".cm-panels": { backgroundColor: "var(--panel)", color: "var(--fg)", borderColor: "var(--line)" },
  ".cm-placeholder": { color: "var(--faint)" },
  ".cm-lintRange-error": { backgroundImage: "none", textDecoration: "underline wavy var(--prod)", textUnderlineOffset: "3px" },
  ".cm-diagnostic-error": { borderLeft: "3px solid var(--prod)" },
  ".cm-tblpeek": { padding: "6px 10px", fontFamily: "var(--mono)", fontSize: "12px", maxHeight: "260px", overflow: "auto" },
  ".cm-tblpeek b": { display: "block", marginBottom: "4px", fontFamily: "var(--ui)" },
  ".cm-tblpeek span": { color: "var(--muted)" },
});

const highlight = HighlightStyle.define([
  { tag: t.keyword, color: "var(--k)", fontWeight: "500" },
  { tag: [t.string, t.special(t.string)], color: "var(--s)" },
  { tag: [t.number, t.bool, t.null], color: "var(--n)" },
  { tag: [t.lineComment, t.blockComment], color: "var(--c)", fontStyle: "italic" },
  { tag: [t.typeName, t.standard(t.name)], color: "var(--t)" },
  { tag: [t.operator, t.punctuation], color: "var(--muted)" },
  { tag: t.special(t.name), color: "var(--t)" },
]);

// Type the label (sel, join, cte, ...) and pick it from the completion list; Tab moves between fields.
const SNIPPETS = completeFromList([
  snip("SELECT ${*}\nFROM ${table}\nWHERE ${condition}\nLIMIT ${100};", { label: "sel", detail: "SELECT … FROM … WHERE", type: "text" }),
  snip("SELECT ${*}\nFROM ${a} a\nJOIN ${b} b ON b.${id} = a.${b_id};", { label: "join", detail: "SELECT with JOIN", type: "text" }),
  snip("SELECT ${column}, count(*)\nFROM ${table}\nGROUP BY ${column}\nORDER BY count(*) DESC;", { label: "group", detail: "GROUP BY with counts", type: "text" }),
  snip("WITH ${name} AS (\n  ${query}\n)\nSELECT * FROM ${name};", { label: "cte", detail: "WITH … AS (…)", type: "text" }),
  snip("INSERT INTO ${table} (${columns})\nVALUES (${values});", { label: "ins", detail: "INSERT INTO … VALUES", type: "text" }),
  snip("UPDATE ${table}\nSET ${column} = ${value}\nWHERE ${condition};", { label: "upd", detail: "UPDATE … SET … WHERE", type: "text" }),
  snip("DELETE FROM ${table}\nWHERE ${condition};", { label: "del", detail: "DELETE … WHERE", type: "text" }),
  snip("CASE WHEN ${condition} THEN ${a} ELSE ${b} END", { label: "case", detail: "CASE WHEN … END", type: "text" }),
  snip("BEGIN;\n${}\nCOMMIT;", { label: "tx", detail: "transaction", type: "text" }),
]);

const FORMAT_LANG = { postgres: "postgresql", mysql: "mysql", sqlite: "sqlite" } as const;

/** Format the selection, or the whole text; one undo step. `:name` parameters are kept. */
export function formatSql(view: EditorView, engine: Engine | null): string | null {
  const { from, to } = view.state.selection.main;
  const whole = from === to;
  const text = whole ? view.state.doc.toString() : view.state.sliceDoc(from, to);
  if (!text.trim()) return null;
  try {
    const { keywordCase, tabSize } = getSettings();
    const out = format(text, { language: engine ? FORMAT_LANG[engine] : "sql", keywordCase, tabWidth: tabSize, paramTypes: { named: [":"] } });
    view.dispatch({ changes: { from: whole ? 0 : from, to: whole ? view.state.doc.length : to, insert: out } });
    return null;
  } catch (e) {
    return `Couldn't format this SQL: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`;
  }
}

/** the table a word in the editor names (bare or schema-qualified, any case) */
function tableAt(view: EditorView, pos: number, tables: Table[]) {
  const line = view.state.doc.lineAt(pos);
  let a = pos - line.from, b = a;
  const text = line.text, w = /[\w.$]/;
  while (a > 0 && w.test(text[a - 1])) a--;
  while (b < text.length && w.test(text[b])) b++;
  const word = text.slice(a, b).replace(/["`]/g, "");
  if (!word) return null;
  const [sch, name] = word.includes(".") ? word.split(".").slice(-2) : [null, word];
  const t = tables.find((x) => x.name.toLowerCase() === name.toLowerCase() && (!sch || x.schema.toLowerCase() === sch.toLowerCase()));
  return t ? { table: t, from: line.from + a, to: line.from + b } : null;
}

/** "FROM customers c JOIN |": the related tables with their ON clause, from foreign keys */
const joinSource = (tables: Table[], engine: Engine | null) => (ctx: CompletionContext) => {
  const before = ctx.state.sliceDoc(Math.max(0, ctx.pos - 2000), ctx.pos);
  const m = /\bjoin\s+(\w*)$/i.exec(before);
  if (!m) return null;
  const hints = joinHints(before, tables, engine ?? "postgres");
  return hints.length ? { from: ctx.pos - m[1].length, options: hints.map((h, i) => ({ label: h.label, detail: "foreign key", type: "class", boost: 99 - i })), validFor: /^\w*$/ } : null;
};

function language(engine: Engine | null, tables: Table[]) {
  const dialect = engine === "postgres" ? PostgreSQL : engine === "mysql" ? MySQL : engine === "sqlite" ? SQLite : StandardSQL;
  const single = new Set(tables.map((x) => x.schema)).size <= 1;
  const schema: Record<string, string[]> = {};
  for (const tb of tables) {
    const key = single || ["public", "main", "dbo"].includes(tb.schema) ? tb.name : `${tb.schema}.${tb.name}`;
    schema[key] = tb.columns.map((c) => c.name);
  }
  const support = sql({ dialect, schema, upperCaseKeywords: true });
  return [support, support.language.data.of({ autocomplete: SNIPPETS }), support.language.data.of({ autocomplete: joinSource(tables, engine) })];
}

// CodeMirror 6 with SQL highlighting and schema-aware completion.
// Ctrl+Enter runs the statement under the cursor (or the selection); Ctrl+Shift+Enter runs everything.
export function SqlEditor({ value, onChange, engine, tables, onRun, onRunAll, onExplain, onSave, onError, viewRef, onOpenTable, error, keys }: {
  value: string;
  onChange: (sql: string) => void;
  engine: Engine | null;
  tables: Table[];
  onRun: () => void;
  onRunAll: () => void;
  onExplain: () => void;
  onSave: () => void;
  onError?: (message: string) => void; // e.g. SQL the formatter can't parse
  viewRef: MutableRefObject<EditorView | null>;
  onOpenTable?: (t: Table) => void; // Ctrl+click on a table name
  error?: { from: number; to: number; message: string } | null; // underlined until the next run
  keys?: Record<string, string>; // shortcut overrides (lib/keymap)
}) {
  const host = useRef<HTMLDivElement>(null);
  const lang = useRef(new Compartment());
  const keyComp = useRef(new Compartment());
  const prefs = useRef(new Compartment());
  // Settings › Editor: wrap, suggestions while typing, tab size, line numbers
  const editorPrefs = () => {
    const s = getSettings();
    return [
      s.wrap ? EditorView.lineWrapping : [],
      autocompletion({ activateOnTyping: s.autocomplete }),
      EditorState.tabSize.of(s.tabSize),
      indentUnit.of(" ".repeat(s.tabSize)),
      EditorView.editorAttributes.of({ class: s.lineNumbers ? "" : "nolines" }),
    ];
  };
  const cb = useRef({ onChange, onRun, onRunAll, onExplain, onSave, onError, onOpenTable, tables });
  cb.current = { onChange, onRun, onRunAll, onExplain, onSave, onError, onOpenTable, tables };
  const bindings = (k: Record<string, string>) => Prec.highest(keymap.of([
    { key: k.run, run: () => { cb.current.onRun(); return true; } },
    { key: k.runAll, run: () => { cb.current.onRunAll(); return true; } },
    { key: k.explain, run: () => { cb.current.onExplain(); return true; } },
    { key: k.save, run: () => { cb.current.onSave(); return true; } },
    ...[k.format, "Shift-Alt-f"].map((key) => ({ key, run: (v: EditorView) => { const err = formatSql(v, engineRef.current); if (err) cb.current.onError?.(err); return true; } })),
  ]));
  const engineRef = useRef(engine);
  engineRef.current = engine;

  useEffect(() => {
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          keyComp.current.of(bindings(keys ?? loadKeys())),
          hoverTooltip((v, pos) => {
            const hit = tableAt(v, pos, cb.current.tables);
            if (!hit) return null;
            return {
              pos: hit.from, end: hit.to, above: true,
              create: () => {
                const dom = document.createElement("div");
                dom.className = "cm-tblpeek";
                const head = document.createElement("b");
                head.textContent = `${hit.table.name}${hit.table.kind === "view" ? " (view)" : ""}${cb.current.onOpenTable ? " · Ctrl+click to open" : ""}`;
                dom.append(head);
                for (const c of hit.table.columns) {
                  const row = document.createElement("div");
                  row.textContent = c.name + " ";
                  const ty = document.createElement("span");
                  ty.textContent = `${c.dataType}${c.pk ? " · PK" : ""}${c.fk ? ` · → ${c.fk}` : ""}`;
                  row.append(ty);
                  dom.append(row);
                }
                return { dom };
              },
            };
          }, { hoverTime: 400 }),
          EditorView.domEventHandlers({
            mousedown: (e, v) => {
              if (!(e.ctrlKey || e.metaKey) || !cb.current.onOpenTable) return false;
              const pos = v.posAtCoords({ x: e.clientX, y: e.clientY });
              const hit = pos == null ? null : tableAt(v, pos, cb.current.tables);
              if (!hit) return false;
              e.preventDefault();
              cb.current.onOpenTable(hit.table);
              return true;
            },
          }),
          basicSetup,
          prefs.current.of(editorPrefs()),
          lang.current.of(language(engine, tables)),
          theme,
          syntaxHighlighting(highlight),
          placeholder("Write SQL here. Ctrl+Enter runs the statement under the cursor."),
          EditorView.updateListener.of((u) => { if (u.docChanged) cb.current.onChange(u.state.doc.toString()); }),
        ],
      }),
    });
    viewRef.current = view;
    return () => { view.destroy(); viewRef.current = null; };
  }, []); // the editor owns its text after mount; `value` is only the initial document

  useEffect(() => {
    viewRef.current?.dispatch({ effects: lang.current.reconfigure(language(engine, tables)) });
  }, [engine, tables, viewRef]);
  useEffect(() => { if (keys) viewRef.current?.dispatch({ effects: keyComp.current.reconfigure(bindings(keys)) }); }, [keys]); // deps chosen on purpose
  useEffect(() => {
    const on = () => viewRef.current?.dispatch({ effects: prefs.current.reconfigure(editorPrefs()) });
    addEventListener("tilki:settings", on);
    return () => removeEventListener("tilki:settings", on);
  }, []); // deps chosen on purpose
  useEffect(() => {
    const v = viewRef.current;
    if (!v) return;
    const len = v.state.doc.length;
    const d = error && error.from < len ? [{ from: error.from, to: Math.min(len, Math.max(error.to, error.from + 1)), severity: "error" as const, message: error.message }] : [];
    v.dispatch(setDiagnostics(v.state, d));
  }, [error, viewRef]);

  return <div className="editor" ref={host} />;
}
