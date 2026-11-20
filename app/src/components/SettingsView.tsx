import { useEffect, useState, type ReactNode } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { desktop } from "../lib/api";
import { DATA_FONTS, getSettings, type Settings } from "../lib/settings";
import { isDark, THEMES, type Mode, type ThemeChoice } from "../theme/themes";
import { Icon, Logo, type IconName } from "./Icons";
import devDark from "../assets/dev-logo-dark.svg";
import devLight from "../assets/dev-logo-light.svg";

export type Density = "compact" | "comfortable" | "spacious";
export const DENSITIES: [Density, string, string][] = [["compact", "Compact", "more rows on screen"], ["comfortable", "Default", "balanced spacing"], ["spacious", "Spacious", "roomier rows and toolbars"]];
export const MODES: [Mode, string][] = [["system", "System"], ["light", "Light"], ["dark", "Dark"]];

const SITE = "https://bilenahmet.com/tilkidb";
const LINKS = { site: SITE, support: `${SITE}/support`, developer: "https://bilenahmet.com" };
const SECTIONS = ["Appearance", "Editor", "Results", "Connections & safety", "History & privacy", "Keyboard", "AI assistant", "About"] as const;
type Section = (typeof SECTIONS)[number];
const SECTION_ICON: Record<Section, IconName> = {
  Appearance: "theme", Editor: "code", Results: "table", "Connections & safety": "shield",
  "History & privacy": "history", Keyboard: "keyboard", "AI assistant": "sparkle", About: "info",
};

const openUrl = (url: string) => (desktop ? invoke("open_url", { url }) : Promise.resolve(window.open(url, "_blank")));

function Seg<T extends string | number>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <span className="seg" role="group" aria-label={label}>
      {options.map(([v, text]) => <button key={String(v)} className={v === value ? "on" : ""} aria-pressed={v === value} onClick={() => onChange(v)}>{text}</button>)}
    </span>
  );
}

const Row = ({ label, help, children }: { label: string; help?: string; children: ReactNode }) => (
  <div className="srow"><div><b>{label}</b>{help && <small>{help}</small>}</div><div className="ctl">{children}</div></div>
);

// The Settings tab: appearance, editor, results, connections, history, keyboard, AI and About.
export function SettingsView(p: {
  settings: Settings; onSettings: (s: Settings) => void;
  theme: ThemeChoice; onTheme: (t: ThemeChoice) => void;
  density: Density; onDensity: (d: Density) => void;
  zoom: number; onZoom: (z: number) => void;
  reconnect: boolean; onReconnect: (v: boolean) => void;
  aiReady: boolean; onAiSetup: () => void;
  onShortcuts: () => void; onClearHistory: () => void; onToast: (m: string) => void; onCheckUpdate: () => void;
}) {
  const [section, setSection] = useState<Section>("Appearance");
  const [version, setVersion] = useState("");
  useEffect(() => { if (desktop) getVersion().then(setVersion, () => {}); }, []);
  const s = p.settings;
  // on top of the latest saved values, so two quick changes don't undo each other
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => p.onSettings({ ...getSettings(), [k]: v });
  const link = (url: string) => openUrl(url).catch((e) => p.onToast(String(e)));
  const onOff: [string, string][] = [["on", "On"], ["off", "Off"]];
  const flag = (k: "autocomplete" | "wrap" | "lineNumbers" | "reconnectLast" | "historySkipProd" | "ai" | "autoUpdate", label: string) =>
    <Seg label={label} value={s[k] ? "on" : "off"} options={onOff} onChange={(v) => set(k, v === "on")} />;

  const body: Record<Section, ReactNode> = {
    Appearance: (
      <>
        <Row label="Mode" help="The button at the bottom of the rail switches this too: System → Light → Dark.">
          <Seg label="Mode" value={p.theme.mode} options={MODES} onChange={(mode) => p.onTheme({ ...p.theme, mode })} />
        </Row>
        <div className="srow stack">
          <div><b>Color theme</b><small>Every theme has a light and a dark side.</small></div>
          {([["Fox themes", true, 4], ["More themes", false, 5]] as const).map(([title, fox, cols]) => (
            <div key={title}>
              <h5>{title}</h5>
              <div className="tiles" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
                {Object.entries(THEMES).filter(([, t]) => t.fox === fox).map(([id, t]) => (
                  <button key={id} className={`tile${p.theme.pal === id ? " on" : ""}`} aria-pressed={p.theme.pal === id} title={t.desc} onClick={() => p.onTheme({ ...p.theme, pal: id })}>
                    <span className="sample"><i style={{ background: t.dark[1] }}><b style={{ background: t.dark[9] }} /></i><i style={{ background: t.light[1] }}><b style={{ background: t.light[9] }} /></i></span>
                    <span className="nm">{t.name}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
        <Row label="Density" help="Compact fits more rows on screen; Spacious gives rows and toolbars more room.">
          <Seg label="Density" value={p.density} options={DENSITIES.map(([d, l]) => [d, l])} onChange={p.onDensity} />
        </Row>
        <Row label="Zoom" help="The whole window: text, icons and spacing. Also Ctrl + / Ctrl − / Ctrl 0.">
          <Seg label="Zoom" value={p.zoom} options={[[0.9, "90%"], [1, "100%"], [1.1, "110%"], [1.25, "125%"], [1.5, "150%"]]} onChange={p.onZoom} />
        </Row>
        <Row label="Data and code font" help="Results, the SQL editor and previews. Cascadia Mono and Consolas come with Windows.">
          <Seg label="Data and code font" value={s.dataFont} options={Object.keys(DATA_FONTS).map((f) => [f, f])} onChange={(v) => set("dataFont", v)} />
        </Row>
      </>
    ),
    Editor: (
      <>
        <Row label="Font size"><Seg label="Editor font size" value={s.editorFontSize} options={[[12, "12"], [13, "13"], [14, "14"], [16, "16"]]} onChange={(v) => set("editorFontSize", v)} /></Row>
        <Row label="Tab size" help="Spaces per indent, also used by Format."><Seg label="Tab size" value={s.tabSize} options={[[2, "2"], [4, "4"]]} onChange={(v) => set("tabSize", v)} /></Row>
        <Row label="Keyword case when formatting" help="What Format (Ctrl+Shift+F) does to SELECT, FROM…">
          <Seg label="Keyword case" value={s.keywordCase} options={[["upper", "UPPER"], ["lower", "lower"], ["preserve", "As typed"]]} onChange={(v) => set("keywordCase", v)} />
        </Row>
        <Row label="Suggestions while typing" help="Off: suggestions only with Ctrl+Space.">{flag("autocomplete", "Suggestions while typing")}</Row>
        <Row label="Word wrap">{flag("wrap", "Word wrap")}</Row>
        <Row label="Line numbers">{flag("lineNumbers", "Line numbers")}</Row>
      </>
    ),
    Results: (
      <>
        <Row label="Row limit for new query tabs" help="Each tab can still change its own limit.">
          <Seg label="Row limit" value={s.rowLimit} options={[[100, "100"], [1000, "1,000"], [10000, "10,000"], [100000, "100,000"], [0, "No limit"]]} onChange={(v) => set("rowLimit", v)} />
        </Row>
        <Row label="How NULL is shown"><Seg label="NULL text" value={s.nullText} options={[["NULL", "NULL"], ["∅", "∅"], ["", "Empty"]]} onChange={(v) => set("nullText", v)} /></Row>
        <Row label="Rows per page in table tabs"><Seg label="Rows per page" value={s.pageSize} options={[[100, "100"], [500, "500"], [1000, "1,000"], [5000, "5,000"]]} onChange={(v) => set("pageSize", v)} /></Row>
      </>
    ),
    "Connections & safety": (
      <>
        <Row label="Auto-reconnect" help="Reopens a connection that dropped (also a dead SSH tunnel). Nothing is run again by itself.">
          <Seg label="Auto-reconnect" value={p.reconnect ? "on" : "off"} options={onOff} onChange={(v) => p.onReconnect(v === "on")} />
        </Row>
        <Row label="Query timeout" help="Stops a query tab's statement after this long.">
          <Seg label="Query timeout" value={s.queryTimeout} options={[[0, "Off"], [30, "30 s"], [300, "5 min"], [1800, "30 min"]]} onChange={(v) => set("queryTimeout", v)} />
        </Row>
        <Row label="Open the last connection on start">{flag("reconnectLast", "Open the last connection on start")}</Row>
        <Row label="Production connections" help="Writes to a connection marked production always ask for its name first. This can't be turned off.">
          <span className="ty">Always on</span>
        </Row>
      </>
    ),
    "History & privacy": (
      <>
        <Row label="Queries to keep in the list"><Seg label="History size" value={s.historyKeep} options={[[100, "100"], [300, "300"], [1000, "1,000"]]} onChange={(v) => set("historyKeep", v)} /></Row>
        <Row label="Skip history for production connections" help="Queries run on production connections aren't recorded.">{flag("historySkipProd", "Skip history for production")}</Row>
        <Row label="Clear history" help="Removes every recorded query. Saved queries and notebooks stay.">
          <button className="btn danger" onClick={p.onClearHistory}><Icon name="trash" />Clear history…</button>
        </Row>
      </>
    ),
    Keyboard: (
      <Row label="Shortcuts" help="Every shortcut, and changing the app and editor ones. Also F1.">
        <button className="btn" onClick={p.onShortcuts}><Icon name="keyboard" />Open shortcuts</button>
      </Row>
    ),
    "AI assistant": (
      <>
        <Row label="Show the AI assistant" help="Off hides the AI tab in query tabs.">{flag("ai", "Show the AI assistant")}</Row>
        <Row label="API key" help="Kept in the OS keychain; queries go straight from this computer to the Claude API.">
          <button className="btn" onClick={p.onAiSetup}><Icon name="edit" />{p.aiReady ? "Change or remove…" : "Set up…"}</button>
        </Row>
      </>
    ),
    About: (
      <div className="about">
        <div className="hero"><Logo /><div>
          <h1>Tilki <span>DB</span></h1>
          <p>A fast, keyboard-first SQL client for PostgreSQL, MySQL, MariaDB and SQLite.</p>
          <div className="ver"><b>Version {version || "…"}</b><button className="btn" onClick={p.onCheckUpdate}><Icon name="refresh" />Check for updates</button></div>
        </div></div>
        <Row label="Check for updates on start" help="Looks at the GitHub releases a few seconds after start. Nothing is installed until you click Update.">{flag("autoUpdate", "Check for updates on start")}</Row>
        <div className="links">
          <button className="lk" onClick={() => link(LINKS.site)}><Icon name="globe" /><span><b>Website</b><small>bilenahmet.com/tilkidb</small></span><Icon name="external" /></button>
          <button className="lk" onClick={() => link(LINKS.support)}><Icon name="bug" /><span><b>Report a problem</b><small>Support and contact</small></span><Icon name="external" /></button>
        </div>
        <h5>Made by</h5>
        <div className="dev">
          <img src={isDark(p.theme) ? devDark : devLight} alt="Ahmet Bilen" height={52} />
          <div><small>Developer website</small><button className="linkbtn" onClick={() => link(LINKS.developer)}>bilenahmet.com <Icon name="external" /></button></div>
        </div>
        <h5>Built with</h5>
        <p className="credits">Tauri, React, Rust, sqlx, CodeMirror, and the Poppins and JetBrains Mono fonts.</p>
        <p className="legal">© 2026 Tilki DB. All rights reserved.</p>
      </div>
    ),
  };

  return (
    <div className="settings">
      <nav className="snav" aria-label="Settings sections">
        {SECTIONS.map((x) => <button key={x} className={x === section ? "on" : ""} aria-current={x === section ? "page" : undefined} onClick={() => setSection(x)}><Icon name={SECTION_ICON[x]} />{x}</button>)}
      </nav>
      <div className="sbody">
        {section !== "About" && <h2>{section}</h2>}
        {body[section]}
      </div>
    </div>
  );
}
