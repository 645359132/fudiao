//! 备份与恢复（需求 B06）。

use fudiao_lib::db::{
    backup::{self, BACKUP_DIR},
    migrate::EMBEDDED,
    Database, Statement,
};
use serde_json::json;

const T0: &str = "2026-10-08T00:00:00.000Z";
const T1: &str = "2026-10-08T01:00:00.000Z";
const T2: &str = "2026-10-08T02:00:00.000Z";

fn sql(text: &str) -> Statement {
    Statement {
        sql: text.into(),
        params: vec![],
        expect_changes: None,
    }
}

fn titles(db: &Database) -> serde_json::Value {
    json!(db
        .query("SELECT title FROM chapter ORDER BY order_key", &[])
        .unwrap())
}

#[test]
fn backup_then_restore_brings_back_the_backed_up_content() {
    let dir = tempfile::tempdir().unwrap();
    let (db, _) = Database::open(dir.path(), EMBEDDED, T0).unwrap();
    db.transaction(&[sql(
        "INSERT INTO chapter (id, order_key, title, created_at, updated_at) VALUES ('c1', 'a0', '第一章', 'x', 'x')",
    )])
    .unwrap();
    let manual = backup::create(&db, "manual", T1).unwrap();
    assert_eq!(manual.kind, "manual");
    assert_eq!(manual.created_at, T1);
    assert!(manual.size_bytes > 0);

    db.transaction(&[
        sql("UPDATE chapter SET title = '改过的第一章' WHERE id = 'c1'"),
        sql("INSERT INTO chapter (id, order_key, title, created_at, updated_at) VALUES ('c2', 'a1', '第二章', 'x', 'x')"),
    ])
    .unwrap();

    let (db, _, saved) = backup::restore(db, &manual.name, EMBEDDED, T2)
        .map_err(|e| e.1)
        .unwrap();
    assert_eq!(titles(&db), json!([{ "title": "第一章" }]));
    assert_eq!(saved.kind, "pre-restore");

    // 恢复前的现稿也能恢复回来。
    let (db, _, _) = backup::restore(db, &saved.name, EMBEDDED, "2026-10-08T03:00:00.000Z")
        .map_err(|e| e.1)
        .unwrap();
    assert_eq!(
        titles(&db),
        json!([{ "title": "改过的第一章" }, { "title": "第二章" }])
    );
    let kinds: Vec<String> = backup::list(dir.path())
        .into_iter()
        .map(|b| b.kind)
        .collect();
    assert_eq!(kinds, vec!["pre-restore", "pre-restore", "manual"]);
}

#[test]
fn restoring_an_unknown_backup_keeps_the_database_open() {
    let dir = tempfile::tempdir().unwrap();
    let (db, _) = Database::open(dir.path(), EMBEDDED, T0).unwrap();
    let (kept, error) = match backup::restore(db, "../project.sqlite", EMBEDDED, T1) {
        Err(e) => *e,
        Ok(_) => panic!("不应恢复"),
    };
    assert!(format!("{error:?}").contains("找不到备份"));
    assert!(kept
        .expect("库应保持打开")
        .query("SELECT 1 AS x", &[])
        .is_ok());
    assert!(!dir.path().join(BACKUP_DIR).exists());
}

#[test]
fn auto_backups_keep_the_latest_thirty() {
    let dir = tempfile::tempdir().unwrap();
    let (db, _) = Database::open(dir.path(), EMBEDDED, T0).unwrap();
    backup::create(&db, "manual", "2026-01-01T00:00:00.000Z").unwrap();
    for minute in 0..32 {
        backup::create(&db, "auto", &format!("2026-10-08T00:{minute:02}:00.000Z")).unwrap();
    }
    let all = backup::list(dir.path());
    assert_eq!(
        all.iter().filter(|b| b.kind == "auto").count(),
        backup::KEEP_AUTO
    );
    assert_eq!(all.iter().filter(|b| b.kind == "manual").count(), 1);
    assert_eq!(all[0].created_at, "2026-10-08T00:31:00.000Z");
}

#[test]
fn backup_time_must_be_an_iso_timestamp() {
    let dir = tempfile::tempdir().unwrap();
    let (db, _) = Database::open(dir.path(), EMBEDDED, T0).unwrap();
    for bad in [
        "../../evil",
        "2026-10-08T01:00:00.000Z/../../x",
        r"2026-10-08T01:00:00.00\Z",
        r"..\..\2026-10-08T01:00:0",
        "",
    ] {
        assert!(backup::create(&db, "manual", bad).is_err(), "{bad}");
    }
    assert!(backup::create(&db, "manual", T1).is_ok());
    let names: Vec<String> = std::fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
        .collect();
    assert!(names.iter().all(|n| !n.contains("evil")), "{names:?}");
    assert!(Database::open(dir.path(), EMBEDDED, "../x").is_err());
}

#[test]
fn queries_cannot_attach_other_files() {
    let dir = tempfile::tempdir().unwrap();
    let (db, _) = Database::open(dir.path(), EMBEDDED, T0).unwrap();
    let other = dir.path().join("other.sqlite");
    let attach = format!("ATTACH '{}' AS other", other.to_string_lossy());
    assert!(db.query(&attach, &[]).is_err());
    assert!(db.transaction(&[sql(&attach)]).is_err());
    assert!(!other.exists());
    // 备份（写连接上的 VACUUM INTO）照常可用。
    assert!(backup::create(&db, "manual", T1).is_ok());
}
