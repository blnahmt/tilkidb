// Prompts for the optional AI assistant. Only SQL text and table / column names go into them,
// never row data. The system prompt (with the schema) stays the same per connection, so the
// API can cache it across questions.
import { ENGINES, type Engine, type Table } from "./api.ts";

const MAX_SCHEMA_CHARS = 60_000;

/** Compact schema listing; very large schemas are trimmed and the count of left-out tables returned. */
export function schemaContext(tables: Table[]): { text: string; listed: number; omitted: number } {
  const multi = new Set(tables.map((t) => t.schema)).size > 1;
  const lines: string[] = [];
  let size = 0;
  for (const t of tables) {
    const cols = t.columns.map((c) => `${c.name} ${c.dataType}${c.pk ? " PK" : ""}${c.fk ? ` -> ${c.fk}` : ""}${c.nullable ? "" : " NOT NULL"}`).join(", ");
    const line = `${t.kind === "view" ? "VIEW " : ""}${multi ? `${t.schema}.` : ""}${t.name}(${cols})`;
    if (size + line.length > MAX_SCHEMA_CHARS) break;
    lines.push(line);
    size += line.length + 1;
  }
  return { text: lines.join("\n"), listed: lines.length, omitted: tables.length - lines.length };
}

export function systemPrompt(engine: Engine, tables: Table[]): string {
  const s = schemaContext(tables);
  return [
    `You are the SQL assistant inside Tilki DB, a desktop SQL client. The user is connected to a ${ENGINES[engine].label} database.`,
    `Its schema (table and column names and types only; you never see row data):`,
    `<schema>\n${s.text || "(no tables)"}\n</schema>`,
    s.omitted ? `The schema is large: ${s.omitted} more tables exist but are not listed. If the question needs them, say which table you assumed.` : "",
    `Write SQL for ${ENGINES[engine].label} only, using tables and columns from the schema. When you write a query, put it in one \`\`\`sql block.`,
    `Keep answers short and concrete. The user reviews and runs any SQL themselves.`,
  ].filter(Boolean).join("\n\n");
}

export const explainPrompt = (sql: string) =>
  `Explain what this query does, for someone who knows SQL. Then list correctness or performance problems you see (join conditions, filters that can't use an index, NULL handling, row explosions), or say there are none.\n\n\`\`\`sql\n${sql}\n\`\`\``;

export const writePrompt = (request: string, current: string) =>
  `Write a query for this request: ${request}\n` +
  (current.trim() ? `\nThe editor currently holds this SQL, in case the request refers to it:\n\`\`\`sql\n${current}\n\`\`\`\n` : "") +
  `\nReply with the query in one \`\`\`sql block, then at most two sentences on any assumption you made.`;

export const fixPrompt = (sql: string, error: string) =>
  `This query failed. Explain the cause in one or two sentences, then give the corrected query in one \`\`\`sql block.\n\n\`\`\`sql\n${sql}\n\`\`\`\n\nError:\n${error}`;

/** The first ```sql block of an answer, or null. */
export function extractSql(answer: string): string | null {
  const m = /```(?:sql)?[^\S\n]*\n([\s\S]*?)```/i.exec(answer);
  return m ? m[1].trim() || null : null;
}
