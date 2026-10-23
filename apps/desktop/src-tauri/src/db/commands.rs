//! 数据库的 Tauri 命令：`db_open`、`db_close`、`db_query`、`db_tx`，以及备份 `backup_list`、`backup_create`、`backup_restore`。
//! 数据库操作是阻塞调用，放在 spawn_blocking 中执行，不占用异步运行时的线程。
//! 每个窗口各开一部作品（作者决定 2026-10-23：一本书在一个窗口里写着，另一个窗口可以开另一本书），
//! 命令按发起它的窗口找作品库；同一部作品只能在一个窗口里打开。

use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use serde_json::Value;
use tauri::State;

use tauri::{AppHandle, Manager, Window};

use super::{
    backup::{self, BackupInfo},
    migrate::{APP_EMBEDDED, EMBEDDED},
    Database, OpenError, OpenReport, Row, SqlError, Statement, StatementResult, APP_DB_FILE,
};

/// 各窗口打开的作品库，键是窗口的标签。
#[derive(Default)]
pub struct DbState(Mutex<Windows>);

#[derive(Default)]
struct Windows {
    open: HashMap<String, Arc<Database>>,
    /// 正在打开或从备份恢复的作品（窗口标签到文件夹）：这期间别的窗口不能打开同一部。
    reserved: HashMap<String, PathBuf>,
    /// 已经关掉的窗口：之后才结束的打开或恢复不再记到它名下（窗口标签不会重复使用）。
    closed: HashSet<String>,
}

impl Windows {
    fn holder(&self, dir: &Path, except: &str) -> Option<String> {
        let open = self.open.iter().map(|(label, db)| (label, db.dir()));
        let reserved = self
            .reserved
            .iter()
            .map(|(label, dir)| (label, dir.as_path()));
        open.chain(reserved)
            .find(|(label, held)| label.as_str() != except && same_dir(held, dir))
            .map(|(label, _)| label.clone())
    }
}

impl DbState {
    fn lock(&self) -> std::sync::MutexGuard<'_, Windows> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn current(&self, label: &str) -> Result<Arc<Database>, SqlError> {
        self.lock()
            .open
            .get(label)
            .cloned()
            .ok_or(SqlError::NotOpen)
    }

    /// 已经在别的窗口里打开（或正在打开、正在恢复）这个文件夹的窗口标签。
    pub fn holder(&self, dir: &Path, except: &str) -> Option<String> {
        self.lock().holder(dir, except)
    }

    /// 这个窗口要打开这个文件夹：先占下，打开期间别的窗口打不开同一部。已经被别的窗口占着、或这个窗口已经关掉时说明原因。
    pub fn reserve(&self, label: &str, dir: &Path) -> Result<(), Reserve> {
        let mut w = self.lock();
        if w.closed.contains(label) {
            return Err(Reserve::Closed);
        }
        if let Some(other) = w.holder(dir, label) {
            return Err(Reserve::HeldBy(other));
        }
        w.reserved.insert(label.to_string(), dir.to_path_buf());
        Ok(())
    }

    /// 打开或恢复结束：放下占位，打开成了就记下（换掉这个窗口之前开的那一部）。窗口在这期间关掉了就不记，连接随之关闭。
    pub fn settle(&self, label: &str, db: Option<Database>) -> bool {
        let mut w = self.lock();
        w.reserved.remove(label);
        match db {
            Some(db) if !w.closed.contains(label) => {
                w.open.insert(label.to_string(), Arc::new(db));
                true
            }
            _ => false,
        }
    }

    /// 记下这个窗口打开的作品库；同一个文件夹已在别的窗口里打开时不记，返回那个窗口（测试与简单场合用）。
    pub fn put(&self, label: &str, db: Database) -> Result<(), String> {
        self.reserve(label, db.dir()).map_err(|e| match e {
            Reserve::HeldBy(other) => other,
            Reserve::Closed => label.to_string(),
        })?;
        self.settle(label, Some(db));
        Ok(())
    }

    /// 关闭这个窗口里的作品（正在执行的操作持有 Arc，执行完毕后连接随最后一个引用关闭）。
    pub fn release(&self, label: &str) {
        self.lock().open.remove(label);
    }

    /// 窗口关掉了：忘掉它的作品库，之后才结束的打开或恢复也不再记到它名下。
    pub fn forget(&self, label: &str) {
        let mut w = self.lock();
        w.open.remove(label);
        w.closed.insert(label.to_string());
    }

    /// 从备份恢复前取出这个窗口的作品库，同时占着它的文件夹（恢复期间别的窗口打不开这一部）。
    fn take_reserved(&self, label: &str) -> Option<Arc<Database>> {
        let mut w = self.lock();
        let db = w.open.remove(label)?;
        w.reserved.insert(label.to_string(), db.dir().to_path_buf());
        Some(db)
    }
}

/// 占下文件夹失败的原因。
#[derive(Debug, PartialEq, Eq)]
pub enum Reserve {
    /// 别的窗口开着（或正在打开）这一部。
    HeldBy(String),
    /// 这个窗口已经关掉了。
    Closed,
}

/// 两个路径是不是同一个文件夹：能解析出真实路径时比较真实路径，否则比较写法（Windows 上不分大小写、不分斜杠）。
pub fn same_dir(a: &Path, b: &Path) -> bool {
    if let (Ok(x), Ok(y)) = (a.canonicalize(), b.canonicalize()) {
        return x == y;
    }
    let plain = |p: &Path| {
        let text = p.to_string_lossy().replace('\\', "/");
        let text = text.trim_end_matches('/');
        if cfg!(windows) {
            text.to_lowercase()
        } else {
            text.to_string()
        }
    };
    plain(a) == plain(b)
}

/// 把那个窗口切到前面（作者想打开的作品已经在那里开着）。
fn focus(app: &AppHandle, label: &str) {
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// 打开或创建作品库。`now` 由界面的时钟端口提供（UTC ISO 字符串），用于迁移记录与备份文件名。
/// 这部作品已在另一个窗口里打开时不打开，把那个窗口切到前面。
#[tauri::command]
pub async fn db_open(
    window: Window,
    state: State<'_, DbState>,
    project_dir: String,
    now: String,
) -> Result<OpenReport, OpenError> {
    let label = window.label().to_string();
    let dir = PathBuf::from(project_dir);
    match state.reserve(&label, &dir) {
        Ok(()) => {}
        Err(Reserve::HeldBy(other)) => {
            focus(window.app_handle(), &other);
            return Err(OpenError::AlreadyOpen {});
        }
        Err(Reserve::Closed) => return Err(window_closed()),
    }
    let opened = tauri::async_runtime::spawn_blocking(move || Database::open(&dir, EMBEDDED, &now))
        .await
        .map_err(|e| OpenError::IoError {
            detail: e.to_string(),
        })
        .and_then(|r| r);
    match opened {
        Ok((db, report)) => {
            if state.settle(&label, Some(db)) {
                Ok(report)
            } else {
                Err(window_closed())
            }
        }
        Err(e) => {
            state.settle(&label, None);
            Err(e)
        }
    }
}

#[tauri::command]
pub fn db_close(window: Window, state: State<'_, DbState>) {
    state.release(window.label());
}

/// 这部作品是不是已经在别的窗口里打开：是的话把那个窗口切到前面。界面在关掉手上的作品、换开另一部之前先问，
/// 免得关了这一部又打不开那一部，窗口里什么也没有。
#[tauri::command]
pub fn db_held_elsewhere(window: Window, state: State<'_, DbState>, project_dir: String) -> bool {
    match state.holder(&PathBuf::from(project_dir), window.label()) {
        Some(other) => {
            focus(window.app_handle(), &other);
            true
        }
        None => false,
    }
}

fn window_closed() -> OpenError {
    OpenError::IoError {
        detail: "窗口已经关掉".into(),
    }
}

#[tauri::command]
pub async fn db_query(
    window: Window,
    state: State<'_, DbState>,
    sql: String,
    params: Option<Vec<Value>>,
) -> Result<Vec<Row>, SqlError> {
    let db = state.current(window.label())?;
    tauri::async_runtime::spawn_blocking(move || db.query(&sql, &params.unwrap_or_default()))
        .await
        .map_err(|e| SqlError::SqlError {
            index: 0,
            detail: e.to_string(),
        })?
}

#[tauri::command]
pub async fn db_tx(
    window: Window,
    state: State<'_, DbState>,
    statements: Vec<Statement>,
) -> Result<Vec<StatementResult>, SqlError> {
    let db = state.current(window.label())?;
    tauri::async_runtime::spawn_blocking(move || db.transaction(&statements))
        .await
        .map_err(|e| SqlError::SqlError {
            index: 0,
            detail: e.to_string(),
        })?
}

/// 当前作品库的备份列表，最近的在前。
#[tauri::command]
pub fn backup_list(window: Window, state: State<'_, DbState>) -> Result<Vec<BackupInfo>, SqlError> {
    Ok(backup::list(state.current(window.label())?.dir()))
}

/// 立即备份。kind 只能是 auto（打开作品时）或 manual（作者点“立即备份”）。
#[tauri::command]
pub async fn backup_create(
    window: Window,
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
    let db = state.current(window.label())?;
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
    window: Window,
    state: State<'_, DbState>,
    name: String,
    now: String,
) -> Result<(OpenReport, BackupInfo), OpenError> {
    let label = window.label().to_string();
    let shared = state.take_reserved(&label).ok_or(OpenError::IoError {
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
    });
    match result {
        Ok(Ok((db, report, saved))) => {
            if state.settle(&label, Some(db)) {
                Ok((report, saved))
            } else {
                Err(window_closed())
            }
        }
        Ok(Err(failure)) => {
            let (db, error) = *failure;
            state.settle(&label, db);
            Err(error)
        }
        Err(e) => {
            state.settle(&label, None);
            Err(e)
        }
    }
}

/// 应用设置库（M2-02）：模型服务、模型与任务分配，各个窗口共用一个。由界面在启动时打开，与作品库互不影响；
/// 已经打开时（另一个窗口先开了）照样用它，返回第一次打开的报告。
#[derive(Default)]
pub struct AppDbState(Mutex<Option<(Arc<Database>, OpenReport)>>);

impl AppDbState {
    fn slot(&self) -> std::sync::MutexGuard<'_, Option<(Arc<Database>, OpenReport)>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn current(&self) -> Result<Arc<Database>, SqlError> {
        self.slot()
            .as_ref()
            .map(|(db, _)| db.clone())
            .ok_or(SqlError::NotOpen)
    }
}

#[tauri::command]
pub async fn app_db_open(
    app: AppHandle,
    state: State<'_, AppDbState>,
    now: String,
) -> Result<OpenReport, OpenError> {
    if let Some((_, report)) = state.slot().as_ref() {
        return Ok(report.clone());
    }
    let dir = app.path().app_data_dir().map_err(|e| OpenError::IoError {
        detail: e.to_string(),
    })?;
    let opened = tauri::async_runtime::spawn_blocking(move || {
        Database::open_file(&dir, APP_DB_FILE, APP_EMBEDDED, &now)
    })
    .await
    .map_err(|e| OpenError::IoError {
        detail: e.to_string(),
    })??;
    let (db, report) = opened;
    let mut slot = state.slot();
    // 两个窗口同时启动：先打开的那一份留下，后到的这一份关掉。
    if let Some((_, first)) = slot.as_ref() {
        return Ok(first.clone());
    }
    *slot = Some((Arc::new(db), report.clone()));
    Ok(report)
}

#[tauri::command]
pub async fn app_db_query(
    state: State<'_, AppDbState>,
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
pub async fn app_db_tx(
    state: State<'_, AppDbState>,
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
