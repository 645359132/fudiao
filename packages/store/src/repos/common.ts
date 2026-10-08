import { err, ok, type Result } from '@fudiao/shared';
import type { z } from 'zod';
import type { Row, SqlError, SqlPort, Statement } from '../sql';

export type RepoError =
  /** 记录已被别处修改（版本不符），界面应重新加载。 */
  | { readonly code: 'conflict' }
  | { readonly code: 'not_found' }
  | { readonly code: 'invalid'; readonly detail: string }
  /** 锁定设定不能修改：自动流程一律不能改，作者须先解锁（需求 B09）。 */
  | { readonly code: 'locked' }
  /** 仍被引用，不能删除（例如还有人物认知以该人物为持有者）。 */
  | { readonly code: 'in_use' }
  | { readonly code: 'sql'; readonly error: SqlError };

/** 写入时间与新标识由调用方提供（时钟端口、标识端口），仓储本身不读系统时间。 */
export type WriteContext = { readonly now: string };

export function parseRows<T>(schema: z.ZodType<T>, rows: readonly Row[]): Result<T[], RepoError> {
  const out: T[] = [];
  for (const row of rows) {
    const parsed = schema.safeParse(row);
    if (!parsed.success) return err({ code: 'invalid', detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('；') });
    out.push(parsed.data);
  }
  return ok(out);
}

export async function queryAll<T>(port: SqlPort, schema: z.ZodType<T>, sql: string, params: Statement['params'] = []): Promise<Result<T[], RepoError>> {
  const rows = await port.query(sql, params);
  return rows.ok ? parseRows(schema, rows.value) : err({ code: 'sql', error: rows.error });
}

export async function queryOne<T>(port: SqlPort, schema: z.ZodType<T>, sql: string, params: Statement['params'] = []): Promise<Result<T | null, RepoError>> {
  const rows = await queryAll(port, schema, sql, params);
  return rows.ok ? ok(rows.value[0] ?? null) : rows;
}

/**
 * 带版本守卫的更新：语句须为 `UPDATE … WHERE id = ? AND version = ? RETURNING *`。
 * 影响行数不是 1 时区分“记录不存在”与“版本不符”。
 */
export async function guardedUpdate<T>(
  port: SqlPort,
  schema: z.ZodType<T>,
  table: string,
  id: string,
  statement: Statement,
): Promise<Result<T, RepoError>> {
  const result = await port.transaction([{ ...statement, expectChanges: 1 }]);
  if (!result.ok) {
    if (result.error.code !== 'guard_failed') return err({ code: 'sql', error: result.error });
    const exists = await port.query(`SELECT 1 AS present FROM ${table} WHERE id = ?`, [id]);
    if (!exists.ok) return err({ code: 'sql', error: exists.error });
    return err(exists.value.length === 0 ? { code: 'not_found' } : { code: 'conflict' });
  }
  const rows = parseRows(schema, result.value[0]?.rows ?? []);
  if (!rows.ok) return rows;
  const row = rows.value[0];
  return row === undefined ? err({ code: 'not_found' }) : ok(row);
}

export async function insertReturning<T>(port: SqlPort, schema: z.ZodType<T>, statement: Statement): Promise<Result<T, RepoError>> {
  const result = await port.transaction([statement]);
  if (!result.ok) return err({ code: 'sql', error: result.error });
  const rows = parseRows(schema, result.value[0]?.rows ?? []);
  if (!rows.ok) return rows;
  const row = rows.value[0];
  return row === undefined ? err({ code: 'invalid', detail: '插入后没有返回记录' }) : ok(row);
}
