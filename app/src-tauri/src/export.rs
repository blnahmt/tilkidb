// Export rows to a file, one row at a time, so "all rows" of a big query streams to disk
// instead of being held in memory. Formats: CSV, TSV, JSON, JSON Lines, SQL INSERT, Markdown, Excel.
use crate::query::ColInfo;
use crate::store::Engine;
use rust_xlsxwriter::{Format as XFormat, Workbook};
use serde::Deserialize;
use serde_json::Value;
use std::{
    fs::File,
    io::{BufWriter, Write},
    path::{Path, PathBuf},
};

#[derive(Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    Csv,
    Tsv,
    Json,
    Jsonl,
    Sql,
    Markdown,
    Xlsx,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Options {
    pub format: Format,
    pub header: bool,
    pub delimiter: String, // CSV only
    pub null_text: String, // CSV/TSV/Markdown
    pub table: String,     // SQL INSERT target, already quoted by the UI
    pub engine: Engine,    // literal rules for SQL INSERT
    pub pretty: bool,      // JSON
    pub batch: usize,      // rows per INSERT
}

impl Default for Options {
    fn default() -> Self {
        Self { format: Format::Csv, header: true, delimiter: ",".into(), null_text: String::new(), table: "exported".into(), engine: Engine::Postgres, pretty: false, batch: 500 }
    }
}

const XLSX_MAX_ROWS: u32 = 1_048_575; // per sheet, below the header

fn text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// SQL literal for an exported value. MySQL also needs backslashes escaped.
pub fn literal(v: &Value, engine: Engine) -> String {
    match v {
        Value::Null => "NULL".into(),
        Value::Bool(b) => if *b { "TRUE".into() } else { "FALSE".into() },
        Value::Number(n) => n.to_string(),
        other => {
            let s = text(other);
            let s = if engine == Engine::Mysql { s.replace('\\', "\\\\") } else { s };
            format!("'{}'", s.replace('\'', "''"))
        }
    }
}

enum Out {
    Text(BufWriter<File>),
    Xlsx { book: Workbook, sheet: usize, row: u32, path: PathBuf },
}

pub struct Exporter {
    opts: Options,
    out: Out,
    cols: Vec<ColInfo>,
    rows: u64,
    sql_batch: Vec<String>,
}

impl Exporter {
    pub fn create(path: &Path, opts: Options) -> Result<Self, String> {
        let out = if opts.format == Format::Xlsx {
            let mut book = Workbook::new();
            book.add_worksheet_with_constant_memory().map_err(|e| e.to_string())?;
            Out::Xlsx { book, sheet: 0, row: 0, path: path.to_path_buf() }
        } else {
            Out::Text(BufWriter::new(File::create(path).map_err(|e| format!("Could not create {}: {e}", path.display()))?))
        };
        Ok(Self { opts, out, cols: vec![], rows: 0, sql_batch: vec![] })
    }

    fn w(&mut self, s: &str) -> Result<(), String> {
        match &mut self.out {
            Out::Text(f) => f.write_all(s.as_bytes()).map_err(|e| format!("Write failed: {e}")),
            Out::Xlsx { .. } => Ok(()),
        }
    }

    fn csv_field(&self, s: &str, delim: &str) -> String {
        if s.contains(delim) || s.contains('"') || s.contains('\n') || s.contains('\r') { format!("\"{}\"", s.replace('"', "\"\"")) } else { s.to_string() }
    }

    fn xlsx_header(&mut self) -> Result<(), String> {
        let bold = XFormat::new().set_bold();
        let names: Vec<String> = self.cols.iter().map(|c| c.name.clone()).collect();
        let header = self.opts.header;
        if let Out::Xlsx { book, sheet, row, .. } = &mut self.out {
            let ws = book.worksheet_from_index(*sheet).map_err(|e| e.to_string())?;
            if header {
                for (i, n) in names.iter().enumerate() {
                    ws.write_string_with_format(0, i as u16, n, &bold).map_err(|e| e.to_string())?;
                }
                ws.set_freeze_panes(1, 0).map_err(|e| e.to_string())?;
                *row = 1;
            }
        }
        Ok(())
    }

    pub fn columns(&mut self, cols: Vec<ColInfo>) -> Result<(), String> {
        self.cols = cols;
        let names: Vec<String> = self.cols.iter().map(|c| c.name.clone()).collect();
        match self.opts.format {
            Format::Csv | Format::Tsv if self.opts.header => {
                let d = if self.opts.format == Format::Tsv { "\t".to_string() } else { self.opts.delimiter.clone() };
                let line = names.iter().map(|n| self.csv_field(n, &d)).collect::<Vec<_>>().join(&d) + "\n";
                self.w(&line)
            }
            Format::Json => self.w("["),
            Format::Markdown => {
                let line = format!("| {} |\n|{}|\n", names.iter().map(|n| n.replace('|', "\\|")).collect::<Vec<_>>().join(" | "), names.iter().map(|_| " --- ").collect::<Vec<_>>().join("|"));
                self.w(&line)
            }
            Format::Xlsx => self.xlsx_header(),
            _ => Ok(()),
        }
    }

    fn object(&self, row: &[Value]) -> Value {
        Value::Object(self.cols.iter().zip(row).map(|(c, v)| (c.name.clone(), v.clone())).collect())
    }

    pub fn row(&mut self, row: &[Value]) -> Result<(), String> {
        self.rows += 1;
        match self.opts.format {
            Format::Csv | Format::Tsv => {
                let d = if self.opts.format == Format::Tsv { "\t".to_string() } else { self.opts.delimiter.clone() };
                let line = row.iter().map(|v| if v.is_null() { self.opts.null_text.clone() } else { self.csv_field(&text(v), &d) }).collect::<Vec<_>>().join(&d) + "\n";
                self.w(&line)
            }
            Format::Json => {
                let obj = self.object(row);
                let s = if self.opts.pretty { serde_json::to_string_pretty(&obj) } else { serde_json::to_string(&obj) }.map_err(|e| e.to_string())?;
                let sep = if self.rows == 1 { "\n" } else { ",\n" };
                self.w(&format!("{sep}{s}"))
            }
            Format::Jsonl => {
                let s = serde_json::to_string(&self.object(row)).map_err(|e| e.to_string())? + "\n";
                self.w(&s)
            }
            Format::Markdown => {
                let line = format!("| {} |\n", row.iter().map(|v| if v.is_null() { self.opts.null_text.clone() } else { text(v).replace('|', "\\|").replace('\n', " ") }).collect::<Vec<_>>().join(" | "));
                self.w(&line)
            }
            Format::Sql => {
                let vals = row.iter().map(|v| literal(v, self.opts.engine)).collect::<Vec<_>>().join(", ");
                self.sql_batch.push(format!("  ({vals})"));
                if self.sql_batch.len() >= self.opts.batch.max(1) { self.flush_sql() } else { Ok(()) }
            }
            Format::Xlsx => self.xlsx_row(row),
        }
    }

    fn xlsx_row(&mut self, row: &[Value]) -> Result<(), String> {
        let needs_sheet = matches!(&self.out, Out::Xlsx { row: r, .. } if *r > XLSX_MAX_ROWS);
        if needs_sheet {
            if let Out::Xlsx { book, sheet, row: r, .. } = &mut self.out {
                book.add_worksheet_with_constant_memory().map_err(|e| e.to_string())?;
                *sheet += 1;
                *r = 0;
            }
            self.xlsx_header()?;
        }
        let Out::Xlsx { book, sheet, row: r, .. } = &mut self.out else { return Ok(()) };
        let ws = book.worksheet_from_index(*sheet).map_err(|e| e.to_string())?;
        for (i, v) in row.iter().enumerate() {
            let c = i as u16;
            let res = match v {
                Value::Null => continue, // empty cell
                Value::Bool(b) => ws.write_boolean(*r, c, *b).map(|_| ()),
                Value::Number(n) => ws.write_number(*r, c, n.as_f64().unwrap_or(0.0)).map(|_| ()),
                other => ws.write_string(*r, c, text(other)).map(|_| ()),
            };
            res.map_err(|e| e.to_string())?;
        }
        *r += 1;
        Ok(())
    }

    fn flush_sql(&mut self) -> Result<(), String> {
        if self.sql_batch.is_empty() { return Ok(()); }
        let cols = self.cols.iter().map(|c| quote_ident(&c.name, self.opts.engine)).collect::<Vec<_>>().join(", ");
        let stmt = format!("INSERT INTO {} ({cols}) VALUES\n{};\n", self.opts.table, self.sql_batch.join(",\n"));
        self.sql_batch.clear();
        self.w(&stmt)
    }

    pub fn finish(mut self) -> Result<u64, String> {
        match self.opts.format {
            Format::Json => self.w(if self.rows == 0 { "]\n" } else { "\n]\n" })?,
            Format::Sql => self.flush_sql()?,
            _ => {}
        }
        match self.out {
            Out::Text(mut f) => f.flush().map_err(|e| format!("Write failed: {e}"))?,
            Out::Xlsx { mut book, path, .. } => book.save(&path).map_err(|e| format!("Could not save {}: {e}", path.display()))?,
        }
        Ok(self.rows)
    }
}

pub fn quote_ident(name: &str, engine: Engine) -> String {
    if engine == Engine::Mysql { format!("`{}`", name.replace('`', "``")) } else { format!("\"{}\"", name.replace('"', "\"\"")) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn cols() -> Vec<ColInfo> {
        ["id", "name", "note"].iter().map(|n| ColInfo { name: n.to_string(), data_type: String::new() }).collect()
    }
    fn rows() -> Vec<Vec<Value>> {
        vec![vec![json!(1), json!("Kaya, Deniz"), Value::Null], vec![json!(2), json!("it's \"quoted\""), json!({"a": 1})]]
    }
    fn export(fmt: Format, tweak: impl Fn(&mut Options)) -> String {
        let p = std::env::temp_dir().join(format!("tilki-exp-{}-{fmt:?}", std::process::id()));
        let mut o = Options { format: fmt, ..Default::default() };
        tweak(&mut o);
        let mut e = Exporter::create(&p, o).unwrap();
        e.columns(cols()).unwrap();
        for r in rows() { e.row(&r).unwrap(); }
        assert_eq!(e.finish().unwrap(), 2);
        let s = std::fs::read(&p).unwrap();
        let _ = std::fs::remove_file(&p);
        String::from_utf8_lossy(&s).into()
    }

    #[test]
    fn csv_quotes_only_when_needed() {
        assert_eq!(export(Format::Csv, |o| o.null_text = "NULL".into()), "id,name,note\n1,\"Kaya, Deniz\",NULL\n2,\"it's \"\"quoted\"\"\",\"{\"\"a\"\":1}\"\n");
        assert_eq!(export(Format::Tsv, |o| o.header = false).lines().next().unwrap(), "1\tKaya, Deniz\t");
    }

    #[test]
    fn json_and_json_lines_are_valid() {
        let j: Value = serde_json::from_str(&export(Format::Json, |_| {})).unwrap();
        assert_eq!(j[1]["note"], json!({"a": 1}));
        assert_eq!(j[0]["note"], Value::Null);
        let lines: Vec<Value> = export(Format::Jsonl, |_| {}).lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        assert_eq!(lines[0]["name"], json!("Kaya, Deniz"));
    }

    #[test]
    fn sql_insert_escapes_per_engine() {
        let pg = export(Format::Sql, |o| o.table = "\"t\"".into());
        assert!(pg.starts_with("INSERT INTO \"t\" (\"id\", \"name\", \"note\") VALUES\n  (1, 'Kaya, Deniz', NULL),\n  (2, 'it''s \"quoted\"', '{\"a\":1}');"), "{pg}");
        let my = export(Format::Sql, |o| { o.engine = Engine::Mysql; o.batch = 1; });
        assert_eq!(my.matches("INSERT INTO").count(), 2, "one statement per batch");
        assert!(my.contains("(`id`, `name`, `note`)"));
        assert_eq!(literal(&json!(r"C:\x"), Engine::Mysql), r"'C:\\x'");
        assert_eq!(literal(&json!(r"C:\x"), Engine::Postgres), r"'C:\x'");
    }

    #[test]
    fn markdown_table() {
        let md = export(Format::Markdown, |_| {});
        assert!(md.starts_with("| id | name | note |\n| --- | --- | --- |\n| 1 | Kaya, Deniz |  |\n"), "{md}");
    }

    #[test]
    fn xlsx_is_a_real_workbook() {
        let p = std::env::temp_dir().join(format!("tilki-exp-{}.xlsx", std::process::id()));
        let mut e = Exporter::create(&p, Options { format: Format::Xlsx, ..Default::default() }).unwrap();
        e.columns(cols()).unwrap();
        for r in rows() { e.row(&r).unwrap(); }
        e.finish().unwrap();
        let bytes = std::fs::read(&p).unwrap();
        assert_eq!(&bytes[..2], b"PK", "xlsx is a zip file");
        assert!(bytes.len() > 1000);
        let _ = std::fs::remove_file(p);
    }
}
