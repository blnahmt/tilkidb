// Saved connections and tags, kept as JSON in the app config folder.
// Passwords never go here; they live in the OS keychain (secrets.rs).
use serde::{Deserialize, Serialize};
use std::{fs, io, path::Path};

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum Engine {
    #[default]
    Postgres,
    Mysql,
    Sqlite,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum SslMode {
    Disable,
    #[default]
    Prefer,
    Require,
    VerifyFull,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum SshAuth {
    #[default]
    Key,
    Password,
    Agent,
}

/// SSH tunnel settings. The SSH password / key passphrase is in the keychain under "<id>:ssh".
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SshConfig {
    pub enabled: bool,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: SshAuth,
    pub key_file: String,
}

impl Default for SshConfig {
    fn default() -> Self {
        Self { enabled: false, host: String::new(), port: 22, user: String::new(), auth: SshAuth::Key, key_file: "~/.ssh/id_ed25519".into() }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ConnConfig {
    pub id: String,
    pub name: String,
    pub engine: Engine,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub user: String,
    pub file: String, // SQLite only
    pub ssl: SslMode,
    pub tag: String,
    pub color: String,
    pub prod: bool,
    pub read_only: bool,
    pub ssh: SshConfig,
    pub ssl_ca: String,   // CA certificate file (verify the server)
    pub ssl_cert: String, // client certificate file
    pub ssl_key: String,  // client key file
    pub folder: String,   // groups connections in the picker
}

impl Default for ConnConfig {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            engine: Engine::Postgres,
            host: "localhost".into(),
            port: 5432,
            database: String::new(),
            user: String::new(),
            file: String::new(),
            ssl: SslMode::Prefer,
            tag: String::new(),
            color: "#3fbf7f".into(),
            prod: false,
            read_only: false,
            ssh: SshConfig::default(),
            ssl_ca: String::new(),
            ssl_cert: String::new(),
            ssl_key: String::new(),
            folder: String::new(),
        }
    }
}

/// A saved query. `conn_id` is the connection it was saved from ("" = any).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SavedQuery {
    pub id: String,
    pub name: String,
    pub sql: String,
    pub conn_id: String,
    pub updated: i64, // unix ms
}

/// A notebook: SQL and Markdown cells. Results are not stored.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Notebook {
    pub id: String,
    pub name: String,
    pub cells: Vec<Cell>,
    pub updated: i64, // unix ms
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(default)]
pub struct Cell {
    pub id: String,
    pub kind: String, // "sql" | "md"
    pub src: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default)]
pub struct Store {
    pub connections: Vec<ConnConfig>,
    pub tags: Vec<String>,
    pub saved: Vec<SavedQuery>, // older files without it load as empty
    pub notebooks: Vec<Notebook>,
}

impl Default for Store {
    fn default() -> Self {
        Self { connections: vec![], tags: vec!["Development".into(), "Staging".into(), "Production".into()], saved: vec![], notebooks: vec![] }
    }
}

impl Store {
    /// A missing file means a fresh install. A damaged file is an error, never silently replaced.
    pub fn load(path: &Path) -> Result<Store, String> {
        match fs::read_to_string(path) {
            Ok(text) => serde_json::from_str(&text)
                .map_err(|e| format!("{} is damaged ({e}). Fix or move it, then restart Tilki DB.", path.display())),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Store::default()),
            Err(e) => Err(format!("Could not read {}: {e}", path.display())),
        }
    }

    /// Write to a temp file and rename, so a crash mid-write can't corrupt the list.
    pub fn save(&self, path: &Path) -> Result<(), String> {
        let json = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, json).and_then(|_| fs::rename(&tmp, path)).map_err(|e| format!("Could not save connections: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("tilki-test-{}-{name}", std::process::id()));
        let _ = fs::remove_file(&p);
        p
    }

    #[test]
    fn missing_file_gives_default_tags() {
        let s = Store::load(&temp("missing.json")).unwrap();
        assert!(s.connections.is_empty());
        assert_eq!(s.tags, ["Development", "Staging", "Production"]);
    }

    #[test]
    fn save_then_load_round_trips() {
        let p = temp("roundtrip.json");
        let mut s = Store::default();
        s.connections.push(ConnConfig { id: "a".into(), name: "shop".into(), engine: Engine::Mysql, tag: "Customer A".into(), prod: true, ..Default::default() });
        s.tags.push("Customer A".into());
        s.save(&p).unwrap();
        assert_eq!(Store::load(&p).unwrap(), s);
        let _ = fs::remove_file(p);
    }

    #[test]
    fn files_from_before_saved_queries_still_load() {
        let p = temp("old.json");
        fs::write(&p, r#"{"connections":[],"tags":["Development"]}"#).unwrap();
        let s = Store::load(&p).unwrap();
        assert!(s.saved.is_empty());
        assert_eq!(s.tags, ["Development"]);
        let _ = fs::remove_file(p);
    }

    #[test]
    fn damaged_file_is_an_error_and_left_alone() {
        let p = temp("damaged.json");
        fs::write(&p, "{ not json").unwrap();
        assert!(Store::load(&p).unwrap_err().contains("damaged"));
        assert_eq!(fs::read_to_string(&p).unwrap(), "{ not json");
        let _ = fs::remove_file(p);
    }
}
