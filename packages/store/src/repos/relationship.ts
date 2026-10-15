// 人物关系网（需求 B73，迁移 0012）：两项设定之间的关系与关系图上作者拖定的位置。
// label 读作“from 是 to 的〈label〉”；mutual 为真时两边相同。关系随两端的设定一起删除（外键级联）。
import { err, ok, type Result } from '@fudiao/shared';
import { z } from 'zod';
import type { SqlPort } from '../sql';
import { guardedUpdate, insertReturning, queryAll, queryOne, type RepoError, type WriteContext } from './common';

export const RELATION_CATEGORIES = ['family', 'romance', 'mentor', 'ally', 'rival', 'enemy', 'affiliation', 'other'] as const;
export type RelationCategory = (typeof RELATION_CATEGORIES)[number];

const RelationshipRow = z
  .object({
    id: z.string(),
    from_id: z.string(),
    to_id: z.string(),
    category: z.enum(RELATION_CATEGORIES),
    label: z.string(),
    mutual: z.number().int(),
    description: z.string(),
    secret: z.number().int(),
    valid_from_chapter_id: z.string().nullable(),
    valid_to_chapter_id: z.string().nullable(),
    version: z.number().int(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .transform((r) => ({
    id: r.id,
    fromId: r.from_id,
    toId: r.to_id,
    category: r.category,
    label: r.label,
    mutual: r.mutual === 1,
    description: r.description,
    secret: r.secret === 1,
    validFromChapterId: r.valid_from_chapter_id,
    validToChapterId: r.valid_to_chapter_id,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
export type Relationship = z.output<typeof RelationshipRow>;

/** 新建与修改共用的字段。 */
export type RelationshipFields = {
  readonly fromId: string;
  readonly toId: string;
  readonly category: RelationCategory;
  readonly label: string;
  readonly mutual: boolean;
  readonly description: string;
  readonly secret: boolean;
  readonly validFromChapterId: string | null;
  readonly validToChapterId: string | null;
};

const COLUMNS = 'id, from_id, to_id, category, label, mutual, description, secret, valid_from_chapter_id, valid_to_chapter_id, version, created_at, updated_at';

/** 全部关系，按建立的先后。 */
export function listRelationships(port: SqlPort): Promise<Result<Relationship[], RepoError>> {
  return queryAll(port, RelationshipRow, `SELECT ${COLUMNS} FROM relationship ORDER BY created_at, id`);
}

/** 两端须是不同的、已有的设定，称谓不能为空。 */
async function checked(port: SqlPort, fields: RelationshipFields): Promise<Result<RelationshipFields, RepoError>> {
  const label = fields.label.trim();
  if (label === '') return err({ code: 'invalid', detail: '关系的称谓不能为空' });
  if (fields.fromId === fields.toId) return err({ code: 'invalid', detail: '关系的两端不能是同一项设定' });
  const found = await queryOne(port, z.object({ n: z.number() }), 'SELECT count(*) AS n FROM entity WHERE id IN (?, ?)', [fields.fromId, fields.toId]);
  if (!found.ok) return found;
  if ((found.value?.n ?? 0) < 2) return err({ code: 'invalid', detail: '关系的一端不是已有的设定' });
  return ok({ ...fields, label, description: fields.description.trim() });
}

export async function createRelationship(port: SqlPort, input: RelationshipFields & { readonly id: string }, ctx: WriteContext): Promise<Result<Relationship, RepoError>> {
  const f = await checked(port, input);
  if (!f.ok) return f;
  const v = f.value;
  return insertReturning(port, RelationshipRow, {
    sql: `INSERT INTO relationship (id, from_id, to_id, category, label, mutual, description, secret, valid_from_chapter_id, valid_to_chapter_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${COLUMNS}`,
    params: [input.id, v.fromId, v.toId, v.category, v.label, v.mutual ? 1 : 0, v.description, v.secret ? 1 : 0, v.validFromChapterId, v.validToChapterId, ctx.now, ctx.now],
  });
}

export async function updateRelationship(port: SqlPort, id: string, expectedVersion: number, fields: RelationshipFields, ctx: WriteContext): Promise<Result<Relationship, RepoError>> {
  const f = await checked(port, fields);
  if (!f.ok) return f;
  const v = f.value;
  return guardedUpdate(port, RelationshipRow, 'relationship', id, {
    sql: `UPDATE relationship SET from_id = ?, to_id = ?, category = ?, label = ?, mutual = ?, description = ?, secret = ?, valid_from_chapter_id = ?, valid_to_chapter_id = ?,
          version = version + 1, updated_at = ? WHERE id = ? AND version = ? RETURNING ${COLUMNS}`,
    params: [v.fromId, v.toId, v.category, v.label, v.mutual ? 1 : 0, v.description, v.secret ? 1 : 0, v.validFromChapterId, v.validToChapterId, ctx.now, id, expectedVersion],
  });
}

export async function deleteRelationship(port: SqlPort, id: string, expectedVersion: number): Promise<Result<void, RepoError>> {
  const done = await port.transaction([{ sql: 'DELETE FROM relationship WHERE id = ? AND version = ?', params: [id, expectedVersion], expectChanges: 1 }]);
  if (done.ok) return ok(undefined);
  if (done.error.code !== 'guard_failed') return err({ code: 'sql', error: done.error });
  const exists = await queryOne(port, z.object({ n: z.number() }), 'SELECT count(*) AS n FROM relationship WHERE id = ?', [id]);
  return err(exists.ok && (exists.value?.n ?? 0) === 0 ? { code: 'not_found' } : { code: 'conflict' });
}

const PositionRow = z.object({ entity_id: z.string(), x: z.number(), y: z.number() }).transform((r) => ({ entityId: r.entity_id, x: r.x, y: r.y }));
export type RelationPosition = z.output<typeof PositionRow>;

/** 关系图上作者拖定的位置。 */
export function listRelationPositions(port: SqlPort): Promise<Result<RelationPosition[], RepoError>> {
  return queryAll(port, PositionRow, 'SELECT entity_id, x, y FROM relation_position ORDER BY entity_id');
}

/** 记下（或清除，x 与 y 为 null 时）一项设定在关系图上的位置。只影响显示，不需要版本守卫。 */
export async function setRelationPosition(port: SqlPort, entityId: string, at: { readonly x: number; readonly y: number } | null, ctx: WriteContext): Promise<Result<void, RepoError>> {
  const done = await port.transaction([
    at === null
      ? { sql: 'DELETE FROM relation_position WHERE entity_id = ?', params: [entityId] }
      : {
          sql: 'INSERT INTO relation_position (entity_id, x, y, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (entity_id) DO UPDATE SET x = excluded.x, y = excluded.y, updated_at = excluded.updated_at',
          params: [entityId, at.x, at.y, ctx.now],
        },
  ]);
  return done.ok ? ok(undefined) : err({ code: 'sql', error: done.error });
}
