use std::{env, fs, path::Path};

fn main() {
    embed_migrations();
    tauri_build::build()
}

/// 把 packages/store/migrations 下的迁移文件编译期嵌入程序：安装后的程序不依赖源码目录，
/// 与 Node 端读取的是同一批文件（施工文档第四章）。
fn embed_migrations() {
    let manifest = env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
    let dir = Path::new(&manifest).join("../../../packages/store/migrations");
    println!("cargo:rerun-if-changed={}", dir.display());

    let mut entries: Vec<(u32, String, String)> = Vec::new();
    if dir.exists() {
        for entry in fs::read_dir(&dir).expect("无法读取迁移目录") {
            let path = entry.expect("无法读取迁移文件").path();
            let file = path
                .file_name()
                .and_then(|f| f.to_str())
                .unwrap_or_default()
                .to_string();
            let Some((version, name)) = parse_name(&file) else {
                continue;
            };
            println!("cargo:rerun-if-changed={}", path.display());
            let absolute = fs::canonicalize(&path).expect("无法解析迁移文件路径");
            entries.push((version, name, absolute.display().to_string()));
        }
    }
    entries.sort_by_key(|e| e.0);
    for pair in entries.windows(2) {
        assert!(pair[0].0 != pair[1].0, "迁移版本号重复：{}", pair[0].0);
    }

    let items: String = entries
        .iter()
        .map(|(version, name, path)| {
            format!("    Migration {{ version: {version}, name: {name:?}, sql: include_str!({path:?}) }},\n")
        })
        .collect();
    let out = Path::new(&env::var("OUT_DIR").expect("OUT_DIR")).join("migrations.rs");
    fs::write(
        out,
        format!("pub static EMBEDDED: &[Migration<'static>] = &[\n{items}];\n"),
    )
    .expect("无法写出迁移列表");
}

/// 与 packages/store/src/sql.ts 的 parseMigrationName 相同：`NNNN_名称.sql`，名称只用小写字母、数字与下划线。
fn parse_name(file: &str) -> Option<(u32, String)> {
    let stem = file.strip_suffix(".sql")?;
    let (digits, name) = stem.split_once('_')?;
    let valid_digits = digits.len() == 4 && digits.bytes().all(|b| b.is_ascii_digit());
    let valid_name = !name.is_empty()
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_');
    if !valid_digits || !valid_name {
        return None;
    }
    Some((digits.parse().ok()?, name.to_string()))
}
