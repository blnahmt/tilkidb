// What the structure view shows for one table: its CREATE statement, indexes, triggers and
// column defaults (columns, keys and types already come with list_schema).
use crate::db::{list_schema, Db};
use crate::dump::table_ddl;
use serde::Serialize;

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Structure {
    pub ddl: String,
    pub indexes: Vec<Named>,
    pub triggers: Vec<Named>,
    pub defaults: Vec<Named>, // column -> default expression
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Named {
    pub name: String,
    pub def: String,
    pub unique: bool,
}

fn named(rows: Vec<(String, String)>) -> Vec<Named> {
    rows.into_iter().map(|(name, def)| Named { unique: def.to_ascii_uppercase().contains("UNIQUE") || name == "PRIMARY", name, def }).collect()
}

pub async fn structure(db: &Db, schema: &str, name: &str) -> Result<Structure, String> {
    let e = |e: sqlx::Error| e.to_string();
    let t = list_schema(db).await?.into_iter().find(|t| t.schema == schema && t.name == name).ok_or_else(|| format!("{name} no longer exists. Refresh the schema."))?;
    let ddl = table_ddl(db, &t).await?;
    let (indexes, triggers, defaults) = match db {
        Db::Pg(p) => {
            let q = format!("\"{}\".\"{}\"", schema.replace('"', "\"\""), name.replace('"', "\"\""));
            (
                sqlx::query_as("SELECT indexname::text, indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 ORDER BY indexname").bind(schema).bind(name).fetch_all(p).await.map_err(e)?,
                sqlx::query_as("SELECT tgname::text, pg_get_triggerdef(oid) FROM pg_trigger WHERE tgrelid = $1::regclass AND NOT tgisinternal ORDER BY tgname").bind(&q).fetch_all(p).await.map_err(e)?,
                sqlx::query_as("SELECT a.attname::text, pg_get_expr(d.adbin, d.adrelid) FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum WHERE d.adrelid = $1::regclass ORDER BY a.attnum").bind(&q).fetch_all(p).await.map_err(e)?,
            )
        }
        Db::My(p) => (
            sqlx::query_as("SELECT CAST(index_name AS CHAR), CAST(CONCAT(IF(MIN(non_unique) = 0, 'UNIQUE ', ''), '(', GROUP_CONCAT(column_name ORDER BY seq_in_index SEPARATOR ', '), ')') AS CHAR) FROM information_schema.statistics WHERE table_schema = ? AND table_name = ? GROUP BY index_name ORDER BY index_name")
                .bind(schema).bind(name).fetch_all(p).await.map_err(e)?,
            sqlx::query_as("SELECT CAST(trigger_name AS CHAR), CAST(CONCAT(action_timing, ' ', event_manipulation, ' FOR EACH ROW ', action_statement) AS CHAR) FROM information_schema.triggers WHERE event_object_schema = ? AND event_object_table = ? ORDER BY trigger_name")
                .bind(schema).bind(name).fetch_all(p).await.map_err(e)?,
            sqlx::query_as("SELECT CAST(column_name AS CHAR), CAST(column_default AS CHAR) FROM information_schema.columns WHERE table_schema = ? AND table_name = ? AND column_default IS NOT NULL ORDER BY ordinal_position")
                .bind(schema).bind(name).fetch_all(p).await.map_err(e)?,
        ),
        Db::Lite(p) => {
            let idx: Vec<(String, Option<String>)> = sqlx::query_as("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ?1 ORDER BY name").bind(name).fetch_all(p).await.map_err(e)?;
            (
                idx.into_iter().map(|(n, sql)| { let d = sql.unwrap_or_else(|| "(created by a PRIMARY KEY / UNIQUE constraint)".into()); (n, d) }).collect(),
                sqlx::query_as("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?1 ORDER BY name").bind(name).fetch_all(p).await.map_err(e)?,
                sqlx::query_as("SELECT name, dflt_value FROM pragma_table_info(?1) WHERE dflt_value IS NOT NULL").bind(name).fetch_all(p).await.map_err(e)?,
            )
        }
    };
    Ok(Structure { ddl, indexes: named(indexes), triggers: named(triggers), defaults: named(defaults) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sqlite_structure_lists_ddl_indexes_triggers_defaults() {
        tauri::async_runtime::block_on(async {
            let (db, f) = crate::restore::tests::empty_db("structure").await;
            let Db::Lite(p) = &db else { unreachable!() };
            sqlx::raw_sql("CREATE TABLE t (id INTEGER PRIMARY KEY, email TEXT UNIQUE, n INT DEFAULT 5);
                CREATE INDEX idx_n ON t(n);
                CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1; END;").execute(p).await.unwrap();
            let s = structure(&db, "main", "t").await.unwrap();
            assert!(s.ddl.starts_with("CREATE TABLE t") && s.ddl.contains("CREATE INDEX idx_n"), "{}", s.ddl);
            assert_eq!(s.indexes.iter().map(|i| i.name.as_str()).collect::<Vec<_>>(), ["idx_n", "sqlite_autoindex_t_1"]);
            assert_eq!(s.triggers[0].name, "tr");
            assert_eq!((s.defaults[0].name.as_str(), s.defaults[0].def.as_str()), ("n", "5"));
            let _ = std::fs::remove_file(f);
        });
    }
}
