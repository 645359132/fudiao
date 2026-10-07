//! 数据库的 Tauri 命令：`db_open`、`db_close`、`db_query`、`db_tx`。
//! 数据库操作是阻塞调用，放在 spawn_blocking 中执行，不占用异步运行时的线程。

use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};

use serde_json::Value;
use tauri::State;

use super::{
    migrate::EMBEDDED, Database, OpenError, OpenReport, Row, SqlError, Statement, StatementResult,
};

/// 同一时间只打开一部作品。
#[derive(Default)]
pub struct DbState(Mutex<Option<Arc<Database>>>);

impl DbState {
    fn current(&self) -> Result<Arc<Database>, SqlError> {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .ok_or(SqlError::NotOpen)
    }
}

/// 打开或创建作品库。`now` 由界面的时钟端口提供（UTC ISO 字符串），用于迁移记录与备份文件名。
#[tauri::command]
pub async fn db_open(
    state: State<'_, DbState>,
    project_dir: String,
    now: String,
) -> Result<OpenReport, OpenError> {
    let opened = tauri::async_runtime::spawn_blocking(move || {
        Database::open(&PathBuf::from(project_dir), EMBEDDED, &now)
    })
    .await
    .map_err(|e| OpenError::IoError {
        detail: e.to_string(),
    })??;
    let (db, report) = opened;
    *state.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(Arc::new(db));
    Ok(report)
}

#[tauri::command]
pub fn db_close(state: State<'_, DbState>) {
    // 正在执行的操作持有 Arc，执行完毕后连接随最后一个引用关闭。
    *state.0.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

#[tauri::command]
pub async fn db_query(
    state: State<'_, DbState>,
    sql: String,
    params: Option<Vec<Value>>,
) -> Result<Vec<Row>, SqlError> {
    let db = state.current()?;
    tauri::async_runtime::spawn_blocking(move || db.query(&sql, &params.unwrap_or_default()))
        .await
        .map_err(|e| SqlError::SqlError {
            index: 0,
            detail: e.to_string(),
        })?
}

#[tauri::command]
pub async fn db_tx(
    state: State<'_, DbState>,
    statements: Vec<Statement>,
) -> Result<Vec<StatementResult>, SqlError> {
    let db = state.current()?;
    tauri::async_runtime::spawn_blocking(move || db.transaction(&statements))
        .await
        .map_err(|e| SqlError::SqlError {
            index: 0,
            detail: e.to_string(),
        })?
}
