// 桌面端的模型调用（需求 B19、B35、B36，施工文档第五章）：用默认模型、经凭据代理发出，每次调用写入作品库的 llm_call；
// 结构化输出经管线校验与有限次修正，仍失败时暂停并说明原因；必须输出结构化数据的任务只能用通过能力自检的模型。
import {
  structured,
  withCallLog,
  type CallLog,
  type CallOptions,
  type LlmCallRecord,
  type LlmPort,
  type LlmRequest,
  type LlmResult,
  type ModelProfile,
  type StructuredError,
  type TaskKind,
} from '@fudiao/llm';
import { renderStructuredRepair, type RenderedPrompt } from '@fudiao/prompts';
import { err, ok, type Result } from '@fudiao/shared';
import { appendLlmCall, findCompletedCall, type LlmCallRow, type SqlPort, type StoredModel } from '@fudiao/store';
import { z } from 'zod';
import type { AppError } from './errors';
import type { ProviderView } from './model-services';
import type { AppDeps } from './ports';

/** 结构化输出的修正次数上限（B35）。 */
export const MAX_REPAIRS = 2;

const Usage = z.object({ inputTokens: z.number(), outputTokens: z.number(), cacheReadTokens: z.number(), cacheWriteTokens: z.number() });

/** 调用记录中保存的结果，按模型端口的类型校验后才复用。 */
const StoredResult = z.object({
  outcome: z.enum(['completed', 'truncated', 'refused', 'cancelled']),
  text: z.string(),
  usage: Usage.nullable(),
  provider: z.string(),
  servedModel: z.string(),
  stopReason: z.string().nullable(),
  refusal: z.object({ category: z.string().nullable(), explanation: z.string().nullable() }).optional(),
  fallbackUsed: z.boolean(),
  requestHash: z.string(),
});

/** llm_call 表上的调用记录（packages/llm 的 CallLog）。 */
export function projectCallLog(port: SqlPort, newId: () => string): CallLog {
  return {
    async findCompleted(stepKey) {
      const row = await findCompletedCall(port, stepKey);
      if (!row.ok || row.value === null) return undefined;
      const result = StoredResult.safeParse(row.value.response);
      if (!result.success) return undefined;
      return {
        stepKey,
        requestHash: row.value.requestHash,
        task: row.value.taskKind as TaskKind,
        provider: row.value.provider,
        model: row.value.model,
        templateId: row.value.templateId,
        templateVersion: row.value.templateVersion,
        params: { maxOutputTokens: Number(row.value.params['maxOutputTokens'] ?? 0) },
        status: row.value.status,
        result: result.data,
        cost: row.value.cost,
        startedAt: row.value.startedAt,
        finishedAt: row.value.finishedAt,
      } satisfies LlmCallRecord;
    },
    async append(record) {
      const usage = record.result?.usage ?? null;
      const row: LlmCallRow = {
        id: newId(),
        stepKey: record.stepKey,
        taskKind: record.task,
        provider: record.provider,
        model: record.model,
        servedModel: record.result?.servedModel ?? null,
        params: record.params,
        templateId: record.templateId,
        templateVersion: record.templateVersion,
        requestHash: record.requestHash,
        status: record.status,
        usage: usage === null ? null : { input: usage.inputTokens, output: usage.outputTokens, cacheRead: usage.cacheReadTokens, cacheWrite: usage.cacheWriteTokens },
        cost: record.cost,
        response: record.result ?? null,
        error: record.error ?? null,
        startedAt: record.startedAt,
        finishedAt: record.finishedAt,
      };
      // 记录写不进去时不影响调用结果；恢复时该步骤会重新调用。
      await appendLlmCall(port, row);
    },
  };
}

/** 给作者看的暂停原因（B35）。 */
export function describeStructuredFailure(error: StructuredError, modelName: string): string {
  switch (error.code) {
    case 'call_failed':
      return `调用${modelName}失败（${error.error.code}）：${error.error.message}`;
    case 'refused':
      return `${modelName}拒绝了这个请求${error.result.refusal?.explanation ? `：${error.result.refusal.explanation}` : ''}`;
    case 'truncated':
      return `${modelName}的输出被截断：可以在模型服务中调高这个模型的最大输出，或换一个模型`;
    case 'cancelled':
      return '已取消';
    case 'invalid_output':
      return `${modelName}的输出连续 ${MAX_REPAIRS + 1} 次不符合格式，任务已暂停：${error.issues.slice(0, 3).join('；')}`;
  }
}

export type ModelChoice = { readonly provider: ProviderView; readonly model: StoredModel };

export type RunRequest = {
  readonly prompt: RenderedPrompt;
  readonly maxOutputTokens: number;
  readonly effort?: LlmRequest['effort'];
  readonly stepKey?: string;
};

export type RunnerDeps = {
  readonly deps: AppDeps;
  /** 当前打开的作品库；没有打开作品时调用不写记录。 */
  readonly project: () => SqlPort | null;
  readonly defaultModel: () => Promise<Result<ModelChoice | null, AppError>>;
};

const settings = (detail: string): AppError => ({ code: 'settings', detail });

export function modelRunner({ deps, project, defaultModel }: RunnerDeps) {
  async function prepare(request: RunRequest, needsStructured: boolean): Promise<Result<{ port: LlmPort; llmRequest: LlmRequest; name: string }, AppError>> {
    const choice = await defaultModel();
    if (!choice.ok) return choice;
    if (choice.value === null) return err(settings('还没有设置默认模型：请在“模型服务”中添加服务与模型'));
    const { provider, model } = choice.value;
    const name = `“${model.displayName}”`;
    if (needsStructured && (!model.capabilities.selfTestPassed || model.capabilities.structuredOutput === 'none')) {
      return err(settings(`默认模型${name}没有通过能力自检，不能用于需要结构化输出的任务；请在“模型服务”中运行能力自检，或换一个模型`));
    }
    const profile: ModelProfile = { provider: provider.id, model: model.modelId, capabilities: model.capabilities, ...(model.prices !== null && { prices: model.prices }) };
    const p = request.prompt;
    const llmRequest: LlmRequest = {
      task: p.task as TaskKind,
      model: profile,
      template: p.template,
      system: p.system,
      messages: p.messages,
      ...(p.output !== undefined && { output: p.output }),
      maxOutputTokens: Math.min(request.maxOutputTokens, model.capabilities.maxOutputTokens),
      ...(request.effort !== undefined && { effort: request.effort }),
      ...(request.stepKey !== undefined && { stepKey: request.stepKey }),
    };
    const adapter = deps.llm.forProvider(provider);
    const db = project();
    const port = db === null ? adapter : withCallLog(adapter, projectCallLog(db, () => deps.ids.next()), () => deps.clock.now());
    return ok({ port, llmRequest, name });
  }

  return {
    /** 纯文本任务（续写、改写等）：不需要通过能力自检。 */
    async text(request: RunRequest, options: CallOptions = {}): Promise<Result<LlmResult, AppError>> {
      const prepared = await prepare(request, false);
      if (!prepared.ok) return prepared;
      const result = await prepared.value.port.complete(prepared.value.llmRequest, options);
      return result.ok ? result : err(settings(`调用${prepared.value.name}失败（${result.error.code}）：${result.error.message}`));
    },

    /** 结构化任务：经结构化输出管线校验，失败时最多修正 MAX_REPAIRS 次，仍失败则返回暂停原因。 */
    async structured<T>(request: RunRequest, schema: z.ZodType<T>, options: CallOptions = {}): Promise<Result<{ value: T; attempts: readonly LlmResult[] }, AppError>> {
      const prepared = await prepare(request, true);
      if (!prepared.ok) return prepared;
      const repairMessage = (issues: readonly string[]) => {
        const rendered = renderStructuredRepair(issues);
        return rendered.ok ? rendered.value : issues.join('\n');
      };
      const result = await structured(prepared.value.port, schema, prepared.value.llmRequest, { ...options, maxRepairs: MAX_REPAIRS, repairMessage });
      return result.ok ? ok(result.value) : err(settings(describeStructuredFailure(result.error, prepared.value.name)));
    },
  };
}
