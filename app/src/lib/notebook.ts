// Notebook files (.tilkinb): plain JSON so they can be shared, diffed and kept in git.
import type { Notebook, NotebookCell } from "./api.ts";

const FORMAT = "tilki-notebook";
const id = () => (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2));

export const newCell = (kind: NotebookCell["kind"], src = ""): NotebookCell => ({ id: id(), kind, src });

export function newNotebook(name: string): Notebook {
  return { id: id(), name, updated: Date.now(), cells: [newCell("md", `# ${name}\n\nWhat this notebook is for.`), newCell("sql", "SELECT 1;")] };
}

export const toFile = (nb: Notebook) =>
  JSON.stringify({ format: FORMAT, version: 1, name: nb.name, cells: nb.cells.map(({ kind, src }) => ({ kind, src })) }, null, 2) + "\n";

/** Parse a notebook file into a new notebook (fresh ids). Throws a readable message if it isn't one. */
export function fromFile(text: string, fallbackName: string): Notebook {
  let v: unknown;
  try { v = JSON.parse(text); } catch { throw new Error("This file is not a Tilki DB notebook (not JSON)."); }
  const o = v as { format?: unknown; name?: unknown; cells?: unknown };
  if (!o || o.format !== FORMAT || !Array.isArray(o.cells)) throw new Error("This file is not a Tilki DB notebook.");
  const cells = o.cells.map((c: { kind?: unknown; src?: unknown }) => {
    if (!c || (c.kind !== "sql" && c.kind !== "md") || typeof c.src !== "string") throw new Error("The notebook has a cell it can't read.");
    return newCell(c.kind, c.src);
  });
  return { id: id(), name: typeof o.name === "string" && o.name.trim() ? o.name.trim() : fallbackName, updated: Date.now(), cells };
}
