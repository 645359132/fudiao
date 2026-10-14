// 卷（需求 B68，迁移 0010）：一部作品分若干卷，一卷有若干章。章节以 volume_id 归属到卷，为空即未分卷；
// 卷的顺序由 order_key 决定，章节在书中的顺序是“未分卷在前，再按卷的顺序，卷内按章节的顺序”（视图 chapter_book_order）。
import { err, keyBetween, ok, type Result } from '@fudiao/shared';
import { z } from 'zod';
import type { SqlPort } from '../sql';
import { guardedUpdate, insertReturning, queryAll, queryOne, type RepoError, type WriteContext } from './common';

const VolumeRow = z
  .object({
    id: z.string(),
    order_key: z.string(),
    title: z.string(),
    summary: z.string(),
    version: z.number().int(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .transform((r) => ({ id: r.id, orderKey: r.order_key, title: r.title, summary: r.summary, version: r.version, createdAt: r.created_at, updatedAt: r.updated_at }));
export type Volume = z.output<typeof VolumeRow>;

const COLUMNS = 'id, order_key, title, summary, version, created_at, updated_at';
const KeyRow = z.object({ order_key: z.string() });

const title = (t: string): Result<string, RepoError> => (t.trim() === '' ? err({ code: 'invalid', detail: '卷名不能为空' }) : ok(t.trim()));

/** 全部卷，按书中的顺序。 */
export function listVolumes(port: SqlPort): Promise<Result<Volume[], RepoError>> {
  return queryAll(port, VolumeRow, `SELECT ${COLUMNS} FROM volume ORDER BY order_key, id`);
}

async function keyOf(port: SqlPort, id: string): Promise<Result<string, RepoError>> {
  const row = await queryOne(port, KeyRow, 'SELECT order_key FROM volume WHERE id = ?', [id]);
  if (!row.ok) return row;
  return row.value === null ? err({ code: 'not_found' }) : ok(row.value.order_key);
}

/** 紧跟在 key 之后（key 为 null 时取第一卷）、不是 except 的那一卷的排序键。 */
async function keyAfter(port: SqlPort, key: string | null, except: string | null): Promise<Result<string | null, RepoError>> {
  const row =
    key === null
      ? await queryOne(port, KeyRow, 'SELECT order_key FROM volume WHERE id IS NOT ? ORDER BY order_key LIMIT 1', [except])
      : await queryOne(port, KeyRow, 'SELECT order_key FROM volume WHERE order_key > ? AND id IS NOT ? ORDER BY order_key LIMIT 1', [key, except]);
  return row.ok ? ok(row.value?.order_key ?? null) : row;
}

/** 新建一卷：after 为前一卷，省略时放在最后。 */
export async function createVolume(port: SqlPort, input: { readonly id: string; readonly title: string; readonly after?: string }, ctx: WriteContext): Promise<Result<Volume, RepoError>> {
  const t = title(input.title);
  if (!t.ok) return t;
  let key: string;
  if (input.after === undefined) {
    const last = await queryOne(port, KeyRow, 'SELECT order_key FROM volume ORDER BY order_key DESC LIMIT 1');
    if (!last.ok) return last;
    key = keyBetween(last.value?.order_key ?? null, null);
  } else {
    const prev = await keyOf(port, input.after);
    if (!prev.ok) return prev;
    const next = await keyAfter(port, prev.value, null);
    if (!next.ok) return next;
    key = keyBetween(prev.value, next.value);
  }
  return insertReturning(port, VolumeRow, {
    sql: `INSERT INTO volume (id, order_key, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING ${COLUMNS}`,
    params: [input.id, key, t.value, ctx.now, ctx.now],
  });
}

/** 改卷名与本卷简介。 */
export async function updateVolume(
  port: SqlPort,
  id: string,
  expectedVersion: number,
  fields: { readonly title: string; readonly summary: string },
  ctx: WriteContext,
): Promise<Result<Volume, RepoError>> {
  const t = title(fields.title);
  if (!t.ok) return t;
  return guardedUpdate(port, VolumeRow, 'volume', id, {
    sql: `UPDATE volume SET title = ?, summary = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ? RETURNING ${COLUMNS}`,
    params: [t.value, fields.summary, ctx.now, id, expectedVersion],
  });
}

/** 把一卷移到 after 之后（null 为最前）；卷里的章节跟着一起移动（章节的顺序以卷的顺序为先）。 */
export async function moveVolume(port: SqlPort, id: string, expectedVersion: number, after: string | null, ctx: WriteContext): Promise<Result<Volume, RepoError>> {
  if (after === id) return err({ code: 'invalid', detail: '不能移到自己之后' });
  let prev: string | null = null;
  if (after !== null) {
    const k = await keyOf(port, after);
    if (!k.ok) return k;
    prev = k.value;
  }
  const next = await keyAfter(port, prev, id);
  if (!next.ok) return next;
  if (prev !== null && next.value !== null && prev >= next.value) return err({ code: 'invalid', detail: '排序键冲突，请重新加载目录' });
  return guardedUpdate(port, VolumeRow, 'volume', id, {
    sql: `UPDATE volume SET order_key = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ? RETURNING ${COLUMNS}`,
    params: [keyBetween(prev, next.value), ctx.now, id, expectedVersion],
  });
}

/** 删除一卷：卷里还有（不在回收站的）章节时不删，先把它们移到别的卷；回收站里的章节变为未分卷。 */
export async function deleteVolume(port: SqlPort, id: string, expectedVersion: number): Promise<Result<void, RepoError>> {
  const result = await port.transaction([
    {
      sql: "DELETE FROM volume WHERE id = ? AND version = ? AND NOT EXISTS (SELECT 1 FROM chapter WHERE volume_id = ? AND status = 'normal')",
      params: [id, expectedVersion, id],
      expectChanges: 1,
    },
  ]);
  if (result.ok) return ok(undefined);
  if (result.error.code !== 'guard_failed') return err({ code: 'sql', error: result.error });
  const used = await queryOne(port, z.object({ n: z.number() }), "SELECT count(*) AS n FROM chapter WHERE volume_id = ? AND status = 'normal'", [id]);
  if (used.ok && (used.value?.n ?? 0) > 0) return err({ code: 'in_use' });
  return err({ code: 'conflict' });
}
