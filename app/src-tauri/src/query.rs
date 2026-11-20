// Run user SQL and stream results in chunks. Uses sqlx::raw_sql (simple/text protocol), so
// several statements can run at once and PostgreSQL/MySQL return every value as text:
// we keep the server's own formatting and only turn numbers, booleans and JSON into real values.
use crate::db::{Conn, Db};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{Column, Either, Executor, Row, TypeInfo, ValueRef};
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ColInfo {
    pub name: String,
    pub data_type: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "event", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum QueryEvent {
    /// A result set starts (one per statement that returns rows).
    Columns { columns: Vec<ColInfo> },
    Rows { rows: Vec<Vec<Value>> },
    /// A statement finished; `affected` is rows returned or changed.
    StatementDone { index: usize, affected: u64 },
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub rows: u64,
    pub ms: u64,
    pub truncated: bool, // stopped at the row limit
    pub cancelled: bool,
    /// After a session run with keep_tx: whether a transaction is open. None = the engine can't tell (SQLite).
    pub in_transaction: Option<bool>,
}

/// How to stop a query on the server from another connection.
#[derive(Clone)]
pub enum Kill {
    Pg(sqlx::PgPool, i32),
    My(sqlx::MySqlPool, u64),
}

pub async fn kill(k: &Kill) {
    let _ = match k {
        Kill::Pg(pool, pid) => sqlx::query("SELECT pg_cancel_backend($1)").bind(pid).execute(pool).await.map(|_| ()),
        Kill::My(pool, id) => sqlx::raw_sql(&format!("KILL QUERY {id}")).execute(pool).await.map(|_| ()),
    };
}

const MAX_SAFE_INT: i64 = 9_007_199_254_740_991; // JS Number.MAX_SAFE_INTEGER

fn int(n: i64) -> Value {
    if n.unsigned_abs() <= MAX_SAFE_INT as u64 { json!(n) } else { Value::String(n.to_string()) } // keep big ids exact
}

fn hex(b: &[u8]) -> Value {
    let shown: String = b.iter().take(512).map(|x| format!("{x:02x}")).collect();
    Value::String(format!("0x{shown}{}", if b.len() > 512 { "…" } else { "" }))
}

/// Text value + column type name → JSON. DECIMAL/NUMERIC stay strings so no precision is lost.
pub fn typed(ty: &str, text: String) -> Value {
    // sqlx type names are already uppercase; only allocate when they aren't (this runs for every cell)
    let t: std::borrow::Cow<str> = if ty.bytes().any(|b| b.is_ascii_lowercase()) { ty.to_ascii_uppercase().into() } else { ty.into() };
    let array = t.ends_with("[]");
    if !array && t.contains("INT") && !t.contains("INTERVAL") && !t.contains("POINT") {
        if let Ok(n) = text.parse::<i64>() { return int(n); }
    } else if !array && (t.starts_with("FLOAT") || t == "DOUBLE" || t == "REAL") {
        if let Ok(f) = text.parse::<f64>() {
            if f.is_finite() { return json!(f); }
        }
    } else if t == "BOOL" || t == "BOOLEAN" {
        return Value::Bool(matches!(text.as_str(), "t" | "true" | "1"));
    } else if t == "JSON" || t == "JSONB" {
        if let Ok(v) = serde_json::from_str(&text) { return v; }
    }
    Value::String(text)
}

/// The bytes as text when they are valid UTF-8 without control characters (tabs and newlines allowed); empty counts as text.
fn printable(b: &[u8]) -> Option<&str> {
    let t = std::str::from_utf8(b).ok()?;
    (!t.chars().any(|c| c.is_control() && !matches!(c, '\t' | '\n' | '\r'))).then_some(t)
}

macro_rules! text_cell {
    ($name:ident, $row:ty) => {
        fn $name(row: &$row, i: usize) -> Value {
            let Ok(raw) = row.try_get_raw(i) else { return Value::Null };
            if raw.is_null() { return Value::Null; }
            let info = raw.type_info();
            let ty = info.name();
            // always-binary MySQL types: bytes that happen to be valid UTF-8 (BIT 0 = "\0") must still show as hex.
            // BLOB is not here: MariaDB reports JSON / long text as BLOB too.
            if matches!(ty, "BIT" | "GEOMETRY") {
                if let Ok(b) = row.try_get_unchecked::<Vec<u8>, _>(i) { return hex(&b); }
            }
            // MySQL also calls text with a _bin collation (utf8mb4_bin, mysql.user names) BINARY / VARBINARY:
            // printable UTF-8 shows as text, anything else as hex
            if matches!(ty, "BINARY" | "VARBINARY") {
                if let Ok(b) = row.try_get_unchecked::<Vec<u8>, _>(i) {
                    return match printable(&b) { Some(t) => Value::String(t.to_string()), None => hex(&b) };
                }
            }
            match row.try_get_unchecked::<String, _>(i) {
                Ok(text) => typed(ty, text),
                Err(_) => row.try_get_unchecked::<Vec<u8>, _>(i).map(|b| hex(&b)).unwrap_or_else(|_| Value::String(format!("<{}>", ty.to_lowercase()))),
            }
        }
    };
}
text_cell!(pg_cell, sqlx::postgres::PgRow);
text_cell!(my_cell, sqlx::mysql::MySqlRow);

fn lite_cell(row: &sqlx::sqlite::SqliteRow, i: usize) -> Value {
    let Ok(raw) = row.try_get_raw(i) else { return Value::Null };
    if raw.is_null() { return Value::Null; }
    let r = match raw.type_info().name() {
        "INTEGER" => row.try_get_unchecked::<i64, _>(i).map(int),
        "REAL" => row.try_get_unchecked::<f64, _>(i).map(|f| json!(f)),
        "BLOB" => row.try_get_unchecked::<Vec<u8>, _>(i).map(|b| hex(&b)),
        _ => row.try_get_unchecked::<String, _>(i).map(Value::String),
    };
    r.unwrap_or(Value::Null)
}

/// Batches rows: sends every 2000 rows or 40 ms, whichever comes first.
struct Sink<'a> {
    send: &'a (dyn Fn(QueryEvent) -> bool + Sync),
    buf: Vec<Vec<Value>>,
    last: Instant,
    total: u64,
    stmt: usize,
    saw_columns: bool,
}

impl Sink<'_> {
    fn flush(&mut self) -> bool {
        if self.buf.is_empty() { return true; }
        self.last = Instant::now();
        (self.send)(QueryEvent::Rows { rows: std::mem::take(&mut self.buf) })
    }
    fn push(&mut self, row: Vec<Value>) -> bool {
        self.buf.push(row);
        self.total += 1;
        if self.buf.len() >= 2000 || self.last.elapsed() >= Duration::from_millis(40) { self.flush() } else { true }
    }
}

/// The error message; PostgreSQL also says where in the SQL it happened ("At character N.",
/// 1-based) so the editor can underline it.
fn error_text(e: &sqlx::Error) -> String {
    let pos = e.as_database_error().and_then(|d| d.try_downcast_ref::<sqlx::postgres::PgDatabaseError>()).and_then(|p| match p.position() {
        Some(sqlx::postgres::PgErrorPosition::Original(n)) => Some(n),
        _ => None,
    });
    match pos { Some(n) => format!("{e}
At character {n}."), None => e.to_string() }
}

enum Outcome {
    Done,
    Truncated,
    Cancelled,
    Failed(String),
}

macro_rules! pump {
    ($exec:expr, $sql:expr, $cell:path, $limit:expr, $cancel:expr, $sink:expr, $stop:expr) => {{
        let mut stream = sqlx::raw_sql($sql).fetch_many($exec);
        let mut header = false;
        let mut returned = 0u64; // rows of the current result set
        let outcome = loop {
            let next = stream.next().await;
            if $cancel.load(Ordering::Relaxed) { break Outcome::Cancelled; }
            match next {
                None => break Outcome::Done,
                Some(Err(e)) => break Outcome::Failed(error_text(&e)),
                Some(Ok(Either::Left(res))) => {
                    $sink.flush();
                    // SQLite reports the last write's count for a SELECT, so count returned rows ourselves
                    let affected = if header { returned } else { res.rows_affected() };
                    ($sink.send)(QueryEvent::StatementDone { index: $sink.stmt, affected });
                    $sink.stmt += 1;
                    header = false;
                    returned = 0;
                }
                Some(Ok(Either::Right(row))) => {
                    if !header {
                        $sink.flush();
                        $sink.saw_columns = true;
                        let columns = row.columns().iter().enumerate().map(|(i, c)| {
                            // SQLite has no declared type for expressions/joins ("NULL"): use the first value's type
                            let declared = c.type_info().name().to_lowercase();
                            let data_type = if declared == "null" { row.try_get_raw(i).map(|v| v.type_info().name().to_lowercase()).ok().filter(|t| t != "null").unwrap_or_default() } else { declared };
                            ColInfo { name: c.name().to_string(), data_type }
                        }).collect();
                        ($sink.send)(QueryEvent::Columns { columns });
                        header = true;
                    }
                    if $sink.total >= $limit { break Outcome::Truncated; }
                    returned += 1;
                    let cells = (0..row.len()).map(|i| $cell(&row, i)).collect();
                    if !$sink.push(cells) { break Outcome::Cancelled; } // the window went away
                }
            }
        };
        // Stopped early (row limit / cancel): stop the server, then read what's left so the
        // connection ends in a clean state and can be reused (a tab's session survives the limit).
        let clean = match outcome {
            Outcome::Truncated | Outcome::Cancelled => {
                $stop;
                tokio::time::timeout(Duration::from_secs(5), async { while stream.next().await.is_some() {} }).await.is_ok()
            }
            _ => true,
        };
        (outcome, clean)
    }};
}

/// Runs `sql` on a dedicated connection. `register` receives the server-side kill handle as soon
/// as it is known, so a cancel can interrupt a query that hasn't produced rows yet.
pub async fn run(db: &Db, sql: &str, limit: u64, cancel: &AtomicBool, register: &(dyn Fn(Kill) + Sync), send: &(dyn Fn(QueryEvent) -> bool + Sync)) -> Result<Summary, String> {
    run_on(db, None, false, sql, limit, cancel, register, send).await.0 // the connection goes back to the pool
}

/// One read statement (SELECT / WITH / VALUES / TABLE): a zero-row result can still show its columns.
fn single_read(sql: &str, engine: crate::store::Engine) -> bool {
    let stmts = crate::sqlsplit::split(sql, engine == crate::store::Engine::Mysql);
    let first = stmts.first().map(|s| crate::sqlsplit::skip_comments(&s.text).split_whitespace().next().unwrap_or("").to_ascii_lowercase()).unwrap_or_default();
    stmts.len() == 1 && matches!(first.as_str(), "select" | "with" | "values" | "table")
}

/// A zero-row SELECT sends no row to read the columns from: ask the server to describe it.
macro_rules! describe_columns {
    ($exec:expr, $sql:expr, $sink:expr) => {{
        if let Ok(d) = $exec.describe($sql).await {
            let columns = d.columns().iter().map(|c| ColInfo { name: c.name().to_string(), data_type: c.type_info().name().to_lowercase() }).collect();
            ($sink.send)(QueryEvent::Columns { columns });
        }
    }};
}

/// The connection a query ran on, of the right engine, when the caller keeps a session.
macro_rules! session_conn {
    ($pool:expr, $held:expr, $variant:ident, $idq:expr, $idty:ty) => {{
        let held = match $held { Some(Conn::$variant(c)) => Some(c), _ => None };
        let reused = held.is_some();
        let e = |e: sqlx::Error| e.to_string();
        let mut conn = match held { Some(c) => c, None => $pool.acquire().await.map_err(e)? };
        let id = match sqlx::query_scalar::<_, $idty>($idq).fetch_one(&mut *conn).await {
            Ok(id) => Some(id),
            // the user's own transaction failed (PostgreSQL 25P02: only ROLLBACK / COMMIT are accepted now):
            // the session is alive and its transaction must survive; without the id this run can't be killed
            Err(x) if reused && x.as_database_error().and_then(|d| d.code()).as_deref() == Some("25P02") => None,
            // a kept session died (server restart, idle timeout): close it (never back into the pool) and use a fresh one
            Err(_) if reused => {
                let dead = std::mem::replace(&mut conn, $pool.acquire().await.map_err(e)?);
                drop(dead.detach());
                Some(sqlx::query_scalar::<_, $idty>($idq).fetch_one(&mut *conn).await.map_err(e)?)
            }
            Err(x) => return Err(e(x)),
        };
        (conn, id)
    }};
}

/// Runs `sql` on `held` (a query tab's session) or a pool connection, and hands back the
/// connection when it's still usable, so session state (USE, SET, temp tables) carries over.
/// `keep_tx`: leave a transaction the script opened open (a query tab's manual transaction);
/// otherwise it's rolled back at the end of the run.
#[allow(clippy::too_many_arguments)]
pub async fn run_on(db: &Db, held: Option<Conn>, keep_tx: bool, sql: &str, limit: u64, cancel: &AtomicBool, register: &(dyn Fn(Kill) + Sync), send: &(dyn Fn(QueryEvent) -> bool + Sync)) -> (Result<Summary, String>, Option<Conn>) {
    let started = Instant::now();
    let mut sink = Sink { send, buf: vec![], last: Instant::now(), total: 0, stmt: 0, saw_columns: false };
    let mut in_tx: Option<bool> = None;
    let read_one = single_read(sql, db.engine());
    let ran: Result<(Outcome, Option<Conn>), String> = async {
        Ok(match db {
            Db::Pg(pool) => {
                let (mut conn, pid) = session_conn!(pool, held, Pg, "SELECT pg_backend_pid()", i32);
                let k = pid.map(|pid| Kill::Pg(pool.clone(), pid));
                if let Some(k) = &k { register(k.clone()); }
                let (o, clean) = pump!(&mut *conn, sql, pg_cell, limit, cancel, sink, if let Some(k) = &k { kill(k).await });
                if matches!(o, Outcome::Done) && !sink.saw_columns && read_one { describe_columns!(&mut *conn, sql, sink); }
                if keep_tx && clean {
                    // in a transaction block now() is fixed at its start; an aborted block makes the probe fail.
                    // Simple protocol on purpose: with a prepared statement the two times differ by microseconds.
                    let r = (&mut *conn).fetch_one(sqlx::raw_sql("SELECT (now() <> statement_timestamp())::text")).await;
                    in_tx = Some(r.map(|row| row.try_get::<String, _>(0).map(|v| v == "true").unwrap_or(true)).unwrap_or(true));
                }
                (o, finish(conn, clean, keep_tx).await.map(Conn::Pg))
            }
            Db::My(pool) => {
                let (mut conn, id) = session_conn!(pool, held, My, "SELECT CONNECTION_ID()", u64);
                let k = id.map(|id| Kill::My(pool.clone(), id));
                if let Some(k) = &k { register(k.clone()); }
                let (o, clean) = pump!(&mut *conn, sql, my_cell, limit, cancel, sink, if let Some(k) = &k { kill(k).await });
                if matches!(o, Outcome::Done) && !sink.saw_columns && read_one { describe_columns!(&mut *conn, sql, sink); }
                if keep_tx && clean {
                    // Re-setting the next transaction's isolation to its current value changes nothing, but the
                    // server refuses it (1568) while a transaction is open. Querying a status table can't tell:
                    // the probe query is a transaction of its own while it runs.
                    let level = sqlx::query_scalar::<_, String>("SELECT REPLACE(@@transaction_isolation, '-', ' ')").fetch_one(&mut *conn).await;
                    let level = match level { Ok(l) => Ok(l), Err(_) => sqlx::query_scalar::<_, String>("SELECT REPLACE(@@tx_isolation, '-', ' ')").fetch_one(&mut *conn).await };
                    if let Ok(level) = level {
                        let set = (&mut *conn).execute(sqlx::raw_sql(&format!("SET TRANSACTION ISOLATION LEVEL {level}"))).await;
                        in_tx = Some(matches!(&set, Err(e) if e.as_database_error().and_then(|d| d.code()).as_deref() == Some("25001")));
                    }
                }
                (o, finish(conn, clean, keep_tx).await.map(Conn::My))
            }
            Db::Lite(pool) => {
                let mut conn = match held { Some(Conn::Lite(c)) => c, _ => pool.acquire().await.map_err(|e| e.to_string())? };
                // shortcut: SQLite can only stop between rows (no sqlite3_interrupt here); fine for local files
                let (o, clean) = pump!(&mut *conn, sql, lite_cell, limit, cancel, sink, ());
                if matches!(o, Outcome::Done) && !sink.saw_columns && read_one { describe_columns!(&mut *conn, sql, sink); }
                (o, finish(conn, clean, keep_tx).await.map(Conn::Lite))
            }
        })
    }.await;
    let (outcome, back) = match ran { Ok(x) => x, Err(msg) => return (Err(msg), None) };
    sink.flush();
    let ms = started.elapsed().as_millis() as u64;
    let was_cancelled = cancel.load(Ordering::Relaxed);
    let result = match outcome {
        Outcome::Failed(_) if was_cancelled => Ok(Summary { rows: sink.total, ms, truncated: false, cancelled: true, in_transaction: in_tx }),
        Outcome::Failed(msg) if in_tx == Some(true) => Err(format!("{msg}\n(The transaction is still open; roll it back or fix and continue.)")),
        Outcome::Failed(msg) => Err(msg),
        Outcome::Truncated | Outcome::Cancelled => Ok(Summary { rows: sink.total, ms, truncated: matches!(outcome, Outcome::Truncated), cancelled: matches!(outcome, Outcome::Cancelled), in_transaction: in_tx }),
        Outcome::Done => Ok(Summary { rows: sink.total, ms, truncated: false, cancelled: false, in_transaction: in_tx }),
    };
    (result, back)
}

/// After a run: a connection that couldn't be brought back to a clean state is closed (never
/// reused); otherwise any transaction the script left open is rolled back so it can't leak.
/// The ROLLBACK also absorbs a MySQL KILL QUERY that arrived just after the query finished.
async fn finish<DB: sqlx::Database>(conn: sqlx::pool::PoolConnection<DB>, clean: bool, keep_tx: bool) -> Option<sqlx::pool::PoolConnection<DB>>
where
    for<'c> &'c mut DB::Connection: Executor<'c, Database = DB>,
{
    if !clean { drop(conn.detach()); return None; }
    let mut conn = conn;
    if !keep_tx { let _ = (&mut *conn).execute(sqlx::raw_sql("ROLLBACK")).await; } // no-op (or a harmless notice) when nothing is open
    Some(conn)
}

#[cfg(test)]
mod printable_tests {
    use super::printable;
    #[test]
    fn bin_collated_text_reads_as_text_real_bytes_as_hex() {
        assert_eq!(printable(b"root"), Some("root"));
        assert_eq!(printable("çağ\nok".as_bytes()), Some("çağ\nok"));
        assert_eq!(printable(&[0u8]), None, "BIT 0 / NUL bytes");
        assert_eq!(printable(&[0xff, 0x10]), None, "not UTF-8");
        assert_eq!(printable(b""), Some(""), "empty text (MariaDB role hosts)");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Throughput against a real server: TILKI_BENCH="engine|host|port|user|password|db|sql" cargo test --release bench -- --ignored --nocapture
    #[test]
    #[ignore]
    fn bench_stream() {
        let spec = std::env::var("TILKI_BENCH").expect("TILKI_BENCH");
        let p: Vec<&str> = spec.splitn(7, '|').collect();
        let engine = if p[0] == "postgres" { crate::store::Engine::Postgres } else { crate::store::Engine::Mysql };
        let cfg = crate::store::ConnConfig { engine, host: p[1].into(), port: p[2].parse().unwrap(), user: p[3].into(), database: p[5].into(), ..Default::default() };
        tauri::async_runtime::block_on(async {
            let db = crate::db::connect(&cfg, p[4]).await.unwrap();
            let n = std::sync::atomic::AtomicU64::new(0);
            let send = |e: QueryEvent| { if let QueryEvent::Rows { rows } = e { n.fetch_add(rows.len() as u64, std::sync::atomic::Ordering::Relaxed); } true };
            let s = run(&db, p[6], u64::MAX, &std::sync::atomic::AtomicBool::new(false), &|_| {}, &send).await.unwrap();
            println!("BENCH {} rows in {} ms = {} rows/s", s.rows, s.ms, s.rows * 1000 / s.ms.max(1));
        });
    }

    #[test]
    fn single_read_statements() {
        use crate::store::Engine::*;
        assert!(single_read("  -- c
SELECT 1 WHERE false;", Postgres));
        assert!(single_read("WITH x AS (SELECT 1) SELECT * FROM x", Mysql));
        assert!(!single_read("SELECT 1; SELECT 2", Postgres), "two statements: no describe");
        assert!(!single_read("DELETE FROM t", Sqlite));
    }

    #[test]
    fn zero_row_select_still_reports_its_columns() {
        tauri::async_runtime::block_on(async {
            let (db, f) = crate::restore::tests::empty_db("zero-rows").await;
            let Db::Lite(p) = &db else { unreachable!() };
            sqlx::raw_sql("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)").execute(p).await.unwrap();
            let cols = std::sync::Mutex::new(vec![]);
            let send = |e: QueryEvent| { if let QueryEvent::Columns { columns } = e { *cols.lock().unwrap() = columns.into_iter().map(|c| c.name).collect(); } true };
            run(&db, "SELECT id, name FROM t WHERE id < 0", 100, &std::sync::atomic::AtomicBool::new(false), &|_| {}, &send).await.unwrap();
            assert_eq!(*cols.lock().unwrap(), ["id", "name"]);
            let _ = std::fs::remove_file(f);
        });
    }

    #[test]
    fn extreme_integers_stay_exact() {
        assert_eq!(typed("INT8", i64::MIN.to_string()), Value::String("-9223372036854775808".into()), "no overflow on the smallest bigint");
        assert_eq!(typed("INT8", "9007199254740993".into()), Value::String("9007199254740993".into()), "beyond 2^53 stays text");
        assert_eq!(typed("BIGINT UNSIGNED", "18446744073709551615".into()), Value::String("18446744073709551615".into()));
        assert_eq!(typed("INT4", "-9007199254740991".into()), json!(-9007199254740991i64));
    }
    use crate::store::{ConnConfig, Engine};
    use std::sync::Mutex;

    async fn sample(rows: usize, read_only: bool) -> (Db, std::path::PathBuf) {
        let file = std::env::temp_dir().join(format!("tilki-q-{}-{rows}-{read_only}.sqlite", std::process::id()));
        let _ = std::fs::remove_file(&file);
        let w = crate::db::connect(&ConnConfig { engine: Engine::Sqlite, file: file.to_string_lossy().into(), ..Default::default() }, "").await;
        assert!(w.is_err(), "connect never creates files");
        let setup = sqlx::SqlitePool::connect_with(sqlx::sqlite::SqliteConnectOptions::new().filename(&file).create_if_missing(true)).await.unwrap();
        sqlx::raw_sql("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, price REAL, data BLOB, note TEXT)").execute(&setup).await.unwrap();
        sqlx::raw_sql(&format!(
            "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < {rows}) INSERT INTO t (name, price, data, note) SELECT 'item ' || i, i * 1.5, x'dead', NULL FROM n"
        )).execute(&setup).await.unwrap();
        setup.close().await;
        let cfg = ConnConfig { engine: Engine::Sqlite, file: file.to_string_lossy().into(), read_only, ..Default::default() };
        (crate::db::connect(&cfg, "").await.unwrap(), file)
    }

    async fn collect(db: &Db, sql: &str, limit: u64) -> (Result<Summary, String>, Vec<QueryEvent>) {
        let events = Mutex::new(vec![]);
        let cancel = AtomicBool::new(false);
        let r = run(db, sql, limit, &cancel, &|_| {}, &|e| { events.lock().unwrap().push(e); true }).await;
        (r, events.into_inner().unwrap())
    }

    fn rows(ev: &[QueryEvent]) -> Vec<Vec<Value>> {
        ev.iter().flat_map(|e| match e { QueryEvent::Rows { rows } => rows.clone(), _ => vec![] }).collect()
    }

    #[test]
    fn select_streams_columns_and_typed_values() {
        tauri::async_runtime::block_on(async {
            let (db, file) = sample(3, false).await;
            let (r, ev) = collect(&db, "SELECT id, name, price, data, note FROM t ORDER BY id", u64::MAX).await;
            let s = r.unwrap();
            assert_eq!((s.rows, s.truncated, s.cancelled), (3, false, false));
            let QueryEvent::Columns { columns } = &ev[0] else { panic!("columns first: {ev:?}") };
            assert_eq!(columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["id", "name", "price", "data", "note"]);
            assert_eq!(rows(&ev)[0], vec![json!(1), json!("item 1"), json!(1.5), json!("0xdead"), Value::Null]);
            let _ = std::fs::remove_file(file);
        });
    }

    #[test]
    fn row_limit_stops_early() {
        tauri::async_runtime::block_on(async {
            let (db, file) = sample(50, false).await;
            let (r, ev) = collect(&db, "SELECT * FROM t", 10).await;
            let s = r.unwrap();
            assert_eq!((s.rows, s.truncated), (10, true));
            assert_eq!(rows(&ev).len(), 10);
            // the pool still works after a truncated run (that connection was discarded)
            let (r2, _) = collect(&db, "SELECT count(*) FROM t", u64::MAX).await;
            assert_eq!(r2.unwrap().rows, 1);
            let _ = std::fs::remove_file(file);
        });
    }

    #[test]
    fn cancel_stops_the_stream() {
        tauri::async_runtime::block_on(async {
            let (db, file) = sample(5000, false).await;
            let cancel = AtomicBool::new(false);
            let got = Mutex::new(0usize);
            // a cross join makes 25M rows; cancel as soon as the first batch arrives
            let r = run(&db, "SELECT a.id, b.id FROM t a, t b", u64::MAX, &cancel, &|_| {}, &|e| {
                if let QueryEvent::Rows { rows } = e { *got.lock().unwrap() += rows.len(); cancel.store(true, Ordering::Relaxed); }
                true
            }).await.unwrap();
            assert!(r.cancelled && !r.truncated);
            assert!(r.rows < 100_000, "stopped early, got {}", r.rows);
            let (r2, _) = collect(&db, "SELECT 1", u64::MAX).await;
            assert_eq!(r2.unwrap().rows, 1, "the pool still works after a cancel");
            let _ = std::fs::remove_file(file);
        });
    }

    #[test]
    fn several_statements_report_affected_rows() {
        tauri::async_runtime::block_on(async {
            let (db, file) = sample(5, false).await;
            let (r, ev) = collect(&db, "UPDATE t SET note = 'x' WHERE id <= 2; SELECT note FROM t WHERE note IS NOT NULL", u64::MAX).await;
            assert_eq!(r.unwrap().rows, 2);
            assert!(ev.contains(&QueryEvent::StatementDone { index: 0, affected: 2 }), "{ev:?}");
            assert!(ev.contains(&QueryEvent::StatementDone { index: 1, affected: 2 }), "a SELECT reports rows returned: {ev:?}");
            let _ = std::fs::remove_file(file);
        });
    }

    #[test]
    fn sql_errors_come_back_as_messages() {
        tauri::async_runtime::block_on(async {
            let (db, file) = sample(1, false).await;
            let (r, _) = collect(&db, "SELEC nope", u64::MAX).await;
            assert!(r.unwrap_err().contains("syntax error"));
            let _ = std::fs::remove_file(file);
        });
    }

    #[test]
    fn read_only_connections_refuse_writes() {
        tauri::async_runtime::block_on(async {
            let (db, file) = sample(1, true).await;
            let (r, _) = collect(&db, "DELETE FROM t", u64::MAX).await;
            assert!(r.unwrap_err().to_lowercase().contains("readonly"));
            let _ = std::fs::remove_file(file);
        });
    }

    #[test]
    fn text_values_become_typed_json() {
        assert_eq!(typed("INT4", "42".into()), json!(42));
        assert_eq!(typed("INT8", "9007199254740993".into()), json!("9007199254740993"), "beyond JS safe integers stays a string");
        assert_eq!(typed("BIGINT UNSIGNED", "7".into()), json!(7));
        assert_eq!(typed("FLOAT8", "2.5".into()), json!(2.5));
        assert_eq!(typed("NUMERIC", "1.10".into()), json!("1.10"), "decimals keep their digits");
        assert_eq!(typed("BOOL", "t".into()), json!(true));
        assert_eq!(typed("BOOLEAN", "0".into()), json!(false));
        assert_eq!(typed("JSONB", r#"{"a":1}"#.into()), json!({"a": 1}));
        assert_eq!(typed("INTERVAL", "1 day".into()), json!("1 day"));
        assert_eq!(typed("INT4[]", "{1,2}".into()), json!("{1,2}"));
        assert_eq!(typed("TIMESTAMPTZ", "2026-11-18 09:41:00+00".into()), json!("2026-11-18 09:41:00+00"));
    }
}
