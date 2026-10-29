import type { Result } from '@fudiao/shared';

/**
 * SQL 参数与列值。整数必须在安全整数范围内（标识用 ULID 文本，不用自增整数作为外部标识）；
 * 布尔由仓储转为 0 与 1。二进制列首版不支持。
 */
export type SqlValue = null | number | string;

export type Row = Readonly<Record<string, SqlValue>>;

export type Statement = {
  readonly sql: string;
  readonly params?: readonly SqlValue[];
  /** 乐观并发的守卫：影响行数不等于预期时，整个事务回滚。 */
  readonly expectChanges?: number;
};

/** 每条语句的结果：影响行数（只读语句为 0）与返回的行（SELECT 或 RETURNING）。 */
export type StatementResult = { readonly changes: number; readonly rows: readonly Row[] };

/** 批量读取里的一条只读查询。 */
export type Query = { readonly sql: string; readonly params?: readonly SqlValue[] };

export type SqlError =
  | { readonly code: 'not_open' }
  | { readonly code: 'readonly'; readonly detail: string }
  | { readonly code: 'guard_failed'; readonly index: number; readonly expected: number; readonly actual: number }
  | { readonly code: 'constraint'; readonly index: number; readonly detail: string }
  | { readonly code: 'busy' }
  | { readonly code: 'sql_error'; readonly index: number; readonly detail: string };

/**
 * 作品库的查询与事务端口（施工文档第三章）。桌面端经 Rust 命令实现，Node 端用 better-sqlite3。
 *
 * 事务以一批语句一次提交，不提供跨调用的交互式事务：写锁不跨越 WebView 与 Rust 之间的等待。
 * 先读后写用 expectChanges 守卫表达，例如 `UPDATE … WHERE version = ?` 期望影响 1 行。
 */
export interface SqlPort {
  /** 在只读连接上执行；写语句返回 readonly 错误。 */
  query(sql: string, params?: readonly SqlValue[]): Promise<Result<readonly Row[], SqlError>>;
  /**
   * 在只读连接的一个读事务里依次执行一批只读查询，各条读到的是同一个快照（WAL 下不挡写入）：
   * 导出作品包这类要几张表彼此一致的读取用它，分开 query 会读到后台写入交错后的样子。写语句返回 readonly 错误，一条出错整批失败。
   */
  read(queries: readonly Query[]): Promise<Result<readonly (readonly Row[])[], SqlError>>;
  /** 在写连接上以 BEGIN IMMEDIATE 执行一个事务；任一语句出错或守卫不满足即回滚。 */
  transaction(statements: readonly Statement[]): Promise<Result<readonly StatementResult[], SqlError>>;
}

/** 一个迁移文件：`NNNN_名称.sql`，版本号为前缀数字。 */
export type Migration = { readonly version: number; readonly name: string; readonly sql: string };

/** 打开作品库的结果。 */
export type OpenReport = {
  readonly schemaVersion: number;
  readonly applied: readonly { readonly version: number; readonly name: string }[];
  /** 执行迁移前生成的备份文件；没有待执行的迁移或新建的库时为 null。 */
  readonly backup: string | null;
};

export type OpenError =
  | { readonly code: 'checksum_mismatch'; readonly version: number }
  | { readonly code: 'schema_too_new'; readonly version: number; readonly known: number }
  | { readonly code: 'migration_failed'; readonly version: number; readonly detail: string }
  | { readonly code: 'io_error'; readonly detail: string }
  /** 这部作品已经在另一个窗口里打开（桌面端每个窗口各开一部作品，同一部只开在一个窗口里）。 */
  | { readonly code: 'already_open' };

const MIGRATION_FILE = /^(\d{4})_([a-z0-9_]+)\.sql$/;

/** 解析迁移文件名；不符合 `NNNN_名称.sql` 的文件不是迁移（例如 README）。 */
export function parseMigrationName(file: string): { version: number; name: string } | null {
  const m = MIGRATION_FILE.exec(file);
  return m === null ? null : { version: Number(m[1]), name: m[2] ?? '' };
}

/** 计算校验和前统一换行符，同一文件在 Windows 与 Linux 检出时校验和相同。 */
export const normalizeMigration = (sql: string): string => sql.replace(/\r\n/g, '\n');

/** 迁移前备份的文件名；时间中的冒号替换掉，以便在 Windows 上作文件名。 */
export const backupFileName = (fromVersion: number, now: string): string =>
  `pre-migration-v${fromVersion}-${now.replace(/:/g, '-')}.sqlite`;
