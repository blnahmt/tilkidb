// Run a .sql script against a connection, statement by statement, with progress.
// "One transaction" makes the restore all-or-nothing; otherwise "stop at first error" decides
// whether failures abort or are collected and skipped.
use crate::db::{Conn, Db};
use crate::sqlsplit;
use crate::store::Engine;
use serde::Serialize;
use std::{
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};

const MAX_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RestoreSummary {
    pub statements: u64, // that ran successfully
    pub failed: u64,
    pub errors: Vec<String>, // first 50
    pub ms: u64,
    pub cancelled: bool,
}

fn is_tx_control(s: &str) -> bool {
    let u = sqlsplit::skip_comments(s).trim().trim_end_matches(';').to_ascii_uppercase();
    matches!(u.as_str(), "BEGIN" | "BEGIN TRANSACTION" | "START TRANSACTION" | "COMMIT" | "END" | "END TRANSACTION")
}

pub async fn restore(db: &Db, path: &Path, single_tx: bool, stop_on_error: bool, cancel: &AtomicBool, progress: &(dyn Fn(u64, u64) + Sync)) -> Result<RestoreSummary, String> {
    let started = Instant::now();
    let size = std::fs::metadata(path).map_err(|e| format!("Could not open {}: {e}", path.display()))?.len();
    if size > MAX_BYTES {
        return Err(format!("{} is larger than 512 MB; restore it with the database's own command-line tool.", path.display()));
    }
    let bytes = std::fs::read(path).map_err(|e| format!("Could not read {}: {e}", path.display()))?;
    if bytes.starts_with(&[0x1f, 0x8b]) {
        return Err("This file is gzip-compressed. Unzip it first.".into());
    }
    // never "repair" bytes: a lossy decode would silently corrupt binary values (mysqldump without --hex-blob)
    let text = String::from_utf8(bytes).map_err(|e| format!("This file isn't valid UTF-8 text (first bad byte at offset {}). It probably holds raw binary data: make the dump with --hex-blob (mysqldump / mariadb-dump) or as UTF-8, then restore again.", e.utf8_error().valid_up_to()))?;
    if text.contains("FROM stdin;") {
        return Err("This file uses COPY … FROM stdin (pg_dump's default plain format). Restore it with psql, or make the dump with --inserts.".into());
    }
    let engine = db.engine();
    let stmts = sqlsplit::split(&text, engine == Engine::Mysql);
    let stmts: Vec<_> = stmts.into_iter().filter(|s| !(single_tx && is_tx_control(&s.text))).collect(); // we manage the transaction
    // SQLite ignores PRAGMA foreign_keys inside a transaction, so the ones that open and close
    // the script (as in our dumps and sqlite3 .dump) run before BEGIN and after COMMIT.
    let outside = |s: &str| engine == Engine::Sqlite && sqlsplit::skip_comments(s).to_ascii_uppercase().starts_with("PRAGMA FOREIGN_KEYS");
    let tx_from = stmts.iter().position(|s| !outside(&s.text)).unwrap_or(stmts.len());
    let tx_to = stmts.iter().rposition(|s| !outside(&s.text)).map_or(tx_from, |i| i + 1);
    let mut conn = Conn::acquire(db).await?;
    let r = run(&mut conn, &stmts, single_tx, stop_on_error, (tx_from, tx_to), cancel, progress, started).await;
    conn.close();
    r
}

#[allow(clippy::too_many_arguments)]
async fn run(conn: &mut Conn, stmts: &[sqlsplit::Stmt], single_tx: bool, stop_on_error: bool, (tx_from, tx_to): (usize, usize), cancel: &AtomicBool, progress: &(dyn Fn(u64, u64) + Sync), started: Instant) -> Result<RestoreSummary, String> {
    let total = stmts.len() as u64;
    let in_tx = |i: usize| single_tx && i >= tx_from && i < tx_to;
    let (mut ok, mut failed, mut errors) = (0u64, 0u64, Vec::new());
    let mut last_report = Instant::now();
    progress(0, total);
    for (i, s) in stmts.iter().enumerate() {
        if cancel.load(Ordering::Relaxed) {
            if in_tx(i) && i > tx_from { let _ = conn.exec("ROLLBACK").await; }
            return Ok(RestoreSummary { statements: ok, failed, errors, ms: started.elapsed().as_millis() as u64, cancelled: true });
        }
        if in_tx(i) && i == tx_from { conn.exec("BEGIN").await?; }
        match conn.exec(&s.text).await {
            Ok(_) => ok += 1,
            Err(e) => {
                failed += 1;
                let msg = format!("Statement {} (line {}): {e}", i + 1, s.line);
                if single_tx {
                    if in_tx(i) { let _ = conn.exec("ROLLBACK").await; }
                    return Err(format!("{msg}. Nothing was saved (one transaction)."));
                }
                if stop_on_error {
                    return Err(format!("{msg}. Stopped here; the {ok} statements before it were applied."));
                }
                if errors.len() < 50 { errors.push(msg); }
            }
        }
        if in_tx(i) && i + 1 == tx_to { conn.exec("COMMIT").await?; }
        if last_report.elapsed().as_millis() >= 100 { progress(i as u64 + 1, total); last_report = Instant::now(); }
    }
    progress(total, total);
    Ok(RestoreSummary { statements: ok, failed, errors, ms: started.elapsed().as_millis() as u64, cancelled: false })
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::store::ConnConfig;

    /// A fresh, empty SQLite database (connect() refuses to create files).
    pub async fn empty_db(name: &str) -> (Db, std::path::PathBuf) {
        let file = std::env::temp_dir().join(format!("tilki-{}-{name}.sqlite", std::process::id()));
        let _ = std::fs::remove_file(&file);
        sqlx::SqlitePool::connect_with(sqlx::sqlite::SqliteConnectOptions::new().filename(&file).create_if_missing(true)).await.unwrap().close().await;
        (crate::db::connect(&ConnConfig { engine: Engine::Sqlite, file: file.to_string_lossy().into(), ..Default::default() }, "").await.unwrap(), file)
    }

    pub async fn scalar(db: &Db, sql: &str) -> i64 {
        let Db::Lite(p) = db else { unreachable!() };
        sqlx::query_scalar(sql).fetch_one(p).await.unwrap()
    }

    fn script(name: &str, sql: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("tilki-{}-{name}.sql", std::process::id()));
        std::fs::write(&p, sql).unwrap();
        p
    }

    #[test]
    fn restores_a_script_in_one_transaction() {
        tauri::async_runtime::block_on(async {
            let (db, f) = empty_db("rs-ok").await;
            let p = script("ok", "BEGIN;\nCREATE TABLE t (id INTEGER PRIMARY KEY, s TEXT);\nINSERT INTO t (s) VALUES ('a;b'), ('ü');\nCOMMIT;\n");
            let r = restore(&db, &p, true, true, &AtomicBool::new(false), &|_, _| {}).await.unwrap();
            assert_eq!((r.statements, r.failed), (2, 0), "BEGIN/COMMIT in the file are skipped");
            assert_eq!(scalar(&db, "SELECT count(*) FROM t").await, 2);
            let _ = std::fs::remove_file(f);
            let _ = std::fs::remove_file(p);
        });
    }

    #[test]
    fn one_transaction_rolls_back_on_error() {
        tauri::async_runtime::block_on(async {
            let (db, f) = empty_db("rs-fail").await;
            let p = script("fail", "CREATE TABLE t (id INTEGER PRIMARY KEY);\nINSERT INTO t VALUES (1);\nINSERT INTO nope VALUES (2);");
            let err = restore(&db, &p, true, true, &AtomicBool::new(false), &|_, _| {}).await.unwrap_err();
            assert!(err.contains("Statement 3 (line 3)") && err.contains("Nothing was saved"), "{err}");
            assert_eq!(scalar(&db, "SELECT count(*) FROM sqlite_master WHERE name = 't'").await, 0, "the table was rolled back");
            let _ = std::fs::remove_file(f);
            let _ = std::fs::remove_file(p);
        });
    }

    #[test]
    fn without_a_transaction_errors_can_be_skipped() {
        tauri::async_runtime::block_on(async {
            let (db, f) = empty_db("rs-skip").await;
            let p = script("skip", "CREATE TABLE t (id INTEGER PRIMARY KEY);\nINSERT INTO nope VALUES (1);\nINSERT INTO t VALUES (2);");
            let r = restore(&db, &p, false, false, &AtomicBool::new(false), &|_, _| {}).await.unwrap();
            assert_eq!((r.statements, r.failed), (2, 1));
            assert!(r.errors[0].starts_with("Statement 2 (line 2)"));
            assert_eq!(scalar(&db, "SELECT count(*) FROM t").await, 1);
            let _ = std::fs::remove_file(f);
            let _ = std::fs::remove_file(p);
        });
    }

    #[test]
    fn sqlite_fk_pragmas_run_outside_the_transaction() {
        tauri::async_runtime::block_on(async {
            let (db, f) = empty_db("rs-fk").await;
            let Db::Lite(pool) = &db else { unreachable!() };
            sqlx::raw_sql("CREATE TABLE p (id INTEGER PRIMARY KEY); CREATE TABLE c (id INTEGER PRIMARY KEY, p_id INTEGER REFERENCES p(id)); INSERT INTO p VALUES (1); INSERT INTO c VALUES (1, 1);").execute(pool).await.unwrap();
            // dropping the parent first only works with foreign keys off
            let p = script("fk", "-- header comment\nPRAGMA foreign_keys = OFF;
BEGIN;
DROP TABLE IF EXISTS p;
CREATE TABLE p (id INTEGER PRIMARY KEY);
INSERT INTO p VALUES (1);
COMMIT;
PRAGMA foreign_keys = ON;
");
            let r = restore(&db, &p, true, true, &AtomicBool::new(false), &|_, _| {}).await.unwrap();
            assert_eq!((r.statements, r.failed), (5, 0));
            assert_eq!(scalar(&db, "PRAGMA foreign_keys").await, 1, "pooled connections keep foreign keys on");
            let _ = std::fs::remove_file(f);
            let _ = std::fs::remove_file(p);
        });
    }

    #[test]
    fn copy_from_stdin_is_refused_with_a_hint() {
        tauri::async_runtime::block_on(async {
            let (db, f) = empty_db("rs-copy").await;
            let p = script("copy", "COPY public.t (id) FROM stdin;\n1\n\\.\n");
            assert!(restore(&db, &p, true, true, &AtomicBool::new(false), &|_, _| {}).await.unwrap_err().contains("psql"));
            let _ = std::fs::remove_file(f);
            let _ = std::fs::remove_file(p);
        });
    }
}
