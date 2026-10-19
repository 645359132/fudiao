//! 作品库的数据库访问（施工文档第二、三章）：一个写连接加只读连接池，WAL 模式下读写互不阻塞。
//! TypeScript 经 `SqlPort` 使用；行为与 Node 实现共用 packages/store/contract/sql-cases.json 的契约用例。

pub mod backup;
pub mod commands;
pub mod migrate;
mod value;

use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex, MutexGuard,
    },
    time::Duration,
};

use rusqlite::{
    limits::Limit, params_from_iter, Connection, ErrorCode, OpenFlags, TransactionBehavior,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub use migrate::{Migration, OpenError, OpenReport};

/// 作品库文件名（与 packages/store/src/node/sqlite.ts 的 PROJECT_DB_FILE 相同）。
pub const PROJECT_DB_FILE: &str = "project.sqlite";
/// 应用设置库文件名，位于应用数据目录（与 Node 端的 APP_DB_FILE 相同）。
pub const APP_DB_FILE: &str = "app.sqlite";
const READERS: usize = 2;
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

pub type Row = Map<String, Value>;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Statement {
    pub sql: String,
    #[serde(default)]
    pub params: Vec<Value>,
    /// 乐观并发的守卫：影响行数不等于预期时整个事务回滚。
    pub expect_changes: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct StatementResult {
    pub changes: i64,
    pub rows: Vec<Row>,
}

/// 与 packages/store/src/sql.ts 的 SqlError 对应。detail 只含 SQLite 的错误信息，不含参数，避免正文进入日志。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum SqlError {
    NotOpen,
    Readonly {
        detail: String,
    },
    GuardFailed {
        index: usize,
        expected: i64,
        actual: i64,
    },
    Constraint {
        index: usize,
        detail: String,
    },
    Busy,
    SqlError {
        index: usize,
        detail: String,
    },
}

pub struct Database {
    dir: PathBuf,
    writer: Mutex<Connection>,
    readers: Vec<Mutex<Connection>>,
    next: AtomicUsize,
}

impl Database {
    /// 打开或创建 `<project_dir>/project.sqlite`，执行待执行的迁移，再打开只读连接。
    pub fn open(
        project_dir: &Path,
        migrations: &[Migration<'_>],
        now: &str,
    ) -> Result<(Database, OpenReport), OpenError> {
        Database::open_file(project_dir, PROJECT_DB_FILE, migrations, now)
    }

    /// 同 `open`，库文件名由调用方给出（应用设置库 `app.sqlite`）。迁移前的备份同样写在该目录的 `backups/` 中。
    pub fn open_file(
        project_dir: &Path,
        file: &str,
        migrations: &[Migration<'_>],
        now: &str,
    ) -> Result<(Database, OpenReport), OpenError> {
        let io = |e: &dyn std::fmt::Display| OpenError::IoError {
            detail: e.to_string(),
        };
        fs::create_dir_all(project_dir).map_err(|e| io(&e))?;
        let path = project_dir.join(file);

        let writer = Connection::open(&path).map_err(|e| io(&e))?;
        writer
            .pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get::<_, String>(0))
            .map_err(|e| io(&e))?;
        writer
            .pragma_update(None, "synchronous", "NORMAL")
            .map_err(|e| io(&e))?;
        writer
            .pragma_update(None, "foreign_keys", "ON")
            .map_err(|e| io(&e))?;
        writer.busy_timeout(BUSY_TIMEOUT).map_err(|e| io(&e))?;

        let report = migrate::migrate(&writer, project_dir, migrations, now)?;
        // ATTACH 能通过 query 的只读检查，在事务里也能执行，借它可以读写任意位置的文件。
        // 所有连接都禁止；备份的 VACUUM INTO 内部要用到它，由 vacuum_into 临时放开。
        writer
            .set_limit(Limit::SQLITE_LIMIT_ATTACHED, 0)
            .map_err(|e| io(&e))?;

        // 只读连接在迁移完成后打开，读到的总是最新结构。
        let mut readers = Vec::with_capacity(READERS);
        for _ in 0..READERS {
            let reader = Connection::open_with_flags(
                &path,
                OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )
            .map_err(|e| io(&e))?;
            reader.busy_timeout(BUSY_TIMEOUT).map_err(|e| io(&e))?;
            reader
                .set_limit(Limit::SQLITE_LIMIT_ATTACHED, 0)
                .map_err(|e| io(&e))?;
            readers.push(Mutex::new(reader));
        }
        Ok((
            Database {
                dir: project_dir.to_path_buf(),
                writer: Mutex::new(writer),
                readers,
                next: AtomicUsize::new(0),
            },
            report,
        ))
    }

    /// 作品文件夹。
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// 用写连接把整个库写成一份一致的副本（备份）。
    pub fn vacuum_into(&self, target: &Path) -> Result<(), SqlError> {
        let conn = self.writer.lock().unwrap_or_else(|e| e.into_inner());
        conn.set_limit(Limit::SQLITE_LIMIT_ATTACHED, 1)
            .map_err(|e| map_error(e, 0))?;
        let result = conn
            .execute("VACUUM INTO ?1", [target.to_string_lossy().as_ref()])
            .map(|_| ())
            .map_err(|e| map_error(e, 0));
        conn.set_limit(Limit::SQLITE_LIMIT_ATTACHED, 0)
            .map_err(|e| map_error(e, 0))?;
        result
    }

    /// 在只读连接上执行一条只读语句。
    pub fn query(&self, sql: &str, params: &[Value]) -> Result<Vec<Row>, SqlError> {
        let conn = self.reader();
        let stmt = conn.prepare(sql).map_err(|e| map_error(e, 0))?;
        if !stmt.readonly() {
            return Err(SqlError::Readonly {
                detail: "query 只接受只读语句".into(),
            });
        }
        drop(stmt);
        Ok(run(&conn, sql, params, 0)?.rows)
    }

    /// 在写连接上以 BEGIN IMMEDIATE 执行一个事务；任一语句出错或守卫不满足即回滚。
    pub fn transaction(&self, statements: &[Statement]) -> Result<Vec<StatementResult>, SqlError> {
        let mut conn = self.writer.lock().unwrap_or_else(|e| e.into_inner());
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| map_error(e, 0))?;
        let mut results = Vec::with_capacity(statements.len());
        for (index, s) in statements.iter().enumerate() {
            let result = run(&tx, &s.sql, &s.params, index)?;
            if let Some(expected) = s.expect_changes {
                if result.changes != expected {
                    // tx 在返回时被丢弃，自动回滚。
                    return Err(SqlError::GuardFailed {
                        index,
                        expected,
                        actual: result.changes,
                    });
                }
            }
            results.push(result);
        }
        tx.commit().map_err(|e| map_error(e, statements.len()))?;
        Ok(results)
    }

    /// 优先取空闲的只读连接，都在使用时按轮转等待其中一个。
    fn reader(&self) -> MutexGuard<'_, Connection> {
        for reader in &self.readers {
            if let Ok(guard) = reader.try_lock() {
                return guard;
            }
        }
        let i = self.next.fetch_add(1, Ordering::Relaxed) % self.readers.len();
        self.readers[i].lock().unwrap_or_else(|e| e.into_inner())
    }
}

fn run(
    conn: &Connection,
    sql: &str,
    params: &[Value],
    index: usize,
) -> Result<StatementResult, SqlError> {
    let mut stmt = conn.prepare(sql).map_err(|e| map_error(e, index))?;
    let readonly = stmt.readonly();
    let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let values = params
        .iter()
        .map(|p| value::to_sql(p).map_err(|detail| SqlError::SqlError { index, detail }))
        .collect::<Result<Vec<_>, _>>()?;

    let mut rows = stmt
        .query(params_from_iter(values.iter()))
        .map_err(|e| map_error(e, index))?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(|e| map_error(e, index))? {
        let mut map = Map::with_capacity(names.len());
        for (i, name) in names.iter().enumerate() {
            let cell = row.get_ref(i).map_err(|e| map_error(e, index))?;
            let json = value::from_sql(cell).map_err(|why| SqlError::SqlError {
                index,
                detail: format!("列 {name}：{why}"),
            })?;
            map.insert(name.clone(), json);
        }
        out.push(map);
    }
    drop(rows);
    // RETURNING 的语句既返回行又有影响行数；只读语句的 changes() 是上一条写语句的残留，记为 0。
    let changes = if readonly { 0 } else { conn.changes() as i64 };
    Ok(StatementResult { changes, rows: out })
}

fn map_error(error: rusqlite::Error, index: usize) -> SqlError {
    match &error {
        rusqlite::Error::SqliteFailure(failure, _) => match failure.code {
            ErrorCode::ConstraintViolation => SqlError::Constraint {
                index,
                detail: error.to_string(),
            },
            ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked => SqlError::Busy,
            ErrorCode::ReadOnly => SqlError::Readonly {
                detail: error.to_string(),
            },
            _ => SqlError::SqlError {
                index,
                detail: error.to_string(),
            },
        },
        _ => SqlError::SqlError {
            index,
            detail: error.to_string(),
        },
    }
}
