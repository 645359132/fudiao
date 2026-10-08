//! 未保存编辑的草稿（意外退出后恢复）。M1-05。正文导出见 transfer.rs。

use std::{
    fs,
    path::{Path, PathBuf},
};

use crate::{
    db::PROJECT_DB_FILE,
    library::{read_text, write_atomic, FileError},
};

const DRAFTS_DIR: &str = "drafts";

/// 章节标识必须是 ULID（Crockford base32 的 26 个字符），防止借标识拼出作品文件夹以外的路径。
fn is_ulid(id: &str) -> bool {
    id.len() == 26
        && id.bytes().all(|b| {
            b.is_ascii_digit()
                || (b.is_ascii_uppercase() && !matches!(b, b'I' | b'L' | b'O' | b'U'))
        })
}

/// 草稿只写在已有作品的文件夹里：`<作品文件夹>/drafts/<章节标识>.json`。
pub fn draft_path(project_dir: &Path, chapter_id: &str) -> Result<PathBuf, FileError> {
    if !is_ulid(chapter_id) {
        return Err(FileError::IoError {
            detail: "章节标识无效".into(),
        });
    }
    if !project_dir.join(PROJECT_DB_FILE).is_file() {
        return Err(FileError::IoError {
            detail: "不是作品文件夹".into(),
        });
    }
    Ok(project_dir
        .join(DRAFTS_DIR)
        .join(format!("{chapter_id}.json")))
}

#[tauri::command]
pub fn draft_read(project_dir: String, chapter_id: String) -> Result<Option<String>, FileError> {
    read_text(&draft_path(Path::new(&project_dir), &chapter_id)?)
}

#[tauri::command]
pub fn draft_write(
    project_dir: String,
    chapter_id: String,
    content: String,
) -> Result<(), FileError> {
    write_atomic(&draft_path(Path::new(&project_dir), &chapter_id)?, &content)
}

#[tauri::command]
pub fn draft_delete(project_dir: String, chapter_id: String) -> Result<(), FileError> {
    match fs::remove_file(draft_path(Path::new(&project_dir), &chapter_id)?) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(FileError::IoError {
            detail: e.to_string(),
        }),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "01K6Z8Q2W3E4R5T6Y7U8I9O0PA";

    #[test]
    fn rejects_identifiers_that_are_not_ulids() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(PROJECT_DB_FILE), b"").unwrap();
        for bad in [
            "../../etc",
            "01K6Z8Q2W3E4R5T6Y7U8I9O0P",
            "01k6z8q2w3e4r5t6y7u8i9o0pa",
            "01K6Z8Q2W3E4R5T6Y7U8I9O0P/",
        ] {
            assert!(draft_path(dir.path(), bad).is_err(), "{bad}");
        }
        // 示例标识含 I、O、U，本身不是合法 ULID。
        assert!(draft_path(dir.path(), ID).is_err());
        assert!(draft_path(dir.path(), "01K6Z8Q2W3E4R5T6Y7V8J9P0QA").is_ok());
    }

    #[test]
    fn only_inside_existing_projects() {
        let dir = tempfile::tempdir().unwrap();
        assert!(draft_path(dir.path(), "01K6Z8Q2W3E4R5T6Y7V8J9P0QA").is_err());
    }

    #[test]
    fn write_read_delete_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(PROJECT_DB_FILE), b"").unwrap();
        let project = dir.path().display().to_string();
        let id = "01K6Z8Q2W3E4R5T6Y7V8J9P0QA".to_string();
        assert_eq!(draft_read(project.clone(), id.clone()).unwrap(), None);
        draft_write(project.clone(), id.clone(), "{\"雨夜\":1}".into()).unwrap();
        assert_eq!(
            draft_read(project.clone(), id.clone()).unwrap().as_deref(),
            Some("{\"雨夜\":1}")
        );
        draft_delete(project.clone(), id.clone()).unwrap();
        draft_delete(project.clone(), id.clone()).unwrap();
        assert_eq!(draft_read(project, id).unwrap(), None);
    }
}
