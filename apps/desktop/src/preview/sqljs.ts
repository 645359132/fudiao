// 浏览器预览（只在开发时用，不随产品发布）：用 sql.js（WASM 的 SQLite）实现 SqlPort，执行与桌面端相同的迁移，
// 让界面在浏览器里用真实的用例与演示数据运行，便于看界面、截图。sql.js 没有 FTS5，跳过全文索引的迁移（查找在预览里不可用）。
import { err, ok, type Result } from '@fudiao/shared';
import type { Query, Row, SqlError, SqlPort, SqlValue, Statement, StatementResult } from '@fudiao/store';
import type { Database, SqlJsStatic } from 'sql.js';

const PROJECT_MIGRATIONS = import.meta.glob<string>('../../../../packages/store/migrations/*.sql', { query: '?raw', import: 'default', eager: true });
const APP_MIGRATIONS = import.meta.glob<string>('../../../../packages/store/app-migrations/*.sql', { query: '?raw', import: 'default', eager: true });

/** 全文索引（FTS5）在 sql.js 里没有。 */
const SKIPPED = new Set([2]);

const versionOf = (path: string) => Number(/\/(\d{4})_[^/]+\.sql$/.exec(path)?.[1] ?? 0);

function migrate(db: Database, sources: Record<string, string>, skip: ReadonlySet<number>): void {
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const entries = Object.entries(sources).sort(([a], [b]) => versionOf(a) - versionOf(b));
  for (const [path, sql] of entries) {
    const version = versionOf(path);
    if (skip.has(version)) continue;
    db.exec(sql);
    db.run('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)', [version, path.split('/').at(-1) ?? '', 'preview', new Date().toISOString()]);
  }
}

function toError(error: unknown, index: number): SqlError {
  const message = error instanceof Error ? error.message : String(error);
  return /constraint failed/i.test(message) ? { code: 'constraint', index, detail: message } : { code: 'sql_error', index, detail: message };
}

function rows(db: Database, sql: string, params: readonly SqlValue[]): Row[] {
  const stmt = db.prepare(sql);
  try {
    stmt.bind([...params]);
    const out: Row[] = [];
    while (stmt.step()) out.push(stmt.getAsObject() as Row);
    return out;
  } finally {
    stmt.free();
  }
}

/** sql.js 的 SqlPort：同一连接上读写；事务按语句顺序执行，守卫不满足或出错即回滚。 */
export function sqljsPort(db: Database): SqlPort {
  return {
    query(sql, params = []) {
      try {
        return Promise.resolve(ok(rows(db, sql, params)));
      } catch (error) {
        return Promise.resolve(err(toError(error, 0)));
      }
    },
    // 同一连接上没有别的写入会交错，一个读事务里依次执行即可。
    read(queries: readonly Query[]): Promise<Result<readonly (readonly Row[])[], SqlError>> {
      db.exec('BEGIN');
      const results: (readonly Row[])[] = [];
      for (const [index, q] of queries.entries()) {
        try {
          results.push(rows(db, q.sql, q.params ?? []));
        } catch (error) {
          db.exec('ROLLBACK');
          return Promise.resolve(err(toError(error, index)));
        }
      }
      db.exec('COMMIT');
      return Promise.resolve(ok(results));
    },
    transaction(statements: readonly Statement[]): Promise<Result<readonly StatementResult[], SqlError>> {
      db.exec('BEGIN IMMEDIATE');
      const results: StatementResult[] = [];
      for (const [index, s] of statements.entries()) {
        try {
          const out = rows(db, s.sql, s.params ?? []);
          const changes = db.getRowsModified();
          if (s.expectChanges !== undefined && changes !== s.expectChanges) {
            db.exec('ROLLBACK');
            return Promise.resolve(err({ code: 'guard_failed', index, expected: s.expectChanges, actual: changes }));
          }
          results.push({ changes, rows: out });
        } catch (error) {
          db.exec('ROLLBACK');
          return Promise.resolve(err(toError(error, index)));
        }
      }
      db.exec('COMMIT');
      return Promise.resolve(ok(results));
    },
  };
}

export function openProject(SQL: SqlJsStatic): Database {
  const db = new SQL.Database();
  migrate(db, PROJECT_MIGRATIONS, SKIPPED);
  return db;
}

export function openSettings(SQL: SqlJsStatic): Database {
  const db = new SQL.Database();
  migrate(db, APP_MIGRATIONS, new Set());
  return db;
}

/** 最新的迁移版本（OpenReport 用）。 */
export const latestVersion = Math.max(...Object.keys(PROJECT_MIGRATIONS).map(versionOf));
