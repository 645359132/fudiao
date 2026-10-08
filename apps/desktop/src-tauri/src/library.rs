//! 作品列表与作品文件夹（M1-04）。作品列表的结构与校验在 TypeScript（Zod），Rust 只做文件 IO。

use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::db::PROJECT_DB_FILE;

const LIBRARY_FILE: &str = "library.json";
/// 默认作品库在“文档”下的文件夹名。
const LIBRARY_DIR_NAME: &str = "复调";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum FileError {
    IoError { detail: String },
}

impl FileError {
    fn from(e: impl std::fmt::Display) -> Self {
        FileError::IoError {
            detail: e.to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    pub exists: bool,
    pub is_dir: bool,
    /// 文件夹中有作品库文件，是一部已有的作品。
    pub has_project: bool,
}

pub fn probe(dir: &Path) -> Probe {
    Probe {
        exists: dir.exists(),
        is_dir: dir.is_dir(),
        has_project: dir.join(PROJECT_DB_FILE).is_file(),
    }
}

pub fn read_text(path: &Path) -> Result<Option<String>, FileError> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(FileError::from(e)),
    }
}

/// 先写临时文件并落盘，再改名覆盖：中途崩溃时旧文件保持完整。
pub fn write_atomic(path: &Path, content: &str) -> Result<(), FileError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(FileError::from)?;
    }
    let tmp: PathBuf = path.with_extension("json.tmp");
    {
        let mut file = fs::File::create(&tmp).map_err(FileError::from)?;
        file.write_all(content.as_bytes())
            .map_err(FileError::from)?;
        file.sync_all().map_err(FileError::from)?;
    }
    fs::rename(&tmp, path).map_err(FileError::from)
}

fn library_path(app: &AppHandle) -> Result<PathBuf, FileError> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(FileError::from)?
        .join(LIBRARY_FILE))
}

#[tauri::command]
pub fn library_read(app: AppHandle) -> Result<Option<String>, FileError> {
    read_text(&library_path(&app)?)
}

#[tauri::command]
pub fn library_write(app: AppHandle, content: String) -> Result<(), FileError> {
    write_atomic(&library_path(&app)?, &content)
}

#[tauri::command]
pub fn library_default_dir(app: AppHandle) -> Result<String, FileError> {
    let documents = app.path().document_dir().map_err(FileError::from)?;
    Ok(documents.join(LIBRARY_DIR_NAME).display().to_string())
}

#[tauri::command]
pub fn project_probe(dir: String) -> Probe {
    probe(Path::new(&dir))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_write_replaces_and_leaves_no_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join(LIBRARY_FILE);
        assert_eq!(read_text(&path).unwrap(), None);
        write_atomic(&path, "{\"version\":1}").unwrap();
        write_atomic(&path, "{\"version\":2,\"作品\":\"雨夜\"}").unwrap();
        assert_eq!(
            read_text(&path).unwrap().as_deref(),
            Some("{\"version\":2,\"作品\":\"雨夜\"}")
        );
        let names: Vec<_> = fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from(LIBRARY_FILE)]);
    }

    #[test]
    fn probe_distinguishes_missing_plain_and_project_folders() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("missing");
        assert_eq!(
            probe(&missing),
            Probe {
                exists: false,
                is_dir: false,
                has_project: false
            }
        );
        assert_eq!(
            probe(dir.path()),
            Probe {
                exists: true,
                is_dir: true,
                has_project: false
            }
        );
        fs::write(dir.path().join(PROJECT_DB_FILE), b"").unwrap();
        assert!(probe(dir.path()).has_project);
    }
}
