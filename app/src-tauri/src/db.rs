// Database access: one pool per open connection, plus schema introspection.
use crate::store::{ConnConfig, Engine, SslMode};
use crate::tunnel::{self, Tunnel};
use serde::Serialize;
use sqlx::{
    mysql::{MySqlConnectOptions, MySqlPool, MySqlPoolOptions, MySqlSslMode},
    postgres::{PgConnectOptions, PgPool, PgPoolOptions, PgSslMode},
    sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions},
};
use sqlx::Executor;
use std::{collections::BTreeMap, time::Duration};

#[derive(Clone)]
pub enum Db {
    Pg(PgPool),
    My(MySqlPool),
    Lite(SqlitePool),
}

const TIMEOUT: Duration = Duration::from_secs(10);

/// An open connection: the pool, plus the SSH tunnel it runs through (dropped with it).
pub struct Live {
    pub db: Db,
    pub tunnel: Option<Tunnel>,
}

/// Connect, through an SSH tunnel when the config asks for one (not for SQLite files).
pub async fn open(cfg: &ConnConfig, password: &str, ssh_secret: &str, trust_host: bool) -> Result<Live, String> {
    if !cfg.ssh.enabled || cfg.engine == Engine::Sqlite {
        return Ok(Live { db: connect(cfg, password).await?, tunnel: None });
    }
    let known_hosts = tunnel::default_known_hosts().ok_or("Could not find your home folder for ~/.ssh/known_hosts.")?;
    let t = tunnel::open(&cfg.ssh, &cfg.host, cfg.port, ssh_secret, trust_host, known_hosts).await?;
    // shortcut: TLS "verify certificate" checks against 127.0.0.1 through the tunnel; fix when SNI override lands in sqlx
    let via = ConnConfig { host: "127.0.0.1".into(), port: t.local_port, ..cfg.clone() };
    let db = connect(&via, password).await?;
    Ok(Live { db, tunnel: Some(t) })
}

/// Reach host:port before handing over to sqlx, whose pool hides "connection refused" or an
/// unknown host behind a 10 s "pool timed out" message.
async fn probe(host: &str, port: u16) -> Result<(), String> {
    let addrs: Vec<_> = tokio::net::lookup_host((host, port)).await.map_err(|_| format!("Couldn't find the host \"{host}\". Check the name, and your VPN or DNS."))?.collect();
    let mut last = None;
    for a in addrs {
        match tokio::time::timeout(Duration::from_secs(8), tokio::net::TcpStream::connect(a)).await {
            Ok(Ok(_)) => return Ok(()),
            Ok(Err(e)) => last = Some(e),
            Err(_) => return Err(format!("No answer from {host}:{port} within 8 seconds. Check the address, the firewall or your VPN.")),
        }
    }
    Err(match last {
        Some(e) if e.kind() == std::io::ErrorKind::ConnectionRefused => format!("Nothing is listening on {host}:{port} (connection refused). Is the server running, and is the port right?"),
        Some(e) => format!("Could not reach {host}:{port}: {e}"),
        None => format!("Couldn't find the host \"{host}\"."),
    })
}

pub async fn connect(cfg: &ConnConfig, password: &str) -> Result<Db, String> {
    if cfg.engine != Engine::Sqlite {
        for (path, what) in [(&cfg.ssl_ca, "CA certificate"), (&cfg.ssl_cert, "client certificate"), (&cfg.ssl_key, "client key")] {
            if !path.trim().is_empty() && !std::path::Path::new(path.trim()).is_file() { return Err(format!("The {what} file wasn't found: {}", path.trim())); }
        }
        probe(&cfg.host, cfg.port).await?;
    }
    let res = match cfg.engine {
        Engine::Postgres => {
            let ssl = match cfg.ssl {
                SslMode::Disable => PgSslMode::Disable,
                SslMode::Prefer => PgSslMode::Prefer,
                SslMode::Require => PgSslMode::Require,
                SslMode::VerifyFull => PgSslMode::VerifyFull,
            };
            let mut o = PgConnectOptions::new().host(&cfg.host).port(cfg.port).username(&cfg.user).password(password).ssl_mode(ssl).application_name("Tilki DB");
            if !cfg.ssl_ca.trim().is_empty() { o = o.ssl_root_cert(cfg.ssl_ca.trim()); }
            if !cfg.ssl_cert.trim().is_empty() { o = o.ssl_client_cert(cfg.ssl_cert.trim()); }
            if !cfg.ssl_key.trim().is_empty() { o = o.ssl_client_key(cfg.ssl_key.trim()); }
            if !cfg.database.is_empty() {
                o = o.database(&cfg.database);
            }
            let ro = cfg.read_only;
            PgPoolOptions::new()
                .max_connections(10) // query tabs keep their own session connection
                .acquire_timeout(TIMEOUT)
                .after_connect(move |c, _| Box::pin(async move {
                    // enforced by the server, so even "SET ..." tricks in a script can't write by accident
                    if ro { c.execute("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY").await?; }
                    Ok(())
                }))
                .connect_with(o)
                .await
                .map(Db::Pg)
        }
        Engine::Mysql => {
            let ssl = match cfg.ssl {
                SslMode::Disable => MySqlSslMode::Disabled,
                SslMode::Prefer => MySqlSslMode::Preferred,
                SslMode::Require => MySqlSslMode::Required,
                SslMode::VerifyFull => MySqlSslMode::VerifyIdentity,
            };
            let mut o = MySqlConnectOptions::new().host(&cfg.host).port(cfg.port).username(&cfg.user).password(password).ssl_mode(ssl);
            if !cfg.ssl_ca.trim().is_empty() { o = o.ssl_ca(cfg.ssl_ca.trim()); }
            if !cfg.ssl_cert.trim().is_empty() { o = o.ssl_client_cert(cfg.ssl_cert.trim()); }
            if !cfg.ssl_key.trim().is_empty() { o = o.ssl_client_key(cfg.ssl_key.trim()); }
            if !cfg.database.is_empty() {
                o = o.database(&cfg.database);
            }
            let ro = cfg.read_only;
            MySqlPoolOptions::new()
                .max_connections(10) // query tabs keep their own session connection
                .acquire_timeout(TIMEOUT)
                .after_connect(move |c, _| Box::pin(async move {
                    if ro { c.execute("SET SESSION TRANSACTION READ ONLY").await?; }
                    Ok(())
                }))
                .connect_with(o)
                .await
                .map(Db::My)
        }
        Engine::Sqlite => {
            if cfg.file.trim().is_empty() {
                return Err("Choose a database file.".into());
            }
            let o = SqliteConnectOptions::new().filename(&cfg.file).create_if_missing(false).read_only(cfg.read_only);
            // query tabs keep a session connection each; writers queue on the file lock (busy timeout)
            SqlitePoolOptions::new().max_connections(4).acquire_timeout(TIMEOUT).connect_with(o).await.map(Db::Lite)
        }
    };
    res.map_err(|e| {
        let m = e.to_string();
        // MariaDB answers a wrong password by offering Windows (GSSAPI) sign-in, which sqlx can't do
        if m.contains("auth_gssapi_client") { format!("Access denied for user '{}': the user name or password is probably wrong (the server then offered Windows / GSSAPI sign-in, which Tilki DB doesn't support).", cfg.user) } else { m }
    })
}

impl Db {
    pub fn engine(&self) -> Engine {
        match self {
            Db::Pg(_) => Engine::Postgres,
            Db::My(_) => Engine::Mysql,
            Db::Lite(_) => Engine::Sqlite,
        }
    }
}

/// One pooled connection of any engine, for tools that run many statements in order
/// (dump, restore, import). exec() goes through Executor::execute, whose boxed future keeps
/// Tauri commands Send.
pub enum Conn {
    Pg(sqlx::pool::PoolConnection<sqlx::Postgres>),
    My(sqlx::pool::PoolConnection<sqlx::MySql>),
    Lite(sqlx::pool::PoolConnection<sqlx::Sqlite>),
}

impl Conn {
    pub async fn acquire(db: &Db) -> Result<Conn, String> {
        let e = |e: sqlx::Error| e.to_string();
        Ok(match db {
            Db::Pg(p) => Conn::Pg(p.acquire().await.map_err(e)?),
            Db::My(p) => Conn::My(p.acquire().await.map_err(e)?),
            Db::Lite(p) => Conn::Lite(p.acquire().await.map_err(e)?),
        })
    }

    /// Runs one or more statements; returns rows affected.
    pub async fn exec(&mut self, sql: &str) -> Result<u64, String> {
        let r = match self {
            Conn::Pg(c) => (&mut **c).execute(sqlx::raw_sql(sql)).await.map(|r| r.rows_affected()),
            Conn::My(c) => (&mut **c).execute(sqlx::raw_sql(sql)).await.map(|r| r.rows_affected()),
            Conn::Lite(c) => (&mut **c).execute(sqlx::raw_sql(sql)).await.map(|r| r.rows_affected()),
        };
        r.map_err(|e| e.to_string())
    }

    /// Close instead of returning to the pool, so session state (SET …, PRAGMA …) set by a
    /// script can't leak into later queries.
    pub fn close(self) {
        match self {
            Conn::Pg(c) => drop(c.detach()),
            Conn::My(c) => drop(c.detach()),
            Conn::Lite(c) => drop(c.detach()),
        }
    }
}

pub async fn server_version(db: &Db) -> Result<String, String> {
    let r = match db {
        // "PostgreSQL 16.4 on x86_64…" → keep the first two words
        Db::Pg(p) => sqlx::query_scalar::<_, String>("SELECT version()").fetch_one(p).await.map(|v| v.split_whitespace().take(2).collect::<Vec<_>>().join(" ")),
        Db::My(p) => sqlx::query_scalar::<_, String>("SELECT VERSION()").fetch_one(p).await.map(|v| {
            if v.to_lowercase().contains("mariadb") { format!("MariaDB {}", v.split('-').next().unwrap_or(&v)) } else { format!("MySQL {v}") }
        }),
        Db::Lite(p) => sqlx::query_scalar::<_, String>("SELECT sqlite_version()").fetch_one(p).await.map(|v| format!("SQLite {v}")),
    };
    r.map_err(|e| e.to_string())
}

pub async fn close(db: Db) {
    match db {
        Db::Pg(p) => p.close().await,
        Db::My(p) => p.close().await,
        Db::Lite(p) => p.close().await,
    }
}

#[derive(Serialize, Debug, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Column {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub pk: bool,
    pub fk: Option<String>, // referenced table
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Table {
    pub schema: String,
    pub name: String,
    pub kind: String,      // "table" | "view"
    pub rows: Option<i64>, // planner estimate; None when unknown
    pub columns: Vec<Column>,
}

type TableRow = (String, String, String, Option<i64>); // schema, name, kind, rows
type ColRow = (String, String, String, String, bool); // schema, table, column, type, nullable
type KeyRow = (String, String, String, String, Option<String>); // schema, table, column, "PRIMARY KEY"|"FOREIGN KEY", ref table

fn assemble(tables: Vec<TableRow>, cols: Vec<ColRow>, keys: Vec<KeyRow>) -> Vec<Table> {
    let mut map: BTreeMap<(String, String), Table> = tables
        .into_iter()
        .map(|(schema, name, kind, rows)| ((schema.clone(), name.clone()), Table { schema, name, kind, rows: rows.filter(|r| *r >= 0), columns: vec![] }))
        .collect();
    for (s, t, name, data_type, nullable) in cols {
        if let Some(tb) = map.get_mut(&(s, t)) {
            tb.columns.push(Column { name, data_type, nullable, pk: false, fk: None });
        }
    }
    for (s, t, c, kind, reference) in keys {
        if let Some(col) = map.get_mut(&(s, t)).and_then(|tb| tb.columns.iter_mut().find(|x| x.name == c)) {
            if kind == "PRIMARY KEY" { col.pk = true } else { col.fk = reference }
        }
    }
    map.into_values().collect()
}

const PG_TABLES: &str = "SELECT n.nspname::text, c.relname::text, CASE WHEN c.relkind IN ('v','m') THEN 'view' ELSE 'table' END, c.reltuples::bigint
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r','p','v','m') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'";
// format_type keeps length / precision (numeric(10,2), character(2)), which schema diff needs
const PG_COLS: &str = "SELECT n.nspname::text, c.relname::text, a.attname::text, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull
  FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r','p','v','m') AND a.attnum > 0 AND NOT a.attisdropped
    AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
  ORDER BY n.nspname, c.relname, a.attnum";
const PG_KEYS: &str = "SELECT tc.table_schema::text, tc.table_name::text, kcu.column_name::text, tc.constraint_type::text, ccu.table_name::text
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.constraint_schema = tc.constraint_schema
  LEFT JOIN information_schema.constraint_column_usage ccu ON tc.constraint_type = 'FOREIGN KEY' AND ccu.constraint_name = tc.constraint_name AND ccu.constraint_schema = tc.constraint_schema
  WHERE tc.constraint_type IN ('PRIMARY KEY','FOREIGN KEY')";

// MySQL: CAST(... AS CHAR) because information_schema text can arrive as binary; comparisons return integers.
const MY_FILTER: &str = "TABLE_SCHEMA NOT IN ('mysql','information_schema','performance_schema','sys') AND (DATABASE() IS NULL OR TABLE_SCHEMA = DATABASE())";

pub async fn list_schema(db: &Db) -> Result<Vec<Table>, String> {
    let e = |e: sqlx::Error| e.to_string();
    match db {
        Db::Pg(p) => {
            let t = sqlx::query_as::<_, TableRow>(PG_TABLES).fetch_all(p).await.map_err(e)?;
            let c = sqlx::query_as::<_, ColRow>(PG_COLS).fetch_all(p).await.map_err(e)?;
            let k = sqlx::query_as::<_, KeyRow>(PG_KEYS).fetch_all(p).await.map_err(e)?;
            Ok(assemble(t, c, k))
        }
        Db::My(p) => {
            let t = sqlx::query_as::<_, TableRow>(&format!(
                "SELECT CAST(TABLE_SCHEMA AS CHAR), CAST(TABLE_NAME AS CHAR), CAST(IF(TABLE_TYPE = 'VIEW', 'view', 'table') AS CHAR), CAST(TABLE_ROWS AS SIGNED) FROM information_schema.TABLES WHERE {MY_FILTER}"
            )).fetch_all(p).await.map_err(e)?;
            let c: Vec<(String, String, String, String, i64)> = sqlx::query_as(&format!(
                "SELECT CAST(TABLE_SCHEMA AS CHAR), CAST(TABLE_NAME AS CHAR), CAST(COLUMN_NAME AS CHAR), CAST(COLUMN_TYPE AS CHAR), CAST(IS_NULLABLE = 'YES' AS SIGNED) FROM information_schema.COLUMNS WHERE {MY_FILTER} ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION"
            )).fetch_all(p).await.map_err(e)?;
            let k = sqlx::query_as::<_, KeyRow>(&format!(
                "SELECT CAST(TABLE_SCHEMA AS CHAR), CAST(TABLE_NAME AS CHAR), CAST(COLUMN_NAME AS CHAR), CAST(IF(CONSTRAINT_NAME = 'PRIMARY', 'PRIMARY KEY', 'FOREIGN KEY') AS CHAR), CAST(REFERENCED_TABLE_NAME AS CHAR) FROM information_schema.KEY_COLUMN_USAGE WHERE {MY_FILTER} AND (CONSTRAINT_NAME = 'PRIMARY' OR REFERENCED_TABLE_NAME IS NOT NULL)"
            )).fetch_all(p).await.map_err(e)?;
            Ok(assemble(t, c.into_iter().map(|(s, t, n, ty, nul)| (s, t, n, ty, nul != 0)).collect(), k))
        }
        Db::Lite(p) => {
            let names: Vec<(String, String)> = sqlx::query_as(
                "SELECT name, CASE type WHEN 'view' THEN 'view' ELSE 'table' END FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'",
            ).fetch_all(p).await.map_err(e)?;
            let (mut t, mut c, mut k) = (vec![], vec![], vec![]);
            for (name, kind) in names {
                let info: Vec<(String, String, i64, i64)> = sqlx::query_as(r#"SELECT name, type, "notnull", pk FROM pragma_table_info(?1)"#).bind(&name).fetch_all(p).await.map_err(e)?;
                for (col, ty, notnull, pk) in info {
                    if pk > 0 {
                        k.push(("main".into(), name.clone(), col.clone(), "PRIMARY KEY".into(), None));
                    }
                    c.push(("main".into(), name.clone(), col, ty, notnull == 0));
                }
                let fks: Vec<(String, String)> = sqlx::query_as(r#"SELECT "from", "table" FROM pragma_foreign_key_list(?1)"#).bind(&name).fetch_all(p).await.map_err(e)?;
                for (col, target) in fks {
                    k.push(("main".into(), name.clone(), col, "FOREIGN KEY".into(), Some(target)));
                }
                t.push(("main".into(), name, kind, None)); // shortcut: no row counts for SQLite (count(*) is a full scan); add on demand later
            }
            Ok(assemble(t, c, k))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sqlite_schema_has_tables_views_keys() {
        tauri::async_runtime::block_on(async {
            let file = std::env::temp_dir().join(format!("tilki-schema-{}.sqlite", std::process::id()));
            let _ = std::fs::remove_file(&file);
            let setup = SqlitePool::connect_with(SqliteConnectOptions::new().filename(&file).create_if_missing(true)).await.unwrap();
            for sql in [
                "CREATE TABLE customers (id INTEGER PRIMARY KEY, email TEXT NOT NULL)",
                "CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers(id), total REAL)",
                "CREATE VIEW v_orders AS SELECT * FROM orders",
            ] {
                sqlx::query(sql).execute(&setup).await.unwrap();
            }
            setup.close().await;

            let cfg = ConnConfig { engine: Engine::Sqlite, file: file.to_string_lossy().into(), ..Default::default() };
            let db = connect(&cfg, "").await.unwrap();
            assert!(server_version(&db).await.unwrap().starts_with("SQLite 3."));
            let schema = list_schema(&db).await.unwrap();
            let names: Vec<_> = schema.iter().map(|t| (t.name.as_str(), t.kind.as_str())).collect();
            assert_eq!(names, [("customers", "table"), ("orders", "table"), ("v_orders", "view")]);
            let orders = &schema[1].columns;
            assert!(orders[0].pk);
            assert_eq!(orders[1].fk.as_deref(), Some("customers"));
            assert!(!schema[0].columns[1].nullable, "email is NOT NULL");
            close(db).await;
            let _ = std::fs::remove_file(file);
        });
    }

    #[test]
    fn sqlite_missing_file_is_an_error_not_a_new_file() {
        tauri::async_runtime::block_on(async {
            let file = std::env::temp_dir().join("tilki-does-not-exist.sqlite");
            let cfg = ConnConfig { engine: Engine::Sqlite, file: file.to_string_lossy().into(), ..Default::default() };
            assert!(connect(&cfg, "").await.is_err());
            assert!(!file.exists());
        });
    }
}
