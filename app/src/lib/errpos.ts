// Where in the SQL a database error points, so the editor can underline it.
import type { Engine } from "./api.ts";

export interface Span { from: number; to: number }

const IDENT = /[\w$.]/;

/** The word starting at `i` (at least one character). */
function wordAt(sql: string, i: number): Span {
  let to = i;
  while (to < sql.length && IDENT.test(sql[to])) to++;
  return { from: i, to: Math.max(to, Math.min(sql.length, i + 1)) };
}

/** First whole-word, case-insensitive occurrence of `name` (dotted names too). */
function findIdent(sql: string, name: string): Span | null {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(^|[^\\w$])(["\`]?${esc}["\`]?)(?![\\w$])`, "i").exec(sql);
  return m ? { from: m.index + m[1].length, to: m.index + m[1].length + m[2].length } : null;
}

/** Character range in `sql` the error message refers to, or null when it doesn't say. */
export function errorSpan(engine: Engine, message: string, sql: string): Span | null {
  if (!sql) return null;
  // PostgreSQL: the backend adds "At character N." (1-based, in characters)
  const pos = /At character (\d+)\./.exec(message);
  if (pos) {
    // PostgreSQL counts characters; JS strings count UTF-16 units (an emoji is two)
    const i = Math.min(sql.length - 1, Array.from(sql).slice(0, Number(pos[1]) - 1).join("").length);
    return i >= 0 ? wordAt(sql, i) : null;
  }
  // MySQL / MariaDB: "... near 'rest of the text' at line N"
  const near = /near '([\s\S]*?)' at line (\d+)/.exec(message);
  if (engine === "mysql" && near) {
    const lines = sql.split("\n");
    const line = Math.max(0, Math.min(lines.length - 1, Number(near[2]) - 1));
    const lineStart = lines.slice(0, line).reduce((a, l) => a + l.length + 1, 0);
    if (!near[1]) return { from: Math.max(0, sql.trimEnd().length - 1), to: sql.trimEnd().length }; // unexpected end
    const probe = near[1].split("\n")[0].slice(0, 24);
    const at = sql.indexOf(probe, lineStart);
    if (at >= 0) return wordAt(sql, at);
  }
  // SQLite: near "token": syntax error
  const tok = /near "([^"]+)": syntax error/.exec(message);
  if (tok) return findIdent(sql, tok[1]) ?? (() => { const i = sql.indexOf(tok[1]); return i >= 0 ? { from: i, to: i + tok[1].length } : null; })();
  // unknown names, all engines
  const name = /(?:column|relation|table|function|type|schema) "([^"]+)" does not exist/.exec(message)?.[1]
    ?? /no such (?:column|table|function): ([\w.$]+)/.exec(message)?.[1]
    ?? /Unknown column '([^']+)'/.exec(message)?.[1]
    ?? /Table '([^']+)' doesn't exist/.exec(message)?.[1]?.split(".").pop()
    ?? /FUNCTION ([\w.]+) does not exist/.exec(message)?.[1]?.split(".").pop();
  if (name) return findIdent(sql, name) ?? (name.includes(".") ? findIdent(sql, name.split(".").pop()!) : null);
  return null;
}
