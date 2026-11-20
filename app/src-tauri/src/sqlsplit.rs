// Split a SQL script into statements for restore. Semicolons inside strings, quoted identifiers,
// comments and PostgreSQL $tag$…$tag$ bodies don't split. MySQL scripts may switch the delimiter
// with `DELIMITER ;;` lines (mysqldump does this around triggers and routines).

#[derive(Debug, PartialEq)]
pub struct Stmt {
    pub text: String,
    pub line: usize, // 1-based line where the statement starts
}

/// MySQL runs /*! ... */ (versioned) comments as code: mysqldump puts SQL_MODE, TIME_ZONE,
/// FOREIGN_KEY_CHECKS and character sets there, so they must not be dropped as comments.
fn only_comments(s: &str, mysql: bool) -> bool {
    if mysql && s.contains("/*!") { return false; }
    skip_comments(s).trim().is_empty()
}

/// The statement without the comments and whitespace in front of it.
pub fn skip_comments(s: &str) -> &str {
    let mut rest = s.trim_start();
    loop {
        if let Some(r) = rest.strip_prefix("--") {
            rest = r.find('\n').map(|i| r[i..].trim_start()).unwrap_or("");
        } else if let Some(r) = rest.strip_prefix("/*") {
            rest = r.find("*/").map(|i| r[i + 2..].trim_start()).unwrap_or("");
        } else {
            return rest;
        }
    }
}

/// `mysql` turns on backslash escapes in strings and DELIMITER lines, and turns off $$ quoting.
pub fn split(sql: &str, mysql: bool) -> Vec<Stmt> {
    let b = sql.as_bytes();
    let mut out = Vec::new();
    let mut delim: Vec<u8> = b";".to_vec();
    let mut start = 0;
    let mut i = 0;
    let mut line_start = true; // only whitespace seen since the last newline

    let push = |out: &mut Vec<Stmt>, from: usize, to: usize| {
        let raw = &sql[from..to];
        let text = raw.trim();
        if !text.is_empty() && !only_comments(text, mysql) {
            let lead = raw.len() - raw.trim_start().len();
            let line = 1 + sql[..from + lead].matches('\n').count();
            out.push(Stmt { text: text.to_string(), line });
        }
    };

    while i < b.len() {
        let c = b[i];
        if mysql && line_start && (b.len() - i) > 10 && b[i..i + 10].eq_ignore_ascii_case(b"DELIMITER ") {
            let end = sql[i..].find('\n').map(|n| i + n).unwrap_or(b.len());
            push(&mut out, start, i); // whatever came before the directive
            let d = sql[i + 10..end].trim();
            if !d.is_empty() { delim = d.as_bytes().to_vec(); }
            i = end;
            start = end;
            continue;
        }
        // psql meta-commands (\restrict, \connect, \set ... from pg_dump) are for psql, not the server
        if !mysql && line_start && c == b'\\' {
            let end = sql[i..].find('\n').map(|n| i + n).unwrap_or(b.len());
            push(&mut out, start, i);
            i = end;
            start = end;
            continue;
        }
        if c == b'\n' { line_start = true; i += 1; continue; }
        if !c.is_ascii_whitespace() { line_start = false; }
        if c == b'-' && b.get(i + 1) == Some(&b'-') {
            i = sql[i..].find('\n').map(|n| i + n).unwrap_or(b.len());
            continue;
        }
        if c == b'/' && b.get(i + 1) == Some(&b'*') {
            i = sql[i + 2..].find("*/").map(|n| i + 2 + n + 2).unwrap_or(b.len());
            continue;
        }
        if c == b'\'' || c == b'"' || c == b'`' {
            i += 1;
            while i < b.len() {
                if mysql && b[i] == b'\\' { i += 2; continue; }
                if b[i] == c {
                    if b.get(i + 1) == Some(&c) { i += 2; continue; } // doubled quote
                    break;
                }
                i += 1;
            }
            i += 1;
            continue;
        }
        if !mysql && c == b'$' {
            let tag_len = b[i + 1..].iter().take_while(|x| x.is_ascii_alphanumeric() || **x == b'_').count();
            if b.get(i + 1 + tag_len) == Some(&b'$') {
                let tag = &sql[i..i + tag_len + 2];
                i = sql[i + tag.len()..].find(tag).map(|n| i + tag.len() + n + tag.len()).unwrap_or(b.len());
                continue;
            }
        }
        if b[i..].starts_with(&delim) {
            push(&mut out, start, i);
            i += delim.len();
            start = i;
            continue;
        }
        i += 1;
    }
    push(&mut out, start, b.len());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(sql: &str, mysql: bool) -> Vec<String> {
        split(sql, mysql).into_iter().map(|s| s.text).collect()
    }

    #[test]
    fn splits_and_ignores_semicolons_in_strings_and_comments() {
        assert_eq!(texts("SELECT 'a;b'; -- c;d\nSELECT \"x;y\" /* ; */;\n\n", false), ["SELECT 'a;b'", "-- c;d\nSELECT \"x;y\" /* ; */"]);
        assert_eq!(texts("INSERT INTO t VALUES ('it''s; ok');", false), ["INSERT INTO t VALUES ('it''s; ok')"]);
    }

    #[test]
    fn dollar_quoted_bodies_stay_whole() {
        let s = texts("CREATE FUNCTION f() RETURNS int AS $body$ BEGIN RETURN 1; END $body$ LANGUAGE plpgsql; SELECT 1", false);
        assert_eq!(s.len(), 2);
        assert!(s[0].ends_with("LANGUAGE plpgsql"));
    }

    #[test]
    fn mysql_backslashes_and_delimiter_lines() {
        assert_eq!(texts(r"INSERT INTO t VALUES ('a\';b'); SELECT 2", true), [r"INSERT INTO t VALUES ('a\';b')", "SELECT 2"]);
        let script = "CREATE TABLE t (a int);\nDELIMITER ;;\nCREATE TRIGGER tr BEFORE INSERT ON t FOR EACH ROW BEGIN SET NEW.a = 1; END ;;\nDELIMITER ;\nINSERT INTO t VALUES (2);";
        assert_eq!(texts(script, true), ["CREATE TABLE t (a int)", "CREATE TRIGGER tr BEFORE INSERT ON t FOR EACH ROW BEGIN SET NEW.a = 1; END", "INSERT INTO t VALUES (2)"]);
    }

    #[test]
    fn line_numbers_point_at_the_statement() {
        let s = split("-- header\n\nSELECT 1;\n\nSELECT\n  2;", false);
        assert_eq!(s.iter().map(|x| x.line).collect::<Vec<_>>(), [1, 5]);
        assert_eq!(s[1].text, "SELECT\n  2");
    }

    #[test]
    fn mysql_versioned_comments_run_and_psql_meta_commands_are_skipped() {
        let my = texts("/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;\n/* plain */;\nINSERT INTO t VALUES (1);", true);
        assert_eq!(my, ["/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */", "INSERT INTO t VALUES (1)"]);
        let pg = texts("\\restrict AbC123\nSET x = 1;\nINSERT INTO t VALUES ('a\n\\b');\n\\unrestrict AbC123\n", false);
        assert_eq!(pg, ["SET x = 1", "INSERT INTO t VALUES ('a\n\\b')"], "a backslash line inside a string is data");
    }

    #[test]
    fn unicode_text_is_safe() {
        assert_eq!(texts("INSERT INTO t VALUES ('Öztürk; ğüşiöç'); SELECT 'ü'", false).len(), 2);
    }
}
