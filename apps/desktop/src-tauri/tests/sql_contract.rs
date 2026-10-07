//! SqlPort 契约（Rust 实现）：与 Node 实现跑同一份 packages/store/contract/sql-cases.json。

use std::{fs, path::PathBuf};

use novel_writer_lib::db::{migrate::checksum, Database, Statement};
use serde_json::{json, Value};

fn contract() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../packages/store/contract/sql-cases.json");
    serde_json::from_str(&fs::read_to_string(path).expect("无法读取契约用例"))
        .expect("契约用例不是有效的 JSON")
}

fn fresh(setup: &Value) -> (tempfile::TempDir, Database) {
    let dir = tempfile::tempdir().unwrap();
    let (db, _) = Database::open(dir.path(), &[], "2026-10-07T00:00:00.000Z").unwrap();
    let statements: Vec<Statement> = setup
        .as_array()
        .unwrap()
        .iter()
        .map(|sql| Statement {
            sql: sql.as_str().unwrap().into(),
            params: vec![],
            expect_changes: None,
        })
        .collect();
    db.transaction(&statements).unwrap();
    (dir, db)
}

/// error 只比较用例中列出的字段（detail 是各端的 SQLite 错误信息，不比较）。
fn matches(actual: &Value, expected: &Value) -> bool {
    expected
        .as_object()
        .unwrap()
        .iter()
        .all(|(k, v)| actual.get(k) == Some(v))
}

#[test]
fn contract_cases() {
    let contract = contract();
    let mut failures = Vec::new();
    for case in contract["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let (_dir, db) = fresh(&contract["setup"]);
        let result: Result<Value, Value> = if let Some(q) = case.get("query") {
            let params = q
                .get("params")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            db.query(q["sql"].as_str().unwrap(), &params)
                .map(|rows| json!(rows))
                .map_err(|e| serde_json::to_value(e).unwrap())
        } else {
            let statements: Vec<Statement> = serde_json::from_value(case["tx"].clone()).unwrap();
            db.transaction(&statements)
                .map(|r| json!(r))
                .map_err(|e| serde_json::to_value(e).unwrap())
        };
        let expect = &case["expect"];
        let passed = match (&result, expect.get("error")) {
            (Err(actual), Some(expected)) => matches(actual, expected),
            (Ok(actual), None) => {
                Some(actual) == expect.get("rows").or_else(|| expect.get("results"))
            }
            _ => false,
        };
        if !passed {
            failures.push(format!("{name}: 得到 {result:?}，预期 {expect}"));
            continue;
        }
        if let Some(after) = case.get("after") {
            let rows = db.query(after["sql"].as_str().unwrap(), &[]).unwrap();
            if json!(rows) != after["rows"] {
                failures.push(format!(
                    "{name}（之后）: 得到 {rows:?}，预期 {}",
                    after["rows"]
                ));
            }
        }
    }
    assert!(
        failures.is_empty(),
        "契约用例未通过：\n{}",
        failures.join("\n")
    );
}

#[test]
fn migration_checksums() {
    for c in contract()["checksums"].as_array().unwrap() {
        assert_eq!(
            checksum(c["text"].as_str().unwrap()),
            c["sha256"].as_str().unwrap(),
            "{}",
            c["text"]
        );
    }
}
