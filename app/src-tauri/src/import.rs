// Import a CSV/TSV, JSON array or JSON Lines file into an existing table. Each file column maps
// to a target column (or is skipped); the whole import is one transaction of batched INSERTs, so
// a bad row leaves the table untouched. Values go in as text literals and the database coerces
// them to the column type ('42' into an int column works on all three engines).
use crate::db::{Conn, Db};
use crate::export::{literal, quote_ident};
use crate::store::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{
    fs::File,
    io::{BufRead, BufReader, Read},
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub path: String,
    pub format: String,            // csv | json | jsonl ("tsv" = csv with a tab)
    pub delimiter: Option<String>, // csv only; None = detect
    pub header: bool,              // csv only: first row holds the column names
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
    pub delimiter: String,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ImportOptions {
    pub source: Source,
    pub schema: String,
    pub table: String,
    pub mapping: Vec<Option<String>>, // per file column: target column, or None to skip
    pub empty_as_null: bool,
    pub truncate_first: bool,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub rows: u64,
    pub ms: u64,
    pub cancelled: bool,
}

type Rows = Box<dyn Iterator<Item = Result<Vec<Value>, String>> + Send>;

/// The most frequent of , ; tab | in the first line wins.
fn detect_delimiter(path: &str) -> Result<u8, String> {
    let mut first = String::new();
    BufReader::new(open(path)?).read_line(&mut first).map_err(|e| e.to_string())?;
    Ok([b',', b';', b'\t', b'|'].into_iter().max_by_key(|d| first.bytes().filter(|b| b == d).count()).unwrap_or(b','))
}

fn open(path: &str) -> Result<File, String> {
    File::open(path).map_err(|e| format!("Could not open {path}: {e}"))
}

fn delimiter(src: &Source) -> Result<u8, String> {
    match src.delimiter.as_deref() {
        _ if src.format == "tsv" => Ok(b'\t'),
        Some("\\t") | Some("\t") => Ok(b'\t'),
        Some(d) if d.len() == 1 => Ok(d.as_bytes()[0]),
        Some(d) if !d.is_empty() => Err(format!("The delimiter must be one character, not \"{d}\".")),
        _ => detect_delimiter(&src.path),
    }
}

fn object_row(o: &Map<String, Value>, cols: &[String]) -> Vec<Value> {
    cols.iter().map(|c| o.get(c).cloned().unwrap_or(Value::Null)).collect()
}

/// Column names and a row iterator. JSON objects are matched to columns by key.
fn open_rows(src: &Source) -> Result<(Vec<String>, Rows, u8), String> {
    match src.format.as_str() {
        "csv" | "tsv" => {
            let d = delimiter(src)?;
            // the csv crate strips a UTF-8 BOM; flexible: short rows are padded with NULL below
            let r = csv::ReaderBuilder::new().delimiter(d).has_headers(false).flexible(true).from_reader(open(&src.path)?);
            let mut it = r.into_records().peekable();
            let first = match it.peek() { Some(Ok(rec)) => rec.iter().map(String::from).collect::<Vec<_>>(), Some(Err(e)) => return Err(e.to_string()), None => vec![] };
            let cols: Vec<String> = if src.header { it.next(); first.iter().enumerate().map(|(i, c)| if c.trim().is_empty() { format!("column{}", i + 1) } else { c.trim().to_string() }).collect() } else { (1..=first.len()).map(|i| format!("column{i}")).collect() };
            let n = cols.len();
            let rows = it.map(move |rec| {
                let rec = rec.map_err(|e| e.to_string())?;
                let mut v: Vec<Value> = rec.iter().take(n).map(|s| Value::String(s.to_string())).collect();
                v.resize(n, Value::Null);
                Ok(v)
            });
            Ok((cols, Box::new(rows), d))
        }
        "json" => {
            // shortcut: a JSON array is parsed whole in memory; JSON Lines streams, suggest it for huge files
            let mut text = String::new();
            open(&src.path)?.read_to_string(&mut text).map_err(|e| format!("Could not read the file: {e}"))?;
            let v: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|e| format!("Not valid JSON: {e}"))?;
            let Value::Array(items) = v else { return Err("The JSON file must hold an array of objects.".into()) };
            let cols = union_keys(items.iter())?;
            let c2 = cols.clone();
            Ok((cols, Box::new(items.into_iter().map(move |it| match it { Value::Object(o) => Ok(object_row(&o, &c2)), _ => Err("Every array item must be an object.".into()) })), 0))
        }
        "jsonl" => {
            // columns come from the first 1000 lines; keys seen only later are ignored
            let parse = |l: String| -> Option<Result<Map<String, Value>, String>> {
                let t = l.trim().trim_start_matches('\u{feff}');
                if t.is_empty() { return None; }
                Some(match serde_json::from_str(t) { Ok(Value::Object(o)) => Ok(o), Ok(_) => Err("Every line must be a JSON object.".into()), Err(e) => Err(format!("Not valid JSON: {e}")) })
            };
            let head: Vec<Value> = BufReader::new(open(&src.path)?).lines().map_while(Result::ok).filter_map(parse).take(1000).collect::<Result<Vec<_>, _>>()?.into_iter().map(Value::Object).collect();
            let cols = union_keys(head.iter())?;
            let c2 = cols.clone();
            let rows = BufReader::new(open(&src.path)?).lines().filter_map(move |l| match l { Ok(l) => parse(l), Err(e) => Some(Err(e.to_string())) }).map(move |o| o.map(|o| object_row(&o, &c2)));
            Ok((cols, Box::new(rows), 0))
        }
        f => Err(format!("Unknown format {f}")),
    }
}

fn union_keys<'a>(items: impl Iterator<Item = &'a Value>) -> Result<Vec<String>, String> {
    let mut cols: Vec<String> = vec![];
    for it in items {
        let Value::Object(o) = it else { return Err("Every item must be a JSON object.".into()) };
        for k in o.keys() { if !cols.contains(k) { cols.push(k.clone()); } }
    }
    Ok(cols)
}

pub fn preview(src: &Source) -> Result<Preview, String> {
    let (columns, rows, d) = open_rows(src)?;
    let rows = rows.take(50).collect::<Result<Vec<_>, _>>()?;
    Ok(Preview { columns, rows, delimiter: if d == 0 { String::new() } else { (d as char).to_string() } })
}

pub async fn import(db: &Db, o: &ImportOptions, cancel: &AtomicBool, progress: &(dyn Fn(u64) + Sync)) -> Result<ImportSummary, String> {
    let started = Instant::now();
    let engine = db.engine();
    let (cols, rows, _) = open_rows(&o.source)?;
    if o.mapping.len() != cols.len() { return Err("The column mapping doesn't match the file. Preview it again.".into()); }
    let picks: Vec<(usize, &String)> = o.mapping.iter().enumerate().filter_map(|(i, m)| m.as_ref().filter(|m| !m.is_empty()).map(|m| (i, m))).collect();
    if picks.is_empty() { return Err("Map at least one column.".into()); }
    let table = if engine == Engine::Sqlite { quote_ident(&o.table, engine) } else { format!("{}.{}", quote_ident(&o.schema, engine), quote_ident(&o.table, engine)) };
    let head = format!("INSERT INTO {table} ({}) VALUES ", picks.iter().map(|(_, c)| quote_ident(c, engine)).collect::<Vec<_>>().join(", "));
    // ~1000 values per statement keeps well under SQLite's 32k parameter-free statement limits and MySQL's packet size
    let batch = (1000 / picks.len()).clamp(1, 500);

    let mut conn = Conn::acquire(db).await?;
    conn.exec("BEGIN").await?;
    let mut n = 0u64;
    let mut buf: Vec<String> = Vec::with_capacity(batch);
    let mut last = Instant::now();
    let result: Result<bool, String> = async {
        if o.truncate_first { conn.exec(&format!("DELETE FROM {table}")).await.map_err(|e| format!("Could not empty the table: {e}"))?; }
        for (i, row) in rows.enumerate() {
            if cancel.load(Ordering::Relaxed) { return Ok(true); }
            let row = row.map_err(|e| format!("Row {}: {e}", i + 1))?;
            let vals: Vec<String> = picks.iter().map(|(ci, _)| match &row[*ci] {
                Value::String(s) if o.empty_as_null && s.is_empty() => "NULL".into(),
                v => literal(v, engine),
            }).collect();
            buf.push(format!("({})", vals.join(", ")));
            if buf.len() >= batch {
                let first = n + 1;
                n += buf.len() as u64;
                conn.exec(&format!("{head}{}", buf.join(", "))).await.map_err(|e| format!("Rows {first}–{n}: {e}"))?;
                buf.clear();
                if last.elapsed().as_millis() >= 100 { progress(n); last = Instant::now(); }
            }
        }
        if !buf.is_empty() {
            let first = n + 1;
            n += buf.len() as u64;
            conn.exec(&format!("{head}{}", buf.join(", "))).await.map_err(|e| format!("Rows {first}–{n}: {e}"))?;
        }
        Ok(false)
    }.await;
    match result {
        Ok(false) => { conn.exec("COMMIT").await?; progress(n); Ok(ImportSummary { rows: n, ms: started.elapsed().as_millis() as u64, cancelled: false }) }
        Ok(true) => { let _ = conn.exec("ROLLBACK").await; Ok(ImportSummary { rows: 0, ms: started.elapsed().as_millis() as u64, cancelled: true }) }
        Err(e) => { let _ = conn.exec("ROLLBACK").await; Err(format!("{e}. Nothing was imported.")) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::restore::tests::{empty_db, scalar};

    fn file(name: &str, body: &str) -> String {
        let p = std::env::temp_dir().join(format!("tilki-{}-{name}", std::process::id()));
        std::fs::write(&p, body).unwrap();
        p.to_string_lossy().into()
    }
    fn src(path: &str, format: &str) -> Source {
        Source { path: path.into(), format: format.into(), delimiter: None, header: true }
    }

    #[test]
    fn preview_detects_delimiter_bom_and_quotes() {
        let p = file("p.csv", "\u{feff}id;name;note\n1;\"Öz; türk\";\n2;Lena\n");
        let pv = preview(&src(&p, "csv")).unwrap();
        assert_eq!(pv.delimiter, ";");
        assert_eq!(pv.columns, ["id", "name", "note"]);
        assert_eq!(pv.rows[0], [Value::from("1"), Value::from("Öz; türk"), Value::from("")]);
        assert_eq!(pv.rows[1][2], Value::Null, "short rows are padded");
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn json_and_jsonl_columns_are_the_union_of_keys() {
        let p = file("p.json", r#"[{"id":1,"name":"a"},{"id":2,"extra":true}]"#);
        let pv = preview(&src(&p, "json")).unwrap();
        assert_eq!(pv.columns, ["id", "name", "extra"]);
        assert_eq!(pv.rows[1], [Value::from(2), Value::Null, Value::from(true)]);
        let o = file("p2.json", r#"[{"sku":"A","name":"x","price":1}]"#);
        assert_eq!(preview(&src(&o, "json")).unwrap().columns, ["sku", "name", "price"], "file order, not alphabetical");
        let _ = std::fs::remove_file(o);
        let q = file("p.jsonl", "{\"id\":1}\n\n{\"id\":2,\"name\":\"b\"}\n");
        assert_eq!(preview(&src(&q, "jsonl")).unwrap().rows.len(), 2);
        for f in [p, q] { let _ = std::fs::remove_file(f); }
    }

    #[test]
    fn imports_with_mapping_and_rolls_back_on_a_bad_row() {
        tauri::async_runtime::block_on(async {
            let (db, f) = empty_db("imp").await;
            let Db::Lite(pool) = &db else { unreachable!() };
            sqlx::raw_sql("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL, note TEXT); INSERT INTO t VALUES (99, 'old', NULL);").execute(pool).await.unwrap();
            let p = file("imp.csv", "skip,id,name,note\nx,1,Deniz,\nx,2,it's,hi\n");
            let mut o = ImportOptions { source: src(&p, "csv"), schema: "main".into(), table: "t".into(), mapping: vec![None, Some("id".into()), Some("name".into()), Some("note".into())], empty_as_null: true, truncate_first: true };
            let s = import(&db, &o, &AtomicBool::new(false), &|_| {}).await.unwrap();
            assert_eq!(s.rows, 2);
            assert_eq!(scalar(&db, "SELECT count(*) FROM t WHERE (id = 1 AND note IS NULL) OR (id = 2 AND name = 'it''s')").await, 2);
            assert_eq!(scalar(&db, "SELECT count(*) FROM t WHERE id = 99").await, 0, "truncated first");

            let bad = file("bad.csv", "id,name\n3,ok\n1,dup\n");
            o.source = src(&bad, "csv");
            o.mapping = vec![Some("id".into()), Some("name".into())];
            o.truncate_first = false;
            let err = import(&db, &o, &AtomicBool::new(false), &|_| {}).await.unwrap_err();
            assert!(err.contains("Nothing was imported"), "{err}");
            assert_eq!(scalar(&db, "SELECT count(*) FROM t").await, 2, "row 3 was rolled back too");
            for x in [p, bad, f.to_string_lossy().into()] { let _ = std::fs::remove_file(x); }
        });
    }
}
