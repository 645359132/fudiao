import { err, keyBetween, ok, type Result } from '@fudiao/shared';
import { z } from 'zod';
import type { SqlPort } from '../sql';
import { guardedUpdate, insertReturning, queryAll, queryOne, type RepoError, type WriteContext } from './common';

export type ChapterStatus = 'normal' | 'trashed';

const ChapterRow = z
  .object({
    id: z.string(),
    order_key: z.string(),
    title: z.string(),
    summary: z.string(),
    notes: z.string(),
    status: z.enum(['normal', 'trashed']),
    trashed_at: z.string().nullable(),
    version: z.number().int(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .transform((r) => ({
    id: r.id,
    orderKey: r.order_key,
    title: r.title,
    summary: r.summary,
    notes: r.notes,
    status: r.status,
    trashedAt: r.trashed_at,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
export type Chapter = z.output<typeof ChapterRow>;

const COLUMNS = 'id, order_key, title, summary, notes, status, trashed_at, version, created_at, updated_at';
const KeyRow = z.object({ order_key: z.string() });

/** 正常章节按目录顺序；回收站按移入时间从近到远。 */
export function listChapters(port: SqlPort, status: ChapterStatus): Promise<Result<Chapter[], RepoError>> {
  const order = status === 'normal' ? 'order_key, id' : 'trashed_at DESC, id';
  return queryAll(port, ChapterRow, `SELECT ${COLUMNS} FROM chapter WHERE status = ? ORDER BY ${order}`, [status]);
}

const title = (t: string): Result<string, RepoError> => (t.trim() === '' ? err({ code: 'invalid', detail: '章节名不能为空' }) : ok(t.trim()));

async function keyOf(port: SqlPort, id: string): Promise<Result<string, RepoError>> {
  const row = await queryOne(port, KeyRow, "SELECT order_key FROM chapter WHERE id = ? AND status = 'normal'", [id]);
  if (!row.ok) return row;
  return row.value === null ? err({ code: 'not_found' }) : ok(row.value.order_key);
}

/** 目录中紧跟在 key 之后的正常章节的排序键；key 为 null 时取第一章。 */
async function keyAfter(port: SqlPort, key: string | null): Promise<Result<string | null, RepoError>> {
  const row =
    key === null
      ? await queryOne(port, KeyRow, "SELECT order_key FROM chapter WHERE status = 'normal' ORDER BY order_key LIMIT 1")
      : await queryOne(port, KeyRow, "SELECT order_key FROM chapter WHERE status = 'normal' AND order_key > ? ORDER BY order_key LIMIT 1", [key]);
  return row.ok ? ok(row.value?.order_key ?? null) : row;
}

async function lastKey(port: SqlPort): Promise<Result<string | null, RepoError>> {
  const row = await queryOne(port, KeyRow, "SELECT order_key FROM chapter WHERE status = 'normal' ORDER BY order_key DESC LIMIT 1");
  return row.ok ? ok(row.value?.order_key ?? null) : row;
}

/** 新建章节：after 为前一章的标识，省略时放在目录末尾。 */
export async function createChapter(
  port: SqlPort,
  input: { readonly id: string; readonly title: string; readonly after?: string },
  ctx: WriteContext,
): Promise<Result<Chapter, RepoError>> {
  const t = title(input.title);
  if (!t.ok) return t;
  let key: string;
  if (input.after === undefined) {
    const last = await lastKey(port);
    if (!last.ok) return last;
    key = keyBetween(last.value, null);
  } else {
    const prev = await keyOf(port, input.after);
    if (!prev.ok) return prev;
    const next = await keyAfter(port, prev.value);
    if (!next.ok) return next;
    key = keyBetween(prev.value, next.value);
  }
  return insertReturning(port, ChapterRow, {
    sql: `INSERT INTO chapter (id, order_key, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING ${COLUMNS}`,
    params: [input.id, key, t.value, ctx.now, ctx.now],
  });
}

export async function renameChapter(port: SqlPort, id: string, expectedVersion: number, newTitle: string, ctx: WriteContext): Promise<Result<Chapter, RepoError>> {
  const t = title(newTitle);
  if (!t.ok) return t;
  return guardedUpdate(port, ChapterRow, 'chapter', id, {
    sql: `UPDATE chapter SET title = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ? RETURNING ${COLUMNS}`,
    params: [t.value, ctx.now, id, expectedVersion],
  });
}

export function updateChapterNotes(
  port: SqlPort,
  id: string,
  expectedVersion: number,
  notes: { readonly summary: string; readonly notes: string },
  ctx: WriteContext,
): Promise<Result<Chapter, RepoError>> {
  return guardedUpdate(port, ChapterRow, 'chapter', id, {
    sql: `UPDATE chapter SET summary = ?, notes = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ? RETURNING ${COLUMNS}`,
    params: [notes.summary, notes.notes, ctx.now, id, expectedVersion],
  });
}

/**
 * 把章节移到 after 之后（after 为 null 时移到最前）。只改这一章的排序键，其余章节不动。
 */
export async function moveChapter(
  port: SqlPort,
  id: string,
  expectedVersion: number,
  after: string | null,
  ctx: WriteContext,
): Promise<Result<Chapter, RepoError>> {
  if (after === id) return err({ code: 'invalid', detail: '不能移到自己之后' });
  let prev: string | null = null;
  if (after !== null) {
    const k = await keyOf(port, after);
    if (!k.ok) return k;
    prev = k.value;
  }
  // 下一章跳过被移动的章节本身。
  let next = await keyAfter(port, prev);
  if (!next.ok) return next;
  const own = await keyOf(port, id);
  if (!own.ok) return own;
  if (next.value === own.value) {
    next = await keyAfter(port, own.value);
    if (!next.ok) return next;
  }
  if (prev !== null && next.value !== null && prev >= next.value) return err({ code: 'invalid', detail: '排序键冲突，请重新加载目录' });
  return guardedUpdate(port, ChapterRow, 'chapter', id, {
    sql: `UPDATE chapter SET order_key = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND status = 'normal' RETURNING ${COLUMNS}`,
    params: [keyBetween(prev, next.value), ctx.now, id, expectedVersion],
  });
}

export function trashChapter(port: SqlPort, id: string, expectedVersion: number, ctx: WriteContext): Promise<Result<Chapter, RepoError>> {
  return guardedUpdate(port, ChapterRow, 'chapter', id, {
    sql: `UPDATE chapter SET status = 'trashed', trashed_at = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND status = 'normal' RETURNING ${COLUMNS}`,
    params: [ctx.now, ctx.now, id, expectedVersion],
  });
}

/** 从回收站恢复，放到目录末尾。 */
export async function restoreChapter(port: SqlPort, id: string, expectedVersion: number, ctx: WriteContext): Promise<Result<Chapter, RepoError>> {
  const last = await lastKey(port);
  if (!last.ok) return last;
  return guardedUpdate(port, ChapterRow, 'chapter', id, {
    sql: `UPDATE chapter SET status = 'normal', trashed_at = NULL, order_key = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND status = 'trashed' RETURNING ${COLUMNS}`,
    params: [keyBetween(last.value, null), ctx.now, id, expectedVersion],
  });
}
