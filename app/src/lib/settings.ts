// App preferences shown in Settings, remembered in localStorage. Theme, density, zoom, shortcuts and
// auto-reconnect keep their own keys (they predate this page); everything newer lives here.
export interface Settings {
  dataFont: string; // results, editor, previews
  editorFontSize: number;
  tabSize: 2 | 4;
  keywordCase: "upper" | "lower" | "preserve"; // Format SQL
  autocomplete: boolean; // suggestions while typing (Ctrl+Space always works)
  wrap: boolean;
  lineNumbers: boolean;
  rowLimit: number; // new query tabs; 0 = no limit
  nullText: string;
  pageSize: number; // new table tabs
  queryTimeout: number; // seconds, 0 = off
  reconnectLast: boolean; // open the last connection on start
  historyKeep: number;
  historySkipProd: boolean;
  ai: boolean; // show the AI assistant
  autoUpdate: boolean; // look for a new release a few seconds after start
}

export const DEFAULTS: Settings = {
  dataFont: "JetBrains Mono", editorFontSize: 13, tabSize: 2, keywordCase: "upper", autocomplete: true, wrap: false, lineNumbers: true,
  rowLimit: 1000, nullText: "NULL", pageSize: 500, queryTimeout: 0, reconnectLast: false, historyKeep: 300, historySkipProd: false, ai: true, autoUpdate: true,
};

/** Bundled first, then fonts Windows ships with. */
export const DATA_FONTS: Record<string, string> = {
  "JetBrains Mono": `"JetBrains Mono", Consolas, monospace`,
  "Cascadia Mono": `"Cascadia Mono", "Cascadia Code", Consolas, monospace`,
  Consolas: `Consolas, "Courier New", monospace`,
};

const KEY = "tilkidb.settings";

/** Saved values over the defaults; unknown or mistyped entries are ignored. */
export function parseSettings(raw: string | null): Settings {
  const out = { ...DEFAULTS };
  try {
    const s = JSON.parse(raw ?? "{}");
    for (const k of Object.keys(DEFAULTS) as (keyof Settings)[]) if (s && typeof s[k] === typeof DEFAULTS[k]) (out as Record<string, unknown>)[k] = s[k];
  } catch { /* defaults */ }
  if (!(out.dataFont in DATA_FONTS)) out.dataFont = DEFAULTS.dataFont;
  return out;
}

let current: Settings = (() => { try { return parseSettings(localStorage.getItem(KEY)); } catch { return { ...DEFAULTS }; } })();

/** For code outside React state (cell text, formatting, new tabs). */
export const getSettings = () => current;

export function saveSettings(s: Settings) {
  current = s;
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* not remembered */ }
  applySettings(s);
  dispatchEvent(new Event("tilki:settings")); // editors reconfigure themselves
}

/** The CSS side: fonts and editor size are variables. */
export function applySettings(s: Settings) {
  const root = document.documentElement.style;
  root.setProperty("--mono", DATA_FONTS[s.dataFont]);
  root.setProperty("--editor-size", `${s.editorFontSize}px`);
}
