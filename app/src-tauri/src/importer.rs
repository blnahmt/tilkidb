// Bring saved connections over from other tools: DBeaver (data-sources.json), Beekeeper Studio
// (app.db) and PostgreSQL's pgpass file. Only pgpass carries passwords in the clear; the others
// keep them encrypted, so those come in without one (the user types it on first connect).
use crate::store::{ConnConfig, Engine};
use serde::Serialize;
use serde_json::Value;
use sqlx::Row;
use std::path::PathBuf;

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Imported {
    pub cfg: ConnConfig,
    pub password: Option<String>,
}

/// Where each tool keeps its connections on this machine.
pub fn default_path(kind: &str) -> Option<PathBuf> {
    let appdata = std::env::var_os("APPDATA").map(PathBuf::from).or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))?;
    Some(match kind {
        "dbeaver" => appdata.join("DBeaverData").join("workspace6").join("General").join(".dbeaver").join("data-sources.json"),
        "beekeeper" => appdata.join("beekeeper-studio").join("app.db"),
        "pgpass" if cfg!(windows) => appdata.join("postgresql").join("pgpass.conf"),
        "pgpass" => PathBuf::from(std::env::var_os("HOME")?).join(".pgpass"),
        _ => return None,
    })
}

fn base(engine: Engine, name: &str) -> ConnConfig {
    let port = match engine { Engine::Postgres => 5432, Engine::Mysql => 3306, Engine::Sqlite => 0 };
    let user = match engine { Engine::Postgres => "postgres", Engine::Mysql => "root", Engine::Sqlite => "" };
    ConnConfig { name: name.to_string(), engine, port, user: user.into(), ..Default::default() }
}

fn engine_of(s: &str) -> Option<Engine> {
    let s = s.to_ascii_lowercase();
    if s.contains("postgres") || s.contains("cockroach") || s.contains("redshift") { Some(Engine::Postgres) }
    else if s.contains("mysql") || s.contains("maria") { Some(Engine::Mysql) }
    else if s.contains("sqlite") { Some(Engine::Sqlite) }
    else { None }
}

pub fn parse_dbeaver(text: &str) -> Result<Vec<Imported>, String> {
    let v: Value = serde_json::from_str(text).map_err(|e| format!("Not a DBeaver data-sources.json file: {e}"))?;
    let conns = v["connections"].as_object().ok_or("No connections in this DBeaver file.")?;
    let mut out = vec![];
    for c in conns.values() {
        let Some(engine) = engine_of(&format!("{} {}", c["provider"].as_str().unwrap_or(""), c["driver"].as_str().unwrap_or(""))) else { continue };
        let conf = &c["configuration"];
        let s = |k: &str| conf[k].as_str().unwrap_or("").to_string();
        let mut cfg = base(engine, c["name"].as_str().unwrap_or("DBeaver connection"));
        if engine == Engine::Sqlite {
            cfg.file = if s("database").is_empty() { s("url").trim_start_matches("jdbc:sqlite:").to_string() } else { s("database") };
        } else {
            cfg.host = if s("host").is_empty() { "localhost".into() } else { s("host") };
            if let Some(p) = conf["port"].as_str().and_then(|p| p.parse().ok()).or(conf["port"].as_u64().map(|p| p as u16)) { cfg.port = p; }
            cfg.database = s("database");
            if !s("user").is_empty() { cfg.user = s("user"); }
        }
        cfg.folder = c["folder"].as_str().unwrap_or("").to_string();
        cfg.read_only = c["read-only"].as_bool().unwrap_or(false);
        cfg.prod = conf["type"].as_str() == Some("prod");
        out.push(Imported { cfg, password: None });
    }
    Ok(out)
}

/// pgpass lines: host:port:database:user:password, with \: and \\ escapes; * is a wildcard.
pub fn parse_pgpass(text: &str) -> Vec<Imported> {
    let mut out = vec![];
    for line in text.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')) {
        let mut parts: Vec<String> = vec![String::new()];
        let mut chars = line.chars();
        while let Some(ch) = chars.next() {
            match ch {
                '\\' => { if let Some(n) = chars.next() { parts.last_mut().unwrap().push(n); } }
                ':' if parts.len() < 5 => parts.push(String::new()),
                _ => parts.last_mut().unwrap().push(ch),
            }
        }
        if parts.len() != 5 || parts[0] == "*" || parts[3] == "*" { continue; } // a wildcard host or user isn't a connection
        let db = if parts[2] == "*" { String::new() } else { parts[2].clone() };
        let mut cfg = base(Engine::Postgres, &format!("{}@{}{}", parts[3], parts[0], if db.is_empty() { String::new() } else { format!("/{db}") }));
        cfg.host = parts[0].clone();
        cfg.port = parts[1].parse().unwrap_or(5432);
        cfg.database = db;
        cfg.user = parts[3].clone();
        out.push(Imported { cfg, password: Some(parts[4].clone()) });
    }
    out
}

async fn read_beekeeper(path: &PathBuf) -> Result<Vec<Imported>, String> {
    let o = sqlx::sqlite::SqliteConnectOptions::new().filename(path).read_only(true);
    let pool = sqlx::SqlitePool::connect_with(o).await.map_err(|e| format!("Could not open {}: {e}", path.display()))?;
    let rows = sqlx::query("SELECT * FROM saved_connection").fetch_all(&pool).await.map_err(|e| format!("Not a Beekeeper Studio database: {e}"))?;
    pool.close().await;
    let mut out = vec![];
    for r in rows {
        let s = |k: &str| r.try_get::<Option<String>, _>(k).ok().flatten().unwrap_or_default();
        let Some(engine) = engine_of(&s("connectionType")) else { continue };
        let mut cfg = base(engine, &if s("name").is_empty() { "Beekeeper connection".into() } else { s("name") });
        if engine == Engine::Sqlite { cfg.file = s("defaultDatabase"); } else {
            cfg.host = if s("host").is_empty() { "localhost".into() } else { s("host") };
            if let Ok(Some(p)) = r.try_get::<Option<i64>, _>("port") { cfg.port = p as u16; }
            if !s("username").is_empty() { cfg.user = s("username"); }
            cfg.database = s("defaultDatabase");
        }
        cfg.read_only = r.try_get::<Option<bool>, _>("readOnlyMode").ok().flatten().unwrap_or(false);
        out.push(Imported { cfg, password: None });
    }
    Ok(out)
}

pub async fn import(kind: &str, path: Option<String>) -> Result<Vec<Imported>, String> {
    let path = match path { Some(p) => PathBuf::from(p), None => default_path(kind).ok_or("Unknown source.")? };
    if !path.exists() { return Err(format!("Nothing found at {}.", path.display())); }
    match kind {
        "beekeeper" => read_beekeeper(&path).await,
        "dbeaver" | "pgpass" => {
            let text = std::fs::read_to_string(&path).map_err(|e| format!("Could not read {}: {e}", path.display()))?;
            if kind == "dbeaver" { parse_dbeaver(&text) } else { Ok(parse_pgpass(&text)) }
        }
        _ => Err("Unknown source.".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pgpass_lines() {
        let got = parse_pgpass("# comment\ndb.example.com:5432:sales:ana:p\\:w\\\\d\n*:*:*:x:y\nlocalhost:6543:*:bob:secret:with:colons\n");
        assert_eq!(got.len(), 2);
        assert_eq!((got[0].cfg.name.as_str(), got[0].cfg.database.as_str(), got[0].password.as_deref()), ("ana@db.example.com/sales", "sales", Some("p:w\\d")));
        assert_eq!((got[1].cfg.port, got[1].cfg.database.as_str(), got[1].password.as_deref()), (6543, "", Some("secret:with:colons")));
    }

    #[test]
    fn dbeaver_file() {
        let json = r#"{"folders":{},"connections":{
            "postgres-jdbc-1":{"provider":"postgresql","driver":"postgres-jdbc","name":"Prod DB","folder":"Customers","read-only":true,
              "configuration":{"host":"pg.local","port":"5433","database":"app","user":"ana","type":"prod"}},
            "mysql8-1":{"provider":"mysql","driver":"mariaDB","name":"Maria","configuration":{"host":"m.local","port":"3307","database":"shop"}},
            "sqlite-1":{"provider":"sqlite","driver":"sqlite_jdbc","name":"Local","configuration":{"database":"C:\\data\\a.db"}},
            "mongo-1":{"provider":"mongodb","name":"skip me","configuration":{}}}}"#;
        let got = parse_dbeaver(json).unwrap();
        assert_eq!(got.len(), 3);
        let pg = got.iter().find(|i| i.cfg.name == "Prod DB").unwrap();
        assert_eq!((pg.cfg.engine, pg.cfg.port, pg.cfg.user.as_str(), pg.cfg.folder.as_str(), pg.cfg.prod, pg.cfg.read_only), (Engine::Postgres, 5433, "ana", "Customers", true, true));
        assert_eq!(got.iter().find(|i| i.cfg.name == "Maria").unwrap().cfg.engine, Engine::Mysql);
        assert_eq!(got.iter().find(|i| i.cfg.name == "Local").unwrap().cfg.file, "C:\\data\\a.db");
    }
}
