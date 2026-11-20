// Shortcuts: defaults, the user's overrides (remembered in localStorage) and key matching.
// Keys use CodeMirror's notation ("Mod-Shift-Enter"; Mod = Ctrl, or Cmd on a Mac).
export interface Action { id: string; label: string; group: "App" | "Editor"; key: string }

export const ACTIONS: Action[] = [
  { id: "palette", label: "Command menu", group: "App", key: "Mod-k" },
  { id: "newTab", label: "New query tab", group: "App", key: "Mod-t" },
  { id: "closeTab", label: "Close tab", group: "App", key: "Mod-w" },
  { id: "sidebar", label: "Show / hide sidebar", group: "App", key: "Mod-b" },
  { id: "inspector", label: "Cell inspector", group: "App", key: "Mod-i" },
  { id: "zoomIn", label: "Zoom in", group: "App", key: "Mod-=" },
  { id: "zoomOut", label: "Zoom out", group: "App", key: "Mod--" },
  { id: "zoomReset", label: "Reset zoom", group: "App", key: "Mod-0" },
  { id: "shortcuts", label: "Keyboard shortcuts", group: "App", key: "F1" },
  { id: "settings", label: "Settings", group: "App", key: "Mod-," },
  { id: "run", label: "Run statement under the cursor", group: "Editor", key: "Mod-Enter" },
  { id: "runAll", label: "Run all", group: "Editor", key: "Mod-Shift-Enter" },
  { id: "explain", label: "Explain", group: "Editor", key: "Mod-Shift-e" },
  { id: "save", label: "Save query", group: "Editor", key: "Mod-s" },
  { id: "format", label: "Format SQL", group: "Editor", key: "Mod-Shift-f" },
];

/** Fixed shortcuts, listed on the shortcuts screen but not changeable. */
export const FIXED: { label: string; keys: string; where: string }[] = [
  { where: "Editor", label: "Open the table under the cursor", keys: "Ctrl+click" },
  { where: "Editor", label: "Autocomplete / snippets (sel, join, cte…)", keys: "Ctrl+Space" },
  { where: "Editor", label: "Cancel the running query", keys: "Esc" },
  { where: "Results", label: "Copy selection (with headers)", keys: "Ctrl+C (Ctrl+Shift+C)" },
  { where: "Results", label: "Paste into cells (table view)", keys: "Ctrl+V" },
  { where: "Results", label: "Select all", keys: "Ctrl+A" },
  { where: "Results", label: "Extend selection", keys: "Shift+arrows / Shift+click" },
  { where: "Results", label: "Edit cell", keys: "Enter / F2 / double-click" },
  { where: "Results", label: "Set NULL", keys: "Shift+Delete" },
  { where: "Results", label: "Mark row for deletion", keys: "Ctrl+Delete" },
  { where: "Tabs", label: "Show a tab next to the current one", keys: "Ctrl+click a tab" },
  { where: "Tabs", label: "Close a tab", keys: "Middle click" },
];

const KEY = "tilkidb.keys";

export function loadKeys(): Record<string, string> {
  const out = Object.fromEntries(ACTIONS.map((a) => [a.id, a.key]));
  try { Object.assign(out, JSON.parse(localStorage.getItem(KEY) ?? "{}")); } catch { /* defaults */ }
  return out;
}

export function saveKeys(keys: Record<string, string>) {
  const changed = Object.fromEntries(Object.entries(keys).filter(([id, k]) => ACTIONS.find((a) => a.id === id)?.key !== k));
  try { localStorage.setItem(KEY, JSON.stringify(changed)); } catch { /* not remembered */ }
}

const norm = (k: string) => (k.length === 1 ? k.toLowerCase() : k);

/** "Mod-Shift-e" from a key event; null for a lone modifier. */
export function keyOf(e: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }): string | null {
  if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return null;
  const k = e.key === " " ? "Space" : e.key === "+" ? "=" : norm(e.key);
  // Shift counts for letters and named keys; for symbols it is already in the character ("?")
  const shift = e.shiftKey && (k.length > 1 || /[a-z]/.test(k));
  return [(e.ctrlKey || e.metaKey) && "Mod", e.altKey && "Alt", shift && "Shift", k].filter(Boolean).join("-");
}

/** canonical order so "Shift-Mod-e" and "Mod-Shift-e" compare equal */
export function canon(spec: string): string {
  const parts = spec.split(/-(?!$)/);
  const key = norm(parts.pop()!);
  const mods = new Set(parts.map((p) => (p === "Ctrl" || p === "Cmd" || p === "Meta" ? "Mod" : p)));
  return [...["Mod", "Alt", "Shift"].filter((m) => mods.has(m)), key].join("-");
}

export const matches = (e: Parameters<typeof keyOf>[0], spec: string) => { const k = keyOf(e); return !!k && canon(k) === canon(spec); };

/** "Ctrl Shift E" for display */
export const pretty = (spec: string) => canon(spec).split("-").map((p) => (p === "Mod" ? "Ctrl" : p.length === 1 ? p.toUpperCase() : p === "Enter" ? "↵" : p)).join(" ");

/** The first action other than `id` already using this key. */
export const clash = (keys: Record<string, string>, id: string, spec: string) => ACTIONS.find((a) => a.id !== id && canon(keys[a.id]) === canon(spec)) ?? null;
