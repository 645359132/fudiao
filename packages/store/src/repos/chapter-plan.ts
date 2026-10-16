// 章节计划（需求 B65）：每章的目标、出场人物、要写的情节点、要埋与要收的伏笔、详略说明与字数；成书流程按它推进。
import { err, ok, type Result } from '@fudiao/shared';
import { z } from 'zod';
import type { SqlPort } from '../sql';
import { guardedUpdate, insertReturning, jsonColumn, queryAll, queryOne, type RepoError, type WriteContext } from './common';

export const PLAN_STATUSES = ['todo', 'writing', 'written', 'reviewed'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

const ids = jsonColumn(z.array(z.string()));

/** 写手的进度：一次写作开始时定下分段，之后每写入一段更新 done（与段落同一事务）。 */
export const WriterProgress = z.object({
  /** 这次写作的标识，步骤键的一部分：续写时复用已完成的调用，不重复计费。 */
  runId: z.string(),
  /** 每段要写的情节点。 */
  segments: z.array(z.array(z.string())),
  /** 每段的目标字数。 */
  words: z.array(z.number().int().positive()),
  /** 已写入正文的段数。 */
  done: z.number().int().nonnegative(),
  /** 写入前的“写手写入”快照，一键回退用。 */
  snapshotId: z.string(),
});
export type WriterProgress = z.infer<typeof WriterProgress>;

export const PlanRow = z
  .object({
    chapter_id: z.string(),
    goal: z.string(),
    cast_ids: ids,
    beats: ids,
    foreshadow_plant: ids,
    foreshadow_payoff: ids,
    treatment: z.string(),
    target_words: z.number().int().nullable(),
    status: z.enum(PLAN_STATUSES),
    progress: jsonColumn(WriterProgress).nullable(),
    version: z.number().int(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .transform((r) => ({
    chapterId: r.chapter_id,
    goal: r.goal,
    castIds: r.cast_ids,
    beats: r.beats,
    foreshadowPlant: r.foreshadow_plant,
    foreshadowPayoff: r.foreshadow_payoff,
    treatment: r.treatment,
    targetWords: r.target_words,
    status: r.status,
    progress: r.progress,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
export type ChapterPlan = z.output<typeof PlanRow>;

export const PLAN_COLUMNS = 'chapter_id, goal, cast_ids, beats, foreshadow_plant, foreshadow_payoff, treatment, target_words, status, progress, version, created_at, updated_at';
const COLUMNS = PLAN_COLUMNS;

export type PlanFields = {
  readonly goal: string;
  readonly castIds: readonly string[];
  readonly beats: readonly string[];
  readonly foreshadowPlant: readonly string[];
  readonly foreshadowPayoff: readonly string[];
  readonly treatment: string;
  readonly targetWords: number | null;
};

export async function getChapterPlan(port: SqlPort, chapterId: string): Promise<Result<ChapterPlan | null, RepoError>> {
  return queryOne(port, PlanRow, `SELECT ${COLUMNS} FROM chapter_plan WHERE chapter_id = ?`, [chapterId]);
}

/** 回收站以外的章节的计划，按章节顺序。 */
export function listChapterPlans(port: SqlPort): Promise<Result<ChapterPlan[], RepoError>> {
  return queryAll(
    port,
    PlanRow,
    `SELECT ${COLUMNS.split(', ').map((c) => `p.${c}`).join(', ')} FROM chapter_plan p JOIN chapter c ON c.id = p.chapter_id
     JOIN chapter_book_order o ON o.chapter_id = c.id WHERE c.status = 'normal' ORDER BY o.position`,
  );
}

/**
 * 保存一章的计划：没有计划时新建（current 为 null），有则按版本更新。
 * 只改计划的内容，写作进度（status）由 setPlanStatus 推进。
 */
export function saveChapterPlan(port: SqlPort, chapterId: string, current: ChapterPlan | null, fields: PlanFields, ctx: WriteContext): Promise<Result<ChapterPlan, RepoError>> {
  const values = [
    fields.goal,
    JSON.stringify(fields.castIds),
    JSON.stringify(fields.beats),
    JSON.stringify(fields.foreshadowPlant),
    JSON.stringify(fields.foreshadowPayoff),
    fields.treatment,
    fields.targetWords,
  ];
  if (current === null) {
    return insertReturning(port, PlanRow, {
      sql: `INSERT INTO chapter_plan (chapter_id, goal, cast_ids, beats, foreshadow_plant, foreshadow_payoff, treatment, target_words, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${COLUMNS}`,
      params: [chapterId, ...values, ctx.now, ctx.now],
    });
  }
  return guardedUpdate(port, PlanRow, 'chapter_plan', current.chapterId, {
    sql: `UPDATE chapter_plan SET goal = ?, cast_ids = ?, beats = ?, foreshadow_plant = ?, foreshadow_payoff = ?, treatment = ?, target_words = ?,
            version = version + 1, updated_at = ? WHERE chapter_id = ? AND version = ? RETURNING ${COLUMNS}`,
    params: [...values, ctx.now, current.chapterId, current.version],
  }, 'chapter_id');
}

/**
 * 删除一章的计划（AI 助手撤销自己新建的计划时用）。写手写过的计划（有写作进度）不删：先回退写手写入。
 */
export async function deleteChapterPlan(port: SqlPort, current: ChapterPlan): Promise<Result<void, RepoError>> {
  if (current.progress !== null) return err({ code: 'invalid', detail: '写手写过这一章，先回退写手写入再删除计划' });
  const result = await port.transaction([{ sql: 'DELETE FROM chapter_plan WHERE chapter_id = ? AND version = ?', params: [current.chapterId, current.version], expectChanges: 1 }]);
  if (result.ok) return ok(undefined);
  return err(result.error.code === 'guard_failed' ? { code: 'conflict' } : { code: 'sql', error: result.error });
}

export function setPlanStatus(port: SqlPort, current: ChapterPlan, status: PlanStatus, ctx: WriteContext): Promise<Result<ChapterPlan, RepoError>> {
  return guardedUpdate(port, PlanRow, 'chapter_plan', current.chapterId, {
    sql: `UPDATE chapter_plan SET status = ?, version = version + 1, updated_at = ? WHERE chapter_id = ? AND version = ? RETURNING ${COLUMNS}`,
    params: [status, ctx.now, current.chapterId, current.version],
  }, 'chapter_id');
}
