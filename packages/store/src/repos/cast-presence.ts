// 人物的出场、退场与回归（需求 B73 补充，迁移 0024）。出场多数由章节计划与长篇记忆推算（listCastAppearances），
// 这里只记推算不出的出场与作者改过的；退场与回归只记在这里。退场那一章人物还在，下一章起不在；回归那一章起又在。
import { err, ok, type Result } from '@fudiao/shared';
import { z } from 'zod';
import type { SqlPort } from '../sql';
import { guardedUpdate, queryAll, type RepoError, type WriteContext } from './common';

export const PRESENCE_KINDS = ['enter', 'exit', 'return'] as const;
export type PresenceKind = (typeof PRESENCE_KINDS)[number];

const PresenceRow = z
  .object({
    id: z.string(),
    entity_id: z.string(),
    chapter_id: z.string(),
    kind: z.enum(PRESENCE_KINDS),
    note: z.string(),
    version: z.number().int(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .transform((r) => ({ id: r.id, entityId: r.entity_id, chapterId: r.chapter_id, kind: r.kind, note: r.note, version: r.version, createdAt: r.created_at, updatedAt: r.updated_at }));
export type CastPresence = z.output<typeof PresenceRow>;

export type CastPresenceFields = { readonly entityId: string; readonly chapterId: string; readonly kind: PresenceKind; readonly note: string };

const COLUMNS = 'id, entity_id, chapter_id, kind, note, version, created_at, updated_at';

/** 全部记录（含回收站里的章节上的：按书中顺序推算时不在目录里的章节不算）。 */
export function listCastPresence(port: SqlPort): Promise<Result<CastPresence[], RepoError>> {
  return queryAll(port, PresenceRow, `SELECT ${COLUMNS} FROM cast_presence ORDER BY entity_id, created_at, id`);
}

/** 同一个人物在同一章只有一条同种的记录：已有时改它的说明。 */
export async function saveCastPresence(port: SqlPort, input: CastPresenceFields & { readonly id: string }, ctx: WriteContext): Promise<Result<CastPresence, RepoError>> {
  const result = await port.transaction([
    {
      sql: `INSERT INTO cast_presence (id, entity_id, chapter_id, kind, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (entity_id, chapter_id, kind) DO UPDATE SET note = excluded.note, version = cast_presence.version + 1, updated_at = excluded.updated_at
            RETURNING ${COLUMNS}`,
      params: [input.id, input.entityId, input.chapterId, input.kind, input.note.trim(), ctx.now, ctx.now],
    },
  ]);
  if (!result.ok) return err(result.error.code === 'constraint' ? { code: 'invalid', detail: '人物或章节不存在' } : { code: 'sql', error: result.error });
  const row = PresenceRow.safeParse(result.value[0]?.rows[0]);
  return row.success ? ok(row.data) : err({ code: 'invalid', detail: '写入后没有返回记录' });
}

export async function updateCastPresence(port: SqlPort, id: string, expectedVersion: number, fields: Omit<CastPresenceFields, 'entityId'>, ctx: WriteContext): Promise<Result<CastPresence, RepoError>> {
  const done = await guardedUpdate(port, PresenceRow, 'cast_presence', id, {
    sql: `UPDATE cast_presence SET chapter_id = ?, kind = ?, note = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ? RETURNING ${COLUMNS}`,
    params: [fields.chapterId, fields.kind, fields.note.trim(), ctx.now, id, expectedVersion],
  });
  if (!done.ok && done.error.code === 'sql' && done.error.error.code === 'constraint') return err({ code: 'invalid', detail: '这个人物在这一章已经有一条同样的记录' });
  return done;
}

export async function deleteCastPresence(port: SqlPort, id: string, expectedVersion: number): Promise<Result<void, RepoError>> {
  const done = await port.transaction([{ sql: 'DELETE FROM cast_presence WHERE id = ? AND version = ?', params: [id, expectedVersion], expectChanges: 1 }]);
  if (done.ok) return ok(undefined);
  if (done.error.code !== 'guard_failed') return err({ code: 'sql', error: done.error });
  const exists = await queryAll(port, z.object({ n: z.number() }), 'SELECT count(*) AS n FROM cast_presence WHERE id = ?', [id]);
  return err(exists.ok && (exists.value[0]?.n ?? 0) === 0 ? { code: 'not_found' } : { code: 'conflict' });
}

/**
 * 人物在哪些章出现过：章节计划的出场人物与长篇记忆的人物状态（回收站以外的章节）。只取标识，不搬计划与记忆的内容。
 */
export async function listCastAppearances(port: SqlPort): Promise<Result<{ readonly chapterId: string; readonly entityId: string }[], RepoError>> {
  const rows = await queryAll(
    port,
    z.object({ chapter_id: z.string(), entity_id: z.string() }),
    `SELECT p.chapter_id, j.value AS entity_id FROM chapter_plan p JOIN chapter c ON c.id = p.chapter_id, json_each(p.cast_ids) j WHERE c.status = 'normal'
     UNION
     SELECT m.chapter_id, j.key AS entity_id FROM chapter_memory m JOIN chapter c ON c.id = m.chapter_id, json_each(m.cast_state) j WHERE c.status = 'normal'`,
  );
  return rows.ok ? ok(rows.value.map((r) => ({ chapterId: r.chapter_id, entityId: r.entity_id }))) : rows;
}
