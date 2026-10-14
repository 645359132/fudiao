// 模型调用记录（需求 B19、B36）：llm_call 表的读写与用量汇总。
// 只处理行；与 packages/llm 的 CallLog 之间的转换在应用层，存储层不依赖模型端口。
import { ok, type Result } from '@fudiao/shared';
import { z } from 'zod';
import type { SqlPort } from '../sql';
import { queryAll, queryOne, type RepoError } from './common';

export type LlmCallStatus = 'completed' | 'truncated' | 'refused' | 'cancelled' | 'error';

export type LlmCallUsage = { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number };

export type LlmCallRow = {
  readonly id: string;
  readonly stepKey: string | null;
  readonly taskKind: string;
  readonly provider: string;
  readonly model: string;
  readonly servedModel: string | null;
  readonly params: Readonly<Record<string, unknown>>;
  readonly templateId: string;
  readonly templateVersion: string;
  readonly requestHash: string;
  readonly status: LlmCallStatus;
  readonly usage: LlmCallUsage | null;
  readonly cost: number | null;
  /** 调用结果（含文本）或错误；由应用层按模型端口的类型校验。 */
  readonly response: unknown;
  readonly error: unknown;
  readonly startedAt: string;
  readonly finishedAt: string;
};

const jsonOrNull = z
  .string()
  .nullable()
  .transform((text, ctx): unknown => {
    if (text === null) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      ctx.addIssue({ code: 'custom', message: '调用记录的 JSON 无效' });
      return z.NEVER;
    }
  });

const Row = z
  .object({
    id: z.string(),
    step_key: z.string().nullable(),
    task_kind: z.string(),
    provider: z.string(),
    model: z.string(),
    served_model: z.string().nullable(),
    params: jsonOrNull,
    template_id: z.string(),
    template_version: z.string(),
    request_hash: z.string(),
    status: z.enum(['completed', 'truncated', 'refused', 'cancelled', 'error']),
    input_tokens: z.number().int().nullable(),
    output_tokens: z.number().int().nullable(),
    cache_read_tokens: z.number().int().nullable(),
    cache_write_tokens: z.number().int().nullable(),
    cost: z.number().nullable(),
    response: jsonOrNull,
    error: jsonOrNull,
    started_at: z.string(),
    finished_at: z.string(),
  })
  .transform(
    (r): LlmCallRow => ({
      id: r.id,
      stepKey: r.step_key,
      taskKind: r.task_kind,
      provider: r.provider,
      model: r.model,
      servedModel: r.served_model,
      params: r.params !== null && typeof r.params === 'object' ? (r.params as Record<string, unknown>) : {},
      templateId: r.template_id,
      templateVersion: r.template_version,
      requestHash: r.request_hash,
      status: r.status,
      usage:
        r.input_tokens === null || r.output_tokens === null
          ? null
          : { input: r.input_tokens, output: r.output_tokens, cacheRead: r.cache_read_tokens ?? 0, cacheWrite: r.cache_write_tokens ?? 0 },
      cost: r.cost,
      response: r.response,
      error: r.error,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
    }),
  );

const COLUMNS =
  'id, step_key, task_kind, provider, model, served_model, params, template_id, template_version, request_hash, status, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost, response, error, started_at, finished_at';

export async function appendLlmCall(port: SqlPort, row: LlmCallRow): Promise<Result<void, RepoError>> {
  const done = await port.transaction([
    {
      sql: `INSERT INTO llm_call (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        row.id,
        row.stepKey,
        row.taskKind,
        row.provider,
        row.model,
        row.servedModel,
        JSON.stringify(row.params),
        row.templateId,
        row.templateVersion,
        row.requestHash,
        row.status,
        row.usage?.input ?? null,
        row.usage?.output ?? null,
        row.usage?.cacheRead ?? null,
        row.usage?.cacheWrite ?? null,
        row.cost,
        row.response === null || row.response === undefined ? null : JSON.stringify(row.response),
        row.error === null || row.error === undefined ? null : JSON.stringify(row.error),
        row.startedAt,
        row.finishedAt,
      ],
    },
  ]);
  return done.ok ? ok(undefined) : { ok: false, error: { code: 'sql', error: done.error } };
}

/** 该步骤最近一次已完成（完成、截断或拒答）的记录；失败与取消的步骤会重新调用。 */
export function findCompletedCall(port: SqlPort, stepKey: string): Promise<Result<LlmCallRow | null, RepoError>> {
  return queryOne(
    port,
    Row,
    `SELECT ${COLUMNS} FROM llm_call WHERE step_key = ? AND status IN ('completed', 'truncated', 'refused') ORDER BY finished_at DESC, id DESC LIMIT 1`,
    [stepKey],
  );
}

/** 按请求哈希找到最近一次调用的记录标识与费用（候选稿据此关联生成它的调用，任务中心据此显示费用）。 */
export async function findCallByRequestHash(port: SqlPort, requestHash: string): Promise<Result<{ id: string; cost: number | null } | null, RepoError>> {
  const row = await queryOne(
    port,
    z.object({ id: z.string(), cost: z.number().nullable() }),
    'SELECT id, cost FROM llm_call WHERE request_hash = ? ORDER BY finished_at DESC, id DESC LIMIT 1',
    [requestHash],
  );
  return row.ok ? ok(row.value) : row;
}

/** 最近的调用，新的在前。 */
export function listLlmCalls(port: SqlPort, limit = 100): Promise<Result<LlmCallRow[], RepoError>> {
  return queryAll(port, Row, `SELECT ${COLUMNS} FROM llm_call ORDER BY finished_at DESC, id DESC LIMIT ?`, [limit]);
}

export type UsageTotals = {
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  /** 已知费用之和（美元）。 */
  readonly cost: number;
  /** 费用未知的调用数（价格未配置或服务没有返回用量）；大于 0 时总费用只是下限（B19）。 */
  readonly unknownCost: number;
};

export type UsageSummary = {
  readonly total: UsageTotals;
  readonly byTask: readonly (UsageTotals & { readonly task: string })[];
  readonly byModel: readonly (UsageTotals & { readonly provider: string; readonly model: string })[];
};

const TotalsRow = z.object({
  calls: z.number().int(),
  input_tokens: z.number().nullable(),
  output_tokens: z.number().nullable(),
  cache_read_tokens: z.number().nullable(),
  cache_write_tokens: z.number().nullable(),
  cost: z.number().nullable(),
  unknown_cost: z.number().nullable(),
});

const AGGREGATE = `count(*) AS calls,
  sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens,
  sum(cache_read_tokens) AS cache_read_tokens, sum(cache_write_tokens) AS cache_write_tokens,
  sum(cost) AS cost,
  sum(CASE WHEN cost IS NULL AND status <> 'error' THEN 1 ELSE 0 END) AS unknown_cost`;

const totals = (r: z.infer<typeof TotalsRow>): UsageTotals => ({
  calls: r.calls,
  inputTokens: r.input_tokens ?? 0,
  outputTokens: r.output_tokens ?? 0,
  cacheReadTokens: r.cache_read_tokens ?? 0,
  cacheWriteTokens: r.cache_write_tokens ?? 0,
  cost: r.cost ?? 0,
  unknownCost: r.unknown_cost ?? 0,
});

/** 用量与费用的汇总（B19）：全部、按任务、按模型。失败的调用计入次数，没有用量也不算“费用未知”。 */
export async function usageSummary(port: SqlPort): Promise<Result<UsageSummary, RepoError>> {
  const all = await queryOne(port, TotalsRow, `SELECT ${AGGREGATE} FROM llm_call`);
  if (!all.ok) return all;
  const byTask = await queryAll(port, TotalsRow.extend({ task_kind: z.string() }), `SELECT task_kind, ${AGGREGATE} FROM llm_call GROUP BY task_kind ORDER BY task_kind`);
  if (!byTask.ok) return byTask;
  const byModel = await queryAll(
    port,
    TotalsRow.extend({ provider: z.string(), model: z.string() }),
    `SELECT provider, model, ${AGGREGATE} FROM llm_call GROUP BY provider, model ORDER BY provider, model`,
  );
  if (!byModel.ok) return byModel;
  return ok({
    total: all.value === null ? totals({ calls: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost: 0, unknown_cost: 0 }) : totals(all.value),
    byTask: byTask.value.map((r) => ({ task: r.task_kind, ...totals(r) })),
    byModel: byModel.value.map((r) => ({ provider: r.provider, model: r.model, ...totals(r) })),
  });
}

const RunCallRow = z
  .object({ step_key: z.string(), task_kind: z.string(), status: z.string(), cost: z.number().nullable(), started_at: z.string(), finished_at: z.string() })
  .transform((r) => ({ stepKey: r.step_key, taskKind: r.task_kind, status: r.status, cost: r.cost, startedAt: r.started_at, finishedAt: r.finished_at }));
export type RunCall = z.output<typeof RunCallRow>;

/**
 * 一次推演运行的模型调用，按开始时间。推演的步骤键都以“运行标识:”开头，按这个前缀取（用得上步骤键的索引）。
 * 用来算这次运行已用的费用（预算，B28）与每回合的模型响应时间。
 */
export function listRunCalls(port: SqlPort, runId: string): Promise<Result<RunCall[], RepoError>> {
  return queryAll(
    port,
    RunCallRow,
    'SELECT step_key, task_kind, status, cost, started_at, finished_at FROM llm_call WHERE step_key >= ? AND step_key < ? ORDER BY started_at, id',
    // “;”是“:”的下一个字符：区间正好是以“运行标识:”开头的全部步骤键。
    [`${runId}:`, `${runId};`],
  );
}
