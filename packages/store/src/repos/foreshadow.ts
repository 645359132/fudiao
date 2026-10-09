// 伏笔账本（需求 B63）：计划中的伏笔、埋设与回收的位置、揭晓前不得说破的内容与状态。写手写作时读取，审核时检查。
import { err, ok, type Result } from '@fudiao/shared';
import { z } from 'zod';
import type { SqlPort } from '../sql';
import { guardedUpdate, insertReturning, jsonColumn, ParagraphAnchor, queryAll, queryOne, type RepoError, type WriteContext } from './common';

export const FORESHADOW_STATUSES = ['planned', 'planted', 'paid_off', 'dropped'] as const;
export type ForeshadowStatus = (typeof FORESHADOW_STATUSES)[number];

const ForeshadowRow = z
  .object({
    id: z.string(),
    title: z.string(),
    content: z.string(),
    reveal: z.string(),
    plant_chapter_id: z.string().nullable(),
    plant_anchor: jsonColumn(ParagraphAnchor).nullable(),
    payoff_chapter_id: z.string().nullable(),
    payoff_anchor: jsonColumn(ParagraphAnchor).nullable(),
    status: z.enum(FORESHADOW_STATUSES),
    version: z.number().int(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .transform((r) => ({
    id: r.id,
    title: r.title,
    content: r.content,
    reveal: r.reveal,
    plantChapterId: r.plant_chapter_id,
    plantAnchor: r.plant_anchor,
    payoffChapterId: r.payoff_chapter_id,
    payoffAnchor: r.payoff_anchor,
    status: r.status,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
export type Foreshadow = z.output<typeof ForeshadowRow>;

const COLUMNS = 'id, title, content, reveal, plant_chapter_id, plant_anchor, payoff_chapter_id, payoff_anchor, status, version, created_at, updated_at';

export type ForeshadowFields = {
  readonly title: string;
  readonly content: string;
  readonly reveal: string;
  readonly plantChapterId: string | null;
  readonly plantAnchor: ParagraphAnchor | null;
  readonly payoffChapterId: string | null;
  readonly payoffAnchor: ParagraphAnchor | null;
  readonly status: ForeshadowStatus;
};

const anchorJson = (a: ParagraphAnchor | null) => (a === null ? null : JSON.stringify(a));

export function createForeshadow(port: SqlPort, input: { readonly id: string } & ForeshadowFields, ctx: WriteContext): Promise<Result<Foreshadow, RepoError>> {
  return insertReturning(port, ForeshadowRow, {
    sql: `INSERT INTO foreshadow (id, title, content, reveal, plant_chapter_id, plant_anchor, payoff_chapter_id, payoff_anchor, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${COLUMNS}`,
    params: [
      input.id,
      input.title,
      input.content,
      input.reveal,
      input.plantChapterId,
      anchorJson(input.plantAnchor),
      input.payoffChapterId,
      anchorJson(input.payoffAnchor),
      input.status,
      ctx.now,
      ctx.now,
    ],
  });
}

/** 全部伏笔，按建立时间；可只列某些状态。 */
export function listForeshadows(port: SqlPort, statuses: readonly ForeshadowStatus[] = FORESHADOW_STATUSES): Promise<Result<Foreshadow[], RepoError>> {
  return queryAll(
    port,
    ForeshadowRow,
    `SELECT ${COLUMNS} FROM foreshadow WHERE status IN (${statuses.map(() => '?').join(', ')}) ORDER BY created_at, id`,
    [...statuses],
  );
}

export async function getForeshadow(port: SqlPort, id: string): Promise<Result<Foreshadow, RepoError>> {
  const row = await queryOne(port, ForeshadowRow, `SELECT ${COLUMNS} FROM foreshadow WHERE id = ?`, [id]);
  if (!row.ok) return row;
  return row.value === null ? err({ code: 'not_found' }) : ok(row.value);
}

export function updateForeshadow(port: SqlPort, current: Foreshadow, fields: ForeshadowFields, ctx: WriteContext): Promise<Result<Foreshadow, RepoError>> {
  return guardedUpdate(port, ForeshadowRow, 'foreshadow', current.id, {
    sql: `UPDATE foreshadow SET title = ?, content = ?, reveal = ?, plant_chapter_id = ?, plant_anchor = ?, payoff_chapter_id = ?, payoff_anchor = ?, status = ?,
            version = version + 1, updated_at = ? WHERE id = ? AND version = ? RETURNING ${COLUMNS}`,
    params: [
      fields.title,
      fields.content,
      fields.reveal,
      fields.plantChapterId,
      anchorJson(fields.plantAnchor),
      fields.payoffChapterId,
      anchorJson(fields.payoffAnchor),
      fields.status,
      ctx.now,
      current.id,
      current.version,
    ],
  });
}

export async function deleteForeshadow(port: SqlPort, current: Foreshadow): Promise<Result<void, RepoError>> {
  const result = await port.transaction([{ sql: 'DELETE FROM foreshadow WHERE id = ? AND version = ?', params: [current.id, current.version], expectChanges: 1 }]);
  if (result.ok) return ok(undefined);
  return err(result.error.code === 'guard_failed' ? { code: 'conflict' } : { code: 'sql', error: result.error });
}
