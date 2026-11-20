// Rust core: saved connections, keychain passwords, SSH tunnels, live pools and queries.
mod ai;
mod changes;
mod db;
mod dump;
mod export;
mod history;
mod import;
mod importer;
mod query;
mod restore;
mod secrets;
mod sqlsplit;
mod store;
mod structure;
mod tunnel;

use db::{Db, Live, Table};
use query::{Kill, QueryEvent, Summary};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex},
};
use store::{ConnConfig, Store};
use tauri::{ipc::Channel, Manager, State};

/// A query in flight: its cancel flag and, once known, how to stop it on the server.
struct Running {
    cancel: Arc<AtomicBool>,
    kill: Option<Kill>,
}

struct AppState {
    store_path: PathBuf,
    history_path: PathBuf,
    live: Mutex<HashMap<String, Live>>,       // open connections by id
    running: Mutex<HashMap<String, Running>>, // queries by query id
    sessions: Mutex<HashMap<String, (String, db::Conn)>>, // a query tab's own connection: tab id -> (connection id, conn)
}

impl AppState {
    /// A query tab's kept connection, if it belongs to this connection.
    fn take_session(&self, session: &Option<String>, conn_id: &str) -> Option<db::Conn> {
        let (cid, c) = self.sessions.lock().unwrap().remove(session.as_ref()?)?;
        if cid == conn_id { Some(c) } else { c.close(); None }
    }
    /// Keep the connection for the tab's next run; without a session it goes back to the pool.
    fn keep_session(&self, session: Option<String>, conn_id: &str, conn: Option<db::Conn>) {
        if let (Some(s), Some(c)) = (session, conn) {
            if let Some((_, old)) = self.sessions.lock().unwrap().insert(s, (conn_id.to_string(), c)) { old.close(); }
        }
    }
    /// Sessions are closed, never returned to the pool: their USE / SET must not reach other queries.
    /// Must run before the pool itself is closed (pool shutdown waits for every connection).
    fn end_sessions_of(&self, conn_id: &str) {
        let ended: Vec<db::Conn> = { let mut m = self.sessions.lock().unwrap(); let ids: Vec<String> = m.iter().filter(|(_, (c, _))| c == conn_id).map(|(k, _)| k.clone()).collect(); ids.iter().filter_map(|k| m.remove(k)).map(|(_, c)| c).collect() };
        ended.into_iter().for_each(db::Conn::close);
    }

    fn pool(&self, id: &str) -> Result<Db, String> {
        self.live.lock().unwrap().get(id).map(|l| l.db.clone()).ok_or_else(|| "Not connected. Connect first.".into())
    }
}

/// Runs a command's work and turns a panic (a bug) into an error, so the UI gets an answer
/// instead of waiting forever, and the app keeps running.
async fn guarded<T>(work: impl std::future::Future<Output = Result<T, String>>) -> Result<T, String> {
    use futures_util::FutureExt;
    std::panic::AssertUnwindSafe(work).catch_unwind().await.unwrap_or_else(|p| Err(panic_text(&*p))).map_err(friendly)
}

/// guarded() for work that also hands back a connection to keep.
async fn guarded_pair<T>(work: impl std::future::Future<Output = (Result<T, String>, Option<db::Conn>)>) -> (Result<T, String>, Option<db::Conn>) {
    use futures_util::FutureExt;
    match std::panic::AssertUnwindSafe(work).catch_unwind().await {
        Ok((r, c)) => (r.map_err(friendly), c),
        Err(p) => (Err(panic_text(&*p)), None),
    }
}

/// sqlx's pool reports a server that went away as a bare timeout; say what it means.
fn friendly(e: String) -> String {
    if e.contains("pool timed out while waiting for an open connection") {
        "The server isn't answering: no connection could be opened within 10 seconds. It may be down, restarting or unreachable; Tilki DB reconnects by itself once it's back.".into()
    } else { e }
}

fn panic_text(p: &(dyn std::any::Any + Send)) -> String {
    let msg = p.downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| p.downcast_ref::<String>().cloned()).unwrap_or_else(|| "unknown".into());
    format!("Internal error ({msg}). The operation was stopped; nothing else is affected.")
}

/// Keychain key for a connection's SSH password or key passphrase.
fn ssh_key(id: &str) -> String {
    format!("{id}:ssh")
}

#[tauri::command]
fn load_store(state: State<AppState>) -> Result<Store, String> {
    Store::load(&state.store_path)
}

#[tauri::command]
fn save_store(state: State<AppState>, store: Store) -> Result<(), String> {
    store.save(&state.store_path)
}

/// Some(p) saves, None removes. `ssh` picks the SSH secret instead of the database password.
#[tauri::command]
fn set_password(id: String, password: Option<String>, ssh: Option<bool>) -> Result<(), String> {
    let key = if ssh.unwrap_or(false) { ssh_key(&id) } else { id };
    match password {
        Some(p) => secrets::set(&key, &p),
        None => secrets::delete(&key),
    }
}

/// Opens a throwaway connection and returns the server version. A missing password or SSH
/// secret means "use the saved one", so editing a connection doesn't require retyping it.
#[tauri::command]
async fn test_connection(cfg: ConnConfig, password: Option<String>, ssh_secret: Option<String>, trust_host: Option<bool>) -> Result<String, String> {
    let saved = |key: String| if cfg.id.is_empty() { Ok(String::new()) } else { secrets::get(&key) };
    let pw = match password { Some(p) => p, None => saved(cfg.id.clone())? };
    let ssh = match ssh_secret { Some(s) => s, None => saved(ssh_key(&cfg.id))? };
    let live = guarded(db::open(&cfg, &pw, &ssh, trust_host.unwrap_or(false))).await?;
    let version = db::server_version(&live.db).await;
    db::close(live.db).await;
    version.map(|v| if cfg.ssh.enabled && cfg.engine != store::Engine::Sqlite { format!("{v} via SSH {}", cfg.ssh.host) } else { v })
}

#[tauri::command]
async fn connect(state: State<'_, AppState>, id: String, trust_host: Option<bool>) -> Result<String, String> {
    let store = Store::load(&state.store_path)?;
    let cfg = store.connections.iter().find(|c| c.id == id).ok_or("This connection no longer exists.")?;
    let live = guarded(db::open(cfg, &secrets::get(&id)?, &secrets::get(&ssh_key(&id))?, trust_host.unwrap_or(false))).await?;
    let version = db::server_version(&live.db).await?;
    state.end_sessions_of(&id);
    let old = state.live.lock().unwrap().insert(id, live);
    if let Some(old) = old {
        db::close(old.db).await;
    }
    Ok(version)
}

#[tauri::command]
async fn disconnect(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.end_sessions_of(&id);
    let old = state.live.lock().unwrap().remove(&id);
    if let Some(old) = old {
        db::close(old.db).await;
    }
    Ok(())
}

/// For auto-reconnect: false when the connection runs through an SSH tunnel that has died.
/// (A pool timeout alone can also mean every pooled connection is busy, which a reconnect must not "fix".)
#[tauri::command]
fn tunnel_alive(state: State<AppState>, id: String) -> bool {
    state.live.lock().unwrap().get(&id).and_then(|l| l.tunnel.as_ref()).is_none_or(|t| t.alive())
}

#[tauri::command]
async fn list_schema(state: State<'_, AppState>, id: String) -> Result<Vec<Table>, String> {
    guarded(db::list_schema(&state.pool(&id)?)).await
}

/// Runs SQL and streams QueryEvents over `on_event`. `limit` caps the rows fetched (None = all).
#[tauri::command]
/// `session` (a query tab / notebook id) keeps one connection for that tab across runs.
#[allow(clippy::too_many_arguments)]
async fn run_query(state: State<'_, AppState>, conn_id: String, query_id: String, sql: String, limit: Option<u64>, session: Option<String>, keep_tx: Option<bool>, on_event: Channel<QueryEvent>) -> Result<Summary, String> {
    let db = state.pool(&conn_id)?;
    let cancel = Arc::new(AtomicBool::new(false));
    state.running.lock().unwrap().insert(query_id.clone(), Running { cancel: cancel.clone(), kill: None });
    let register = |k: Kill| {
        if let Some(r) = state.running.lock().unwrap().get_mut(&query_id) { r.kill = Some(k); }
    };
    let send = |e: QueryEvent| on_event.send(e).is_ok();
    let held = state.take_session(&session, &conn_id);
    let (result, back) = guarded_pair(query::run_on(&db, held, keep_tx.unwrap_or(false) && session.is_some(), &sql, limit.unwrap_or(u64::MAX), &cancel, &register, &send)).await;
    state.keep_session(session, &conn_id, back);
    state.running.lock().unwrap().remove(&query_id);
    result
}

#[tauri::command]
async fn cancel_query(state: State<'_, AppState>, query_id: String) -> Result<(), String> {
    let kill = {
        let running = state.running.lock().unwrap();
        let Some(r) = running.get(&query_id) else { return Ok(()) }; // already finished
        r.cancel.store(true, Ordering::Relaxed);
        r.kill.clone()
    };
    if let Some(k) = kill { query::kill(&k).await; }
    Ok(())
}

#[tauri::command]
async fn apply_changes(state: State<'_, AppState>, conn_id: String, changes: Vec<changes::Change>) -> Result<u64, String> {
    guarded(changes::apply(&state.pool(&conn_id)?, &changes)).await
}

/// Export rows already loaded in the UI.
#[tauri::command]
async fn export_rows(columns: Vec<query::ColInfo>, rows: Vec<Vec<serde_json::Value>>, path: String, opts: export::Options) -> Result<u64, String> {
    let path = PathBuf::from(path);
    let mut e = export::Exporter::create(&path, opts)?;
    e.columns(columns)?;
    for r in &rows {
        e.row(r)?;
    }
    e.finish()
}

/// Run `sql` and stream every row straight into the file. Cancel with cancel_query(query_id).
/// A failed or cancelled export removes the partial file.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn export_query(state: State<'_, AppState>, conn_id: String, query_id: String, sql: String, path: String, opts: export::Options, session: Option<String>) -> Result<Summary, String> {
    let db = state.pool(&conn_id)?;
    let path = PathBuf::from(path);
    let exporter = Mutex::new(Some(export::Exporter::create(&path, opts)?));
    let failed: Mutex<Option<String>> = Mutex::new(None);
    let seen_columns = AtomicBool::new(false);
    let cancel = Arc::new(AtomicBool::new(false));
    state.running.lock().unwrap().insert(query_id.clone(), Running { cancel: cancel.clone(), kill: None });
    let register = |k: Kill| {
        if let Some(r) = state.running.lock().unwrap().get_mut(&query_id) { r.kill = Some(k); }
    };
    let send = |e: QueryEvent| {
        let mut ex = exporter.lock().unwrap();
        let Some(x) = ex.as_mut() else { return false };
        let r = match e {
            // only the first result set is exported
            QueryEvent::Columns { columns } if !seen_columns.swap(true, Ordering::Relaxed) => x.columns(columns),
            QueryEvent::Rows { rows } if seen_columns.load(Ordering::Relaxed) => rows.iter().try_for_each(|r| x.row(r)),
            _ => Ok(()),
        };
        match r {
            Ok(()) => true,
            Err(msg) => { *failed.lock().unwrap() = Some(msg); false }
        }
    };
    let held = state.take_session(&session, &conn_id);
    let (result, back) = guarded_pair(query::run_on(&db, held, session.is_some(), &sql, u64::MAX, &cancel, &register, &send)).await;
    state.keep_session(session, &conn_id, back);
    state.running.lock().unwrap().remove(&query_id);
    let ex = exporter.lock().unwrap().take();
    let outcome = match (result, failed.into_inner().unwrap()) {
        (_, Some(msg)) => Err(msg),
        (Err(e), _) => Err(e),
        (Ok(s), _) if s.cancelled => Ok(s),
        (Ok(s), _) => ex.ok_or("Export closed early".to_string())?.finish().map(|_| s),
    };
    if !matches!(&outcome, Ok(s) if !s.cancelled) {
        let _ = std::fs::remove_file(&path);
    }
    outcome
}

/// Progress of a long job (dump, restore, import): `done` of `total` (0 = unknown), current item.
#[derive(serde::Serialize, Clone)]
struct JobProgress {
    done: u64,
    total: u64,
    label: String,
}

impl AppState {
    /// Track a job under `id` so cancel_query(id) can stop it.
    fn track(&self, id: &str) -> Arc<AtomicBool> {
        let cancel = Arc::new(AtomicBool::new(false));
        self.running.lock().unwrap().insert(id.to_string(), Running { cancel: cancel.clone(), kill: None });
        cancel
    }
}

#[tauri::command]
async fn dump_db(state: State<'_, AppState>, conn_id: String, job_id: String, path: String, opts: dump::DumpOptions, on_progress: Channel<JobProgress>) -> Result<dump::DumpSummary, String> {
    let db = state.pool(&conn_id)?;
    let name = Store::load(&state.store_path)?.connections.into_iter().find(|c| c.id == conn_id).map(|c| c.name).unwrap_or_default();
    let cancel = state.track(&job_id);
    let register = |k: Kill| {
        if let Some(r) = state.running.lock().unwrap().get_mut(&job_id) { r.kill = Some(k); }
    };
    let progress = |done: u64, total: u64, label: &str| { let _ = on_progress.send(JobProgress { done, total, label: label.into() }); };
    let path = PathBuf::from(path);
    let result = guarded(dump::dump(&db, &name, &path, &opts, &cancel, &register, &progress)).await;
    state.running.lock().unwrap().remove(&job_id);
    if result.is_err() { let _ = std::fs::remove_file(&path); }
    result
}

#[tauri::command]
async fn restore_file(state: State<'_, AppState>, conn_id: String, job_id: String, path: String, single_tx: bool, stop_on_error: bool, on_progress: Channel<JobProgress>) -> Result<restore::RestoreSummary, String> {
    let db = state.pool(&conn_id)?;
    let cancel = state.track(&job_id);
    let progress = |done: u64, total: u64| { let _ = on_progress.send(JobProgress { done, total, label: String::new() }); };
    let result = guarded(restore::restore(&db, &PathBuf::from(path), single_tx, stop_on_error, &cancel, &progress)).await;
    state.running.lock().unwrap().remove(&job_id);
    result
}

#[tauri::command]
fn preview_import(source: import::Source) -> Result<import::Preview, String> {
    std::panic::catch_unwind(|| import::preview(&source)).unwrap_or_else(|p| Err(panic_text(&*p)))
}

#[tauri::command]
async fn import_file(state: State<'_, AppState>, conn_id: String, job_id: String, opts: import::ImportOptions, on_progress: Channel<JobProgress>) -> Result<import::ImportSummary, String> {
    let db = state.pool(&conn_id)?;
    let cancel = state.track(&job_id);
    let progress = |done: u64| { let _ = on_progress.send(JobProgress { done, total: 0, label: String::new() }); };
    let result = guarded(import::import(&db, &opts, &cancel, &progress)).await;
    state.running.lock().unwrap().remove(&job_id);
    result
}

/// Optional AI: whether a key is saved; saving / removing it (None removes).
/// A query tab or notebook closed: close its connection.
#[tauri::command]
fn end_session(state: State<AppState>, session: String) {
    let ended = state.sessions.lock().unwrap().remove(&session);
    if let Some((_, c)) = ended { c.close(); }
}

/// Structure view: CREATE statement, indexes, triggers and defaults of one table.
#[tauri::command]
async fn table_structure(state: State<'_, AppState>, conn_id: String, schema: String, name: String) -> Result<structure::Structure, String> {
    guarded(structure::structure(&state.pool(&conn_id)?, &schema, &name)).await
}

/// Connections saved by DBeaver / Beekeeper Studio / pgpass; `path` None = the tool's usual place.
#[tauri::command]
async fn import_connections(kind: String, path: Option<String>) -> Result<Vec<importer::Imported>, String> {
    guarded(importer::import(&kind, path)).await
}

#[tauri::command]
fn ai_key_status() -> Result<bool, String> {
    Ok(!secrets::get(ai::KEY_ID)?.is_empty())
}

#[tauri::command]
fn set_ai_key(key: Option<String>) -> Result<(), String> {
    match key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty()) {
        Some(k) => secrets::set(ai::KEY_ID, &k),
        None => secrets::delete(ai::KEY_ID),
    }
}

/// Streams the answer as text chunks over `on_text`. Cancel with cancel_query(job_id).
#[tauri::command]
async fn ai_ask(state: State<'_, AppState>, job_id: String, system: String, prompt: String, on_text: Channel<String>) -> Result<ai::AiSummary, String> {
    let key = secrets::get(ai::KEY_ID)?;
    let cancel = state.track(&job_id);
    let result = guarded(ai::ask(&key, &system, &prompt, &cancel, &|t| { let _ = on_text.send(t); })).await;
    state.running.lock().unwrap().remove(&job_id);
    result
}

/// Text files the user picked in a save / open dialog (migration SQL, notebooks).
#[tauri::command]
fn write_text(path: String, text: String) -> Result<(), String> {
    std::fs::write(&path, text).map_err(|e| format!("Could not write {path}: {e}"))
}

/// Binary files the user picked in a save dialog (diagram PNG).
#[tauri::command]
fn write_bytes(path: String, data: Vec<u8>) -> Result<(), String> {
    std::fs::write(&path, data).map_err(|e| format!("Could not write {path}: {e}"))
}

#[tauri::command]
fn read_text(path: String) -> Result<String, String> {
    let meta = std::fs::metadata(&path).map_err(|e| format!("Could not open {path}: {e}"))?;
    if meta.len() > 50 * 1024 * 1024 { return Err(format!("{path} is larger than 50 MB.")); }
    std::fs::read_to_string(&path).map_err(|e| format!("Could not read {path}: {e}"))
}

#[tauri::command]
fn add_history(state: State<AppState>, entry: history::Entry) -> Result<(), String> {
    history::add(&state.history_path, &entry)
}

#[tauri::command]
fn load_history(state: State<AppState>, limit: Option<usize>) -> Result<Vec<history::Entry>, String> {
    history::load(&state.history_path, limit.unwrap_or(300))
}

#[tauri::command]
fn clear_history(state: State<AppState>) -> Result<(), String> {
    match std::fs::remove_file(&state.history_path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("Could not clear history: {e}")),
        _ => Ok(()),
    }
}

/// Opens a web or mail link in the user's default app (About page). Only https: and mailto:
/// links without spaces or quotes, so nothing else can reach the shell.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("mailto:")) || url.chars().any(|c| c.is_whitespace() || c == '"' || c == '\'') {
        return Err("Only https and mailto links can be opened.".into());
    }
    #[cfg(windows)]
    let r = std::process::Command::new("explorer").arg(&url).spawn();
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("open").arg(&url).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let r = std::process::Command::new("xdg-open").arg(&url).spawn();
    r.map(|_| ()).map_err(|e| format!("Could not open the link: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let dir = app.path().app_config_dir()?;
            std::fs::create_dir_all(&dir)?;
            app.manage(AppState {
                store_path: dir.join("connections.json"),
                history_path: dir.join("history.jsonl"),
                live: Mutex::new(HashMap::new()),
                running: Mutex::new(HashMap::new()),
                sessions: Mutex::new(HashMap::new()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_store, save_store, set_password, test_connection, connect, disconnect, list_schema, tunnel_alive,
            run_query, cancel_query, add_history, load_history, clear_history, open_url, apply_changes, export_rows, export_query,
            dump_db, restore_file, preview_import, import_file, write_text, write_bytes, read_text,
            ai_key_status, set_ai_key, ai_ask, end_session, table_structure, import_connections
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tilki DB");
}
