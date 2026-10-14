// 设定条目（需求 B09）：人物、地点、组织、物品与世界规则；别名；锁定设定。
import { err, ok, type Result } from '@fudiao/shared';
import { z } from 'zod';
import type { SqlPort } from '../sql';
import { guardedUpdate, insertReturning, queryAll, queryOne, type RepoError, type WriteContext } from './common';

export const ENTITY_KINDS = ['character', 'location', 'organization', 'item', 'rule'] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

/** entity.data 的内容：说明文字与作者自定义的属性。 */
const EntityData = z.object({
  description: z.string().default(''),
  attributes: z.array(z.object({ label: z.string(), value: z.string() })).default([]),
});

const jsonColumn = <T>(schema: z.ZodType<T>) =>
  z.string().transform((text, ctx): T => {
    try {
      const parsed = schema.safeParse(JSON.parse(text));
      if (parsed.success) return parsed.data;
    } catch {
      // 落到下面的错误
    }
    ctx.addIssue({ code: 'custom', message: '设定数据格式无效' });
    return z.NEVER;
  });

const EntityRow = z
  .object({
    id: z.string(),
    kind: z.enum(ENTITY_KINDS),
    name: z.string(),
    aliases: jsonColumn(z.array(z.string())),
    data: jsonColumn(EntityData),
    locked: z.number().int(),
    version: z.number().int(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .transform((r) => ({
    id: r.id,
    kind: r.kind,
    name: r.name,
    aliases: r.aliases,
    description: r.data.description,
    attributes: r.data.attributes,
    locked: r.locked === 1,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
export type Entity = z.output<typeof EntityRow>;

export type EntityPatch = Partial<Pick<Entity, 'kind' | 'name' | 'aliases' | 'description' | 'attributes'>>;

const COLUMNS = 'id, kind, name, aliases, data, locked, version, created_at, updated_at';

export function listEntities(port: SqlPort): Promise<Result<Entity[], RepoError>> {
  return queryAll(port, EntityRow, `SELECT ${COLUMNS} FROM entity ORDER BY kind, name, id`);
}

export async function getEntity(port: SqlPort, id: string): Promise<Result<Entity, RepoError>> {
  const row = await queryOne(port, EntityRow, `SELECT ${COLUMNS} FROM entity WHERE id = ?`, [id]);
  if (!row.ok) return row;
  return row.value === null ? err({ code: 'not_found' }) : ok(row.value);
}

/** 别名去掉首尾空白、空项、重复项与和名字相同的项。 */
function cleanAliases(name: string, aliases: readonly string[]): string[] {
  const seen = new Set<string>([name]);
  const out: string[] = [];
  for (const a of aliases.map((x) => x.trim())) {
    if (a === '' || seen.has(a)) continue;
    seen.add(a);
    out.push(a);
  }
  return out;
}

export function createEntity(
  port: SqlPort,
  input: { readonly id: string; readonly kind: EntityKind; readonly name: string },
  ctx: WriteContext,
): Promise<Result<Entity, RepoError>> {
  const name = input.name.trim();
  if (name === '') return Promise.resolve(err({ code: 'invalid', detail: '设定名不能为空' }));
  return insertReturning(port, EntityRow, {
    sql: `INSERT INTO entity (id, kind, name, aliases, data, created_at, updated_at) VALUES (?, ?, ?, '[]', ?, ?, ?) RETURNING ${COLUMNS}`,
    params: [input.id, input.kind, name, JSON.stringify({ description: '', attributes: [] }), ctx.now, ctx.now],
  });
}

/**
 * 修改设定条目。锁定的条目一律拒绝，不论修改来自作者还是推演、生成等自动流程；作者须先解锁
 * （需求 B09、验收“锁定设定”）。
 * 每次修改版本加一，依赖它的事实据此标为待复核（M1-09）。
 */
export async function updateEntity(
  port: SqlPort,
  id: string,
  expectedVersion: number,
  patch: EntityPatch,
  ctx: WriteContext,
): Promise<Result<Entity, RepoError>> {
  const current = await getEntity(port, id);
  if (!current.ok) return current;
  if (current.value.locked) return err({ code: 'locked' });
  if (current.value.version !== expectedVersion) return err({ code: 'conflict' });
  const name = (patch.name ?? current.value.name).trim();
  if (name === '') return err({ code: 'invalid', detail: '设定名不能为空' });
  const aliases = cleanAliases(name, patch.aliases ?? current.value.aliases);
  const attributes = (patch.attributes ?? current.value.attributes)
    .map((a) => ({ label: a.label.trim(), value: a.value.trim() }))
    .filter((a) => a.label !== '' || a.value !== '');
  const data = { description: patch.description ?? current.value.description, attributes };
  // 锁定状态在同一条语句中再核对一次，避免检查之后被锁定。
  return guardedUpdate(port, EntityRow, 'entity', id, {
    sql: `UPDATE entity SET kind = ?, name = ?, aliases = ?, data = ?, version = version + 1, updated_at = ?
          WHERE id = ? AND version = ? AND locked = 0 RETURNING ${COLUMNS}`,
    params: [patch.kind ?? current.value.kind, name, JSON.stringify(aliases), JSON.stringify(data), ctx.now, id, expectedVersion],
  });
}

/** 锁定或解锁：只有作者可以操作。锁定状态的变化不提升版本（内容没有变）。 */
export function setEntityLocked(port: SqlPort, id: string, expectedVersion: number, locked: boolean, ctx: WriteContext): Promise<Result<Entity, RepoError>> {
  return guardedUpdate(port, EntityRow, 'entity', id, {
    sql: `UPDATE entity SET locked = ?, updated_at = ? WHERE id = ? AND version = ? RETURNING ${COLUMNS}`,
    params: [locked ? 1 : 0, ctx.now, id, expectedVersion],
  });
}

/** 删除设定条目。锁定的不能删；仍被人物认知或说法引用时拒绝（外键 RESTRICT）。 */
export async function deleteEntity(port: SqlPort, id: string, expectedVersion: number): Promise<Result<void, RepoError>> {
  const current = await getEntity(port, id);
  if (!current.ok) return current;
  if (current.value.locked) return err({ code: 'locked' });
  // 外键只管得住人物认知的持有者；记在 JSON 里的引用（事实涉及的设定、章节计划的出场人物、故事事件的参与者）
  // 要先查，否则删除后这些引用悄悄失效，事实再也进不了上下文。作为事实依据的设定可以删除，依赖它的事实标为待复核（M1-09）。
  const used = await port.query(
    `SELECT (SELECT count(*) FROM fact f, json_each(f.subject_ids) j WHERE j.value = ?)
          + (SELECT count(*) FROM chapter_plan p, json_each(p.cast_ids) j WHERE j.value = ?)
          + (SELECT count(*) FROM story_event e, json_each(e.participants) j WHERE j.value = ?) AS n`,
    [id, id, id],
  );
  if (!used.ok) return err({ code: 'sql', error: used.error });
  if (Number(used.value[0]?.['n'] ?? 0) > 0) return err({ code: 'in_use' });
  const done = await port.transaction([{ sql: 'DELETE FROM entity WHERE id = ? AND version = ? AND locked = 0', params: [id, expectedVersion], expectChanges: 1 }]);
  if (done.ok) return ok(undefined);
  if (done.error.code === 'constraint') return err({ code: 'in_use' });
  if (done.error.code === 'guard_failed') return err({ code: 'conflict' });
  return err({ code: 'sql', error: done.error });
}
