// Color themes. Each palette has a dark and a light set of the same tokens;
// connection colors (dev/staging/prod) are not part of a palette on purpose.
export type Mode = "system" | "light" | "dark";
export interface ThemeChoice {
  mode: Mode;
  pal: string;
}
interface Palette {
  name: string;
  desc: string;
  fox: boolean;
  dark: string[];
  light: string[];
}

const KEYS = ["desk", "bg", "panel", "panel2", "line", "grid", "fg", "muted", "faint", "accent", "accent-fg", "accent-soft", "k"];

export const THEMES: Record<string, Palette> = {
  redfox: { name: "Red Fox", desc: "Russet orange on cream and charcoal", fox: true,
    dark: ["#0b0908", "#13100e", "#1a1613", "#221d19", "#332b25", "#1f1a17", "#f3e9df", "#9a8d81", "#645a51", "#e8612a", "#1c0b02", "rgba(232,97,42,.15)", "#f4c58e"],
    light: ["#e3d8cc", "#fcf8f3", "#f5eee5", "#ece2d6", "#e1d4c5", "#f0e7dc", "#24180f", "#6f5f50", "#ad9d8d", "#c4471a", "#ffffff", "rgba(196,71,26,.10)", "#a2410f"] },
  arcticfox: { name: "Arctic Fox", desc: "Snow white and ice, ink accent", fox: true,
    dark: ["#07090b", "#0d1114", "#13181c", "#1a2025", "#263038", "#182025", "#eef3f6", "#8796a1", "#56636d", "#dfe9f0", "#0d1418", "rgba(223,233,240,.10)", "#a9c7dc"],
    light: ["#d5dde3", "#fbfcfd", "#f2f5f7", "#e7ecf0", "#d9e0e6", "#ecf0f3", "#15202a", "#5b6b78", "#9eabb5", "#23384b", "#ffffff", "rgba(35,56,75,.09)", "#2d5f8a"] },
  silverfox: { name: "Silver Fox", desc: "Charcoal and silver with copper tips", fox: true,
    dark: ["#070708", "#0e0f11", "#151619", "#1c1e22", "#2a2d33", "#191b1f", "#e8eaee", "#8d929c", "#5a5f68", "#d98a52", "#1a0d04", "rgba(217,138,82,.15)", "#c9ced6"],
    light: ["#d6d8dc", "#f8f9fa", "#eff0f2", "#e4e6e9", "#d6d9de", "#e9ebee", "#17191d", "#60656e", "#a0a5ad", "#a4521f", "#ffffff", "rgba(164,82,31,.10)", "#4b5563"] },
  fennec: { name: "Fennec", desc: "Desert sand with soft tan", fox: true,
    dark: ["#0e0b07", "#16120c", "#1d1811", "#261f16", "#3a3022", "#231c14", "#f3e8d6", "#a2927a", "#6b5e4c", "#e9a061", "#1f1205", "rgba(233,160,97,.15)", "#f0bd84"],
    light: ["#e4d8c3", "#fdf8ef", "#f6eedf", "#eee2cd", "#e3d4bb", "#f1e7d5", "#2a2015", "#74654f", "#b2a289", "#b0601f", "#ffffff", "rgba(176,96,31,.11)", "#8f4c14"] },
  ember: { name: "Ember", desc: "Graphite with warm orange", fox: false,
    dark: ["#0a0a0b", "#121110", "#181716", "#211f1d", "#2b2825", "#1f1d1b", "#ece7e1", "#8e877f", "#5d5852", "#ff7a1a", "#1a0d03", "rgba(255,122,26,.14)", "#ff9a4d"],
    light: ["#dcd7d0", "#faf8f5", "#f2efeb", "#e8e4de", "#ddd7cf", "#ebe7e1", "#1d1b19", "#6e675f", "#a39b92", "#d95c06", "#ffffff", "rgba(217,92,6,.11)", "#c2510a"] },
  monolith: { name: "Monolith", desc: "Basalt and limestone, sandstone accent", fox: false,
    dark: ["#060606", "#0c0c0d", "#131314", "#1a1a1c", "#262628", "#18181a", "#e9e6e1", "#8c8882", "#5a5753", "#cfae74", "#17110a", "rgba(207,174,116,.14)", "#d9bb85"],
    light: ["#cfcbc4", "#f3f1ec", "#e9e6df", "#dedad2", "#cfcac0", "#e2ded6", "#161514", "#5f5b55", "#9d978f", "#7a5a26", "#ffffff", "rgba(122,90,38,.12)", "#7a5a26"] },
  glacier: { name: "Glacier", desc: "Cool slate with sky blue", fox: false,
    dark: ["#090b0d", "#0f1215", "#151a1e", "#1c2227", "#263038", "#1a2025", "#e3eaf0", "#84919c", "#56626c", "#4cb8ff", "#04121c", "rgba(76,184,255,.14)", "#6cc4ff"],
    light: ["#d3dbe2", "#f7f9fb", "#eef2f5", "#e2e8ed", "#d3dbe2", "#e6ebef", "#172029", "#5c6b77", "#9aa7b1", "#0b6fbf", "#ffffff", "rgba(11,111,191,.10)", "#0b6fbf"] },
  lagoon: { name: "Lagoon", desc: "Deep teal, calm and readable", fox: false,
    dark: ["#080b0b", "#0e1313", "#141a1a", "#1a2222", "#243030", "#182020", "#e0ecea", "#7f9391", "#536361", "#2fd1b5", "#03140f", "rgba(47,209,181,.14)", "#4fdcc3"],
    light: ["#d0dedb", "#f6faf9", "#ecf3f1", "#dfe9e6", "#cfdeda", "#e3ece9", "#13201e", "#56706b", "#95aaa6", "#0b8a76", "#ffffff", "rgba(11,138,118,.10)", "#0b8a76"] },
  moss: { name: "Moss", desc: "Olive greys with leaf green", fox: false,
    dark: ["#090b09", "#101310", "#161a16", "#1d221c", "#283027", "#1b2019", "#e4eade", "#87917f", "#586152", "#9bd65c", "#0d1604", "rgba(155,214,92,.14)", "#a9dc72"],
    light: ["#d6dccf", "#f8f9f4", "#eff2ea", "#e4e9dc", "#d5dccb", "#e7ebe0", "#1a2015", "#5f6b55", "#9ea891", "#3f7f1c", "#ffffff", "rgba(63,127,28,.10)", "#3f7f1c"] },
  iris: { name: "Iris", desc: "Ink blue with soft violet", fox: false,
    dark: ["#0a0a0e", "#111118", "#17171f", "#1e1e29", "#2a2a38", "#1c1c26", "#e7e6f2", "#8b89a0", "#5b5a6e", "#a58cff", "#120a2a", "rgba(165,140,255,.15)", "#b7a2ff"],
    light: ["#d9d8e4", "#f9f9fc", "#f0eff6", "#e5e3ef", "#d8d6e5", "#e9e8f1", "#1b1a26", "#64627a", "#a3a1b6", "#6a4fd6", "#ffffff", "rgba(106,79,214,.10)", "#6a4fd6"] },
  rosewood: { name: "Rosewood", desc: "Warm mauve with soft pink", fox: false,
    dark: ["#0c090a", "#141011", "#1a1517", "#221b1e", "#31272b", "#1f191c", "#f0e6ea", "#9a8a90", "#64585d", "#f283ac", "#22070f", "rgba(242,131,172,.15)", "#f59dbd"],
    light: ["#e0d5d9", "#fbf7f8", "#f4edf0", "#eadfe4", "#e0d3d9", "#efe6ea", "#23181c", "#6e5c63", "#ae9ca3", "#c0356c", "#ffffff", "rgba(192,53,108,.10)", "#c0356c"] },
  dune: { name: "Dune", desc: "Desert sand with sky blue", fox: false,
    dark: ["#0d0b08", "#15120e", "#1c1813", "#241f18", "#352d22", "#211c16", "#efe6d8", "#9b8f7c", "#655c4f", "#86b0de", "#08121d", "rgba(134,176,222,.15)", "#e0b26a"],
    light: ["#ddd3c2", "#faf6ee", "#f2ebde", "#e8dfcd", "#ddd2bd", "#ede5d6", "#241e15", "#6f6452", "#ab9f8a", "#2f5f93", "#ffffff", "rgba(47,95,147,.10)", "#8a5a12"] },
  graphite: { name: "Graphite", desc: "Pure neutral, no color", fox: false,
    dark: ["#08080a", "#101012", "#161618", "#1d1d20", "#2a2a2e", "#1b1b1e", "#ececee", "#8a8a90", "#5a5a60", "#f2f2f4", "#111113", "rgba(242,242,244,.10)", "#f2f2f4"],
    light: ["#d8d8dc", "#fafafa", "#f1f1f3", "#e6e6e9", "#dadade", "#ebebee", "#18181b", "#66666d", "#a5a5ab", "#18181b", "#ffffff", "rgba(24,24,27,.08)", "#18181b"] },
};

/** CSS for every palette, keyed on data-palette and data-theme on <html>. */
export function themeCss(): string {
  const vars = (vals: string[]) => KEYS.map((k, i) => `--${k}:${vals[i]}`).join(";");
  return Object.entries(THEMES)
    .map(([id, p]) =>
      `:root[data-palette="${id}"]{${vars(p.dark)}}` +
      `@media (prefers-color-scheme: light){:root[data-palette="${id}"]:not([data-theme="dark"]){${vars(p.light)}}}` +
      `:root[data-palette="${id}"][data-theme="light"]{${vars(p.light)}}`)
    .join("\n");
}

const STORE_KEY = "tilkidb.theme";
const DEFAULT: ThemeChoice = { mode: "system", pal: "redfox" };

export function loadTheme(): ThemeChoice {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) ?? "null");
    if (s && THEMES[s.pal] && ["system", "light", "dark"].includes(s.mode)) return s;
  } catch {
    // storage blocked or corrupt: fall back to the default theme
  }
  return DEFAULT;
}

export function applyTheme(c: ThemeChoice): void {
  const root = document.documentElement;
  if (c.mode === "system") delete root.dataset.theme;
  else root.dataset.theme = c.mode;
  root.dataset.palette = c.pal;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(c));
  } catch {
    // not fatal: the theme just won't be remembered
  }
}

export const isDark = (c: ThemeChoice): boolean =>
  c.mode === "dark" || (c.mode === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
