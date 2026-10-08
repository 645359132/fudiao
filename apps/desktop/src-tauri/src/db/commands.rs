//! 数据库的 Tauri 命令：`db_open`、`db_close`、`db_query`、`db_tx`，以及备份 `backup_list`、`backup_create`、`backup_restore`。
//! 数据库操作是阻塞调用，放在 spawn_blocking 中执行，不占用异步运行时的线程。

use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};

use serde_json::Value;
use tauri::State;

use super::{
    backup::{self, BackupInfo},
    migrate::EMBEDDED,
    Database, OpenError, OpenReport, Row, SqlError, Statement, StatementResult,
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

/// 当前作品库的备份列表，最近的在前。
#[tauri::command]
pub fn backup_list(state: State<'_, DbState>) -> Result<Vec<BackupInfo>, SqlError> {
    Ok(backup::list(state.current()?.dir()))
}

/// 立即备份。kind 只能是 auto（打开作品时）或 manual（作者点“立即备份”）。
#[tauri::command]
pub async fn backup_create(
    state: State<'_, DbState>,
    kind: String,
    now: String,
) -> Result<BackupInfo, SqlError> {
    if kind != "auto" && kind != "manual" {
        return Err(SqlError::SqlError {
            index: 0,
            detail: format!("不支持的备份种类：{kind}"),
        });
    }
    let db = state.current()?;
    tauri::async_runtime::spawn_blocking(move || backup::create(&db, &kind, &now))
        .await
        .map_err(|e| SqlError::SqlError {
            index: 0,
            detail: e.to_string(),
        })?
}

/// 恢复到备份（现稿先存为恢复前备份），返回重新打开后的报告与恢复前备份。
#[tauri::command]
pub async fn backup_restore(
    state: State<'_, DbState>,
    name: String,
    now: String,
) -> Result<(OpenReport, BackupInfo), OpenError> {
    let shared = state
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take()
        .ok_or(OpenError::IoError {
            detail: "没有打开作品".into(),
        })?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        // 等进行中的查询与事务结束，拿到唯一的所有权后才能关闭连接。
        let mut shared = shared;
        let db = loop {
            match Arc::try_unwrap(shared) {
                Ok(db) => break db,
                Err(still) => {
                    shared = still;
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
            }
        };
        backup::restore(db, &name, EMBEDDED, &now)
    })
    .await
    .map_err(|e| OpenError::IoError {
        detail: e.to_string(),
    })?;
    match result {
        Ok((db, report, saved)) => {
            *state.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(Arc::new(db));
            Ok((report, saved))
        }
        Err(failure) => {
            let (db, error) = *failure;
            *state.0.lock().unwrap_or_else(|e| e.into_inner()) = db.map(Arc::new);
            Err(error)
        }
    }
}
