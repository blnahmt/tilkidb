// Which editor a grid cell gets, from the column's database type.
export type EditorKind = "bool" | "date" | "datetime" | "json" | "enum" | null;

/** MySQL `enum('a','b')` values, or null. */
export function enumValues(dataType: string): string[] | null {
  const m = /^enum\((.*)\)$/i.exec(dataType.trim());
  return m ? (m[1].match(/'((?:[^']|'')*)'/g) ?? []).map((x) => x.slice(1, -1).replace(/''/g, "'")) : null;
}

export function editorKind(dataType: string, pgEnum = false): EditorKind {
  const t = dataType.toLowerCase().trim();
  if (pgEnum || enumValues(t)) return "enum";
  if (/^(bool|boolean|bit\(1\)|tinyint\(1\))$/.test(t)) return "bool";
  if (/^json/.test(t)) return "json";
  if (t === "date") return "date";
  // timezone-aware types keep a text editor: the browser picker would drop the offset
  if (/^(timestamp|datetime)(\(\d\))?( without time zone)?$/.test(t)) return "datetime";
  return null;
}

/** Can the browser picker show this value without losing anything (fractions, year 0, infinity)? */
export function fitsPicker(kind: "date" | "datetime", v: unknown): boolean {
  if (v === null) return true;
  const s = String(v);
  if (/^0000/.test(s)) return false;
  return kind === "date" ? /^\d{4}-\d\d-\d\d$/.test(s) : /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d(:\d\d)?$/.test(s);
}

/** "2024-05-01 10:20:30.5" -> "2024-05-01T10:20:30" for <input type="datetime-local">. */
export const toInputDateTime = (v: string) => v.replace(" ", "T").replace(/\.\d+$/, "").slice(0, 19);
/** back to the form databases accept everywhere */
export const fromInputDateTime = (v: string) => (v ? (v.length === 16 ? `${v}:00` : v).replace("T", " ") : v);
