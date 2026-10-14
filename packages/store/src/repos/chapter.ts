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
    volume_id: z.string().nullable(),
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
    /** 所在的卷；null 为未分卷。 */
    volumeId: r.volume_id,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
export type Chapter = z.output<typeof ChapterRow>;

const COLUMNS = 'id, order_key, title, summary, notes, status, trashed_at, volume_id, version, created_at, updated_at';
const C_COLUMNS = COLUMNS.split(', ').map((c) => `c.${c}`).join(', ');
const KeyRow = z.object({ order_key: z.string() });
const PlaceRow = z.object({ order_key: z.string(), volume_id: z.string().nullable() });

/** 正常章节按书中的顺序（未分卷在前，再按卷的顺序，卷内按章节的顺序）；回收站按移入时间从近到远。 */
export function listChapters(port: SqlPort, status: ChapterStatus): Promise<Result<Chapter[], RepoError>> {
  return status === 'normal'
    ? queryAll(port, ChapterRow, `SELECT ${C_COLUMNS} FROM chapter c JOIN chapter_book_order o ON o.chapter_id = c.id WHERE c.status = 'normal' ORDER BY o.position`)
    : queryAll(port, ChapterRow, `SELECT ${COLUMNS} FROM chapter WHERE status = 'trashed' ORDER BY trashed_at DESC, id`);
}

const title = (t: string): Result<string, RepoError> => (t.trim() === '' ? err({ code: 'invalid', detail: '章节名不能为空' }) : ok(t.trim()));

/** 一章的排序键与所在的卷。 */
async function placeOf(port: SqlPort, id: string): Promise<Result<{ key: string; volumeId: string | null }, RepoError>> {
  const row = await queryOne(port, PlaceRow, "SELECT order_key, volume_id FROM chapter WHERE id = ? AND status = 'normal'", [id]);
  if (!row.ok) return row;
  return row.value === null ? err({ code: 'not_found' }) : ok({ key: row.value.order_key, volumeId: row.value.volume_id });
}

/** 同一卷中紧跟在 key 之后（key 为 null 时取卷里的第一章）、不是 except 的正常章节的排序键。 */
async function keyAfter(port: SqlPort, volumeId: string | null, key: string | null, except: string | null = null): Promise<Result<string | null, RepoError>> {
  const row =
    key === null
      ? await queryOne(port, KeyRow, "SELECT order_key FROM chapter WHERE status = 'normal' AND volume_id IS ? AND id IS NOT ? ORDER BY order_key LIMIT 1", [volumeId, except])
      : await queryOne(port, KeyRow, "SELECT order_key FROM chapter WHERE status = 'normal' AND volume_id IS ? AND order_key > ? AND id IS NOT ? ORDER BY order_key LIMIT 1", [
          volumeId,
          key,
          except,
        ]);
  return row.ok ? ok(row.value?.order_key ?? null) : row;
}

/** 一卷（null 为未分卷）中最后一章的排序键。 */
async function lastKey(port: SqlPort, volumeId: string | null): Promise<Result<string | null, RepoError>> {
  const row = await queryOne(port, KeyRow, "SELECT order_key FROM chapter WHERE status = 'normal' AND volume_id IS ? ORDER BY order_key DESC LIMIT 1", [volumeId]);
  return row.ok ? ok(row.value?.order_key ?? null) : row;
}

/** 书中最后一卷；没有分卷时为 null。 */
async function lastVolume(port: SqlPort): Promise<Result<string | null, RepoError>> {
  const row = await queryOne(port, z.object({ id: z.string() }), 'SELECT id FROM volume ORDER BY order_key DESC, id DESC LIMIT 1');
  return row.ok ? ok(row.value?.id ?? null) : row;
}

/**
 * 新建章节：after 为前一章（新章节在它所在的卷里、紧跟其后）；省略时放在 volumeId 这一卷的末尾，
 * volumeId 也省略时放在全书末尾（最后一卷的末尾；没有分卷时为目录末尾）。
 */
export async function createChapter(
  port: SqlPort,
  input: { readonly id: string; readonly title: string; readonly after?: string; readonly volumeId?: string | null },
  ctx: WriteContext,
): Promise<Result<Chapter, RepoError>> {
  const t = title(input.title);
  if (!t.ok) return t;
  let key: string;
  let volumeId: string | null;
  if (input.after === undefined) {
    if (input.volumeId === undefined) {
      const last = await lastVolume(port);
      if (!last.ok) return last;
      volumeId = last.value;
    } else {
      volumeId = input.volumeId;
    }
    const last = await lastKey(port, volumeId);
    if (!last.ok) return last;
    key = keyBetween(last.value, null);
  } else {
    const prev = await placeOf(port, input.after);
    if (!prev.ok) return prev;
    volumeId = prev.value.volumeId;
    const next = await keyAfter(port, volumeId, prev.value.key);
    if (!next.ok) return next;
    key = keyBetween(prev.value.key, next.value);
  }
  return insertReturning(port, ChapterRow, {
    sql: `INSERT INTO chapter (id, order_key, title, volume_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING ${COLUMNS}`,
    params: [input.id, key, t.value, volumeId, ctx.now, ctx.now],
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

/** 移动章节的目的地：哪一卷（null 为未分卷），以及在卷里哪一章之后（null 为卷首）。 */
export type ChapterTarget = { readonly volumeId: string | null; readonly after: string | null };

/**
 * 把章节移到 target：可以在卷内调整顺序，也可以移到别的卷。只改这一章的卷与排序键，其余章节不动。
 */
export async function moveChapter(port: SqlPort, id: string, expectedVersion: number, target: ChapterTarget, ctx: WriteContext): Promise<Result<Chapter, RepoError>> {
  if (target.after === id) return err({ code: 'invalid', detail: '不能移到自己之后' });
  let prev: string | null = null;
  if (target.after !== null) {
    const p = await placeOf(port, target.after);
    if (!p.ok) return p;
    if (p.value.volumeId !== target.volumeId) return err({ code: 'invalid', detail: '前一章不在目标卷里，请重新加载目录' });
    prev = p.value.key;
  }
  if (target.volumeId !== null) {
    const exists = await queryOne(port, z.object({ id: z.string() }), 'SELECT id FROM volume WHERE id = ?', [target.volumeId]);
    if (!exists.ok) return exists;
    if (exists.value === null) return err({ code: 'not_found' });
  }
  // 下一章跳过被移动的章节本身。
  const next = await keyAfter(port, target.volumeId, prev, id);
  if (!next.ok) return next;
  if (prev !== null && next.value !== null && prev >= next.value) return err({ code: 'invalid', detail: '排序键冲突，请重新加载目录' });
  return guardedUpdate(port, ChapterRow, 'chapter', id, {
    sql: `UPDATE chapter SET order_key = ?, volume_id = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND status = 'normal' RETURNING ${COLUMNS}`,
    params: [keyBetween(prev, next.value), target.volumeId, ctx.now, id, expectedVersion],
  });
}

export function trashChapter(port: SqlPort, id: string, expectedVersion: number, ctx: WriteContext): Promise<Result<Chapter, RepoError>> {
  return guardedUpdate(port, ChapterRow, 'chapter', id, {
    sql: `UPDATE chapter SET status = 'trashed', trashed_at = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND status = 'normal' RETURNING ${COLUMNS}`,
    params: [ctx.now, ctx.now, id, expectedVersion],
  });
}

/** 从回收站恢复，放到它所在的卷的末尾（卷已删除的为未分卷）。 */
export async function restoreChapter(port: SqlPort, id: string, expectedVersion: number, ctx: WriteContext): Promise<Result<Chapter, RepoError>> {
  const row = await queryOne(port, z.object({ volume_id: z.string().nullable() }), "SELECT volume_id FROM chapter WHERE id = ? AND status = 'trashed'", [id]);
  if (!row.ok) return row;
  if (row.value === null) return err({ code: 'not_found' });
  const last = await lastKey(port, row.value.volume_id);
  if (!last.ok) return last;
  return guardedUpdate(port, ChapterRow, 'chapter', id, {
    sql: `UPDATE chapter SET status = 'normal', trashed_at = NULL, order_key = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND status = 'trashed' RETURNING ${COLUMNS}`,
    params: [keyBetween(last.value, null), ctx.now, id, expectedVersion],
  });
}
