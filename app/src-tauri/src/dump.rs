// Built-in SQL dump: schema (CREATE statements) and/or data (batched INSERTs) for chosen tables.
// Values are quoted by the server itself — SQLite quote(), MySQL QUOTE()/HEX(), PostgreSQL
// quote_nullable() — so binary data comes out whole and escaping matches each engine exactly.
// PostgreSQL DDL is rebuilt from the catalog (columns, defaults, identity, constraints, indexes,
// sequences, views); functions, triggers, types and ownership are left to pg_dump.
use crate::db::{list_schema, Db, Table};
use crate::export::quote_ident;
use crate::query::{self, Kill, QueryEvent};
use crate::store::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::Row;
use std::{
    fs::File,
    io::{BufWriter, Write},
    path::Path,
    sync::{atomic::AtomicBool, Mutex},
    time::Instant,
};

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TableRef {
    pub schema: String,
    pub name: String,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct DumpOptions {
    pub tables: Vec<TableRef>, // tables and views to include
    pub schema: bool,
    pub data: bool,
    pub drop: bool,          // DROP … IF EXISTS before each CREATE
    pub if_not_exists: bool, // CREATE … IF NOT EXISTS
    pub single_transaction: bool,
    pub batch: usize, // rows per INSERT
}

impl Default for DumpOptions {
    fn default() -> Self {
        Self { tables: vec![], schema: true, data: true, drop: true, if_not_exists: false, single_transaction: true, batch: 500 }
    }
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DumpSummary {
    pub tables: u64,
    pub rows: u64,
    pub bytes: u64,
    pub ms: u64,
    pub cancelled: bool,
}

fn qual(engine: Engine, t: &Table) -> String {
    if engine == Engine::Sqlite { quote_ident(&t.name, engine) } else { format!("{}.{}", quote_ident(&t.schema, engine), quote_ident(&t.name, engine)) }
}

/// Name as written into the dump. MySQL schemas are databases, so a dump must not name its
/// source database: restoring into another database would otherwise DROP the original tables
/// (and MySQL can't roll DDL back). PostgreSQL schemas live inside the database and are kept.
fn out_name(engine: Engine, t: &Table) -> String {
    if engine == Engine::Mysql { quote_ident(&t.name, engine) } else { qual(engine, t) }
}

/// Insert IF NOT EXISTS after "CREATE <kind> " unless it's already there.
fn add_if_not_exists(ddl: &str, kind: &str) -> String {
    let head = format!("CREATE {kind} ");
    match ddl.get(..head.len()) {
        Some(h) if h.eq_ignore_ascii_case(&head) && !ddl[head.len()..].trim_start().to_ascii_uppercase().starts_with("IF NOT EXISTS") => format!("{head}IF NOT EXISTS {}", &ddl[head.len()..]),
        _ => ddl.to_string(),
    }
}

fn mysql_binary(data_type: &str) -> bool {
    let t = data_type.to_ascii_lowercase();
    ["binary", "varbinary", "blob", "tinyblob", "mediumblob", "longblob", "bit", "geometry", "point", "linestring", "polygon"].iter().any(|b| t.starts_with(b))
}

/// Columns the server computes (GENERATED ... STORED / VIRTUAL); they can't appear in an INSERT.
async fn generated_columns(db: &Db, t: &Table) -> Result<Vec<String>, String> {
    let e = |e: sqlx::Error| e.to_string();
    match db {
        Db::Pg(p) => sqlx::query_scalar("SELECT attname::text FROM pg_attribute WHERE attrelid = $1::regclass AND attnum > 0 AND attgenerated <> ''")
            .bind(qual(Engine::Postgres, t)).fetch_all(p).await.map_err(e),
        // EXTRA says VIRTUAL / STORED GENERATED (MariaDB: PERSISTENT); DEFAULT_GENERATED is an ordinary default
        Db::My(p) => sqlx::query_scalar("SELECT CAST(column_name AS CHAR) FROM information_schema.columns WHERE table_schema = ? AND table_name = ? AND extra REGEXP 'VIRTUAL|STORED|PERSISTENT'")
            .bind(&t.schema).bind(&t.name).fetch_all(p).await.map_err(e),
        Db::Lite(_) => Ok(vec![]), // PRAGMA table_info already leaves generated columns out
    }
}

/// PostgreSQL enum types used by the dumped tables. Domains and composite types are left to pg_dump.
async fn pg_enums(p: &sqlx::PgPool, tables: &[&Table], o: &DumpOptions, out: &mut Out) -> Result<(), String> {
    let names: Vec<String> = tables.iter().map(|t| qual(Engine::Postgres, t)).collect();
    let rows: Vec<(String, String, Vec<String>)> = sqlx::query_as(
        "SELECT n.nspname::text, t.typname::text, array_agg(e.enumlabel::text ORDER BY e.enumsortorder)
         FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace JOIN pg_enum e ON e.enumtypid = t.oid
         WHERE t.oid IN (SELECT CASE WHEN ty.typelem <> 0 AND ty.typcategory = 'A' THEN ty.typelem ELSE ty.oid END
                         FROM pg_attribute a JOIN pg_type ty ON ty.oid = a.atttypid
                         WHERE a.attrelid = ANY (SELECT x::regclass FROM unnest($1::text[]) x) AND a.attnum > 0 AND NOT a.attisdropped)
         GROUP BY 1, 2 ORDER BY 1, 2",
    ).bind(&names).fetch_all(p).await.map_err(|e| e.to_string())?;
    for (schema, name, labels) in rows {
        let q = format!("{}.{}", quote_ident(&schema, Engine::Postgres), quote_ident(&name, Engine::Postgres));
        let list = labels.iter().map(|l| format!("'{}'", l.replace('\'', "''"))).collect::<Vec<_>>().join(", ");
        out.line(&format!("
-- Type {name}"))?;
        if o.drop {
            out.line(&format!("DROP TYPE IF EXISTS {q} CASCADE;
CREATE TYPE {q} AS ENUM ({list});"))?;
        } else {
            out.line(&format!("DO $$ BEGIN CREATE TYPE {q} AS ENUM ({list}); EXCEPTION WHEN duplicate_object THEN NULL; END $$;"))?;
        }
    }
    Ok(())
}

/// SELECT that returns every column as a ready SQL literal (text).
fn quoting_select(engine: Engine, t: &Table) -> String {
    let cols: Vec<String> = t.columns.iter().map(|c| {
        let q = quote_ident(&c.name, engine);
        match engine {
            Engine::Sqlite => format!("quote({q})"),
            Engine::Postgres => format!("quote_nullable({q}::text)"),
            // BIT: HEX(b'0') is '0' (odd length, not a valid X'' literal), so write b'...' instead
            Engine::Mysql if c.data_type.to_ascii_lowercase().starts_with("bit") => format!("IF({q} IS NULL, 'NULL', CONCAT('b''', BIN({q}), ''''))"),
            Engine::Mysql if mysql_binary(&c.data_type) => format!("IF({q} IS NULL, 'NULL', CONCAT('X''', HEX({q}), ''''))"),
            Engine::Mysql => format!("QUOTE({q})"),
        }
    }).collect();
    format!("SELECT {} FROM {}", cols.join(", "), qual(engine, t))
}

/// Dump output: a file, or (w = None) collected in `text` for the structure view.
struct Out {
    w: Option<BufWriter<File>>,
    text: String,
    bytes: u64,
}

impl Out {
    fn line(&mut self, s: &str) -> Result<(), String> {
        self.bytes += s.len() as u64 + 1;
        let Some(w) = self.w.as_mut() else { self.text.push_str(s); self.text.push('\n'); return Ok(()) };
        w.write_all(s.as_bytes()).and_then(|_| w.write_all(b"\n")).map_err(|e| format!("Write failed: {e}"))
    }
}

/// The CREATE statement(s) for one table or view, built the same way a dump builds them.
pub async fn table_ddl(db: &Db, t: &Table) -> Result<String, String> {
    let o = DumpOptions { schema: true, data: false, drop: false, single_transaction: false, ..Default::default() };
    let mut out = Out { w: None, text: String::new(), bytes: 0 };
    match db {
        Db::Pg(p) => {
            if t.kind != "view" { pg_enums(p, &[t], &o, &mut out).await?; }
            let mut extra = PgExtra { fks: vec![], indexes: vec![], setvals: vec![] };
            pg_ddl(p, t, &o, &mut out, &mut extra).await?;
            for l in extra.indexes.iter().chain(&extra.fks) { out.line(l)?; }
        }
        Db::My(p) => mysql_ddl(p, t, &o, &mut out).await?,
        Db::Lite(p) => {
            let mut after = vec![];
            sqlite_ddl(p, t, &o, &mut out, &mut after).await?;
            for l in &after { out.line(l)?; }
        }
    }
    Ok(out.text.trim().to_string())
}

struct PgExtra {
    fks: Vec<String>,
    indexes: Vec<String>,
    setvals: Vec<String>,
}

async fn pg_ddl(p: &sqlx::PgPool, t: &Table, o: &DumpOptions, out: &mut Out, extra: &mut PgExtra) -> Result<(), String> {
    let e = |e: sqlx::Error| e.to_string();
    let q = qual(Engine::Postgres, t);
    if t.kind == "view" {
        let def: String = sqlx::query_scalar("SELECT pg_get_viewdef($1::regclass, true)").bind(&q).fetch_one(p).await.map_err(e)?;
        if o.drop { out.line(&format!("DROP VIEW IF EXISTS {q} CASCADE;"))?; }
        return out.line(&format!("CREATE OR REPLACE VIEW {q} AS\n{}", def.trim()));
    }
    let cols: Vec<(String, String, bool, Option<String>, String)> = sqlx::query_as(
        "SELECT a.attname::text, format_type(a.atttypid, a.atttypmod), a.attnotnull, pg_get_expr(d.adbin, d.adrelid), a.attidentity::text || a.attgenerated::text
         FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
         WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum",
    ).bind(&q).fetch_all(p).await.map_err(e)?;
    let mut lines = Vec::new();
    // after the data, each sequence continues from the highest id (or starts at 1 on an empty table)
    let setval = |seq: String, col: &str| format!("SELECT setval({seq}, COALESCE((SELECT max({c}) FROM {q}), 1), (SELECT max({c}) FROM {q}) IS NOT NULL);", c = quote_ident(col, Engine::Postgres));
    let lit = |s: &str| format!("'{}'", s.replace('\'', "''"));
    for (name, ty, notnull, default, identity) in &cols {
        let mut l = format!("  {} {ty}", quote_ident(name, Engine::Postgres));
        if identity == "a" || identity == "d" { extra.setvals.push(setval(format!("pg_get_serial_sequence({}, {})", lit(&q), lit(name)), name)); }
        match identity.as_str() {
            "a" => l += " GENERATED ALWAYS AS IDENTITY",
            "s" => l += &format!(" GENERATED ALWAYS AS ({}) STORED", default.as_deref().unwrap_or("NULL")), // attgenerated
            "d" => l += " GENERATED BY DEFAULT AS IDENTITY",
            _ => {
                if let Some(d) = default {
                    // serial columns: the sequence must exist first, and gets its value back after the data
                    if let Some(seq) = d.strip_prefix("nextval('").and_then(|r| r.split("'::regclass)").next()) {
                        out.line(&format!("CREATE SEQUENCE IF NOT EXISTS {seq};"))?;
                        extra.setvals.push(setval(format!("'{seq}'"), name));
                    }
                    l += &format!(" DEFAULT {d}");
                }
            }
        }
        if *notnull { l += " NOT NULL"; }
        lines.push(l);
    }
    let cons: Vec<(String, String, String)> = sqlx::query_as("SELECT conname::text, pg_get_constraintdef(oid), contype::text FROM pg_constraint WHERE conrelid = $1::regclass ORDER BY contype, conname")
        .bind(&q).fetch_all(p).await.map_err(e)?;
    for (name, def, kind) in cons {
        if kind == "f" {
            extra.fks.push(format!("ALTER TABLE {q} ADD CONSTRAINT {} {def};", quote_ident(&name, Engine::Postgres)));
        } else {
            lines.push(format!("  CONSTRAINT {} {def}", quote_ident(&name, Engine::Postgres)));
        }
    }
    let idx: Vec<String> = sqlx::query_scalar("SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 AND indexname NOT IN (SELECT conname FROM pg_constraint WHERE conrelid = $3::regclass)")
        .bind(&t.schema).bind(&t.name).bind(&q).fetch_all(p).await.map_err(e)?;
    extra.indexes.extend(idx.into_iter().map(|i| format!("{};", if o.if_not_exists { add_if_not_exists(&add_if_not_exists(&i, "INDEX"), "UNIQUE INDEX") } else { i })));
    if o.drop { out.line(&format!("DROP TABLE IF EXISTS {q} CASCADE;"))?; }
    out.line(&format!("CREATE TABLE {}{q} (\n{}\n);", if o.if_not_exists { "IF NOT EXISTS " } else { "" }, lines.join(",\n")))
}

async fn mysql_ddl(p: &sqlx::MySqlPool, t: &Table, o: &DumpOptions, out: &mut Out) -> Result<(), String> {
    let q = out_name(Engine::Mysql, t);
    let view = t.kind == "view";
    let row = sqlx::query(&format!("SHOW CREATE {} {}", if view { "VIEW" } else { "TABLE" }, qual(Engine::Mysql, t))).fetch_one(p).await.map_err(|e| e.to_string())?;
    let mut ddl = row.try_get::<String, _>(1).or_else(|_| row.try_get::<Vec<u8>, _>(1).map(|b| String::from_utf8_lossy(&b).into_owned())).map_err(|e| e.to_string())?;
    if view {
        // DEFINER=`user`@`host` breaks restores on other servers; drop it like most tools do
        if let Some(s) = ddl.find("DEFINER=") { if let Some(sp) = ddl[s..].find(' ') { ddl.replace_range(s..s + sp + 1, ""); } }
        ddl = ddl.replace(&format!("{}.", quote_ident(&t.schema, Engine::Mysql)), ""); // view bodies name the source database too
        if o.drop { out.line(&format!("DROP VIEW IF EXISTS {q};"))?; }
        return out.line(&format!("{ddl};"));
    }
    if o.drop { out.line(&format!("DROP TABLE IF EXISTS {q};"))?; }
    out.line(&format!("{};", if o.if_not_exists { add_if_not_exists(&ddl, "TABLE") } else { ddl }))
}

/// SQLite: the original CREATE statements from sqlite_master. Indexes and triggers go after the data.
async fn sqlite_ddl(p: &sqlx::SqlitePool, t: &Table, o: &DumpOptions, out: &mut Out, after: &mut Vec<String>) -> Result<(), String> {
    let rows: Vec<(String, String)> = sqlx::query_as("SELECT type, sql FROM sqlite_master WHERE tbl_name = ?1 AND sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'view' THEN 0 ELSE 1 END, rowid")
        .bind(&t.name).fetch_all(p).await.map_err(|e| e.to_string())?;
    let q = qual(Engine::Sqlite, t);
    for (kind, sql) in rows {
        let k = kind.to_ascii_uppercase();
        let sql = if o.if_not_exists { add_if_not_exists(&add_if_not_exists(&sql, &k), &format!("UNIQUE {k}")) } else { sql };
        match kind.as_str() {
            "table" | "view" => {
                if o.drop { out.line(&format!("DROP {k} IF EXISTS {q};"))?; }
                out.line(&format!("{sql};"))?;
            }
            _ => after.push(format!("{sql};")),
        }
    }
    Ok(())
}

pub async fn dump(db: &Db, conn_name: &str, path: &Path, o: &DumpOptions, cancel: &AtomicBool, register: &(dyn Fn(Kill) + Sync), progress: &(dyn Fn(u64, u64, &str) + Sync)) -> Result<DumpSummary, String> {
    let started = Instant::now();
    let engine = db.engine();
    let all = list_schema(db).await?;
    let tables: Vec<Table> = o.tables.iter().filter_map(|r| all.iter().find(|t| t.schema == r.schema && t.name == r.name)).cloned().collect();
    if tables.is_empty() { return Err("Pick at least one table.".into()); }
    let file = File::create(path).map_err(|e| format!("Could not create {}: {e}", path.display()))?;
    let mut out = Out { w: Some(BufWriter::new(file)), text: String::new(), bytes: 0 };
    let (base, views): (Vec<&Table>, Vec<&Table>) = tables.iter().partition(|t| t.kind != "view");
    let total = tables.len() as u64;

    out.line(&format!("-- Tilki DB dump of {conn_name} ({})", match engine { Engine::Postgres => "PostgreSQL", Engine::Mysql => "MySQL", Engine::Sqlite => "SQLite" }))?;
    out.line(&format!("-- {} tables{}{}\n", base.len(), if o.schema { ", schema" } else { "" }, if o.data { ", data" } else { "" }))?;
    match engine {
        Engine::Sqlite => out.line("PRAGMA foreign_keys = OFF;")?,
        Engine::Mysql => out.line("SET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS = 0;")?,
        Engine::Postgres => out.line("SET client_encoding = 'UTF8';")?,
    }
    if o.single_transaction { out.line("BEGIN;")?; }

    let mut pg = PgExtra { fks: vec![], indexes: vec![], setvals: vec![] };
    let mut lite_after = vec![];
    if o.schema {
        if let Db::Pg(p) = db { pg_enums(p, &base, o, &mut out).await?; }
    }
    if o.schema && engine == Engine::Postgres {
        let mut schemas: Vec<&str> = tables.iter().map(|t| t.schema.as_str()).filter(|s| *s != "public").collect();
        schemas.sort();
        schemas.dedup();
        for s in schemas { out.line(&format!("CREATE SCHEMA IF NOT EXISTS {};", quote_ident(s, engine)))?; }
    }
    if o.schema {
        for t in &base {
            out.line(&format!("\n-- Table {}", t.name))?;
            match db {
                Db::Pg(p) => pg_ddl(p, t, o, &mut out, &mut pg).await?,
                Db::My(p) => mysql_ddl(p, t, o, &mut out).await?,
                Db::Lite(p) => sqlite_ddl(p, t, o, &mut out, &mut lite_after).await?,
            }
        }
    }
    let mut rows_total = 0u64;
    let mut cancelled = false;
    if o.data {
        for (i, t) in base.iter().enumerate() {
            progress(i as u64, total, &t.name);
            let skip = generated_columns(db, t).await?; // computed by the server; INSERTs may not set them
            let t = &Table { columns: t.columns.iter().filter(|c| !skip.contains(&c.name)).cloned().collect(), ..(*t).clone() };
            let cols = t.columns.iter().map(|c| quote_ident(&c.name, engine)).collect::<Vec<_>>().join(", ");
            // PostgreSQL: explicit values for GENERATED ALWAYS identity columns need this (harmless elsewhere)
            let head = format!("INSERT INTO {} ({cols}){} VALUES", out_name(engine, t), if engine == Engine::Postgres { " OVERRIDING SYSTEM VALUE" } else { "" });
            out.line(&format!("\n-- Data {}", t.name))?;
            let shared = Mutex::new((&mut out, Vec::<String>::new(), 0u64, None::<String>));
            let flush = |s: &mut (&mut Out, Vec<String>, u64, Option<String>)| {
                if s.1.is_empty() { return; }
                let stmt = format!("{head}\n{};", s.1.join(",\n"));
                s.1.clear();
                if let Err(e) = s.0.line(&stmt) { s.3 = Some(e); }
            };
            let send = |ev: QueryEvent| {
                let mut s = shared.lock().unwrap();
                if let QueryEvent::Rows { rows } = ev {
                    for r in rows {
                        let vals: Vec<String> = r.into_iter().map(|v| match v { Value::String(s) => s, Value::Null => "NULL".into(), other => other.to_string() }).collect();
                        s.1.push(format!("  ({})", vals.join(", ")));
                        s.2 += 1;
                        if s.1.len() >= o.batch.max(1) { flush(&mut s); }
                    }
                }
                s.3.is_none()
            };
            let summary = query::run(db, &quoting_select(engine, t), u64::MAX, cancel, register, &send).await?;
            let mut s = shared.into_inner().unwrap();
            flush(&mut s);
            if let Some(e) = s.3 { return Err(e); }
            rows_total += s.2;
            if summary.cancelled { cancelled = true; break; }
        }
    }
    if !cancelled {
        let tail: Vec<String> = match engine {
            Engine::Postgres => [pg.indexes, if o.schema { pg.fks } else { vec![] }, if o.data { pg.setvals } else { vec![] }].concat(),
            Engine::Sqlite => lite_after,
            Engine::Mysql => vec![],
        };
        if !tail.is_empty() { out.line("")?; }
        for l in tail { out.line(&l)?; }
        if o.schema {
            for v in &views {
                out.line(&format!("\n-- View {}", v.name))?;
                match db {
                    Db::Pg(p) => pg_ddl(p, v, o, &mut out, &mut PgExtra { fks: vec![], indexes: vec![], setvals: vec![] }).await?,
                    Db::My(p) => mysql_ddl(p, v, o, &mut out).await?,
                    Db::Lite(p) => sqlite_ddl(p, v, o, &mut out, &mut vec![]).await?,
                }
            }
        }
        if o.single_transaction { out.line("\nCOMMIT;")?; }
        match engine {
            Engine::Sqlite => out.line("PRAGMA foreign_keys = ON;")?,
            Engine::Mysql => out.line("SET FOREIGN_KEY_CHECKS = 1;")?,
            Engine::Postgres => {}
        }
    }
    if let Some(w) = out.w.as_mut() { w.flush().map_err(|e| format!("Write failed: {e}"))?; }
    drop(out);
    if cancelled { let _ = std::fs::remove_file(path); }
    progress(total, total, "");
    Ok(DumpSummary { tables: base.len() as u64, rows: rows_total, bytes: std::fs::metadata(path).map(|m| m.len()).unwrap_or(0), ms: started.elapsed().as_millis() as u64, cancelled })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::restore::{restore, tests::{empty_db, scalar}};

    async fn sample(name: &str) -> (Db, std::path::PathBuf) {
        let (db, f) = empty_db(name).await;
        let Db::Lite(p) = &db else { unreachable!() };
        sqlx::raw_sql(
            "CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, note TEXT, photo BLOB);
             CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers(id), total REAL);
             CREATE INDEX idx_orders_customer ON orders(customer_id);
             CREATE VIEW v_totals AS SELECT customer_id, sum(total) AS s FROM orders GROUP BY customer_id;
             INSERT INTO customers VALUES (1, 'Deniz Öztürk', 'it''s; \"quoted\"', x'00ff10'), (2, 'Lena', NULL, NULL);
             INSERT INTO orders VALUES (1, 1, 54.4), (2, 1, 10.0), (3, 2, 39.9);",
        ).execute(p).await.unwrap();
        (db, f)
    }

    fn refs() -> Vec<TableRef> {
        ["customers", "orders", "v_totals"].iter().map(|n| TableRef { schema: "main".into(), name: n.to_string() }).collect()
    }

    #[test]
    fn dump_then_restore_gives_the_same_database() {
        tauri::async_runtime::block_on(async {
            let (src, sf) = sample("dump-src1").await;
            let path = std::env::temp_dir().join(format!("tilki-{}-dump.sql", std::process::id()));
            let o = DumpOptions { tables: refs(), batch: 2, ..Default::default() };
            let s = dump(&src, "src", &path, &o, &AtomicBool::new(false), &|_| {}, &|_, _, _| {}).await.unwrap();
            assert_eq!((s.tables, s.rows), (2, 5));
            let text = std::fs::read_to_string(&path).unwrap();
            assert!(text.contains("X'00FF10'"), "blobs are dumped whole as hex literals:\n{text}");
            assert!(text.contains("'it''s; \"quoted\"'"));
            assert!(text.contains("CREATE INDEX idx_orders_customer"));
            assert!(text.contains("CREATE VIEW v_totals"));

            let (dst, df) = empty_db("dump-dst").await;
            let r = restore(&dst, &path, true, true, &AtomicBool::new(false), &|_, _| {}).await.unwrap();
            assert_eq!(r.failed, 0);
            for sql in [
                "SELECT count(*) FROM customers", "SELECT count(*) FROM orders",
                "SELECT count(*) FROM customers WHERE name = 'Deniz Öztürk' AND note = 'it''s; \"quoted\"' AND photo = x'00ff10'",
                "SELECT count(*) FROM customers WHERE id = 2 AND note IS NULL AND photo IS NULL",
                "SELECT CAST(round(sum(total) * 10) AS INTEGER) FROM orders",
                "SELECT count(*) FROM sqlite_master WHERE name IN ('idx_orders_customer', 'v_totals')",
                "SELECT CAST(s * 10 AS INTEGER) FROM v_totals WHERE customer_id = 1",
            ] {
                assert_eq!(scalar(&src, sql).await, scalar(&dst, sql).await, "{sql}");
            }
            for f in [sf, df, path] { let _ = std::fs::remove_file(f); }
        });
    }

    #[test]
    fn schema_only_and_data_only() {
        tauri::async_runtime::block_on(async {
            let (src, sf) = sample("dump-src2").await;
            let path = std::env::temp_dir().join(format!("tilki-{}-dump2.sql", std::process::id()));
            let schema_only = DumpOptions { tables: refs(), data: false, ..Default::default() };
            dump(&src, "src", &path, &schema_only, &AtomicBool::new(false), &|_| {}, &|_, _, _| {}).await.unwrap();
            let t = std::fs::read_to_string(&path).unwrap();
            assert!(t.contains("CREATE TABLE customers") && !t.contains("INSERT INTO"));
            let data_only = DumpOptions { tables: refs(), schema: false, ..Default::default() };
            dump(&src, "src", &path, &data_only, &AtomicBool::new(false), &|_| {}, &|_, _, _| {}).await.unwrap();
            let t = std::fs::read_to_string(&path).unwrap();
            assert!(!t.contains("CREATE TABLE") && t.contains("INSERT INTO \"orders\""));
            for f in [sf, path] { let _ = std::fs::remove_file(f); }
        });
    }

    #[test]
    fn mysql_dumps_never_name_the_source_database() {
        let t = Table { schema: "shop".into(), name: "customers".into(), kind: "table".into(), rows: None, columns: vec![] };
        assert_eq!(out_name(Engine::Mysql, &t), "`customers`", "restoring into another database must not touch `shop`");
        assert_eq!(out_name(Engine::Postgres, &Table { schema: "sales".into(), ..t }), "\"sales\".\"customers\"");
    }

    #[test]
    fn if_not_exists_is_added_once() {
        assert_eq!(add_if_not_exists("CREATE TABLE t (a int)", "TABLE"), "CREATE TABLE IF NOT EXISTS t (a int)");
        assert_eq!(add_if_not_exists("create table if not exists t (a int)", "TABLE"), "create table if not exists t (a int)");
        assert_eq!(add_if_not_exists("CREATE UNIQUE INDEX i ON t(a)", "INDEX"), "CREATE UNIQUE INDEX i ON t(a)", "other kinds untouched");
    }
}
