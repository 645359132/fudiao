// 桌面端的模型调用（需求 B19、B35、B36，施工文档第六章）：用默认模型、经凭据代理发出，每次调用写入作品库的 llm_call；
// 结构化输出经管线校验与有限次修正，仍失败时暂停并说明原因；必须输出结构化数据的任务只能用通过能力自检的模型。
import {
  structured,
  withCallLog,
  withRetry,
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
  webSearch: z.object({ requests: z.number(), results: z.array(z.object({ url: z.string(), title: z.string(), snippet: z.string() })), error: z.string().optional() }).optional(),
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
        costEstimate: row.value.costEstimate,
        startedAt: row.value.startedAt,
        finishedAt: row.value.finishedAt,
      } satisfies LlmCallRecord;
    },
    async append(record) {
      // 回复到一半出错时记下已知的部分用量（这次可能已计费）。
      const usage = record.result?.usage ?? record.error?.partial?.usage ?? null;
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
        costEstimate: record.costEstimate ?? null,
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

export { THINKING_ALLOWANCE } from './thinking';

export type ModelChoice = { readonly provider: ProviderView; readonly model: StoredModel };

export type RunRequest = {
  readonly prompt: RenderedPrompt;
  readonly maxOutputTokens: number;
  readonly effort?: LlmRequest['effort'];
  readonly stepKey?: string;
  /** 不用默认模型、指定用哪个模型（模型自带的联网搜索按搜索服务里选的模型，M7-02）。 */
  readonly model?: ModelChoice;
  /** 服务端工具（目前只有联网搜索）；适配器按模型能力传参，不支持时返回明确的错误。 */
  readonly tools?: LlmRequest['tools'];
};

export type RunnerDeps = {
  readonly deps: AppDeps;
  /** 当前打开的作品库；没有打开作品时调用不写记录。 */
  readonly project: () => SqlPort | null;
  readonly defaultModel: () => Promise<Result<ModelChoice | null, AppError>>;
};

const settings = (detail: string): AppError => ({ code: 'settings', detail });

/** 没有打开作品时最多暂存多少条调用记录（超出时丢掉最早的）。 */
const UNSAVED_CALLS_LIMIT = 500;

export function modelRunner({ deps, project, defaultModel }: RunnerDeps) {
  /**
   * 没有打开作品时（例如 AI 助手新建作品之前的几步）的调用记录先暂存在这里，下一次在某部作品里调用时补记进那部作品，
   * 用量与费用因此不漏算。这些调用没有步骤键，不需要查重。
   */
  let unsaved: LlmCallRecord[] = [];
  const unsavedLog: CallLog = {
    findCompleted: () => Promise.resolve(undefined),
    append(record) {
      unsaved = [...unsaved, record].slice(-UNSAVED_CALLS_LIMIT);
      return Promise.resolve();
    },
  };
  async function flushUnsaved(log: CallLog): Promise<void> {
    const records = unsaved;
    unsaved = [];
    for (const record of records) await log.append(record);
  }

  async function prepare(request: RunRequest, needsStructured: boolean): Promise<Result<{ port: LlmPort; llmRequest: LlmRequest; name: string; contextWindow: number }, AppError>> {
    const choice = request.model === undefined ? await defaultModel() : ok(request.model);
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
      ...(request.tools !== undefined && { tools: request.tools }),
      maxOutputTokens: Math.min(request.maxOutputTokens, model.capabilities.maxOutputTokens),
      ...(request.effort !== undefined && { effort: request.effort }),
      ...(request.stepKey !== undefined && { stepKey: request.stepKey }),
    };
    const adapter = deps.llm.forProvider(provider);
    const db = project();
    const log = db === null ? unsavedLog : projectCallLog(db, () => deps.ids.next());
    if (db !== null && unsaved.length > 0) await flushUnsaved(log);
    // 网络中断时整次重新请求（withRetry 在调用记录外面：每次尝试各记一条，失败的不计入完成记录）。
    const port = withRetry(withCallLog(adapter, log, () => deps.clock.now()), deps.retry);
    return ok({ port, llmRequest, name, contextWindow: model.capabilities.contextWindow });
  }

  return {
    /**
     * 默认模型的上下文上限与最大输出（AI 助手发请求前估算放不放得下）；没有默认模型时为 null。
     * nativeSchema：输出结构是否随请求发出（原生结构化输出），发出时也占输入。
     */
    async modelLimits(): Promise<{ readonly model: string; readonly contextWindow: number; readonly maxOutputTokens: number; readonly nativeSchema: boolean } | null> {
      const choice = await defaultModel();
      if (!choice.ok || choice.value === null) return null;
      const { contextWindow, maxOutputTokens, structuredOutput } = choice.value.model.capabilities;
      return { model: choice.value.model.id, contextWindow, maxOutputTokens, nativeSchema: structuredOutput === 'native' };
    },

    /** 纯文本任务（续写、改写等）：不需要通过能力自检。 */
    async text(request: RunRequest, options: CallOptions = {}): Promise<Result<LlmResult, AppError>> {
      const blocked = options.beforeCall?.() ?? null;
      if (blocked !== null) return err({ code: 'interrupted', detail: blocked });
      const prepared = await prepare(request, false);
      if (!prepared.ok) return prepared;
      const result = await prepared.value.port.complete(prepared.value.llmRequest, options);
      return result.ok ? result : err(settings(`调用${prepared.value.name}失败（${result.error.code}）：${result.error.message}`));
    },

    /** 结构化任务：经结构化输出管线校验，失败时最多修正 MAX_REPAIRS 次，仍失败则返回暂停原因。 */
    /** 结果里带上所用模型的上下文上限（AI 助手据此显示上下文用了多少）。 */
    async structured<T>(
      request: RunRequest,
      schema: z.ZodType<T>,
      options: CallOptions = {},
    ): Promise<Result<{ value: T; attempts: readonly LlmResult[]; contextWindow: number }, AppError>> {
      // 调用开始前问一声（写作工作流的预算）：不发出请求，这次调用以那个原因失败；已有完成记录时也不再复用——停下就是停下。
      const blocked = options.beforeCall?.() ?? null;
      if (blocked !== null) return err({ code: 'interrupted', detail: blocked });
      const prepared = await prepare(request, true);
      if (!prepared.ok) return prepared;
      const repairMessage = (issues: readonly string[]) => {
        const rendered = renderStructuredRepair(issues);
        return rendered.ok ? rendered.value : issues.join('\n');
      };
      const result = await structured(prepared.value.port, schema, prepared.value.llmRequest, { ...options, maxRepairs: MAX_REPAIRS, repairMessage });
      return result.ok ? ok({ ...result.value, contextWindow: prepared.value.contextWindow }) : err(settings(describeStructuredFailure(result.error, prepared.value.name)));
    },
  };
}
