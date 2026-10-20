// 写作工作流（需求 B78，迁移 0019）：一次运行与它的步骤。步骤的结果、改动与用量存为 JSON，
// 结构由应用层按工作流的定义校验，这里只保证是合法的 JSON。
import { err, ok, WORKFLOW_MODES, WORKFLOW_STEP_STATUSES, type Result, type WorkflowMode, type WorkflowStepStatus } from '@fudiao/shared';
import { z } from 'zod';
import type { SqlPort, Statement } from '../sql';
import { guardedUpdate, jsonColumn, queryAll, queryOne, type RepoError, type WriteContext } from './common';

const nullableJson = <T>(schema: z.ZodType<T>) => z.union([z.null(), jsonColumn(schema)]);
const JsonObject = z.record(z.string(), z.unknown());

const RunRow = z
  .object({
    id: z.string(),
    workflow: z.string(),
    title: z.string(),
    params: jsonColumn(JsonObject),
    mode: z.enum(WORKFLOW_MODES),
    budget_usd: z.number().nullable(),
    status: z.enum(['active', 'abandoned']),
    version: z.number().int(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .transform((r) => ({
    id: r.id,
    workflow: r.workflow,
    title: r.title,
    params: r.params,
    mode: r.mode,
    budgetUsd: r.budget_usd,
    abandoned: r.status === 'abandoned',
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
export type WorkflowRun = z.output<typeof RunRow>;

/** 一步的用量：Token 与费用（按当时默认模型的价格；用量或价格未知的调用计入 unknown）。 */
export const StepUsage = z.object({
  input: z.number(),
  output: z.number(),
  cost: z.number(),
  unknown: z.number().int(),
});
export type StepUsage = z.infer<typeof StepUsage>;

const StepRow = z
  .object({
    run_id: z.string(),
    idx: z.number().int(),
    key: z.string(),
    status: z.enum(WORKFLOW_STEP_STATUSES),
    output: nullableJson(z.unknown()),
    edited: z.number().int(),
    attempt: z.number().int(),
    note: z.string(),
    changes: nullableJson(z.array(z.unknown())),
    usage: nullableJson(StepUsage),
    based_on: nullableJson(JsonObject),
    started_at: z.string().nullable(),
    finished_at: z.string().nullable(),
    version: z.number().int(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .transform((r) => ({
    runId: r.run_id,
    idx: r.idx,
    key: r.key,
    status: r.status,
    output: r.output ?? null,
    edited: r.edited === 1,
    attempt: r.attempt,
    note: r.note,
    changes: r.changes ?? null,
    usage: r.usage ?? null,
    basedOn: r.based_on ?? null,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
export type WorkflowStepRow = z.output<typeof StepRow>;

export type WorkflowRunWithSteps = { readonly run: WorkflowRun; readonly steps: readonly WorkflowStepRow[] };

const RUN_COLUMNS = 'id, workflow, title, params, mode, budget_usd, status, version, created_at, updated_at';
const STEP_COLUMNS = 'run_id, idx, key, status, output, edited, attempt, note, changes, usage, based_on, started_at, finished_at, version, created_at, updated_at';

export type NewWorkflowRun = {
  readonly id: string;
  readonly workflow: string;
  readonly title: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly mode: WorkflowMode;
  readonly budgetUsd: number | null;
  /** 步骤的键，按顺序。 */
  readonly steps: readonly string[];
};

/** 新建一次运行与它的全部步骤（都为待做），在一个事务中写入。 */
export async function createWorkflowRun(port: SqlPort, input: NewWorkflowRun, ctx: WriteContext): Promise<Result<WorkflowRunWithSteps, RepoError>> {
  if (input.steps.length === 0) return err({ code: 'invalid', detail: '工作流至少要有一步' });
  if (new Set(input.steps).size !== input.steps.length) return err({ code: 'invalid', detail: '步骤的键重复' });
  if (input.budgetUsd !== null && !(input.budgetUsd > 0)) return err({ code: 'invalid', detail: '预算上限须大于 0' });
  const statements: Statement[] = [
    {
      sql: 'INSERT INTO workflow_run (id, workflow, title, params, mode, budget_usd, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      params: [input.id, input.workflow, input.title, JSON.stringify(input.params), input.mode, input.budgetUsd, ctx.now, ctx.now],
    },
    ...input.steps.map((key, idx) => ({
      sql: 'INSERT INTO workflow_step (run_id, idx, key, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      params: [input.id, idx, key, ctx.now, ctx.now],
    })),
  ];
  const done = await port.transaction(statements);
  if (!done.ok) return err({ code: 'sql', error: done.error });
  const created = await getWorkflowRun(port, input.id);
  if (!created.ok) return created;
  return created.value === null ? err({ code: 'not_found' }) : ok(created.value);
}

/** 这部作品的全部运行，最近开始的在前。 */
export function listWorkflowRuns(port: SqlPort): Promise<Result<WorkflowRun[], RepoError>> {
  return queryAll(port, RunRow, `SELECT ${RUN_COLUMNS} FROM workflow_run ORDER BY created_at DESC, id DESC`);
}

export async function getWorkflowRun(port: SqlPort, id: string): Promise<Result<WorkflowRunWithSteps | null, RepoError>> {
  const run = await queryOne(port, RunRow, `SELECT ${RUN_COLUMNS} FROM workflow_run WHERE id = ?`, [id]);
  if (!run.ok) return run;
  if (run.value === null) return ok(null);
  const steps = await queryAll(port, StepRow, `SELECT ${STEP_COLUMNS} FROM workflow_step WHERE run_id = ? ORDER BY idx`, [id]);
  return steps.ok ? ok({ run: run.value, steps: steps.value }) : steps;
}

/** 步骤可以修改的字段；省略的不改。output、changes、usage、basedOn 为 null 时清空。 */
export type StepPatch = {
  readonly status?: WorkflowStepStatus;
  readonly output?: unknown;
  readonly edited?: boolean;
  readonly attempt?: number;
  readonly note?: string;
  readonly changes?: readonly unknown[] | null;
  readonly usage?: StepUsage | null;
  readonly basedOn?: Readonly<Record<string, unknown>> | null;
  readonly startedAt?: string | null;
  readonly finishedAt?: string | null;
};

const json = (value: unknown): string | null => (value === null || value === undefined ? null : JSON.stringify(value));

function patchStatement(runId: string, idx: number, expectedVersion: number, patch: StepPatch, ctx: WriteContext): Statement {
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  const set = (column: string, value: string | number | null) => {
    sets.push(`${column} = ?`);
    params.push(value);
  };
  if (patch.status !== undefined) set('status', patch.status);
  if (patch.output !== undefined) set('output', json(patch.output));
  if (patch.edited !== undefined) set('edited', patch.edited ? 1 : 0);
  if (patch.attempt !== undefined) set('attempt', patch.attempt);
  if (patch.note !== undefined) set('note', patch.note);
  if (patch.changes !== undefined) set('changes', json(patch.changes));
  if (patch.usage !== undefined) set('usage', json(patch.usage));
  if (patch.basedOn !== undefined) set('based_on', json(patch.basedOn));
  if (patch.startedAt !== undefined) set('started_at', patch.startedAt);
  if (patch.finishedAt !== undefined) set('finished_at', patch.finishedAt);
  return {
    sql: `UPDATE workflow_step SET ${[...sets, 'version = version + 1', 'updated_at = ?'].join(', ')} WHERE run_id = ? AND idx = ? AND version = ?`,
    params: [...params, ctx.now, runId, idx, expectedVersion],
    expectChanges: 1,
  };
}

/** 修改一步（版本守卫）。 */
export function updateWorkflowStep(port: SqlPort, step: Pick<WorkflowStepRow, 'runId' | 'idx' | 'version'>, patch: StepPatch, ctx: WriteContext): Promise<Result<WorkflowStepRow, RepoError>> {
  const statement = patchStatement(step.runId, step.idx, step.version, patch, ctx);
  return guardedUpdate(port, StepRow, 'workflow_step', step.runId, { sql: `${statement.sql} RETURNING ${STEP_COLUMNS}`, params: statement.params }, 'run_id');
}

/**
 * 在一个事务中修改同一运行的几步（例如重做一步时把它后面已完成的步骤标为可能过时）；任何一步的版本不符都不改。
 * 返回修改后的整次运行。
 */
export async function updateWorkflowSteps(
  port: SqlPort,
  runId: string,
  updates: readonly { readonly step: Pick<WorkflowStepRow, 'idx' | 'version'>; readonly patch: StepPatch }[],
  ctx: WriteContext,
): Promise<Result<WorkflowRunWithSteps, RepoError>> {
  if (updates.length > 0) {
    const done = await port.transaction(updates.map((u) => patchStatement(runId, u.step.idx, u.step.version, u.patch, ctx)));
    if (!done.ok) return err(done.error.code === 'guard_failed' ? { code: 'conflict' } : { code: 'sql', error: done.error });
  }
  const after = await getWorkflowRun(port, runId);
  if (!after.ok) return after;
  return after.value === null ? err({ code: 'not_found' }) : ok(after.value);
}

/**
 * 写回一步进行中的用量（不带版本守卫、不改版本）：每收到一次调用的用量就写一次，中途崩溃时已发生的费用不丢。
 * 这一步结束时执行器再以版本守卫写一次总数。
 */
export async function setWorkflowStepUsage(port: SqlPort, runId: string, idx: number, usage: StepUsage, ctx: WriteContext): Promise<Result<void, RepoError>> {
  const done = await port.transaction([{ sql: 'UPDATE workflow_step SET usage = ?, updated_at = ? WHERE run_id = ? AND idx = ?', params: [JSON.stringify(usage), ctx.now, runId, idx] }]);
  return done.ok ? ok(undefined) : err({ code: 'sql', error: done.error });
}

/** 放弃一次运行（版本守卫）。放弃的运行不再推进，记录照旧保留。 */
export function abandonWorkflowRun(port: SqlPort, run: Pick<WorkflowRun, 'id' | 'version'>, ctx: WriteContext): Promise<Result<WorkflowRun, RepoError>> {
  return guardedUpdate(port, RunRow, 'workflow_run', run.id, {
    sql: `UPDATE workflow_run SET status = 'abandoned', version = version + 1, updated_at = ? WHERE id = ? AND version = ? RETURNING ${RUN_COLUMNS}`,
    params: [ctx.now, run.id, run.version],
  });
}

/**
 * 打开作品时：上次没有做完就关掉（或崩溃）的步骤还标着进行中，改为中断，作者继续时从这一步重做。
 * 返回改了几步。
 */
export async function interruptRunningSteps(port: SqlPort, ctx: WriteContext): Promise<Result<number, RepoError>> {
  const done = await port.transaction([{ sql: "UPDATE workflow_step SET status = 'interrupted', version = version + 1, updated_at = ? WHERE status = 'running'", params: [ctx.now] }]);
  if (!done.ok) return err({ code: 'sql', error: done.error });
  return ok(done.value[0]?.changes ?? 0);
}
