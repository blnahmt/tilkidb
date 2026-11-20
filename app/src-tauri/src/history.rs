// Query history: one JSON object per line in history.jsonl, newest last. Trimmed to the
// most recent KEEP entries once the file grows past TRIM_AT bytes.
use serde::{Deserialize, Serialize};
use std::{fs, io::Write, path::Path};

const KEEP: usize = 1000;
const TRIM_AT: u64 = 2 * 1024 * 1024;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub conn_id: String,
    pub conn_name: String,
    pub sql: String,
    pub at: i64, // unix ms
    pub rows: Option<u64>,
    pub ms: Option<u64>,
    pub error: Option<String>,
}

pub fn add(path: &Path, e: &Entry) -> Result<(), String> {
    let line = serde_json::to_string(e).map_err(|e| e.to_string())? + "\n";
    let mut f = fs::OpenOptions::new().create(true).append(true).open(path).map_err(|e| format!("Could not save history: {e}"))?;
    f.write_all(line.as_bytes()).map_err(|e| format!("Could not save history: {e}"))?;
    if f.metadata().map(|m| m.len() > TRIM_AT).unwrap_or(false) {
        let mut all = load(path, usize::MAX)?;
        all.truncate(KEEP);
        all.reverse();
        let text: String = all.iter().filter_map(|e| serde_json::to_string(e).ok()).map(|l| l + "\n").collect();
        let tmp = path.with_extension("jsonl.tmp");
        fs::write(&tmp, text).and_then(|_| fs::rename(&tmp, path)).map_err(|e| format!("Could not trim history: {e}"))?;
    }
    Ok(())
}

/// Newest first. Unreadable lines are skipped rather than losing the whole history.
pub fn load(path: &Path, limit: usize) -> Result<Vec<Entry>, String> {
    let text = match fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(format!("Could not read history: {e}")),
    };
    Ok(text.lines().rev().filter_map(|l| serde_json::from_str(l).ok()).take(limit).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newest_first_and_bad_lines_skipped() {
        let p = std::env::temp_dir().join(format!("tilki-hist-{}.jsonl", std::process::id()));
        let _ = fs::remove_file(&p);
        let e = |sql: &str, at| Entry { conn_id: "c".into(), conn_name: "shop".into(), sql: sql.into(), at, rows: Some(1), ms: Some(3), error: None };
        add(&p, &e("SELECT 1", 1)).unwrap();
        fs::OpenOptions::new().append(true).open(&p).unwrap().write_all(b"not json\n").unwrap();
        add(&p, &e("SELECT 2", 2)).unwrap();
        let got: Vec<_> = load(&p, 10).unwrap().into_iter().map(|e| e.sql).collect();
        assert_eq!(got, ["SELECT 2", "SELECT 1"]);
        assert_eq!(load(&p, 1).unwrap().len(), 1);
        let _ = fs::remove_file(p);
    }
}
