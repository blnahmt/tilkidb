// Typed bridge to the Rust commands in src-tauri/src/lib.rs.
import { Channel, invoke, isTauri } from "@tauri-apps/api/core";

export type Engine = "postgres" | "mysql" | "sqlite";
export type SslMode = "disable" | "prefer" | "require" | "verify-full";
export type SshAuth = "key" | "password" | "agent";

export interface SshConfig {
  enabled: boolean;
  host: string;
  port: number;
  user: string;
  auth: SshAuth;
  keyFile: string;
}

export interface ConnConfig {
  id: string;
  name: string;
  engine: Engine;
  host: string;
  port: number;
  database: string;
  user: string;
  file: string;
  ssl: SslMode;
  tag: string;
  color: string;
  prod: boolean;
  readOnly: boolean;
  ssh: SshConfig;
  sslCa: string; // CA certificate file
  sslCert: string; // client certificate file
  sslKey: string; // client key file
  folder: string; // picker group ("" = by tag)
}
export interface SavedQuery {
  id: string;
  name: string;
  sql: string;
  connId: string; // "" = any connection
  updated: number; // unix ms
}
export interface NotebookCell {
  id: string;
  kind: "sql" | "md";
  src: string;
}
export interface Notebook {
  id: string;
  name: string;
  cells: NotebookCell[];
  updated: number; // unix ms
}
export interface Store {
  connections: ConnConfig[];
  tags: string[];
  saved: SavedQuery[];
  notebooks: Notebook[];
}
export interface Column {
  name: string;
  dataType: string;
  nullable: boolean;
  pk: boolean;
  fk: string | null;
}
export interface Table {
  schema: string;
  name: string;
  kind: "table" | "view";
  rows: number | null;
  columns: Column[];
}

export interface ColInfo {
  name: string;
  dataType: string;
}
export type Cell = null | boolean | number | string | Record<string, unknown> | unknown[];
export type QueryEvent =
  | { event: "columns"; columns: ColInfo[] }
  | { event: "rows"; rows: Cell[][] }
  | { event: "statementDone"; index: number; affected: number };
export interface Summary {
  rows: number;
  ms: number;
  truncated: boolean;
  cancelled: boolean;
  inTransaction?: boolean | null; // query tab sessions: a manual transaction is open (null = engine can't tell)
}
export interface HistoryEntry {
  connId: string;
  connName: string;
  sql: string;
  at: number;
  rows: number | null;
  ms: number | null;
  error: string | null;
}

export type ExportFormat = "csv" | "tsv" | "json" | "jsonl" | "sql" | "markdown" | "xlsx";
export interface ExportOptions {
  format: ExportFormat;
  header: boolean;
  delimiter: string;
  nullText: string;
  table: string; // quoted INSERT target
  engine: Engine;
  pretty: boolean;
  batch: number;
}

export interface JobProgress { done: number; total: number; label: string }
export interface DumpOptions {
  tables: { schema: string; name: string }[];
  schema: boolean;
  data: boolean;
  drop: boolean;
  ifNotExists: boolean;
  singleTransaction: boolean;
  batch: number;
}
export interface DumpSummary { tables: number; rows: number; bytes: number; ms: number; cancelled: boolean }
export interface RestoreSummary { statements: number; failed: number; errors: string[]; ms: number; cancelled: boolean }
export type ImportFormat = "csv" | "tsv" | "json" | "jsonl";
export interface ImportSource { path: string; format: ImportFormat; delimiter: string | null; header: boolean }
export interface ImportPreview { columns: string[]; rows: Cell[][]; delimiter: string }
export interface ImportOptions { source: ImportSource; schema: string; table: string; mapping: (string | null)[]; emptyAsNull: boolean; truncateFirst: boolean }
export interface ImportSummary { rows: number; ms: number; cancelled: boolean }
export interface AiSummary { model: string; stopReason: string; cancelled: boolean; inputTokens: number; outputTokens: number }

const progressChannel = (on: (p: JobProgress) => void) => { const ch = new Channel<JobProgress>(); ch.onmessage = on; return ch; };

export const ENGINES: Record<Engine, { label: string; port: number }> = {
  postgres: { label: "PostgreSQL", port: 5432 },
  mysql: { label: "MySQL / MariaDB", port: 3306 },
  sqlite: { label: "SQLite", port: 0 },
};

export const COLORS = ["#3fbf7f", "#2fb8a8", "#4c9dff", "#8f7cff", "#e66fb0", "#ef4a4a", "#ff8a3d", "#e6b422", "#8e877f"];

export const newSsh = (): SshConfig => ({ enabled: false, host: "", port: 22, user: "", auth: "key", keyFile: "~/.ssh/id_ed25519" });

export const newConnection = (): ConnConfig => ({
  id: "", name: "", engine: "postgres", host: "localhost", port: 5432, database: "", user: "postgres",
  file: "", ssl: "prefer", tag: "", color: COLORS[0], prod: false, readOnly: false, ssh: newSsh(),
  sslCa: "", sslCert: "", sslKey: "", folder: "",
});

export const desktop = isTauri();
const DESKTOP_ONLY = "Connecting needs the desktop app. Start it with: npm run tauri dev";
const PREVIEW_KEY = "tilkidb.preview-store"; // browser preview only: lets the UI be tried without Rust

export const api = desktop
  ? {
      loadStore: () => invoke<Store>("load_store"),
      saveStore: (store: Store) => invoke<void>("save_store", { store }),
      /** a string saves the secret, null removes it; ssh=true for the SSH password / key passphrase */
      setPassword: (id: string, password: string | null, ssh = false) => invoke<void>("set_password", { id, password, ssh }),
      /** null = use the secret saved for cfg.id */
      testConnection: (cfg: ConnConfig, password: string | null, sshSecret: string | null, trustHost = false) =>
        invoke<string>("test_connection", { cfg, password, sshSecret, trustHost }),
      connect: (id: string, trustHost = false) => invoke<string>("connect", { id, trustHost }),
      disconnect: (id: string) => invoke<void>("disconnect", { id }),
      listSchema: (id: string) => invoke<Table[]>("list_schema", { id }),
      /** false when the connection goes through an SSH tunnel that has died */
      tunnelAlive: (id: string) => invoke<boolean>("tunnel_alive", { id }),
      /** streams events to onEvent while it runs; resolves with the summary */
      /** `session` (a query tab / notebook id) keeps one connection for it, so USE / SET / temp tables carry over */
      /** keepTx: leave a transaction the script opened open in the session (query tabs); otherwise it's rolled back */
      runQuery: async (connId: string, queryId: string, sql: string, limit: number | null, onEvent: (e: QueryEvent) => void, session: string | null = null, keepTx = false) => {
        const ch = new Channel<QueryEvent>();
        let got = 0, wake = () => {};
        ch.onmessage = (e) => { onEvent(e); if (e.event === "rows") { got += e.rows.length; wake(); } };
        const s = await invoke<Summary>("run_query", { connId, queryId, sql, limit, session, keepTx, onEvent: ch });
        // the call can return while the channel is still delivering its last (large) batches:
        // resolve only once every row it counted has reached onEvent
        const deadline = Date.now() + 15_000;
        while (got < s.rows && Date.now() < deadline) await new Promise<void>((r) => { wake = r; setTimeout(r, 50); });
        return s;
      },
      endSession: (session: string) => invoke<void>("end_session", { session }),
      importConnections: (kind: string, path: string | null) => invoke<{ cfg: ConnConfig; password: string | null }[]>("import_connections", { kind, path }),
      tableStructure: (connId: string, schema: string, name: string) => invoke<{ ddl: string; indexes: { name: string; def: string; unique: boolean }[]; triggers: { name: string; def: string; unique: boolean }[]; defaults: { name: string; def: string; unique: boolean }[] }>("table_structure", { connId, schema, name }),
      cancelQuery: (queryId: string) => invoke<void>("cancel_query", { queryId }),
      addHistory: (entry: HistoryEntry) => invoke<void>("add_history", { entry }),
      loadHistory: (limit?: number) => invoke<HistoryEntry[]>("load_history", { limit: limit ?? null }),
      clearHistory: () => invoke<void>("clear_history"),
      /** all in one transaction; UPDATE/DELETE must each touch exactly one row */
      applyChanges: (connId: string, changes: { sql: string; expectOne: boolean }[]) => invoke<number>("apply_changes", { connId, changes }),
      exportRows: (columns: ColInfo[], rows: Cell[][], path: string, opts: ExportOptions) => invoke<number>("export_rows", { columns, rows, path, opts }),
      /** streams every row of `sql` into the file; cancel with cancelQuery(queryId) */
      exportQuery: (connId: string, queryId: string, sql: string, path: string, opts: ExportOptions, session: string | null = null) => invoke<Summary>("export_query", { connId, queryId, sql, path, opts, session }),
      /** database tools; each job is cancelled with cancelQuery(jobId) */
      dumpDb: (connId: string, jobId: string, path: string, opts: DumpOptions, onProgress: (p: JobProgress) => void) =>
        invoke<DumpSummary>("dump_db", { connId, jobId, path, opts, onProgress: progressChannel(onProgress) }),
      restoreFile: (connId: string, jobId: string, path: string, singleTx: boolean, stopOnError: boolean, onProgress: (p: JobProgress) => void) =>
        invoke<RestoreSummary>("restore_file", { connId, jobId, path, singleTx, stopOnError, onProgress: progressChannel(onProgress) }),
      previewImport: (source: ImportSource) => invoke<ImportPreview>("preview_import", { source }),
      importFile: (connId: string, jobId: string, opts: ImportOptions, onProgress: (p: JobProgress) => void) =>
        invoke<ImportSummary>("import_file", { connId, jobId, opts, onProgress: progressChannel(onProgress) }),
      writeText: (path: string, text: string) => invoke<void>("write_text", { path, text }),
      readText: (path: string) => invoke<string>("read_text", { path }),
      writeBytes: (path: string, data: Uint8Array) => invoke<void>("write_bytes", { path, data: Array.from(data) }),
      /** optional AI: the key lives in the OS keychain, Rust makes the call */
      aiKeyStatus: () => invoke<boolean>("ai_key_status"),
      setAiKey: (key: string | null) => invoke<void>("set_ai_key", { key }),
      aiAsk: (jobId: string, system: string, prompt: string, onText: (t: string) => void) => {
        const ch = new Channel<string>();
        ch.onmessage = onText;
        return invoke<AiSummary>("ai_ask", { jobId, system, prompt, onText: ch });
      },
    }
  : {
      loadStore: async (): Promise<Store> => {
        try {
          const s = JSON.parse(localStorage.getItem(PREVIEW_KEY) ?? "null");
          if (s) return { saved: [], notebooks: [], ...s };
        } catch {
          // fall through to an empty store
        }
        return { connections: [], tags: ["Development", "Staging", "Production"], saved: [], notebooks: [] };
      },
      saveStore: async (store: Store) => { try { localStorage.setItem(PREVIEW_KEY, JSON.stringify(store)); } catch { /* preview only */ } },
      setPassword: async (_id: string, _password: string | null, _ssh = false) => {},
      testConnection: (_cfg: ConnConfig, _password: string | null, _sshSecret: string | null, _trustHost = false): Promise<string> => Promise.reject(DESKTOP_ONLY),
      connect: (_id: string, _trustHost = false): Promise<string> => Promise.reject(DESKTOP_ONLY),
      disconnect: async (_id: string) => {},
      listSchema: (_id: string): Promise<Table[]> => Promise.reject(DESKTOP_ONLY),
      tunnelAlive: async (_id: string) => true,
      runQuery: (_c: string, _q: string, _s: string, _l: number | null, _e: (e: QueryEvent) => void, _session: string | null = null, _keepTx = false): Promise<Summary> => Promise.reject(DESKTOP_ONLY),
      endSession: async (_session: string) => {},
      importConnections: (_k: string, _p: string | null): Promise<{ cfg: ConnConfig; password: string | null }[]> => Promise.reject(DESKTOP_ONLY),
      tableStructure: (_c: string, _s: string, _n: string): Promise<{ ddl: string; indexes: { name: string; def: string; unique: boolean }[]; triggers: { name: string; def: string; unique: boolean }[]; defaults: { name: string; def: string; unique: boolean }[] }> => Promise.reject(DESKTOP_ONLY),
      cancelQuery: async (_queryId: string) => {},
      addHistory: async (_entry: HistoryEntry) => {},
      loadHistory: async (_limit?: number): Promise<HistoryEntry[]> => [],
      clearHistory: async () => {},
      applyChanges: (_c: string, _ch: { sql: string; expectOne: boolean }[]): Promise<number> => Promise.reject(DESKTOP_ONLY),
      exportRows: (_c: ColInfo[], _r: Cell[][], _p: string, _o: ExportOptions): Promise<number> => Promise.reject(DESKTOP_ONLY),
      exportQuery: (_c: string, _q: string, _s: string, _p: string, _o: ExportOptions, _session: string | null = null): Promise<Summary> => Promise.reject(DESKTOP_ONLY),
      dumpDb: (_c: string, _j: string, _p: string, _o: DumpOptions, _on: (p: JobProgress) => void): Promise<DumpSummary> => Promise.reject(DESKTOP_ONLY),
      restoreFile: (_c: string, _j: string, _p: string, _t: boolean, _s: boolean, _on: (p: JobProgress) => void): Promise<RestoreSummary> => Promise.reject(DESKTOP_ONLY),
      previewImport: (_s: ImportSource): Promise<ImportPreview> => Promise.reject(DESKTOP_ONLY),
      importFile: (_c: string, _j: string, _o: ImportOptions, _on: (p: JobProgress) => void): Promise<ImportSummary> => Promise.reject(DESKTOP_ONLY),
      writeText: (_p: string, _t: string): Promise<void> => Promise.reject(DESKTOP_ONLY),
      readText: (_p: string): Promise<string> => Promise.reject(DESKTOP_ONLY),
      writeBytes: (_p: string, _d: Uint8Array): Promise<void> => Promise.reject(DESKTOP_ONLY),
      aiKeyStatus: async (): Promise<boolean> => false,
      setAiKey: (_k: string | null): Promise<void> => Promise.reject(DESKTOP_ONLY),
      aiAsk: (_j: string, _s: string, _p: string, _on: (t: string) => void): Promise<AiSummary> => Promise.reject(DESKTOP_ONLY),
    };

/** Rust errors arrive as plain strings; anything else gets its message. */
export const errText = (e: unknown): string => (typeof e === "string" ? e : e instanceof Error ? e.message : String(e));

/** All rows of one query (up to `limit`), with its columns: for small lookups and comparisons. */
export async function collect(connId: string, sql: string, limit: number): Promise<{ columns: ColInfo[]; rows: Cell[][]; truncated: boolean }> {
  let columns: ColInfo[] = [];
  const rows: Cell[][] = [];
  const s = await api.runQuery(connId, crypto.randomUUID(), sql, limit, (e) => {
    if (e.event === "columns") { columns = e.columns; rows.length = 0; } else if (e.event === "rows") rows.push(...e.rows);
  });
  return { columns, rows, truncated: s.truncated };
}
