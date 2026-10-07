//! 迁移执行（Rust 实现）。用例与 packages/store/src/node/sqlite.test.ts 的迁移部分一一对应。

use std::{fs, path::Path};

use novel_writer_lib::db::{
    migrate::{Applied, Migration, EMBEDDED},
    Database, OpenError, OpenReport, Statement, PROJECT_DB_FILE,
};
use rusqlite::{Connection, OpenFlags};
use serde_json::json;

const NOW: &str = "2026-10-07T00:00:00.000Z";
const M1: Migration = Migration {
    version: 1,
    name: "create_work",
    sql: "CREATE TABLE work (id TEXT PRIMARY KEY, title TEXT NOT NULL);\n",
};
const M2: Migration = Migration {
    version: 2,
    name: "add_genre",
    sql: "ALTER TABLE work ADD COLUMN genre TEXT;\n",
};

fn open(
    dir: &Path,
    migrations: &[Migration],
    now: &str,
) -> Result<(Database, OpenReport), OpenError> {
    Database::open(dir, migrations, now)
}

fn applied(list: &[(u32, &str)]) -> Vec<Applied> {
    list.iter()
        .map(|(version, name)| Applied {
            version: *version,
            name: name.to_string(),
        })
        .collect()
}

fn sql(text: &str) -> Statement {
    Statement {
        sql: text.into(),
        params: vec![],
        expect_changes: None,
    }
}

#[test]
fn fresh_database_applies_all_without_backup() {
    let dir = tempfile::tempdir().unwrap();
    let (db, report) = open(dir.path(), &[M1, M2], NOW).unwrap();
    assert_eq!(
        report,
        OpenReport {
            schema_version: 2,
            applied: applied(&[(1, "create_work"), (2, "add_genre")]),
            backup: None
        }
    );
    let rows = db
        .query(
            "SELECT version FROM schema_migrations ORDER BY version",
            &[],
        )
        .unwrap();
    assert_eq!(json!(rows), json!([{ "version": 1 }, { "version": 2 }]));
    assert!(!dir.path().join("backups").exists());
}

#[test]
fn reopening_applies_nothing() {
    let dir = tempfile::tempdir().unwrap();
    drop(open(dir.path(), &[M1, M2], NOW).unwrap());
    let (_, report) = open(dir.path(), &[M1, M2], NOW).unwrap();
    assert_eq!(
        report,
        OpenReport {
            schema_version: 2,
            applied: vec![],
            backup: None
        }
    );
}

#[test]
fn existing_data_is_backed_up_before_migrating() {
    let dir = tempfile::tempdir().unwrap();
    let (db, _) = open(dir.path(), &[M1], NOW).unwrap();
    db.transaction(&[sql("INSERT INTO work VALUES ('w1', '雨夜')")])
        .unwrap();
    drop(db);
    let (_, report) = open(dir.path(), &[M1, M2], "2026-10-08T09:30:00.000Z").unwrap();
    assert_eq!(report.applied, applied(&[(2, "add_genre")]));
    let names: Vec<String> = fs::read_dir(dir.path().join("backups"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
        .collect();
    assert_eq!(
        names,
        vec!["pre-migration-v1-2026-10-08T09-30-00.000Z.sqlite"]
    );
    // 备份是完整、可打开的库，内容与结构停留在迁移前。
    let backup = Connection::open_with_flags(
        dir.path().join("backups").join(&names[0]),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let version: u32 = backup
        .query_row("SELECT max(version) FROM schema_migrations", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(version, 1);
    let columns: i64 = backup
        .query_row("SELECT count(*) FROM pragma_table_info('work')", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(columns, 2);
}

#[test]
fn changed_migration_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    drop(open(dir.path(), &[M1], NOW).unwrap());
    let changed = Migration {
        sql: "CREATE TABLE work (id TEXT PRIMARY KEY);\n",
        ..M1
    };
    assert_eq!(
        open(dir.path(), &[changed], NOW).err(),
        Some(OpenError::ChecksumMismatch { version: 1 })
    );
}

#[test]
fn line_endings_do_not_count_as_a_change() {
    let dir = tempfile::tempdir().unwrap();
    drop(open(dir.path(), &[M1], NOW).unwrap());
    let crlf = M1.sql.replace('\n', "\r\n");
    assert!(open(dir.path(), &[Migration { sql: &crlf, ..M1 }], NOW).is_ok());
}

#[test]
fn newer_schema_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    drop(open(dir.path(), &[M1, M2], NOW).unwrap());
    assert_eq!(
        open(dir.path(), &[M1], NOW).err(),
        Some(OpenError::SchemaTooNew {
            version: 2,
            known: 1
        })
    );
}

#[test]
fn failed_migration_rolls_back() {
    let dir = tempfile::tempdir().unwrap();
    drop(open(dir.path(), &[M1], NOW).unwrap());
    let broken = Migration {
        version: 2,
        name: "broken",
        sql: "ALTER TABLE work ADD COLUMN genre TEXT;\nCREATE TABLE oops (;\n",
    };
    assert!(matches!(
        open(dir.path(), &[M1, broken], NOW),
        Err(OpenError::MigrationFailed { version: 2, .. })
    ));
    let (db, _) = open(dir.path(), &[M1], NOW).unwrap();
    let columns = db
        .query("SELECT name FROM pragma_table_info('work')", &[])
        .unwrap();
    assert_eq!(
        json!(columns),
        json!([{ "name": "id" }, { "name": "title" }])
    );
}

#[test]
fn embedded_migrations_match_the_shared_directory() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../packages/store/migrations");
    let mut files: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
        .filter(|f| f.ends_with(".sql"))
        .collect();
    files.sort();
    let embedded: Vec<String> = EMBEDDED
        .iter()
        .map(|m| format!("{:04}_{}.sql", m.version, m.name))
        .collect();
    assert_eq!(embedded, files);
}

#[test]
fn reads_are_not_blocked_by_an_open_write_transaction() {
    let dir = tempfile::tempdir().unwrap();
    let (db, _) = open(dir.path(), &[M1], NOW).unwrap();
    db.transaction(&[sql("INSERT INTO work VALUES ('w1', '雨夜')")])
        .unwrap();

    // 另一个连接持有未提交的写事务；WAL 模式下只读连接照常读到已提交的数据。
    let other = Connection::open(dir.path().join(PROJECT_DB_FILE)).unwrap();
    other
        .execute_batch("BEGIN IMMEDIATE; INSERT INTO work VALUES ('w2', '未提交');")
        .unwrap();
    let rows = db.query("SELECT id FROM work ORDER BY id", &[]).unwrap();
    assert_eq!(json!(rows), json!([{ "id": "w1" }]));
    other.execute_batch("COMMIT").unwrap();
    let rows = db.query("SELECT id FROM work ORDER BY id", &[]).unwrap();
    assert_eq!(json!(rows), json!([{ "id": "w1" }, { "id": "w2" }]));
}

#[test]
fn errors_serialize_like_the_typescript_types() {
    let error = OpenError::SchemaTooNew {
        version: 2,
        known: 1,
    };
    assert_eq!(
        serde_json::to_value(error).unwrap(),
        json!({ "code": "schema_too_new", "version": 2, "known": 1 })
    );
    let report = OpenReport {
        schema_version: 1,
        applied: applied(&[(1, "create_work")]),
        backup: None,
    };
    assert_eq!(
        serde_json::to_value(report).unwrap(),
        json!({ "schemaVersion": 1, "applied": [{ "version": 1, "name": "create_work" }], "backup": null })
    );
}

#[test]
fn embedded_migrations_apply_on_a_fresh_database() {
    let dir = tempfile::tempdir().unwrap();
    let (db, report) = open(dir.path(), EMBEDDED, NOW).unwrap();
    assert_eq!(
        report.schema_version,
        EMBEDDED.last().map_or(0, |m| m.version)
    );
    let tables = db
        .query(
            "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
            &[],
        )
        .unwrap();
    // 与 packages/store/src/schema.ts 的表清单一致（Node 端的测试逐列校验）。
    let mut expected = vec![
        "project",
        "chapter",
        "paragraph",
        "chapter_snapshot",
        "entity",
        "fact",
        "source_ref",
        "story_event",
        "event_paragraph_link",
        "schema_migrations",
    ];
    expected.sort();
    assert_eq!(
        json!(tables),
        json!(expected
            .iter()
            .map(|n| json!({ "name": n }))
            .collect::<Vec<_>>())
    );
}
