// Apply edited/inserted/deleted rows from the table view: all statements in one transaction.
// UPDATE/DELETE by primary key must touch exactly one row, otherwise nothing is saved — this
// catches rows that changed or vanished since they were loaded.
use crate::db::Db;
use serde::Deserialize;
use sqlx::Executor; // its execute() returns a boxed future, which keeps Tauri commands Send

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub sql: String,
    pub expect_one: bool,
}

// Plain connection + explicit BEGIN/COMMIT/ROLLBACK through Executor::execute (boxed futures):
// sqlx's async-fn variants trip the Send check that Tauri commands need.
macro_rules! apply_in_tx {
    ($pool:expr, $changes:expr) => {{
        let mut conn = $pool.acquire().await.map_err(|e| e.to_string())?;
        (&mut *conn).execute(sqlx::raw_sql("BEGIN")).await.map_err(|e| e.to_string())?;
        let mut total = 0u64;
        let mut problem = None;
        for (i, c) in $changes.iter().enumerate() {
            match (&mut *conn).execute(sqlx::raw_sql(&c.sql)).await {
                Err(e) => { problem = Some(format!("Change {} failed: {e}. Nothing was saved.", i + 1)); break; }
                Ok(r) if c.expect_one && r.rows_affected() != 1 => {
                    problem = Some(format!(
                        "Change {} would affect {} rows instead of 1, so nothing was saved. The row may have been changed or deleted since it was loaded; reload and try again.",
                        i + 1, r.rows_affected()
                    ));
                    break;
                }
                Ok(r) => total += r.rows_affected(),
            }
        }
        match problem {
            Some(msg) => {
                let _ = (&mut *conn).execute(sqlx::raw_sql("ROLLBACK")).await;
                Err(msg)
            }
            None => {
                (&mut *conn).execute(sqlx::raw_sql("COMMIT")).await.map_err(|e| e.to_string())?;
                Ok(total)
            }
        }
    }};
}

/// Returns the total number of rows changed.
pub async fn apply(db: &Db, changes: &[Change]) -> Result<u64, String> {
    if changes.is_empty() {
        return Ok(0);
    }
    match db {
        Db::Pg(p) => apply_in_tx!(p, changes),
        Db::My(p) => apply_in_tx!(p, changes),
        Db::Lite(p) => apply_in_tx!(p, changes),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{ConnConfig, Engine};

    async fn db(name: &str) -> (Db, std::path::PathBuf) {
        let file = std::env::temp_dir().join(format!("tilki-ch-{}-{name}.sqlite", std::process::id()));
        let _ = std::fs::remove_file(&file);
        let setup = sqlx::SqlitePool::connect_with(sqlx::sqlite::SqliteConnectOptions::new().filename(&file).create_if_missing(true)).await.unwrap();
        sqlx::raw_sql("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO t VALUES (1, 'a'), (2, 'b');").execute(&setup).await.unwrap();
        setup.close().await;
        (crate::db::connect(&ConnConfig { engine: Engine::Sqlite, file: file.to_string_lossy().into(), ..Default::default() }, "").await.unwrap(), file)
    }

    fn ch(sql: &str, expect_one: bool) -> Change {
        Change { sql: sql.into(), expect_one }
    }

    async fn names(db: &Db) -> Vec<String> {
        let Db::Lite(p) = db else { unreachable!() };
        sqlx::query_scalar("SELECT name FROM t ORDER BY id").fetch_all(p).await.unwrap()
    }

    #[test]
    fn all_changes_commit_together() {
        tauri::async_runtime::block_on(async {
            let (db, f) = db("ok").await;
            let n = apply(&db, &[ch("UPDATE t SET name = 'A' WHERE id = 1", true), ch("INSERT INTO t (name) VALUES ('c')", false), ch("DELETE FROM t WHERE id = 2", true)]).await.unwrap();
            assert_eq!(n, 3);
            assert_eq!(names(&db).await, ["A", "c"]);
            let _ = std::fs::remove_file(f);
        });
    }

    #[test]
    fn a_missing_row_rolls_everything_back() {
        tauri::async_runtime::block_on(async {
            let (db, f) = db("missing").await;
            let err = apply(&db, &[ch("UPDATE t SET name = 'A' WHERE id = 1", true), ch("UPDATE t SET name = 'Z' WHERE id = 99", true)]).await.unwrap_err();
            assert!(err.contains("affect 0 rows"), "{err}");
            assert_eq!(names(&db).await, ["a", "b"], "the first update was rolled back");
            let _ = std::fs::remove_file(f);
        });
    }

    #[test]
    fn a_failing_statement_rolls_everything_back() {
        tauri::async_runtime::block_on(async {
            let (db, f) = db("fail").await;
            let err = apply(&db, &[ch("DELETE FROM t WHERE id = 1", true), ch("INSERT INTO t (id, name) VALUES (2, 'dup')", false)]).await.unwrap_err();
            assert!(err.contains("Change 2 failed"), "{err}");
            assert_eq!(names(&db).await, ["a", "b"]);
            let _ = std::fs::remove_file(f);
        });
    }
}
