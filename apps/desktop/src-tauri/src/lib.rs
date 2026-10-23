//! 桌面应用的 Rust 部分：数据库命令（M1-02）、作品列表与作品文件夹（M1-04）、草稿（M1-05）、导入导出与备份（M1-07）、凭据代理（M2-01）、凭据存储（M2-02）与读公开网页（M7-01）与多个窗口（每个窗口各写一本书）。
//! 业务逻辑留在 TypeScript，Rust 只提供 IO 与凭据（施工文档第二章）。

pub mod credentials;
pub mod db;
pub mod drafts;
pub mod library;
pub mod net;
pub mod transfer;
pub mod web;
pub mod windows;

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
    // 凭据代理与凭据命令共用同一个凭据来源。
    let credentials = credentials::StoredCredentials::new(Box::new(credentials::KeyringStore));
    let proxy = std::sync::Arc::new(net::Proxy::new(credentials.clone()));
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(db::commands::DbState::default())
        .manage(db::commands::AppDbState::default())
        .manage(transfer::ImportState::default())
        .manage(net::NetState { proxy })
        .manage(credentials::CredentialState { credentials })
        .manage(web::WebState {
            reader: web::WebReader::new(),
        })
        .manage(windows::WindowState::default())
        // 每个窗口各开一部作品：窗口关掉时忘掉它的作品库、还没取走的作品与选了还没导入的文件。
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                use tauri::Manager;
                window
                    .state::<db::commands::DbState>()
                    .forget(window.label());
                window
                    .state::<windows::WindowState>()
                    .forget(window.label());
                window
                    .state::<transfer::ImportState>()
                    .forget_window(window.label());
            }
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            db::commands::db_open,
            db::commands::db_close,
            db::commands::db_held_elsewhere,
            db::commands::db_query,
            db::commands::db_tx,
            db::commands::app_db_open,
            db::commands::app_db_query,
            db::commands::app_db_tx,
            library::library_read,
            library::library_write,
            library::library_replace,
            library::library_default_dir,
            library::project_probe,
            drafts::draft_read,
            drafts::draft_write,
            drafts::draft_delete,
            db::commands::backup_list,
            db::commands::backup_create,
            db::commands::backup_restore,
            transfer::import_pick_text,
            transfer::import_redecode,
            transfer::import_release,
            transfer::export_text,
            transfer::export_project,
            transfer::import_pick_project,
            net::net_fetch,
            net::net_cancel,
            net::net_set_limits,
            credentials::credential_set,
            credentials::credential_status,
            credentials::credential_delete,
            web::web_fetch,
            windows::window_open,
            windows::window_take_open
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
