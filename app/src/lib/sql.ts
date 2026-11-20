// SQL text helpers for the editor: find the statement under the cursor, ignoring semicolons
// inside strings, quoted identifiers, comments and PostgreSQL $tag$…$tag$ bodies.

export interface Statement {
  from: number;
  to: number;
  text: string;
}

/** Top-level statements with their trimmed text. Empty / comment-only pieces are dropped. */
export function splitStatements(sql: string, backslashEscapes = false): Statement[] {
  const out: Statement[] = [];
  let start = 0;
  let i = 0;
  const push = (end: number) => {
    const raw = sql.slice(start, end);
    const lead = raw.length - raw.trimStart().length;
    const text = raw.trim();
    if (text && stripComments(text).trim()) out.push({ from: start + lead, to: start + lead + text.length, text });
  };
  while (i < sql.length) {
    const c = sql[i];
    const n = sql[i + 1];
    if (c === "-" && n === "-") { const e = sql.indexOf("\n", i); i = e < 0 ? sql.length : e; continue; }
    if (c === "/" && n === "*") { const e = sql.indexOf("*/", i + 2); i = e < 0 ? sql.length : e + 2; continue; }
    if (c === "'" || c === '"' || c === "`") {
      i++;
      while (i < sql.length) {
        if (backslashEscapes && sql[i] === "\\") { i += 2; continue; }
        if (sql[i] === c) { if (sql[i + 1] === c) { i += 2; continue; } break; } // doubled quote = escaped
        i++;
      }
      i++;
      continue;
    }
    if (c === "$") {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i))?.[0];
      if (tag) { const e = sql.indexOf(tag, i + tag.length); i = e < 0 ? sql.length : e + tag.length; continue; }
    }
    if (c === ";") { push(i); start = i + 1; }
    i++;
  }
  push(sql.length);
  return out;
}

function stripComments(s: string): string {
  return s.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

/** The statement containing `pos`, or the one just before it when the cursor sits after a `;`. */
export function statementAt(sql: string, pos: number, backslashEscapes = false): Statement | null {
  const all = splitStatements(sql, backslashEscapes);
  if (!all.length) return null;
  let best = all[0];
  for (const s of all) {
    if (s.from <= pos) best = s;
    if (pos <= s.to + 1) break; // +1: right after the statement's ";" still counts
  }
  return best;
}

/** Lower-cased words outside strings, comments and parentheses (so subqueries don't count). */
/** `segments`, when given, receives the text of each top-level ( ... ) group (CTE bodies, subqueries). */
export function topLevelWords(stmt: string, backslashEscapes = false, segments?: string[]): string[] {
  const words: string[] = [];
  let depth = 0;
  let open = 0;
  let i = 0;
  while (i < stmt.length) {
    const c = stmt[i];
    const n = stmt[i + 1];
    if (c === "-" && n === "-") { const e = stmt.indexOf("\n", i); i = e < 0 ? stmt.length : e; continue; }
    if (c === "/" && n === "*") { const e = stmt.indexOf("*/", i + 2); i = e < 0 ? stmt.length : e + 2; continue; }
    if (c === "'" || c === '"' || c === "`") {
      i++;
      while (i < stmt.length) {
        if (backslashEscapes && stmt[i] === "\\") { i += 2; continue; }
        if (stmt[i] === c) { if (stmt[i + 1] === c) { i += 2; continue; } break; }
        i++;
      }
      i++;
      continue;
    }
    if (c === "$") {
      const tag = /^\$[A-Za-z_]*\$/.exec(stmt.slice(i))?.[0];
      if (tag) { const e = stmt.indexOf(tag, i + tag.length); i = e < 0 ? stmt.length : e + tag.length; continue; }
    }
    if (c === "(") { if (depth === 0) open = i + 1; depth++; i++; continue; }
    if (c === ")") { depth = Math.max(0, depth - 1); if (depth === 0) segments?.push(stmt.slice(open, i)); i++; continue; }
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(stmt.slice(i, i + 64));
    if (m) { if (depth === 0) words.push(m[0].toLowerCase()); i += m[0].length; continue; }
    i++;
  }
  return words;
}

const VERBS = new Set(["select", "insert", "update", "delete", "merge", "replace", "drop", "truncate", "alter", "create", "grant", "revoke", "rename", "comment", "copy", "call", "do", "lock", "vacuum", "reindex", "cluster", "refresh", "set", "show", "values", "table", "pragma", "attach", "detach"]);
const READS = new Set(["select", "show", "values", "table"]);

export interface Risk {
  statement: string;
  reason: string;
  severe: boolean; // irreversible or whole-table
}

/**
 * Statements that need a typed confirmation: on any connection UPDATE/DELETE without a top-level
 * WHERE, DROP and TRUNCATE; on a writable production connection every write.
 * EXPLAIN is safe unless it ANALYZEs (which runs the statement).
 */
export function risks(sql: string, opts: { prod: boolean; backslashEscapes?: boolean }): Risk[] {
  const out: Risk[] = [];
  for (const s of splitStatements(sql, opts.backslashEscapes)) {
    const groups: string[] = [];
    let words = topLevelWords(s.text, opts.backslashEscapes, groups);
    // PostgreSQL data-modifying CTEs: WITH x AS (DELETE ... RETURNING *) SELECT ... writes too
    if (words[0] === "with") for (const g of groups) out.push(...risks(g, opts).map((r) => ({ ...r, statement: s.text })));
    if (words[0] === "explain") {
      if (!words.slice(1, 4).includes("analyze")) continue;
      words = words.slice(1).filter((w) => w !== "analyze" && w !== "verbose");
    }
    const verb = words.find((w) => VERBS.has(w));
    if (!verb) continue;
    const upper = verb.toUpperCase();
    if ((verb === "update" || verb === "delete") && !words.includes("where")) {
      out.push({ statement: s.text, reason: `${upper} without WHERE changes every row in the table.`, severe: true });
    } else if (verb === "drop" || verb === "truncate") {
      out.push({ statement: s.text, reason: `${upper} can't be undone.`, severe: true });
    } else if (verb === "alter" && words.some((w, i) => w === "drop" && !["default", "not", "expression", "identity"].includes(words[i + 1]))) {
      // DROP DEFAULT / NOT NULL / EXPRESSION / IDENTITY lose no data; DROP [COLUMN] x, CONSTRAINT, INDEX… do
      out.push({ statement: s.text, reason: "ALTER … DROP removes a column or constraint and can't be undone.", severe: true });
    } else if (opts.prod && verb === "select" && words.includes("into")) {
      out.push({ statement: s.text, reason: "Writes to a production connection.", severe: false }); // SELECT INTO new_table / OUTFILE
    } else if (opts.prod && !READS.has(verb) && verb !== "set" && verb !== "pragma") {
      out.push({ statement: s.text, reason: "Writes to a production connection.", severe: false });
    }
  }
  return out;
}

/** The script commits or rolls back (ROLLBACK TO SAVEPOINT doesn't end a transaction). */
export function endsTransaction(sql: string, backslashEscapes = false): boolean {
  return splitStatements(sql, backslashEscapes).some((s) => {
    const w = topLevelWords(s.text, backslashEscapes);
    return w[0] === "commit" || w[0] === "end" || (w[0] === "rollback" && w[1] !== "to");
  });
}

/** Heuristic: the script opens a transaction and never ends it (we roll it back after the run). */
export function leavesTransactionOpen(sql: string): boolean {
  const s = stripComments(sql);
  return /\b(begin|start\s+transaction)\b/i.test(s) && !/\b(commit|rollback|end)\b/i.test(s);
}
