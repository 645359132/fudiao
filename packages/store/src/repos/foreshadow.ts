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

/** 章节计划里要埋或要收这条伏笔（记在 JSON 里，外键管不到）的计划数。 */
const PLAN_USES =
  "(SELECT count(*) FROM chapter_plan p WHERE EXISTS (SELECT 1 FROM json_each(p.foreshadow_plant) j WHERE j.value = ?) OR EXISTS (SELECT 1 FROM json_each(p.foreshadow_payoff) j WHERE j.value = ?))";

/** 删除伏笔。章节计划里还要埋或要收它时拒绝（in_use），不然计划里留下指不到的标识；判断写在删除语句里，不会在两步之间被别处加进计划。 */
export async function deleteForeshadow(port: SqlPort, current: Foreshadow): Promise<Result<void, RepoError>> {
  const result = await port.transaction([
    { sql: `DELETE FROM foreshadow WHERE id = ? AND version = ? AND ${PLAN_USES} = 0`, params: [current.id, current.version, current.id, current.id], expectChanges: 1 },
  ]);
  if (result.ok) return ok(undefined);
  if (result.error.code !== 'guard_failed') return err({ code: 'sql', error: result.error });
  const used = await port.query(`SELECT ${PLAN_USES} AS n`, [current.id, current.id]);
  if (!used.ok) return err({ code: 'sql', error: used.error });
  return err(Number(used.value[0]?.['n'] ?? 0) > 0 ? { code: 'in_use' } : { code: 'conflict' });
}
