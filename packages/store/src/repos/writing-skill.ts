// 写作技能（需求 B61）：内置技能的文字在 packages/prompts/templates/skills/，作品里只存启用状态与作者的改动；
// 作者自定义的技能 builtin_version 为空，说明文字必填。
import { err, ok, type Result } from '@fudiao/shared';
import { z } from 'zod';
import type { SqlPort, Statement } from '../sql';
import { guardedUpdate, insertReturning, queryAll, type RepoError, type WriteContext } from './common';

const SkillRow = z
  .object({
    id: z.string(),
    key: z.string(),
    name: z.string(),
    description: z.string(),
    instruction: z.string(),
    enabled: z.number().int(),
    builtin_version: z.string().nullable(),
    version: z.number().int(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .transform((r) => ({
    id: r.id,
    key: r.key,
    name: r.name,
    /** 适用说明（SKILL.md 的 description）：做什么、什么时候用。内置技能的在模板里，这里为空。 */
    description: r.description,
    /** 作者改过的说明；内置技能为空时沿用模板文字。 */
    instruction: r.instruction,
    enabled: r.enabled === 1,
    builtinVersion: r.builtin_version,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
export type WritingSkill = z.output<typeof SkillRow>;

const COLUMNS = 'id, key, name, description, instruction, enabled, builtin_version, version, created_at, updated_at';

export type BuiltinSkill = { readonly key: string; readonly name: string; readonly version: string };

export function listSkills(port: SqlPort): Promise<Result<WritingSkill[], RepoError>> {
  return queryAll(port, SkillRow, `SELECT ${COLUMNS} FROM writing_skill ORDER BY builtin_version IS NULL, created_at, rowid`);
}

/**
 * 把内置技能登记进作品：作品里还没有的键新建为启用；已有的只更新内置版本与名称，保留作者的启用状态与改动。
 * 打开作品时调用，内置技能升级后作品自动跟上。
 */
export async function ensureBuiltinSkills(
  port: SqlPort,
  builtins: readonly BuiltinSkill[],
  newId: () => string,
  ctx: WriteContext,
): Promise<Result<WritingSkill[], RepoError>> {
  const current = await listSkills(port);
  if (!current.ok) return current;
  const byKey = new Map(current.value.map((s) => [s.key, s]));
  const statements: Statement[] = [];
  for (const b of builtins) {
    const existing = byKey.get(b.key);
    if (existing === undefined) {
      statements.push({
        sql: 'INSERT INTO writing_skill (id, key, name, builtin_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        params: [newId(), b.key, b.name, b.version, ctx.now, ctx.now],
      });
    } else if (existing.builtinVersion !== null && (existing.builtinVersion !== b.version || existing.name !== b.name)) {
      statements.push({
        sql: 'UPDATE writing_skill SET name = ?, builtin_version = ?, version = version + 1, updated_at = ? WHERE id = ?',
        params: [b.name, b.version, ctx.now, existing.id],
      });
    }
  }
  if (statements.length === 0) return current;
  const result = await port.transaction(statements);
  return result.ok ? listSkills(port) : err({ code: 'sql', error: result.error });
}

export function createCustomSkill(
  port: SqlPort,
  input: { readonly id: string; readonly key: string; readonly name: string; readonly description: string; readonly instruction: string },
  ctx: WriteContext,
): Promise<Result<WritingSkill, RepoError>> {
  if (input.instruction.trim() === '') return Promise.resolve(err({ code: 'invalid', detail: '自定义技能须写明说明' }));
  return insertReturning(port, SkillRow, {
    sql: `INSERT INTO writing_skill (id, key, name, description, instruction, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING ${COLUMNS}`,
    params: [input.id, input.key, input.name, input.description, input.instruction, ctx.now, ctx.now],
  });
}

/** 启用、停用或改写说明。内置技能的说明清空即恢复模板文字；自定义技能的说明不能清空。 */
export function updateSkill(
  port: SqlPort,
  current: WritingSkill,
  patch: { readonly enabled?: boolean; readonly name?: string; readonly description?: string; readonly instruction?: string },
  ctx: WriteContext,
): Promise<Result<WritingSkill, RepoError>> {
  const instruction = patch.instruction ?? current.instruction;
  if (current.builtinVersion === null && instruction.trim() === '') return Promise.resolve(err({ code: 'invalid', detail: '自定义技能须写明说明' }));
  return guardedUpdate(port, SkillRow, 'writing_skill', current.id, {
    sql: `UPDATE writing_skill SET enabled = ?, name = ?, description = ?, instruction = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ? RETURNING ${COLUMNS}`,
    params: [(patch.enabled ?? current.enabled) ? 1 : 0, patch.name ?? current.name, patch.description ?? current.description, instruction, ctx.now, current.id, current.version],
  });
}

/** 只有作者自定义的技能可以删除；内置技能只能停用。 */
export async function deleteCustomSkill(port: SqlPort, current: WritingSkill): Promise<Result<void, RepoError>> {
  if (current.builtinVersion !== null) return err({ code: 'invalid', detail: '内置技能只能停用，不能删除' });
  const result = await port.transaction([{ sql: 'DELETE FROM writing_skill WHERE id = ? AND version = ?', params: [current.id, current.version], expectChanges: 1 }]);
  if (result.ok) return ok(undefined);
  return err(result.error.code === 'guard_failed' ? { code: 'conflict' } : { code: 'sql', error: result.error });
}
