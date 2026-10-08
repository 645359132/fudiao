//! 作品备份（需求 B06）：`VACUUM INTO` 写出一致的完整副本，放在作品文件夹的 `backups/`。
//! 文件名为 `<种类>-<时间>.sqlite`：auto（打开作品时自动）、manual（手动）、pre-restore（恢复前）、
//! pre-migration-v<版本>（迁移前，见 migrate.rs）。只有 auto 会按份数自动清理。

use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::Serialize;

use super::{Database, SqlError};

pub const BACKUP_DIR: &str = "backups";
/// 自动备份保留的份数。
pub const KEEP_AUTO: usize = 30;
/// 时间部分的长度：`2026-10-08T01-02-03.000Z`。
const TIME_LEN: usize = 24;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub name: String,
    pub kind: String,
    /// UTC ISO 时间（由文件名还原）。
    pub created_at: String,
    pub size_bytes: u64,
}

pub fn backup_name(kind: &str, now: &str) -> String {
    format!("{kind}-{}.sqlite", now.replace(':', "-"))
}

/// 由文件名得到种类与时间；不是备份文件名时为 None。
fn parse(name: &str) -> Option<(String, String)> {
    let stem = name.strip_suffix(".sqlite")?;
    if stem.len() <= TIME_LEN + 1 || !stem.is_char_boundary(stem.len() - TIME_LEN) {
        return None;
    }
    let (head, time) = stem.split_at(stem.len() - TIME_LEN);
    let kind = head.strip_suffix('-')?;
    let kind = if kind.starts_with("pre-migration-v") {
        "pre-migration"
    } else {
        kind
    };
    if !matches!(kind, "auto" | "manual" | "pre-restore" | "pre-migration") {
        return None;
    }
    let bytes = time.as_bytes();
    if bytes.get(10) != Some(&b'T') || !time.ends_with('Z') {
        return None;
    }
    let mut iso = time.to_string();
    iso.replace_range(13..14, ":");
    iso.replace_range(16..17, ":");
    Some((kind.to_string(), iso))
}

/// 备份列表，最近的在前。
pub fn list(project_dir: &Path) -> Vec<BackupInfo> {
    let Ok(entries) = fs::read_dir(project_dir.join(BACKUP_DIR)) else {
        return Vec::new();
    };
    let mut out: Vec<BackupInfo> = entries
        .filter_map(Result::ok)
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let (kind, created_at) = parse(&name)?;
            let size_bytes = e.metadata().ok()?.len();
            Some(BackupInfo {
                name,
                kind,
                created_at,
                size_bytes,
            })
        })
        .collect();
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(b.name.cmp(&a.name)));
    out
}

/// 只保留最近 keep 份自动备份。
pub fn prune_auto(project_dir: &Path, keep: usize) {
    for old in list(project_dir)
        .into_iter()
        .filter(|b| b.kind == "auto")
        .skip(keep)
    {
        let _ = fs::remove_file(project_dir.join(BACKUP_DIR).join(old.name));
    }
}

/// 备份名必须是备份目录中已有的备份文件，防止借名称读写作品文件夹以外的文件。
pub fn resolve(project_dir: &Path, name: &str) -> Option<PathBuf> {
    if name.contains(['/', '\\', ':']) || name.contains("..") || parse(name).is_none() {
        return None;
    }
    let path = project_dir.join(BACKUP_DIR).join(name);
    path.is_file().then_some(path)
}

pub fn create(db: &Database, kind: &str, now: &str) -> Result<BackupInfo, SqlError> {
    let dir = db.dir().join(BACKUP_DIR);
    fs::create_dir_all(&dir).map_err(|e| SqlError::SqlError {
        index: 0,
        detail: e.to_string(),
    })?;
    let name = backup_name(kind, now);
    db.vacuum_into(&dir.join(&name))?;
    if kind == "auto" {
        prune_auto(db.dir(), KEEP_AUTO);
    }
    list(db.dir())
        .into_iter()
        .find(|b| b.name == name)
        .ok_or_else(|| SqlError::SqlError {
            index: 0,
            detail: "备份没有写出".into(),
        })
}

/// 恢复成功：重新打开的作品库、打开报告与恢复前备份。
pub type Restored = (Database, super::OpenReport, BackupInfo);
/// 恢复失败：仍能打开时交回作品库，以及失败原因。
pub type RestoreFailure = Box<(Option<Database>, super::OpenError)>;

/// 恢复到备份：先把现稿存为 pre-restore 备份，关闭连接，用备份替换作品库，再重新打开（需要时执行迁移）。
/// 替换前先复制成临时文件再改名，中途失败时作品库保持原样；现稿在任何情况下都已有备份。
pub fn restore(
    db: Database,
    name: &str,
    migrations: &[super::Migration<'_>],
    now: &str,
) -> Result<Restored, RestoreFailure> {
    let io = |detail: String| super::OpenError::IoError { detail };
    let dir = db.dir().to_path_buf();
    let Some(source) = resolve(&dir, name) else {
        return Err(Box::new((Some(db), io(format!("找不到备份：{name}")))));
    };
    let saved = match create(&db, "pre-restore", now) {
        Ok(info) => info,
        Err(e) => return Err(Box::new((Some(db), io(format!("恢复前备份失败：{e:?}"))))),
    };
    // 关闭所有连接；SQLite 在最后一个连接关闭时把 WAL 合并回主文件。
    drop(db);
    let target = dir.join(super::PROJECT_DB_FILE);
    let staging = dir.join(format!("{}.restore-tmp", super::PROJECT_DB_FILE));
    let replaced = fs::copy(&source, &staging).and_then(|_| {
        for suffix in ["-wal", "-shm"] {
            let side = dir.join(format!("{}{suffix}", super::PROJECT_DB_FILE));
            if side.exists() {
                fs::remove_file(side)?;
            }
        }
        fs::rename(&staging, &target)
    });
    if let Err(e) = replaced {
        let _ = fs::remove_file(&staging);
        let reopened = Database::open(&dir, migrations, now).ok().map(|(db, _)| db);
        return Err(Box::new((reopened, io(format!("替换作品库失败：{e}")))));
    }
    match Database::open(&dir, migrations, now) {
        Ok((db, report)) => Ok((db, report, saved)),
        Err(e) => Err(Box::new((None, e))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrate::backup_file_name;

    #[test]
    fn parses_names_of_every_kind() {
        assert_eq!(
            parse("auto-2026-10-08T01-02-03.000Z.sqlite"),
            Some(("auto".into(), "2026-10-08T01:02:03.000Z".into()))
        );
        assert_eq!(
            parse(&backup_file_name(1, "2026-10-08T01:02:03.000Z")),
            Some(("pre-migration".into(), "2026-10-08T01:02:03.000Z".into()))
        );
        assert_eq!(
            parse("pre-restore-2026-10-08T01-02-03.000Z.sqlite").map(|p| p.0),
            Some("pre-restore".into())
        );
        for bad in [
            "project.sqlite",
            "auto-x.sqlite",
            "evil-2026-10-08T01-02-03.000Z.sqlite",
            "auto-2026-10-08T01-02-03.000Z.db",
        ] {
            assert_eq!(parse(bad), None, "{bad}");
        }
    }

    #[test]
    fn lists_newest_first_and_prunes_only_auto() {
        let dir = tempfile::tempdir().unwrap();
        let backups = dir.path().join(BACKUP_DIR);
        fs::create_dir_all(&backups).unwrap();
        for minute in 0..35 {
            fs::write(
                backups.join(backup_name(
                    "auto",
                    &format!("2026-10-01T00:{minute:02}:00.000Z"),
                )),
                b"x",
            )
            .unwrap();
        }
        fs::write(
            backups.join(backup_name("manual", "2026-01-01T00:00:00.000Z")),
            b"x",
        )
        .unwrap();
        fs::write(backups.join("notes.txt"), b"x").unwrap();
        let all = list(dir.path());
        assert_eq!(all.len(), 36);
        assert!(all.windows(2).all(|w| w[0].created_at >= w[1].created_at));
        prune_auto(dir.path(), KEEP_AUTO);
        let left = list(dir.path());
        assert_eq!(left.iter().filter(|b| b.kind == "auto").count(), KEEP_AUTO);
        assert_eq!(left.iter().filter(|b| b.kind == "manual").count(), 1);
        // 删掉的是最早的自动备份。
        assert_eq!(
            left.iter().rfind(|b| b.kind == "auto").unwrap().created_at,
            "2026-10-01T00:05:00.000Z"
        );
    }

    #[test]
    fn resolve_rejects_paths_and_unknown_files() {
        let dir = tempfile::tempdir().unwrap();
        let backups = dir.path().join(BACKUP_DIR);
        fs::create_dir_all(&backups).unwrap();
        let name = backup_name("manual", "2026-10-08T01:02:03.000Z");
        fs::write(backups.join(&name), b"x").unwrap();
        assert!(resolve(dir.path(), &name).is_some());
        assert!(resolve(
            dir.path(),
            &backup_name("manual", "2026-10-09T01:02:03.000Z")
        )
        .is_none());
        for bad in [
            "../project.sqlite",
            "..\\project.sqlite",
            "project.sqlite",
            "C:/x.sqlite",
        ] {
            assert!(resolve(dir.path(), bad).is_none(), "{bad}");
        }
    }
}
