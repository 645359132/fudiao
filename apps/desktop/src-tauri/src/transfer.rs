//! 导入与导出（M1-07，需求 B07）：TXT 与 Markdown 的编码识别、正文导出、作品包（zip）的打包与读取。
//! 文件路径只来自 Rust 弹出的对话框，界面拿不到路径，不能借这些命令读写任意文件。

use std::{
    collections::HashMap,
    fs,
    io::{Cursor, Read, Write},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
};

use chardetng::{EncodingDetector, Iso2022JpDetection, Utf8Detection};
use encoding_rs::Encoding;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

use crate::library::FileError;

/// 单个导入文件与作品包的大小上限，防止误选巨大文件耗尽内存。
const MAX_TEXT_BYTES: u64 = 256 * 1024 * 1024;
const MAX_PACKAGE_BYTES: u64 = 1024 * 1024 * 1024;

fn io(e: impl std::fmt::Display) -> FileError {
    FileError::IoError {
        detail: e.to_string(),
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DecodedText {
    pub token: String,
    pub file_name: String,
    pub encoding: String,
    pub text: String,
    /// 有无法按该编码解码、被替换为 U+FFFD 的字节；界面据此提示作者换一种编码。
    pub had_errors: bool,
}

/// 识别编码并解码：有 BOM 按 BOM；能按 UTF-8 严格解码就用 UTF-8；否则由 chardetng 猜测（GB18030、Big5 等）。
/// 指定编码时按指定的解码（BOM 仍会去掉）。
pub fn decode(bytes: &[u8], forced: Option<&'static Encoding>) -> (&'static str, String, bool) {
    let (encoding, body) = match (forced, Encoding::for_bom(bytes)) {
        (Some(enc), Some((bom_enc, len))) if bom_enc == enc => (enc, &bytes[len..]),
        (Some(enc), _) => (enc, bytes),
        (None, Some((enc, len))) => (enc, &bytes[len..]),
        (None, None) if std::str::from_utf8(bytes).is_ok() => (encoding_rs::UTF_8, bytes),
        (None, None) => {
            let mut detector = EncodingDetector::new(Iso2022JpDetection::Deny);
            detector.feed(bytes, true);
            (detector.guess(None, Utf8Detection::Allow), bytes)
        }
    };
    let (text, had_errors) = encoding.decode_without_bom_handling(body);
    (encoding.name(), text.into_owned(), had_errors)
}

/// 选中的导入文件按令牌暂存在 Rust 端，改选编码时重新解码，导入或取消后释放。
#[derive(Default)]
pub struct ImportState {
    files: Mutex<HashMap<String, (String, Vec<u8>)>>,
    next: AtomicU64,
}

#[tauri::command]
pub async fn import_pick_text(
    app: AppHandle,
    state: State<'_, ImportState>,
) -> Result<Option<DecodedText>, FileError> {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter("文本与 Markdown", &["txt", "md", "markdown"])
            .blocking_pick_file()
    })
    .await
    .map_err(io)?;
    let Some(path) = picked else { return Ok(None) };
    let path = path.into_path().map_err(io)?;
    if fs::metadata(&path).map_err(io)?.len() > MAX_TEXT_BYTES {
        return Err(io("文件超过 256 MB"));
    }
    let bytes = fs::read(&path).map_err(io)?;
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let (encoding, text, had_errors) = decode(&bytes, None);
    let token = state.next.fetch_add(1, Ordering::Relaxed).to_string();
    state
        .files
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(token.clone(), (file_name.clone(), bytes));
    Ok(Some(DecodedText {
        token,
        file_name,
        encoding: encoding.into(),
        text,
        had_errors,
    }))
}

#[tauri::command]
pub fn import_redecode(
    state: State<'_, ImportState>,
    token: String,
    encoding: String,
) -> Result<DecodedText, FileError> {
    let forced = Encoding::for_label(encoding.as_bytes())
        .ok_or_else(|| io(format!("不认识的编码：{encoding}")))?;
    let files = state.files.lock().unwrap_or_else(|e| e.into_inner());
    let (file_name, bytes) = files
        .get(&token)
        .ok_or_else(|| io("导入文件已释放，请重新选择"))?;
    let (name, text, had_errors) = decode(bytes, Some(forced));
    Ok(DecodedText {
        token,
        file_name: file_name.clone(),
        encoding: name.into(),
        text,
        had_errors,
    })
}

#[tauri::command]
pub fn import_release(state: State<'_, ImportState>, token: String) {
    state
        .files
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&token);
}

/// 弹出保存对话框，把正文写入作者选择的文件。返回是否已保存（作者取消时为 false）。
#[tauri::command]
pub async fn export_text(
    app: AppHandle,
    suggested_name: String,
    content: String,
    kind: Option<String>,
) -> Result<bool, FileError> {
    let (label, extension) = if kind.as_deref() == Some("md") {
        ("Markdown", "md")
    } else {
        ("文本文件", "txt")
    };
    tauri::async_runtime::spawn_blocking(move || {
        let picked = app
            .dialog()
            .file()
            .set_file_name(&suggested_name)
            .add_filter(label, &[extension])
            .blocking_save_file();
        let Some(path) = picked else { return Ok(false) };
        fs::write(path.into_path().map_err(io)?, content.as_bytes()).map_err(io)?;
        Ok(true)
    })
    .await
    .map_err(io)?
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PackFile {
    pub path: String,
    pub content: String,
}

/// 作品包中只接受这三类条目：`manifest.json`、`chapters/*.md`、`data/*.jsonl`。
/// 拒绝绝对路径、反斜杠与 `..`，防止解包或打包时写到别处。
pub fn valid_entry(path: &str) -> bool {
    if path.contains("..") || path.contains('\\') || path.starts_with('/') || path.contains(':') {
        return false;
    }
    let file_in = |dir: &str, ext: &str| {
        path.strip_prefix(dir).is_some_and(|rest| {
            !rest.is_empty() && !rest.contains('/') && rest.ends_with(ext) && rest.len() > ext.len()
        })
    };
    path == "manifest.json" || file_in("chapters/", ".md") || file_in("data/", ".jsonl")
}

pub fn pack(files: &[PackFile]) -> Result<Vec<u8>, FileError> {
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    for f in files {
        if !valid_entry(&f.path) {
            return Err(io(format!("作品包中不允许的条目：{}", f.path)));
        }
        zip.start_file(f.path.as_str(), options).map_err(io)?;
        zip.write_all(f.content.as_bytes()).map_err(io)?;
    }
    Ok(zip.finish().map_err(io)?.into_inner())
}

/// 读取作品包：只取允许的条目，其他条目（例如压缩软件附带的目录）忽略；带路径穿越的条目整体拒绝。
pub fn unpack(bytes: &[u8]) -> Result<Vec<PackFile>, FileError> {
    let mut archive = ZipArchive::new(Cursor::new(bytes)).map_err(io)?;
    let mut files = Vec::new();
    let mut total = 0u64;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(io)?;
        let name = entry.name().to_string();
        if name.contains("..") || name.starts_with('/') || name.contains('\\') {
            return Err(io(format!("作品包含有不安全的路径：{name}")));
        }
        if entry.is_dir() || !valid_entry(&name) {
            continue;
        }
        total += entry.size();
        if entry.size() > MAX_TEXT_BYTES || total > MAX_PACKAGE_BYTES {
            return Err(io("作品包过大"));
        }
        let mut content = String::new();
        entry
            .read_to_string(&mut content)
            .map_err(|_| io(format!("{name} 不是 UTF-8 文本")))?;
        files.push(PackFile {
            path: name,
            content,
        });
    }
    Ok(files)
}

#[tauri::command]
pub async fn export_project(
    app: AppHandle,
    suggested_name: String,
    files: Vec<PackFile>,
) -> Result<bool, FileError> {
    let bytes = pack(&files)?;
    tauri::async_runtime::spawn_blocking(move || {
        let picked = app
            .dialog()
            .file()
            .set_file_name(&suggested_name)
            .add_filter("复调作品包", &["zip"])
            .blocking_save_file();
        let Some(path) = picked else { return Ok(false) };
        fs::write(path.into_path().map_err(io)?, bytes).map_err(io)?;
        Ok(true)
    })
    .await
    .map_err(io)?
}

#[tauri::command]
pub async fn import_pick_project(app: AppHandle) -> Result<Option<Vec<PackFile>>, FileError> {
    tauri::async_runtime::spawn_blocking(move || {
        let picked = app
            .dialog()
            .file()
            .add_filter("复调作品包", &["zip"])
            .blocking_pick_file();
        let Some(path) = picked else { return Ok(None) };
        let path = path.into_path().map_err(io)?;
        if fs::metadata(&path).map_err(io)?.len() > MAX_PACKAGE_BYTES {
            return Err(io("作品包过大"));
        }
        unpack(&fs::read(path).map_err(io)?).map(Some)
    })
    .await
    .map_err(io)?
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEXT: &str = "第一章 雨夜\n雨下得更紧了。";

    #[test]
    fn decodes_utf8_with_and_without_bom() {
        assert_eq!(
            decode(TEXT.as_bytes(), None),
            ("UTF-8", TEXT.to_string(), false)
        );
        let bom = [b"\xEF\xBB\xBF".as_slice(), TEXT.as_bytes()].concat();
        assert_eq!(decode(&bom, None), ("UTF-8", TEXT.to_string(), false));
    }

    #[test]
    fn decodes_utf16_by_bom() {
        let le: Vec<u8> = [0xFF, 0xFE]
            .into_iter()
            .chain(TEXT.encode_utf16().flat_map(|u| u.to_le_bytes()))
            .collect();
        let be: Vec<u8> = [0xFE, 0xFF]
            .into_iter()
            .chain(TEXT.encode_utf16().flat_map(|u| u.to_be_bytes()))
            .collect();
        assert_eq!(decode(&le, None).1, TEXT);
        assert_eq!(decode(&be, None).1, TEXT);
    }

    #[test]
    fn detects_gb18030_and_big5() {
        let long = TEXT.repeat(20);
        let (gbk, _, _) = encoding_rs::GB18030.encode(&long);
        let (name, text, errors) = decode(&gbk, None);
        assert_eq!((name, errors), ("GBK", false));
        assert_eq!(text, long);
        let traditional = "第一章 雨夜\n雨下得更緊了。他沒有回頭。".repeat(20);
        let (big5, _, _) = encoding_rs::BIG5.encode(&traditional);
        let (name, text, _) = decode(&big5, None);
        assert_eq!(name, "Big5");
        assert_eq!(text, traditional);
    }

    #[test]
    fn forced_encoding_and_errors() {
        let (gbk, _, _) = encoding_rs::GB18030.encode(TEXT);
        let (_, _, errors) = decode(&gbk, Some(encoding_rs::UTF_8));
        assert!(errors);
        let (name, text, errors) = decode(&gbk, Some(encoding_rs::GB18030));
        assert_eq!((name, text.as_str(), errors), ("gb18030", TEXT, false));
    }

    #[test]
    fn entry_validation() {
        for ok in [
            "manifest.json",
            "chapters/0001-雨夜.md",
            "data/chapter.jsonl",
        ] {
            assert!(valid_entry(ok), "{ok}");
        }
        for bad in [
            "../x.md",
            "chapters/../../x.md",
            "/etc/passwd",
            "chapters/a/b.md",
            "data/x.json",
            "C:/x.md",
            "chapters\\x.md",
            "chapters/.md",
            "other.txt",
        ] {
            assert!(!valid_entry(bad), "{bad}");
        }
    }

    #[test]
    fn pack_unpack_round_trip_ignores_unknown_entries() {
        let files = vec![
            PackFile {
                path: "manifest.json".into(),
                content: "{\"format\":\"fudiao-project\"}".into(),
            },
            PackFile {
                path: "data/chapter.jsonl".into(),
                content: "{\"id\":\"c1\",\"title\":\"第一章\"}\n".into(),
            },
        ];
        let bytes = pack(&files).unwrap();
        assert_eq!(unpack(&bytes).unwrap(), files);
        assert!(pack(&[PackFile {
            path: "../evil.md".into(),
            content: String::new()
        }])
        .is_err());

        // 压缩软件附带的条目被忽略。
        let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
        zip.start_file("__MACOSX/._manifest.json", SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"x").unwrap();
        zip.start_file("manifest.json", SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"{}").unwrap();
        let bytes = zip.finish().unwrap().into_inner();
        assert_eq!(
            unpack(&bytes).unwrap(),
            vec![PackFile {
                path: "manifest.json".into(),
                content: "{}".into()
            }]
        );
    }

    #[test]
    fn unpack_rejects_traversal() {
        let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
        zip.start_file("../../evil.md", SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"x").unwrap();
        let bytes = zip.finish().unwrap().into_inner();
        assert!(unpack(&bytes).is_err());
    }
}
