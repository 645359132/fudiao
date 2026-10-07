//! 迁移执行。规则与 packages/store/src/node/sqlite.ts 相同（见 packages/store/migrations/README.md）。

use std::{fs, path::Path};

use rusqlite::{params, Connection};
use serde::Serialize;
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Copy)]
pub struct Migration<'a> {
    pub version: u32,
    pub name: &'a str,
    pub sql: &'a str,
}

// build.rs 生成：packages/store/migrations 下的全部迁移，按版本号排序。
include!(concat!(env!("OUT_DIR"), "/migrations.rs"));

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Applied {
    pub version: u32,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OpenReport {
    pub schema_version: u32,
    pub applied: Vec<Applied>,
    /// 执行迁移前生成的备份文件；没有待执行的迁移或新建的库时为 None。
    pub backup: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum OpenError {
    ChecksumMismatch { version: u32 },
    SchemaTooNew { version: u32, known: u32 },
    MigrationFailed { version: u32, detail: String },
    IoError { detail: String },
}

/// 计算校验和前统一换行符，同一文件在 Windows 与 Linux 检出时校验和相同。
pub fn checksum(sql: &str) -> String {
    let digest = Sha256::digest(sql.replace("\r\n", "\n").as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// 迁移前备份的文件名；时间中的冒号替换掉，以便在 Windows 上作文件名。
pub fn backup_file_name(from_version: u32, now: &str) -> String {
    format!(
        "pre-migration-v{from_version}-{}.sqlite",
        now.replace(':', "-")
    )
}

pub fn migrate(
    conn: &Connection,
    project_dir: &Path,
    migrations: &[Migration<'_>],
    now: &str,
) -> Result<OpenReport, OpenError> {
    let io = |e: rusqlite::Error| OpenError::IoError {
        detail: e.to_string(),
    };
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)",
    )
    .map_err(io)?;
    let applied: Vec<(u32, String)> = {
        let mut stmt = conn
            .prepare("SELECT version, checksum FROM schema_migrations ORDER BY version")
            .map_err(io)?;
        let rows = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(io)?;
        rows.collect::<Result<_, _>>().map_err(io)?
    };

    let latest = migrations.last().map_or(0, |m| m.version);
    let current = applied.last().map_or(0, |a| a.0);
    if current > latest {
        return Err(OpenError::SchemaTooNew {
            version: current,
            known: latest,
        });
    }
    for (version, sum) in &applied {
        let known = migrations.iter().find(|m| m.version == *version);
        if known.map(|m| checksum(m.sql)) != Some(sum.clone()) {
            return Err(OpenError::ChecksumMismatch { version: *version });
        }
    }

    let pending: Vec<&Migration<'_>> = migrations
        .iter()
        .filter(|m| !applied.iter().any(|a| a.0 == m.version))
        .collect();
    let mut backup = None;
    if !pending.is_empty() && current > 0 {
        let dir = project_dir.join("backups");
        fs::create_dir_all(&dir).map_err(|e| OpenError::IoError {
            detail: e.to_string(),
        })?;
        let path = dir.join(backup_file_name(current, now));
        let path_text = path.to_string_lossy().to_string();
        conn.execute("VACUUM INTO ?1", [&path_text]).map_err(io)?;
        backup = Some(path_text);
    }

    for m in &pending {
        let failed = |e: rusqlite::Error| OpenError::MigrationFailed {
            version: m.version,
            detail: e.to_string(),
        };
        let result = conn.execute_batch("BEGIN IMMEDIATE").and_then(|_| {
            conn.execute_batch(m.sql)?;
            conn.execute(
                "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?1, ?2, ?3, ?4)",
                params![m.version, m.name, checksum(m.sql), now],
            )?;
            conn.execute_batch("COMMIT")
        });
        if let Err(e) = result {
            if !conn.is_autocommit() {
                let _ = conn.execute_batch("ROLLBACK");
            }
            return Err(failed(e));
        }
    }

    Ok(OpenReport {
        schema_version: pending.last().map_or(current, |m| m.version),
        applied: pending
            .iter()
            .map(|m| Applied {
                version: m.version,
                name: m.name.to_string(),
            })
            .collect(),
        backup,
    })
}
