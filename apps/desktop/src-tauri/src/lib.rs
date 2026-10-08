//! 桌面应用的 Rust 部分：数据库命令（M1-02）、作品列表与作品文件夹（M1-04）；凭据代理与凭据存储在 M2-01、M2-02 加入。
//! 业务逻辑留在 TypeScript，Rust 只提供 IO 与凭据（施工文档第二章）。

pub mod db;
pub mod library;

use serde::Serialize;

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: &'static str,
    pub version: &'static str,
}

pub fn app_info_value() -> AppInfo {
    AppInfo {
        name: env!("CARGO_PKG_NAME"),
        version: env!("CARGO_PKG_VERSION"),
    }
}

/// 界面显示版本号用；也是前后端命令往返的最小样例。
#[tauri::command]
fn app_info() -> AppInfo {
    app_info_value()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(db::commands::DbState::default())
        .invoke_handler(tauri::generate_handler![
            app_info,
            db::commands::db_open,
            db::commands::db_close,
            db::commands::db_query,
            db::commands::db_tx,
            library::library_read,
            library::library_write,
            library::library_default_dir,
            library::project_probe
        ])
        .run(tauri::generate_context!())
        .expect("无法启动应用");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_info_serializes_in_camel_case() {
        let json = serde_json::to_value(app_info_value()).unwrap();
        assert_eq!(json["name"], "fudiao");
        assert_eq!(json["version"], env!("CARGO_PKG_VERSION"));
    }
}
