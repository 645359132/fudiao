import { err, ok, type Result } from '@fudiao/shared';
import type { OpenError, OpenReport, Row, SqlError, SqlPort, StatementResult } from '@fudiao/store';

/** Tauri 的 invoke（`@tauri-apps/api/core`）；以参数注入，测试中替换为假实现。 */
export type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

/** Rust 命令返回 Err 时，invoke 以序列化后的错误对象拒绝；其他拒绝原因（例如 IPC 失败）是字符串或 Error。 */
const isCoded = (e: unknown): e is { code: string } =>
  typeof e === 'object' && e !== null && typeof (e as { code?: unknown }).code === 'string';

const describe = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function call<T, E>(promise: Promise<T>, fallback: (detail: string) => E): Promise<Result<T, E>> {
  try {
    return ok(await promise);
  } catch (e) {
    return err(isCoded(e) ? (e as E) : fallback(describe(e)));
  }
}

const sqlFallback = (detail: string): SqlError => ({ code: 'sql_error', index: 0, detail });

/**
 * SqlPort 的桌面实现：经 Rust 命令 `db_query`、`db_tx` 访问当前打开的作品库；
 * prefix 为 `app_db` 时访问应用设置库（`app_db_query`、`app_db_tx`）。
 */
export function tauriSqlPort(invoke: Invoke, prefix: 'db' | 'app_db' = 'db'): SqlPort {
  return {
    query: (sql, params) => call(invoke<Row[]>(`${prefix}_query`, { sql, params: params ?? [] }), sqlFallback),
    transaction: (statements) => call(invoke<StatementResult[]>(`${prefix}_tx`, { statements }), sqlFallback),
  };
}

/** 打开应用设置库 app.sqlite（应用数据目录）。 */
export function openAppDb(invoke: Invoke, now: string): Promise<Result<OpenReport, OpenError>> {
  return call(invoke<OpenReport>('app_db_open', { now }), (detail): OpenError => ({ code: 'io_error', detail }));
}

/** 打开或创建作品库并执行迁移；`now` 来自时钟端口（UTC ISO 字符串）。 */
export function openProjectDb(invoke: Invoke, projectDir: string, now: string): Promise<Result<OpenReport, OpenError>> {
  return call(invoke<OpenReport>('db_open', { projectDir, now }), (detail): OpenError => ({ code: 'io_error', detail }));
}

export function closeProjectDb(invoke: Invoke): Promise<void> {
  return invoke<void>('db_close');
}
