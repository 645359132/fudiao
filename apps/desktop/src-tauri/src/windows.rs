//! 多个窗口（作者决定 2026-10-23）：一本书由一个写手在一个窗口里写着，另一个窗口可以开另一本书。
//! 每个窗口各开一部作品（见 `db::commands::DbState`），同一部作品只开在一个窗口里。

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    },
};

use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder, Window};

use crate::db::commands::DbState;

/// 新开的窗口启动后要打开的作品（作品标识），按窗口标签记下；界面启动时取走。
#[derive(Default)]
pub struct WindowState {
    pending: Mutex<HashMap<String, String>>,
    seq: AtomicUsize,
}

impl WindowState {
    fn pending(&self) -> std::sync::MutexGuard<'_, HashMap<String, String>> {
        self.pending.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 窗口关掉时丢掉它还没取走的作品。
    pub fn forget(&self, label: &str) {
        self.pending().remove(label);
    }
}

/// 开一个新窗口：给了作品时新窗口直接打开它（那部作品已经在某个窗口里开着时，把那个窗口切到前面），
/// 没给时新窗口显示作品列表。在 Windows 上同步命令里建窗口会卡住，所以是 async。
#[tauri::command]
pub async fn window_open(
    app: AppHandle,
    db: State<'_, DbState>,
    windows: State<'_, WindowState>,
    work_id: Option<String>,
    work_dir: Option<String>,
) -> Result<(), String> {
    if let Some(dir) = &work_dir {
        if let Some(label) = db.holder(&PathBuf::from(dir), "") {
            if let Some(w) = app.get_webview_window(&label) {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
            return Ok(());
        }
    }
    let label = format!("work-{}", windows.seq.fetch_add(1, Ordering::Relaxed) + 1);
    if let Some(id) = work_id {
        windows.pending().insert(label.clone(), id);
    }
    let built = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
        .title("复调")
        .inner_size(1280.0, 800.0)
        .min_inner_size(900.0, 600.0)
        .build();
    if let Err(e) = built {
        windows.forget(&label);
        return Err(e.to_string());
    }
    Ok(())
}

/// 这个窗口启动时要打开的作品；取一次就没有了（之后回到作品列表再打开别的作品不受影响）。
#[tauri::command]
pub fn window_take_open(window: Window, windows: State<'_, WindowState>) -> Option<String> {
    windows.pending().remove(window.label())
}
