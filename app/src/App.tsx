import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { AiSettings } from "./components/AiPane";
import { CommandPalette, type Command } from "./components/CommandPalette";
import { ConnectionDialog, type TagOps } from "./components/ConnectionDialog";
import { ConnectionPicker, where } from "./components/ConnectionPicker";
import { ActivityView } from "./components/ActivityView";
import { DiffView } from "./components/DiffView";
import { DataCompare } from "./components/DataCompare";
import { CopyTable } from "./components/CopyTable";
import { UsersView } from "./components/UsersView";
import { ShortcutsDialog } from "./components/Shortcuts";
import { loadKeys, matches, pretty, saveKeys } from "./lib/keymap";
import { shouldReopen } from "./lib/reconnect";
import { ErdView } from "./components/ErdView";
import { HistoryList } from "./components/HistoryList";
import { ImportConnections } from "./components/ImportConnections";
import { NotebookList, NotebookView } from "./components/Notebook";
import { Icon, Logo, type IconName } from "./components/Icons";
import { QueryTab, type QTab } from "./components/QueryTab";
import { SavedList } from "./components/SavedList";
import { SchemaTree } from "./components/SchemaTree";
import { NewTableDialog } from "./components/StructureView";
import { TableTab } from "./components/TableTab";
import { ToolsPanel, useJobs } from "./components/Tools";
import { TitleBar } from "./components/TitleBar";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { api, desktop, ENGINES, errText, newConnection, type ConnConfig, type HistoryEntry, type Notebook, type SavedQuery, type Store, type Table } from "./lib/api";
import { fromFile, newNotebook } from "./lib/notebook";
import { unknownHostKey } from "./lib/connUrl";
import { applyTheme, isDark, loadTheme, THEMES, type ThemeChoice } from "./theme/themes";
import { DENSITIES, SettingsView, type Density } from "./components/SettingsView";
import { getSettings, saveSettings, type Settings } from "./lib/settings";

type SideView = "explorer" | "history" | "saved" | "tools";

const SIDE: { id: SideView; icon: IconName; label: string; empty: string }[] = [
  { id: "explorer", icon: "database", label: "Explorer", empty: "" },
  { id: "history", icon: "history", label: "Query history", empty: "" },
  { id: "saved", icon: "saved", label: "Saved queries and notebooks", empty: "" },
  { id: "tools", icon: "tools", label: "Database tools", empty: "" },
];


type Conn = { id: string; state: "connecting" | "connected" | "error"; version?: string; error?: string };

// Open query tabs (with their SQL) survive restarts; results don't.
const TABS_KEY = "tilkidb.tabs";
function loadTabs(): { tabs: QTab[]; active: string | null; lastActive: Record<string, string> } {
  try {
    const s = JSON.parse(localStorage.getItem(TABS_KEY) ?? "null");
    if (s && Array.isArray(s.tabs)) return { tabs: s.tabs.map((t: QTab) => ({ ...t, autorun: false })), active: s.active ?? null, lastActive: s.lastActive ?? {} };
  } catch {
    // corrupt or blocked storage: start with no tabs
  }
  return { tabs: [], active: null, lastActive: {} };
}
type Schema = { loading: boolean; tables: Table[]; error?: string };

export default function App() {
  const [theme, setTheme] = useState<ThemeChoice>(loadTheme);
  const [sideOpen, setSideOpen] = useState(true);
  const [side, setSide] = useState<SideView>("explorer");
  const [palette, setPalette] = useState<string | null>(null); // null = closed, string = initial query
  const [settings, setSettingsState] = useState<Settings>(getSettings);
  const setSettings = useCallback((s: Settings) => { setSettingsState(s); saveSettings(s); }, []);
  const [store, setStore] = useState<Store | null>(null);
  const [storeError, setStoreError] = useState<string | null>(null);
  const storeRef = useRef(store);
  storeRef.current = store;
  const [conn, setConn] = useState<Conn | null>(null);
  const [schema, setSchema] = useState<Schema>({ loading: false, tables: [] });
  const [dialog, setDialog] = useState<{ cfg: ConnConfig | null } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [tabs, setTabs] = useState<QTab[]>(() => loadTabs().tabs);
  const [update, setUpdate] = useState<Update | null>(null);
  const [updating, setUpdating] = useState(false);
  const [activeTab, setActiveTab] = useState<string | null>(() => loadTabs().active);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [inspector, setInspector] = useState(() => { try { return localStorage.getItem("tilkidb.inspector") === "1"; } catch { return false; } });
  useEffect(() => { try { localStorage.setItem("tilkidb.inspector", inspector ? "1" : "0"); } catch { /* not remembered */ } }, [inspector]);

  useEffect(() => applyTheme(theme), [theme]);
  useEffect(() => { api.loadStore().then(setStore, (e) => setStoreError(errText(e))); }, []);

  // Releases come from GitHub (tauri.conf.json plugins.updater); a manual check reports its result, the startup one stays quiet.
  const checkUpdate = useCallback(async (manual: boolean) => {
    if (!desktop) { if (manual) setToast("Updates work in the desktop app."); return; }
    try {
      const u = await check();
      setUpdate(u);
      if (manual) setToast(u ? `Tilki DB ${u.version} is available. Use the button in the status bar to install it.` : "You have the latest version.");
    } catch (e) { if (manual) setToast(`Couldn't check for updates: ${errText(e)}`); }
  }, []);
  useEffect(() => {
    if (!getSettings().autoUpdate) return;
    const t = setTimeout(() => checkUpdate(false), 5000);
    return () => clearTimeout(t);
  }, [checkUpdate]);
  const installUpdate = async () => {
    if (!update || updating) return;
    // the installer closes the app, which would drop an open transaction
    if (tabs.some((t) => t.dirty)) { setToast("Commit or roll back open transactions before updating."); return; }
    setUpdating(true);
    setToast(`Downloading Tilki DB ${update.version}…`);
    try { await update.downloadAndInstall(); } // Windows: the installer closes and restarts the app
    catch (e) { setUpdating(false); setToast(`Update failed: ${errText(e)}`); }
  };
  // Settings › open the last connection on start
  const reopened = useRef(false);
  useEffect(() => {
    if (!store || reopened.current) return;
    reopened.current = true;
    let last: string | null = null;
    try { last = localStorage.getItem("tilkidb.lastConn"); } catch { /* none */ }
    if (getSettings().reconnectLast && last && store.connections.some((c) => c.id === last)) connectTo(last);
  }, [store]); // deps chosen on purpose
  useEffect(() => { api.loadHistory(getSettings().historyKeep).then(setHistory, () => {}); }, []);
  // page zoom (Ctrl + / - / 0) and layout density, remembered between runs
  const [zoom, setZoom] = useState(() => { try { return Number(localStorage.getItem("tilkidb.zoom")) || 1; } catch { return 1; } });
  useEffect(() => {
    if (desktop) getCurrentWebview().setZoom(zoom).catch(() => {});
    try { localStorage.setItem("tilkidb.zoom", String(zoom)); } catch { /* not remembered */ }
  }, [zoom]);
  const bumpZoom = useCallback((d: number) => setZoom((z) => (d === 0 ? 1 : Math.round(Math.min(2, Math.max(0.6, z + d)) * 10) / 10)), []);
  const [density, setDensity] = useState<Density>(() => { try { const d = localStorage.getItem("tilkidb.density"); return d === "compact" || d === "spacious" ? d : "comfortable"; } catch { return "comfortable"; } });
  useEffect(() => {
    document.documentElement.dataset.density = density;
    try { localStorage.setItem("tilkidb.density", density); } catch { /* not remembered */ }
  }, [density]);
  // shortcuts (F1 lists and changes them) and optional auto-reconnect, remembered between runs
  const [keys, setKeysState] = useState(loadKeys);
  const setKeys = useCallback((k: Record<string, string>) => { setKeysState(k); saveKeys(k); }, []);
  const [shortcuts, setShortcuts] = useState(false);
  const [reconnect, setReconnect] = useState(() => { try { return localStorage.getItem("tilkidb.reconnect") === "1"; } catch { return false; } });
  useEffect(() => { try { localStorage.setItem("tilkidb.reconnect", reconnect ? "1" : "0"); } catch { /* not remembered */ } }, [reconnect]);
  const [aiReady, setAiReady] = useState(false);
  const [aiSettings, setAiSettings] = useState(false);
  useEffect(() => { api.aiKeyStatus().then(setAiReady, () => {}); }, []);
  const aiProps = useMemo(() => ({ ready: aiReady, setup: () => setAiSettings(true), enabled: settings.ai }), [aiReady, settings.ai]);
  useEffect(() => {
    try { localStorage.setItem(TABS_KEY, JSON.stringify({ tabs, active: activeTab, lastActive: lastActive.current })); } catch { /* not remembered, not fatal */ }
  }, [tabs, activeTab]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(t);
  }, [toast]);

  const active = store?.connections.find((c) => c.id === conn?.id) ?? null;
  const openPalette = useCallback((q = "") => setPalette((p) => (p === null ? q : null)), []);
  const toggleMode = useCallback(() => setTheme((t) => ({ ...t, mode: isDark(t) ? "light" : "dark" })), []);

  // Every change to connections or tags is written to disk right away.
  const persist = useCallback(async (next: Store) => {
    await api.saveStore(next);
    setStore(next);
  }, []);

  const loadSchema = useCallback(async (id: string) => {
    setSchema({ loading: true, tables: [] });
    try {
      setSchema({ loading: false, tables: await api.listSchema(id) });
    } catch (e) {
      setSchema({ loading: false, tables: [], error: errText(e) });
    }
  }, []);

  const connectTo = useCallback(async (id: string, trustHost = false) => {
    if (conn && conn.id !== id) api.disconnect(conn.id);
    connIdRef.current = id;
    try { localStorage.setItem("tilkidb.lastConn", id); } catch { /* not remembered */ }
    setTabs((ts) => ts.map((t) => (t.connId || t.kind === "settings" ? t : { ...t, connId: id })));
    if (!tabsRef.current.some((t) => (!t.connId && t.kind !== "settings") || t.connId === id)) {
      const t: QTab = { connId: id, id: crypto.randomUUID(), title: "Query 1", sql: "", limit: getSettings().rowLimit };
      setTabs((ts) => [...ts, t]);
      setActiveTab(t.id);
    }
    setConn({ id, state: "connecting" });
    setSchema({ loading: false, tables: [] });
    setSide("explorer");
    setSideOpen(true);
    try {
      const version = await api.connect(id, trustHost);
      setConn({ id, state: "connected", version });
      loadSchema(id);
    } catch (e) {
      setConn({ id, state: "error", error: errText(e) });
    }
  }, [conn, loadSchema]);

  // Tabs belong to the connection they were opened on; only the active connection's are shown.
  const connIdRef = useRef<string | null>(null);
  connIdRef.current = conn?.id ?? null;
  const own = () => tabsRef.current.filter((t) => t.kind === "settings" || (t.connId ?? null) === connIdRef.current);
  const visible = tabs.filter((t) => t.kind === "settings" || (t.connId ?? null) === (conn?.id ?? null));
  const lastActive = useRef<Record<string, string>>(loadTabs().lastActive);
  // switching connection brings back the tab last used there (or its first tab)
  const visibleIds = visible.map((t) => t.id).join(",");
  useEffect(() => {
    if (visible.some((t) => t.id === activeTab)) { if (conn && activeTab) lastActive.current[conn.id] = activeTab; return; }
    const back = conn ? visible.find((t) => t.id === lastActive.current[conn.id]) : undefined;
    const next = back ?? visible[0];
    if (next) setActiveTab(next.id);
  }, [visibleIds, activeTab, conn?.id]); // deps chosen on purpose

  // Tab changes read the current list from a ref and set tabs / active tab separately:
  // state updaters must stay pure (React may run them twice).
  const newTab = useCallback((sql = "", title?: string, autorun = false, savedId?: string) => {
    const t: QTab = { connId: connIdRef.current ?? undefined, id: crypto.randomUUID(), title: title ?? `Query ${own().length + 1}`, sql, limit: getSettings().rowLimit, autorun, savedId };
    setTabs((ts) => [...ts, t]);
    setActiveTab(t.id);
  }, []);
  const openTableTab = useCallback((tb: Table, jump?: { col: string; val: string; n: number }) => {
    const existing = own().find((x) => x.kind === "table" && x.table?.schema === tb.schema && x.table?.name === tb.name);
    if (existing) {
      if (jump) setTabs((ts) => ts.map((x) => (x.id === existing.id ? { ...x, table: { schema: tb.schema, name: tb.name, jump } } : x)));
      setActiveTab(existing.id);
      return;
    }
    const t: QTab = { connId: connIdRef.current ?? undefined, id: crypto.randomUUID(), title: tb.name, kind: "table", table: { schema: tb.schema, name: tb.name, jump }, sql: "", limit: 500 };
    setTabs((ts) => [...ts, t]);
    setActiveTab(t.id);
  }, []);
  const openErd = useCallback(() => {
    const existing = own().find((x) => x.kind === "erd");
    if (existing) { setActiveTab(existing.id); return; }
    const t: QTab = { connId: connIdRef.current ?? undefined, id: crypto.randomUUID(), title: "ER diagram", kind: "erd", sql: "", limit: 0 };
    setTabs((ts) => [...ts, t]);
    setActiveTab(t.id);
  }, []);
  const openDiff = useCallback(() => {
    const existing = own().find((x) => x.kind === "diff");
    if (existing) { setActiveTab(existing.id); return; }
    const t: QTab = { connId: connIdRef.current ?? undefined, id: crypto.randomUUID(), title: "Schema diff", kind: "diff", sql: "", limit: 0 };
    setTabs((ts) => [...ts, t]);
    setActiveTab(t.id);
  }, []);
  const openSingle = useCallback((kind: "datadiff" | "copy" | "users") => {
    const existing = own().find((x) => x.kind === kind);
    if (existing) { setActiveTab(existing.id); return; }
    const t: QTab = { connId: connIdRef.current ?? undefined, id: crypto.randomUUID(), title: { datadiff: "Data compare", copy: "Copy tables", users: "Users and roles" }[kind], kind, sql: "", limit: 0 };
    setTabs((ts) => [...ts, t]);
    setActiveTab(t.id);
  }, []);
  const openSettings = useCallback(() => {
    const existing = tabsRef.current.find((x) => x.kind === "settings");
    if (existing) { setActiveTab(existing.id); return; }
    const t: QTab = { id: crypto.randomUUID(), title: "Settings", kind: "settings", sql: "", limit: 0 };
    setTabs((ts) => [...ts, t]);
    setActiveTab(t.id);
  }, []);
  const clearHistory = () => {
    if (!confirm("Clear the whole query history? Saved queries and notebooks stay.")) return;
    api.clearHistory().then(() => { setHistory([]); setToast("History cleared"); }, (e) => setToast(errText(e)));
  };
  const openActivity = useCallback(() => {
    const existing = own().find((x) => x.kind === "activity");
    if (existing) { setActiveTab(existing.id); return; }
    const t: QTab = { connId: connIdRef.current ?? undefined, id: crypto.randomUUID(), title: "Server activity", kind: "activity", sql: "", limit: 0 };
    setTabs((ts) => [...ts, t]);
    setActiveTab(t.id);
  }, []);
  const [newTable, setNewTable] = useState(false);
  const [importing, setImporting] = useState(false);
  const importConns = async (items: { cfg: ConnConfig; password: string | null }[]) => {
    if (!store) return;
    const added = items.map((i) => ({ ...newConnection(), ...i.cfg, id: crypto.randomUUID(), color: i.cfg.prod ? "#ef4a4a" : newConnection().color }));
    for (let k = 0; k < added.length; k++) if (items[k].password) await api.setPassword(added[k].id, items[k].password);
    await persist({ ...store, connections: [...store.connections, ...added] });
    setToast(`Imported ${added.length} connection${added.length === 1 ? "" : "s"}`);
  };
  // split view: a second tab shown to the right of the active one
  const [splitTab, setSplitTab] = useState<string | null>(null);
  const [splitPct, setSplitPct] = useState(50);
  const prevActive = useRef<string | null>(null);
  useEffect(() => {
    if (splitTab && splitTab === activeTab) setSplitTab(prevActive.current); // picked the right-hand tab: swap sides
    prevActive.current = activeTab;
  }, [activeTab]); // deps chosen on purpose
  const split = splitTab && splitTab !== activeTab && visible.some((t) => t.id === splitTab) ? splitTab : null;
  const toggleSplit = () => {
    if (split) { setSplitTab(null); return; }
    const other = visible.find((t) => t.id === prevActive.current && t.id !== activeTab) ?? visible.find((t) => t.id !== activeTab);
    if (other) setSplitTab(other.id); else setToast("Open a second tab to split the view.");
  };
  const dragSplit = (e: React.PointerEvent) => {
    const box = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
    const move = (ev: PointerEvent) => setSplitPct(Math.max(20, Math.min(80, ((ev.clientX - box.left) / box.width) * 100)));
    const up = () => { removeEventListener("pointermove", move); removeEventListener("pointerup", up); };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  };
  const [closeAsk, setCloseAsk] = useState<string | null>(null);
  const closeTab = useCallback((id: string) => {
    const t = tabs.find((x) => x.id === id);
    if (t?.dirty && closeAsk !== id) { setCloseAsk(id); setToast(`${t.title} has uncommitted changes. Close it again to discard them.`); return; }
    setCloseAsk(null);
    const mine = own();
    const i = mine.findIndex((x) => x.id === id);
    const rest = mine.filter((x) => x.id !== id);
    setTabs(tabsRef.current.filter((x) => x.id !== id));
    setActiveTab((a) => (a === id ? rest[Math.min(i, rest.length - 1)]?.id ?? null : a));
  }, [tabs, closeAsk]);
  const updateTab = useCallback((id: string, patch: Partial<QTab>) => setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t))), []);
  // saved queries: Ctrl+S updates the tab's saved query, or asks for a name the first time
  const [savePrompt, setSavePrompt] = useState<{ tabId: string; sql: string; name: string } | null>(null);
  const saveTab = (t: QTab, sql: string) => {
    if (!store) return;
    const existing = t.savedId ? store.saved.find((q) => q.id === t.savedId) : undefined;
    if (!existing) { setSavePrompt({ tabId: t.id, sql, name: /^Query \d+$/.test(t.title) ? "" : t.title }); return; }
    persist({ ...store, saved: store.saved.map((q) => (q.id === existing.id ? { ...q, sql, updated: Date.now() } : q)) })
      .then(() => setToast(`Saved ${existing.name}`), (e) => setToast(errText(e)));
  };
  const confirmSave = async () => {
    if (!store || !savePrompt || !savePrompt.name.trim()) return;
    const q: SavedQuery = { id: crypto.randomUUID(), name: savePrompt.name.trim(), sql: savePrompt.sql, connId: active?.id ?? "", updated: Date.now() };
    try {
      await persist({ ...store, saved: [...store.saved, q] });
      updateTab(savePrompt.tabId, { savedId: q.id, title: q.name });
      setSavePrompt(null);
      setToast(`Saved ${q.name}`);
    } catch (e) { setToast(errText(e)); }
  };
  const openSaved = (q: SavedQuery) => {
    const open = own().find((t) => t.savedId === q.id);
    if (open) setActiveTab(open.id); else newTab(q.sql, q.name, false, q.id);
  };
  const renameSaved = (q: SavedQuery, name: string) => {
    if (!store) return;
    persist({ ...store, saved: store.saved.map((x) => (x.id === q.id ? { ...x, name, updated: Date.now() } : x)) }).catch((e) => setToast(errText(e)));
    setTabs((ts) => ts.map((t) => (t.savedId === q.id ? { ...t, title: name } : t)));
  };
  const deleteSaved = (q: SavedQuery) => {
    if (!store) return;
    persist({ ...store, saved: store.saved.filter((x) => x.id !== q.id) }).then(() => setToast(`Deleted ${q.name}`), (e) => setToast(errText(e)));
    setTabs((ts) => ts.map((t) => (t.savedId === q.id ? { ...t, savedId: undefined } : t)));
  };

  const reloadSchema = useCallback(() => { if (conn?.state === "connected") loadSchema(conn.id); }, [conn, loadSchema]);
  const jobs = useJobs(setToast, reloadSchema);

  // notebooks live in the store next to saved queries; open ones get a tab
  const [savedView, setSavedView] = useState<"queries" | "notebooks">("queries");
  const openNotebook = (nb: Notebook) => {
    const open = own().find((t) => t.kind === "notebook" && t.notebookId === nb.id);
    if (open) { setActiveTab(open.id); return; }
    const t: QTab = { connId: connIdRef.current ?? undefined, id: crypto.randomUUID(), title: nb.name, kind: "notebook", notebookId: nb.id, sql: "", limit: 0 };
    setTabs((ts) => [...ts, t]);
    setActiveTab(t.id);
  };
  const addNotebook = (nb: Notebook) => {
    if (!store) return;
    persist({ ...store, notebooks: [...store.notebooks, nb] }).then(() => openNotebook(nb), (e) => setToast(errText(e)));
  };
  const createNotebook = () => addNotebook(newNotebook(`Notebook ${(store?.notebooks.length ?? 0) + 1}`));
  const importNotebook = async () => {
    const path = await openDialog({ title: "Open notebook", multiple: false, filters: [{ name: "Tilki DB notebook", extensions: ["tilkinb", "json"] }] });
    if (typeof path !== "string") return;
    try {
      addNotebook(fromFile(await api.readText(path), path.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, "")));
    } catch (e) { setToast(errText(e)); }
  };
  const updateNotebook = (nb: Notebook) => {
    if (!store) return;
    persist({ ...store, notebooks: store.notebooks.map((x) => (x.id === nb.id ? nb : x)) }).catch((e) => setToast(errText(e)));
    setTabs((ts) => ts.map((t) => (t.notebookId === nb.id && t.title !== nb.name ? { ...t, title: nb.name } : t)));
  };
  const deleteNotebook = (nb: Notebook) => {
    if (!store) return;
    persist({ ...store, notebooks: store.notebooks.filter((x) => x.id !== nb.id) }).then(() => setToast(`Deleted ${nb.name}`), (e) => setToast(errText(e)));
    const next = tabsRef.current.filter((t) => t.notebookId !== nb.id);
    setTabs(next);
    setActiveTab((a) => (next.some((t) => t.id === a) ? a : next[next.length - 1]?.id ?? null));
  };

  const recordRun = useCallback((e: HistoryEntry) => {
    const { historyKeep, historySkipProd } = getSettings();
    if (historySkipProd && storeRef.current?.connections.find((c) => c.id === e.connId)?.prod) return;
    setHistory((h) => [e, ...h].slice(0, historyKeep));
    api.addHistory(e).catch((err) => setToast(errText(err)));
  }, []);

  // auto-reconnect: reopen the pool (and SSH tunnel) after a drop. Sessions don't survive it, so
  // query tabs drop their "transaction open" state when they hear about it.
  // null: the error wasn't a dropped connection (e.g. every pooled connection busy), nothing done
  const reopen = useCallback(async (error: string): Promise<boolean | null> => {
    if (!conn || conn.state !== "connected") return false;
    const id = conn.id;
    if (!(await shouldReopen(error, () => api.tunnelAlive(id).catch(() => true)))) return null;
    try {
      const version = await api.connect(conn.id);
      setConn({ id: conn.id, state: "connected", version });
      dispatchEvent(new Event("tilki:reconnected"));
      return true;
    } catch {
      return false; // the old pool stays: it heals by itself if the server comes back
    }
  }, [conn]);
  // while on, a quiet ping every few minutes finds a dropped connection before you do
  useEffect(() => {
    if (!reconnect || conn?.state !== "connected") return;
    const id = conn.id;
    const t = setInterval(() => {
      api.runQuery(id, crypto.randomUUID(), "SELECT 1", 1, () => {}).catch((e) => {
        reopen(errText(e)).then((ok) => { if (ok != null) setToast(ok ? "The connection had dropped and was reopened." : "The connection dropped and could not be reopened."); });
      });
    }, 4 * 60_000);
    return () => clearInterval(t);
  }, [reconnect, conn?.id, conn?.state, reopen]);

  const disconnect = useCallback(() => {
    if (!conn) return;
    api.disconnect(conn.id);
    setConn(null);
    setSchema({ loading: false, tables: [] });
  }, [conn]);

  const saveConnection = async (cfg: ConnConfig, password: string | null, sshSecret: string | null, connectNow: boolean) => {
    if (!store) return;
    const c = { ...cfg, id: cfg.id || crypto.randomUUID() };
    if (password !== null) await api.setPassword(c.id, password === "" ? null : password);
    if (sshSecret !== null) await api.setPassword(c.id, sshSecret === "" ? null : sshSecret, true);
    const exists = store.connections.some((x) => x.id === c.id);
    await persist({ ...store, connections: exists ? store.connections.map((x) => (x.id === c.id ? c : x)) : [...store.connections, c] });
    setDialog(null);
    if (connectNow || conn?.id === c.id) connectTo(c.id); // reconnect so edits take effect
    else setToast(`Saved ${c.name}`);
  };

  const deleteConnection = async (c: ConnConfig) => {
    if (!store) return;
    if (conn?.id === c.id) disconnect();
    await api.setPassword(c.id, null);
    await api.setPassword(c.id, null, true);
    await persist({ ...store, connections: store.connections.filter((x) => x.id !== c.id) });
    setTabs((ts) => ts.filter((t) => t.connId !== c.id)); // its tabs would never show again
    delete lastActive.current[c.id];
    setDialog(null);
    setToast(`Deleted ${c.name}`);
  };

  const tagOps: TagOps | null = store && {
    tags: store.tags,
    uses: (t) => store.connections.filter((c) => c.tag === t).length,
    add: (t) => persist({ ...store, tags: [...store.tags, t] }),
    rename: (from, to) => persist({
      ...store,
      tags: store.tags.map((t) => (t === from ? to : t)),
      connections: store.connections.map((c) => (c.tag === from ? { ...c, tag: to } : c)),
    }),
    remove: (t) => persist({ ...store, tags: store.tags.filter((x) => x !== t), connections: store.connections.map((c) => (c.tag === t ? { ...c, tag: "" } : c)) }),
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement | null)?.closest?.("input, textarea, select, .cm-editor, [contenteditable]");
      const act = (fn: () => void) => { e.preventDefault(); fn(); };
      if (matches(e, keys.palette)) act(() => openPalette());
      else if (matches(e, keys.sidebar)) act(() => setSideOpen((o) => !o));
      else if (matches(e, keys.newTab)) act(() => newTab());
      else if (matches(e, keys.inspector)) act(() => setInspector((v) => !v));
      else if (matches(e, keys.closeTab) && activeTab) act(() => closeTab(activeTab));
      else if (matches(e, keys.zoomIn)) act(() => bumpZoom(0.1));
      else if (matches(e, keys.zoomOut)) act(() => bumpZoom(-0.1));
      else if (matches(e, keys.zoomReset)) act(() => bumpZoom(0));
      else if (matches(e, keys.settings)) act(() => openSettings());
      else if (matches(e, keys.shortcuts) || (e.key === "?" && !typing && !e.ctrlKey && !e.metaKey)) act(() => setShortcuts(true));
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [openPalette, newTab, closeTab, activeTab, bumpZoom, keys, openSettings]);

  const commands = useMemo<Command[]>(() => [
    { id: "new-conn", group: "Connect", title: "New connection…", run: () => setDialog({ cfg: null }) },
    { id: "import-conns", group: "Connect", title: "Import connections from DBeaver, Beekeeper or pgpass…", run: () => setImporting(true) },
    ...(store?.connections ?? []).map((c) => ({ id: `conn-${c.id}`, group: "Connect", title: `${c.name}${c.tag ? ` · ${c.tag}` : ""}`, active: conn?.id === c.id, run: () => connectTo(c.id) })),
    ...(active ? [
      { id: "edit-conn", group: "Connect", title: `Edit ${active.name}`, run: () => setDialog({ cfg: active }) },
      { id: "disconnect", group: "Connect", title: `Disconnect from ${active.name}`, run: disconnect },
      { id: "refresh", group: "Schema", title: "Refresh schema", run: () => loadSchema(active.id) },
      { id: "erd", group: "Schema", title: "Open ER diagram", run: openErd },
      { id: "diff", group: "Schema", title: "Compare schema with another connection", run: openDiff },
      { id: "new-table", group: "Schema", title: "New table…", run: () => setNewTable(true) },
      { id: "activity", group: "Schema", title: "Server activity: sessions, locks, table sizes", run: openActivity },
      { id: "datadiff", group: "Schema", title: "Compare a table's rows with another connection", run: () => openSingle("datadiff") },
      { id: "copy", group: "Schema", title: "Copy tables to another connection", run: () => openSingle("copy") },
      ...(active.engine !== "sqlite" ? [{ id: "users", group: "Schema", title: "Users and roles", run: () => openSingle("users") }] : []),
    ] : []),
    { id: "new-tab", group: "Query", title: "New query tab", shortcut: pretty(keys.newTab), run: () => newTab() },
    { id: "settings", group: "View", title: "Settings…", shortcut: pretty(keys.settings), run: openSettings },
    { id: "about", group: "View", title: "About Tilki DB", run: openSettings },
    { id: "shortcuts", group: "View", title: "Keyboard shortcuts…", shortcut: pretty(keys.shortcuts), run: () => setShortcuts(true) },
    { id: "reconnect", group: "Connect", title: reconnect ? "Auto-reconnect: on (turn off)" : "Auto-reconnect: off (reopen dropped connections by themselves)", active: reconnect, run: () => setReconnect((v) => !v) },
    { id: "new-nb", group: "Notebook", title: "New notebook", run: createNotebook },
    { id: "open-nb", group: "Notebook", title: "Open notebook file…", run: importNotebook },
    ...(store?.notebooks ?? []).map((nb) => ({ id: `nb-${nb.id}`, group: "Notebook", title: nb.name, run: () => openNotebook(nb) })),
    ...(activeTab ? [{ id: "close-tab", group: "Query", title: "Close this tab", shortcut: "Ctrl W", run: () => closeTab(activeTab) }] : []),
    { id: "side", group: "View", title: "Toggle sidebar", shortcut: "Ctrl B", run: () => setSideOpen((o) => !o) },
    { id: "inspector", group: "View", title: "Toggle cell inspector", shortcut: "Ctrl I", active: inspector, run: () => setInspector((v) => !v) },
    ...SIDE.map((s) => ({ id: `side-${s.id}`, group: "View", title: `Show ${s.label.toLowerCase()}`, run: () => { setSide(s.id); setSideOpen(true); } })),
    { id: "ai", group: "AI", title: aiReady ? "AI settings (on)…" : "Set up the AI assistant…", run: () => setAiSettings(true) },
    { id: "zoom-in", group: "View", title: "Zoom in", shortcut: "Ctrl +", run: () => bumpZoom(0.1) },
    { id: "zoom-out", group: "View", title: "Zoom out", shortcut: "Ctrl -", run: () => bumpZoom(-0.1) },
    { id: "zoom-reset", group: "View", title: `Reset zoom (now ${Math.round(zoom * 100)}%)`, shortcut: "Ctrl 0", run: () => bumpZoom(0) },
    ...DENSITIES.map(([d, label, desc]) => ({ id: `density-${d}`, group: "View", title: `${label} layout: ${desc}`, active: density === d, run: () => setDensity(d) })),
    { id: "mode", group: "View", title: "Switch light / dark mode", run: toggleMode },
    { id: "mode-sys", group: "View", title: "Follow system light / dark", active: theme.mode === "system", run: () => setTheme((t) => ({ ...t, mode: "system" })) },
    ...Object.entries(THEMES).map(([id, p]) => ({
      id: `theme-${id}`, group: p.fox ? "Fox theme" : "Theme", title: `${p.name}: ${p.desc}`, active: theme.pal === id, run: () => setTheme((t) => ({ ...t, pal: id })),
    })),
  ], [store, conn, active, theme, activeTab, inspector, connectTo, disconnect, loadSchema, toggleMode, newTab, closeTab, openErd, openDiff, openActivity, openSingle, aiReady, zoom, density, bumpZoom, keys, reconnect]);

  const view = SIDE.find((s) => s.id === side)!;
  const pal = THEMES[theme.pal];
  const pickerStatus = !active ? (store?.connections.length ? "Pick a saved connection" : "Add your first connection")
    : conn?.state === "connecting" ? "Connecting…"
    : conn?.state === "error" ? "Could not connect"
    : `${conn?.version ?? ENGINES[active.engine].label} · ${where(active)}`;

  const explorer = () => {
    if (storeError) return <p className="empty-side err">{storeError}</p>;
    if (!active) {
      return (
        <div className="empty-side">
          {store?.connections.length ? (
            <div className="connlist" role="list" aria-label="Saved connections">
              {store.connections.map((c) => (
                <button key={c.id} role="listitem" className="mi" style={{ "--envc": c.color } as CSSProperties} onClick={() => connectTo(c.id)} title={`Connect to ${c.name}`}>
                  <span className="dot" />
                  <span className="tx"><span className="nm">{c.name}{c.prod && <span className="prodtag">PROD</span>}</span><span className="sub">{ENGINES[c.engine].label} · {where(c)}</span></span>
                </button>
              ))}
            </div>
          ) : <p>No connections yet.</p>}
          <button className="btn pri" onClick={() => setDialog({ cfg: null })}><Icon name="plus" /> New connection</button>
          {!desktop && <p className="note">Browser preview: you can try the dialog, but connecting needs the desktop app (npm run tauri dev).</p>}
        </div>
      );
    }
    if (conn?.state === "connecting") return <p className="empty-side">Connecting to <b>{active.name}</b>…</p>;
    const hk = conn?.state === "error" ? unknownHostKey(conn.error ?? "") : null;
    if (hk) {
      return (
        <div className="empty-side">
          <div className="hostkey" role="alert">
            <b>First connection to {hk.host}</b>
            <p>This SSH server isn't in your known_hosts yet. Check that its fingerprint matches what your server admin gave you:</p>
            <code>{hk.fingerprint}</code>
            <div className="frow"><button className="btn pri" onClick={() => connectTo(active.id, true)}>Trust and connect</button><button className="btn" onClick={disconnect}>Cancel</button></div>
          </div>
        </div>
      );
    }
    if (conn?.state === "error") {
      return (
        <div className="empty-side">
          <p className="err">{conn.error}</p>
          <div className="frow"><button className="btn" onClick={() => connectTo(active.id)}>Try again</button><button className="btn" onClick={() => setDialog({ cfg: active })}>Edit connection</button></div>
        </div>
      );
    }
    if (schema.loading) return <p className="empty-side">Reading the schema…</p>;
    if (schema.error) return <div className="empty-side"><p className="err">{schema.error}</p><button className="btn" onClick={() => loadSchema(active.id)}>Try again</button></div>;
    return <SchemaTree tables={schema.tables} onOpen={openTableTab} />;
  };

  return (
    <div className={`win${active?.prod ? " prod" : ""}`} style={{ "--envc": active?.color ?? "var(--faint)" } as CSSProperties}>
      <TitleBar
        onSearch={() => openPalette()}
        picker={<ConnectionPicker store={store} active={active} status={pickerStatus} onPick={connectTo} onNew={() => setDialog({ cfg: null })} onEdit={(c) => setDialog({ cfg: c })} onImport={() => setImporting(true)} onDisconnect={conn ? disconnect : undefined} />}
      />
      <div className="band" />
      <div className="main">
        <nav className="rail" aria-label="Sections">
          {SIDE.map((s) => (
            <button key={s.id} className={`rbtn${sideOpen && side === s.id ? " on" : ""}`} title={s.label} aria-label={s.label}
              onClick={() => { if (side === s.id) setSideOpen((o) => !o); else { setSide(s.id); setSideOpen(true); } }}>
              <Icon name={s.icon} />
              {s.id === "tools" && jobs.jobs.some((j) => j.state === "running") && <span className="rdot" aria-label="Jobs running" />}
            </button>
          ))}
          <div className="sp" />
          <button className={`rbtn${tabs.find((t) => t.id === activeTab)?.kind === "settings" ? " on" : ""}`} title={`Settings (${pretty(keys.settings)})`} aria-label="Settings" onClick={openSettings}>
            <Icon name="gear" />
          </button>
          {(() => {
            const next = { system: "light", light: "dark", dark: "system" } as const;
            const icon = { system: "monitor", light: "sun", dark: "theme" } as const;
            const name = { system: "System", light: "Light", dark: "Dark" } as const;
            return (
              <button className="rbtn" title={`${name[theme.mode]} mode · click for ${name[next[theme.mode]]}`} aria-label={`${name[theme.mode]} mode, switch to ${name[next[theme.mode]]}`}
                onClick={() => setTheme((t) => ({ ...t, mode: next[t.mode] }))}>
                <Icon name={icon[theme.mode]} />
              </button>
            );
          })()}
        </nav>
        <aside className="side" hidden={!sideOpen}>
          <div className="shead">
            <span>{side === "explorer" && active ? `${active.name}${active.engine !== "sqlite" && active.database ? ` · ${active.database}` : ""}` : view.label}</span>
            {side === "explorer" && conn?.state === "connected" && (
              <span className="frow" style={{ gap: 0 }}>
                {!active?.readOnly && <button className="ibtn" title="New table" aria-label="New table" onClick={() => setNewTable(true)}><Icon name="plus" /></button>}
                <button className="ibtn" title="ER diagram" aria-label="Open ER diagram" onClick={openErd}><Icon name="diagram" /></button>
                <button className="ibtn" title="Refresh schema" aria-label="Refresh schema" onClick={() => loadSchema(conn.id)}><Icon name="refresh" /></button>
                <button className="ibtn" title="Disconnect" aria-label="Disconnect" onClick={disconnect}><Icon name="power" /></button>
              </span>
            )}
          </div>
          {side === "explorer" ? explorer()
            : side === "history" ? <HistoryList entries={history} connId={active?.id ?? null} onOpen={(e, run) => {
                // switch to the entry's connection first (if it still exists), so the tab belongs there
                if (conn?.id !== e.connId && store?.connections.some((c) => c.id === e.connId)) connectTo(e.connId);
                newTab(e.sql, undefined, run);
              }} />
            : side === "saved" ? (
              <>
                <div className="pad-side">
                  <div className="seg">
                    <button className={savedView === "queries" ? "on" : ""} aria-pressed={savedView === "queries"} onClick={() => setSavedView("queries")}>Queries</button>
                    <button className={savedView === "notebooks" ? "on" : ""} aria-pressed={savedView === "notebooks"} onClick={() => setSavedView("notebooks")}>Notebooks</button>
                  </div>
                </div>
                {savedView === "queries"
                  ? <SavedList saved={store?.saved ?? []} connId={active?.id ?? null} onOpen={openSaved} onRename={renameSaved} onDelete={deleteSaved} />
                  : <NotebookList notebooks={store?.notebooks ?? []} onOpen={openNotebook} onNew={createNotebook} onImport={importNotebook}
                      onRename={(nb, name) => updateNotebook({ ...nb, name, updated: Date.now() })} onDelete={deleteNotebook} />}
              </>
            )
            : <ToolsPanel jobs={jobs} tables={schema.tables} onDiff={openDiff} onActivity={openActivity} onOpen={openSingle}
                conn={active ? { id: active.id, name: active.name, engine: active.engine, connected: conn?.state === "connected", prod: active.prod, readOnly: active.readOnly } : null} />}
        </aside>
        <section className="work">
          <div className="tabs" role="tablist">
            {visible.length === 0 && <button className="tab on" role="tab" aria-selected="true">Welcome</button>}
            {visible.map((t) => (
              <div key={t.id} className={`tab${t.id === activeTab ? " on" : ""}${t.id === split ? " splitr" : ""}`} role="tab" aria-selected={t.id === activeTab} tabIndex={0}
                onClick={(e) => { if ((e.ctrlKey || e.metaKey) && t.id !== activeTab) setSplitTab(t.id); else setActiveTab(t.id); }} onKeyDown={(e) => { if (e.key === "Enter") setActiveTab(t.id); }}
                onAuxClick={(e) => { if (e.button === 1) closeTab(t.id); }} title={t.sql.slice(0, 200)}>
                {t.kind === "settings" ? <Icon name="gear" /> : t.kind === "table" || t.kind === "copy" ? <Icon name="table" /> : t.kind === "erd" ? <Icon name="diagram" /> : t.kind === "diff" || t.kind === "datadiff" ? <Icon name="diff" /> : t.kind === "users" ? <Icon name="database" /> : t.kind === "activity" ? <Icon name="activity" /> : t.kind === "notebook" ? <Icon name="notebook" /> : <span className="ty">SQL</span>}{t.title}{t.dirty && <span className="dirty" title="Uncommitted changes">●</span>}
                <button className="x" aria-label={`Close ${t.title}`} title="Close (Ctrl+W)" onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}>×</button>
              </div>
            ))}
            <button className="newtab" onClick={() => newTab()} title="New query tab (Ctrl+T)" aria-label="New query tab"><Icon name="plus" /></button>
            <span className="sp" />
            {visible.length > 0 && <button className={`newtab${split ? " on" : ""}`} onClick={toggleSplit} aria-pressed={!!split} aria-label="Split view"
              title={split ? "Close the split view" : "Split view: show another tab on the right (Ctrl+click a tab to choose it)"}><Icon name="sidebar" /></button>}
          </div>
          <div className={`panes${split ? " split" : ""}`} style={split ? ({ "--split": `${splitPct}%` } as CSSProperties) : undefined}>
          {split && <div className="psplit" onPointerDown={dragSplit} title="Drag to resize" />}
          {visible.map((t) => (
            <div key={t.id} className={`tabpane${t.id === split ? " right" : ""}`} hidden={t.id !== activeTab && t.id !== split}>
              {t.kind === "settings" ? (
                <SettingsView settings={settings} onSettings={setSettings} theme={theme} onTheme={setTheme} density={density} onDensity={setDensity}
                  zoom={zoom} onZoom={setZoom} reconnect={reconnect} onReconnect={setReconnect} aiReady={aiReady} onAiSetup={() => setAiSettings(true)}
                  onShortcuts={() => setShortcuts(true)} onClearHistory={clearHistory} onToast={setToast} onCheckUpdate={() => checkUpdate(true)} />
              ) : t.kind === "datadiff" ? (
                <DataCompare connections={store?.connections ?? []} active={active} connected={conn?.state === "connected"} tables={schema.tables} onToast={setToast} />
              ) : t.kind === "copy" ? (
                <CopyTable connections={store?.connections ?? []} active={active} connected={conn?.state === "connected"} tables={schema.tables} onToast={setToast} />
              ) : t.kind === "users" ? (
                <UsersView tables={schema.tables} onToast={setToast} conn={active ? { id: active.id, name: active.name, engine: active.engine, connected: conn?.state === "connected", prod: active.prod, readOnly: active.readOnly } : null} />
              ) : t.kind === "activity" ? (
                <ActivityView onToast={setToast} conn={active ? { id: active.id, name: active.name, engine: active.engine, connected: conn?.state === "connected", prod: active.prod, readOnly: active.readOnly } : null} />
              ) : t.kind === "notebook" ? (
                (() => {
                  const nb = store?.notebooks.find((x) => x.id === t.notebookId);
                  return nb ? <NotebookView nb={nb} tables={schema.tables} onChange={updateNotebook} onRan={recordRun} onToast={setToast}
                    conn={active ? { id: active.id, name: active.name, engine: active.engine, connected: conn?.state === "connected", prod: active.prod, readOnly: active.readOnly } : null} />
                    : <div className="rempty">This notebook was deleted.</div>;
                })()
              ) : t.kind === "diff" ? (
                <DiffView connections={store?.connections ?? []} active={active} connected={conn?.state === "connected"} tables={schema.tables} onToast={setToast} />
              ) : t.kind === "erd" ? (
                <ErdView tables={schema.tables} onOpen={openTableTab} onToast={setToast} />
              ) : t.kind === "table" && t.table ? (
                <TableTab table={schema.tables.find((x) => x.schema === t.table!.schema && x.name === t.table!.name) ?? null}
                  conn={active ? { id: active.id, name: active.name, engine: active.engine, connected: conn?.state === "connected", prod: active.prod, readOnly: active.readOnly } : null}
                  readOnly={!!active && active.readOnly} inspector={inspector} onDirty={(d) => updateTab(t.id, { dirty: d })} onToast={setToast}
                  onSchemaChanged={() => { if (active) loadSchema(active.id); }} jump={t.table.jump} tables={schema.tables}
                  onOpenRefs={(child, col, val) => openTableTab(child, { col, val, n: Date.now() })}
                  onJump={(fkTable, val) => {
                    const target = schema.tables.find((x) => x.name === fkTable && x.schema === t.table!.schema) ?? schema.tables.find((x) => x.name === fkTable);
                    const pk = target?.columns.filter((c) => c.pk) ?? [];
                    if (!target || pk.length !== 1) { setToast(`Can't open the ${fkTable} row: it needs a single-column primary key.`); return; }
                    openTableTab(target, { col: pk[0].name, val, n: Date.now() });
                  }} />
              ) : (
                <QueryTab tab={t} tables={schema.tables} inspector={inspector} ai={aiProps} onChange={(p) => updateTab(t.id, p)} onRan={recordRun} onToast={setToast} onSave={(sql) => saveTab(t, sql)}
                  onOpenTable={openTableTab} keys={keys} onReconnect={reconnect ? reopen : undefined}
                  conn={active ? { id: active.id, name: active.name, engine: active.engine, connected: conn?.state === "connected", prod: active.prod, readOnly: active.readOnly } : null} />
              )}
            </div>
          ))}
          </div>
          {visible.length === 0 && <div className="welcome">
            <div className="welcome-in">
              <h1><Logo /> Tilki <span>DB</span></h1>
              <p>A fast, keyboard-first SQL client. Add a connection from the title bar, then double-click a table in the sidebar or open a query tab.</p>
              <h2>Try it</h2>
              <div className="keys">
                <kbd>Ctrl K</kbd><span>Command menu: connect, switch, every action</span>
                <kbd>Ctrl T</kbd><span>New query tab; Ctrl+Enter runs the statement under the cursor</span>
                <kbd>Ctrl B</kbd><span>Show or hide the sidebar</span>
                <kbd>Ctrl ⇧ F</kbd><span>Format the SQL; type <code>sel</code>, <code>join</code>, <code>cte</code>… for snippets; <code>:name</code> asks for a value</span>
                <kbd>Ctrl click</kbd><span>On a tab: show it next to the current one; on a table name in the editor: open the table</span>
                <kbd>{pretty(keys.shortcuts)}</kbd><span>Every keyboard shortcut, and changing them</span>
                <kbd>Right click</kbd><span>On results: copy as CSV / JSON / INSERT, column stats, hide or pin columns</span>
                <kbd><Icon name="theme" /></kbd><span>Appearance, bottom left: {Object.keys(THEMES).length} color themes, light / dark, and Compact / Spacious layouts</span>
              </div>
            </div>
          </div>}
        </section>
      </div>
      <footer className="status">
        <span style={{ "--envc": active?.color ?? "var(--faint)" } as CSSProperties}>
          <span className="dot" />
          {active ? <><b>{active.name}</b>{conn?.state === "connected" ? ` · ${conn.version}` : conn?.state === "connecting" ? " · connecting…" : " · not connected"}</> : "Not connected"}
        </span>
        {active && (active.prod || active.readOnly) && <span className="ro">{[active.prod && "PRODUCTION", active.readOnly ? "READ-ONLY" : "GUARDED"].filter(Boolean).join(" · ")}</span>}
        <span className="sp" />
        {zoom !== 1 && <button className="linkbtn" onClick={() => bumpZoom(0)} title="Reset zoom (Ctrl+0)">{Math.round(zoom * 100)}%</button>}
        <span>{pal.name} · {theme.mode === "system" ? `System (${isDark(theme) ? "dark" : "light"})` : theme.mode === "dark" ? "Dark" : "Light"}</span>
        {update && <button className="linkbtn" onClick={installUpdate} disabled={updating} title={`Download Tilki DB ${update.version}, install it and restart`}>{updating ? "Updating…" : `Update to ${update.version}`}</button>}
        <span>v0.4.1</span>
      </footer>
      {dialog && tagOps && <ConnectionDialog initial={dialog.cfg} tagOps={tagOps} folders={[...new Set((store?.connections ?? []).map((c) => c.folder).filter(Boolean))]} onClose={() => setDialog(null)} onSave={saveConnection} onDelete={deleteConnection} />}
      {palette !== null && <CommandPalette commands={commands} initialQuery={palette} onClose={() => setPalette(null)} />}
      {savePrompt && (
        <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && setSavePrompt(null)}>
          <div className="modal small" role="dialog" aria-modal="true" aria-labelledby="sv-title" onKeyDown={(e) => { if (e.key === "Escape") setSavePrompt(null); }}>
            <h3 id="sv-title">Save query</h3>
            <div className="f"><label htmlFor="sv-name">Name</label>
              <input id="sv-name" autoFocus value={savePrompt.name} placeholder="e.g. Revenue by day" onChange={(e) => setSavePrompt({ ...savePrompt, name: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") confirmSave(); }} />
            </div>
            <pre className="sqlprev">{savePrompt.sql.length > 600 ? `${savePrompt.sql.slice(0, 600)}…` : savePrompt.sql}</pre>
            <div className="acts"><button className="btn" onClick={() => setSavePrompt(null)}>Cancel</button><button className="btn pri" onClick={confirmSave} disabled={!savePrompt.name.trim()}>Save</button></div>
          </div>
        </div>
      )}
      {aiSettings && <AiSettings ready={aiReady} onClose={() => setAiSettings(false)} onChanged={setAiReady} onToast={setToast} />}
      {newTable && active && conn?.state === "connected" && (
        <NewTableDialog conn={{ id: active.id, name: active.name, engine: active.engine, connected: true, prod: active.prod, readOnly: active.readOnly }}
          schemas={[...new Set(schema.tables.map((t) => t.schema))]} onClose={() => setNewTable(false)}
          onCreated={(sch, name) => { loadSchema(active.id).then(() => openTableTab({ schema: sch === "" ? "main" : sch, name } as Table)); setToast(`Created ${name}`); }} />
      )}
      {importing && <ImportConnections existing={store?.connections ?? []} onClose={() => setImporting(false)} onImport={importConns} />}
      {shortcuts && <ShortcutsDialog keys={keys} onChange={setKeys} onClose={() => setShortcuts(false)} />}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
