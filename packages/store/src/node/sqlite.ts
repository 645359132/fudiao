// SqlPort 的 Node 实现（better-sqlite3），供测试与 M0 使用。桌面端的 Rust 实现遵循同一份契约用例
// （packages/store/contract/sql-cases.json）与同样的迁移规则。
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { err, ok, type Result } from '@fudiao/shared';
import {
  backupFileName,
  normalizeMigration,
  parseMigrationName,
  type Migration,
  type OpenError,
  type OpenReport,
  type Row,
  type SqlError,
  type SqlPort,
  type SqlValue,
  type Statement,
  type StatementResult,
} from '../sql';

/** 作品库文件名（施工文档第四章：每部作品一个项目文件夹）。 */
export const PROJECT_DB_FILE = 'project.sqlite';

// 用文件路径而不是 new URL 计算：jsdom 测试环境会替换全局 URL，Node 的 fileURLToPath 不接受它。
export const defaultMigrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

export function migrationChecksum(sql: string): string {
  return createHash('sha256').update(normalizeMigration(sql)).digest('hex');
}

/** 读取目录中的迁移文件，按版本号排序。版本号重复时报错。 */
export function loadMigrations(dir: string = defaultMigrationsDir): Migration[] {
  if (!existsSync(dir)) return [];
  const migrations = readdirSync(dir).flatMap((file) => {
    const parsed = parseMigrationName(file);
    return parsed === null ? [] : [{ ...parsed, sql: readFileSync(join(dir, file), 'utf8') }];
  });
  migrations.sort((a, b) => a.version - b.version);
  for (let i = 1; i < migrations.length; i++) {
    if (migrations[i]?.version === migrations[i - 1]?.version) throw new Error(`迁移版本号重复：${migrations[i]?.version}`);
  }
  return migrations;
}

export type ProjectDb = SqlPort & { close(): void };

/**
 * 打开或创建 `<projectDir>/project.sqlite` 并执行待执行的迁移。已有数据的库在迁移前先用 VACUUM INTO 备份。
 * 已执行的迁移校验和不一致，或库的版本高于已知的最新迁移时拒绝打开。
 */
export function openProjectDb(
  projectDir: string,
  options: { readonly migrations: readonly Migration[]; readonly now: string },
): Result<{ readonly db: ProjectDb; readonly report: OpenReport }, OpenError> {
  let writer: Database.Database;
  try {
    mkdirSync(projectDir, { recursive: true });
    writer = new Database(join(projectDir, PROJECT_DB_FILE));
    writer.pragma('journal_mode = WAL');
    writer.pragma('synchronous = NORMAL');
    writer.pragma('foreign_keys = ON');
    writer.pragma('busy_timeout = 5000');
  } catch (error) {
    return err({ code: 'io_error', detail: message(error) });
  }

  const migrated = migrate(writer, projectDir, options.migrations, options.now);
  if (!migrated.ok) {
    writer.close();
    return migrated;
  }
  // 只读连接在迁移完成后打开，读到的总是最新结构。
  const reader = new Database(join(projectDir, PROJECT_DB_FILE), { readonly: true, fileMustExist: true });
  reader.pragma('busy_timeout = 5000');
  return ok({ db: port(writer, reader), report: migrated.value });
}

function migrate(db: Database.Database, projectDir: string, migrations: readonly Migration[], now: string): Result<OpenReport, OpenError> {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)',
  );
  const applied = db.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all() as { version: number; checksum: string }[];
  const latest = migrations.at(-1)?.version ?? 0;
  const current = applied.at(-1)?.version ?? 0;
  if (current > latest) return err({ code: 'schema_too_new', version: current, known: latest });
  for (const a of applied) {
    const known = migrations.find((m) => m.version === a.version);
    if (known === undefined || migrationChecksum(known.sql) !== a.checksum) return err({ code: 'checksum_mismatch', version: a.version });
  }

  const done = new Set(applied.map((a) => a.version));
  const pending = migrations.filter((m) => !done.has(m.version));
  let backup: string | null = null;
  if (pending.length > 0 && current > 0) {
    try {
      mkdirSync(join(projectDir, 'backups'), { recursive: true });
      backup = join(projectDir, 'backups', backupFileName(current, now));
      db.prepare('VACUUM INTO ?').run(backup);
    } catch (error) {
      return err({ code: 'io_error', detail: message(error) });
    }
  }
  for (const m of pending) {
    try {
      db.exec('BEGIN IMMEDIATE');
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)').run(
        m.version,
        m.name,
        migrationChecksum(m.sql),
        now,
      );
      db.exec('COMMIT');
    } catch (error) {
      if (db.inTransaction) db.exec('ROLLBACK');
      return err({ code: 'migration_failed', version: m.version, detail: message(error) });
    }
  }
  return ok({
    schemaVersion: pending.at(-1)?.version ?? current,
    applied: pending.map((m) => ({ version: m.version, name: m.name })),
    backup,
  });
}

/** 语句执行中的预期错误，在事务边界转换为 Result。 */
class Failure extends Error {
  constructor(readonly error: SqlError) {
    super(error.code);
  }
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

// 整数以 BigInt 绑定，与 Rust 端一样存为 INTEGER（否则 better-sqlite3 会把 JS 数字绑定为 REAL）。
const bind = (params: readonly SqlValue[] = []) =>
  params.map((p) => (typeof p === 'number' && Number.isInteger(p) ? BigInt(p) : p));

function toRow(raw: Record<string, unknown>, index: number): Row {
  const row: Record<string, SqlValue> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'bigint') {
      if (value > MAX_SAFE || value < -MAX_SAFE) throw new Failure({ code: 'sql_error', index, detail: `列 ${key} 的整数超出安全范围` });
      row[key] = Number(value);
    } else if (value === null || typeof value === 'number' || typeof value === 'string') {
      row[key] = value;
    } else {
      throw new Failure({ code: 'sql_error', index, detail: `列 ${key} 的类型不受支持` });
    }
  }
  return row;
}

function mapError(error: unknown, index: number): SqlError {
  if (error instanceof Failure) return error.error;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT')) return { code: 'constraint', index, detail: message(error) };
  if (code === 'SQLITE_BUSY') return { code: 'busy' };
  return { code: 'sql_error', index, detail: message(error) };
}

function run(db: Database.Database, s: Statement, index: number): StatementResult {
  const stmt = db.prepare(s.sql).safeIntegers(true);
  if (stmt.reader) {
    const rows = (stmt.all(...bind(s.params)) as Record<string, unknown>[]).map((r) => toRow(r, index));
    // RETURNING 的语句既返回行又有影响行数；只读语句的 changes() 是上一条写语句的残留，记为 0。
    const changes = stmt.readonly ? 0 : Number(db.prepare('SELECT changes() AS c').pluck().get());
    return { changes, rows };
  }
  return { changes: stmt.run(...bind(s.params)).changes, rows: [] };
}

function port(writer: Database.Database, reader: Database.Database): ProjectDb {
  return {
    query(sql, params) {
      try {
        const stmt = reader.prepare(sql);
        if (!stmt.readonly) return Promise.resolve(err({ code: 'readonly', detail: 'query 只接受只读语句' }));
        return Promise.resolve(ok(run(reader, { sql, ...(params && { params }) }, 0).rows));
      } catch (error) {
        return Promise.resolve(err(mapError(error, 0)));
      }
    },

    transaction(statements) {
      let index = 0;
      try {
        writer.exec('BEGIN IMMEDIATE');
        const results: StatementResult[] = [];
        for (const s of statements) {
          const result = run(writer, s, index);
          if (s.expectChanges !== undefined && result.changes !== s.expectChanges) {
            throw new Failure({ code: 'guard_failed', index, expected: s.expectChanges, actual: result.changes });
          }
          results.push(result);
          index++;
        }
        writer.exec('COMMIT');
        return Promise.resolve(ok(results));
      } catch (error) {
        if (writer.inTransaction) writer.exec('ROLLBACK');
        return Promise.resolve(err(mapError(error, index)));
      }
    },

    close() {
      reader.close();
      writer.close();
    },
  };
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
