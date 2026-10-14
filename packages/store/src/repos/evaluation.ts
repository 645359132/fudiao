// 推演评价（需求 B46，迁移 0008）：单次推演评价一次运行，批量推演在整组结束后评价一次。
// 评分项与 M0 评价表相同（apps/m0-cli/src/report），便于与 M0 的结果对照。
import { err, type Result } from '@fudiao/shared';
import { z } from 'zod';
import type { SqlPort } from '../sql';
import { guardedUpdate, insertReturning, jsonColumn, queryOne, type RepoError, type WriteContext } from './common';

const scale = (max: number, min = 1) => z.number().int().min(min).max(max).nullable();

/** 作者的评分；不打的项为 null。edits：采纳前修改量，0 无、1 少量、2 较多、3 需重写。 */
export const EvaluationScores = z.object({
  characters: scale(5),
  intel: scale(5),
  twist: scale(5),
  adopt: scale(5),
  edits: scale(3, 0),
});
export type EvaluationScores = z.infer<typeof EvaluationScores>;

/** 保存时由程序记下的客观数据：采纳进作品的故事事件、调用费用（未知的单独计数）与模型耗时。 */
export const EvaluationMeasured = z.object({
  runIds: z.array(z.string()),
  adoptedEventIds: z.array(z.string()),
  calls: z.number().int().min(0),
  costUsd: z.number().min(0),
  unknownCostCalls: z.number().int().min(0),
  modelMs: z.number().min(0),
});
export type EvaluationMeasured = z.infer<typeof EvaluationMeasured>;

export const EvaluationAnswers = z.object({
  scores: EvaluationScores,
  /** 可采用的转折：是哪一处。 */
  twistNote: z.string(),
  note: z.string(),
  measured: EvaluationMeasured,
});
export type EvaluationAnswers = z.infer<typeof EvaluationAnswers>;

export type EvaluationTarget = { readonly runId: string } | { readonly batchId: string };

const Row = z
  .object({
    id: z.string(),
    run_id: z.string().nullable(),
    batch_id: z.string().nullable(),
    answers: jsonColumn(EvaluationAnswers),
    version: z.number().int(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .transform((r) => ({ id: r.id, runId: r.run_id, batchId: r.batch_id, answers: r.answers, version: r.version, createdAt: r.created_at, updatedAt: r.updated_at }));
export type Evaluation = z.output<typeof Row>;

const COLUMNS = 'id, run_id, batch_id, answers, version, created_at, updated_at';

export function getEvaluation(port: SqlPort, target: EvaluationTarget): Promise<Result<Evaluation | null, RepoError>> {
  return 'runId' in target
    ? queryOne(port, Row, `SELECT ${COLUMNS} FROM evaluation WHERE run_id = ?`, [target.runId])
    : queryOne(port, Row, `SELECT ${COLUMNS} FROM evaluation WHERE batch_id = ?`, [target.batchId]);
}

/** 第一次保存时新建，之后修改（版本守卫）；current 是作者打开时读到的评价。 */
export function saveEvaluation(
  port: SqlPort,
  input: { readonly id: string; readonly target: EvaluationTarget; readonly answers: EvaluationAnswers },
  current: Evaluation | null,
  ctx: WriteContext,
): Promise<Result<Evaluation, RepoError>> {
  const answers = EvaluationAnswers.safeParse(input.answers);
  if (!answers.success) return Promise.resolve(err({ code: 'invalid', detail: '评价的内容不对' }));
  const json = JSON.stringify(answers.data);
  if (current !== null) {
    return guardedUpdate(port, Row, 'evaluation', current.id, {
      sql: `UPDATE evaluation SET answers = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ? RETURNING ${COLUMNS}`,
      params: [json, ctx.now, current.id, current.version],
    });
  }
  const runId = 'runId' in input.target ? input.target.runId : null;
  const batchId = 'batchId' in input.target ? input.target.batchId : null;
  return insertReturning(port, Row, {
    sql: `INSERT INTO evaluation (id, run_id, batch_id, answers, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING ${COLUMNS}`,
    params: [input.id, runId, batchId, json, ctx.now, ctx.now],
  });
}
