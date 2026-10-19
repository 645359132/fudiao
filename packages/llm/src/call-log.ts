import { err, ok, type Result } from '@fudiao/shared';
import { chargeOf } from './budget';
import { requestHash } from './request-hash';
import type { CallOptions, Effort, LlmError, LlmOutcome, LlmPort, LlmRequest, LlmResult, TaskKind } from './types';

/** 调用记录（B19、B36），对应作品库的 llm_call 表。不含请求头与凭据。 */
export type LlmCallRecord = {
  /** 推演步骤的确定键；选区操作等一次性调用没有步骤键。 */
  readonly stepKey: string | null;
  readonly requestHash: string;
  readonly task: TaskKind;
  readonly provider: string;
  readonly model: string;
  readonly templateId: string;
  readonly templateVersion: string;
  readonly params: { readonly maxOutputTokens: number; readonly effort?: Effort };
  /** 修正调用：上一次输出未通过校验的原因。 */
  readonly repairIssues?: readonly string[];
  readonly status: LlmOutcome | 'error';
  readonly result?: LlmResult;
  readonly error?: LlmError;
  readonly cost: number | null;
  /**
   * 费用未知、这次又可能已经计费时（服务没有返回用量，或已经开始回复后出错）按请求的最坏估计（输入估计加输出上限）
   * 记下的费用，预算与界面按它计入并注明是估计。价格未配置或不可能计费时为 null；较早的记录没有这一项。
   */
  readonly costEstimate?: number | null;
  readonly startedAt: string;
  readonly finishedAt: string;
};

export interface CallLog {
  /** 该步骤最近一次已完成（完成、截断或拒答）的记录。 */
  findCompleted(stepKey: string): Promise<LlmCallRecord | undefined>;
  append(record: LlmCallRecord): Promise<void>;
}

const FINAL: ReadonlySet<LlmCallRecord['status']> = new Set(['completed', 'truncated', 'refused']);

/**
 * 每次调用都写入调用记录（B36）。带步骤键的调用先查完成记录，有则直接复用，恢复时不重复调用、不重复计费
 * （硬性规则 10）；失败与取消的步骤会重新调用。
 */
export function withCallLog(port: LlmPort, log: CallLog, now: () => string): LlmPort {
  return {
    async complete(request: LlmRequest, options: CallOptions = {}): Promise<Result<LlmResult, LlmError>> {
      const stepKey = request.stepKey ?? null;
      const hash = requestHash(request);
      const done = stepKey === null ? undefined : await log.findCompleted(stepKey);
      if (done?.result !== undefined) {
        if (done.requestHash !== hash) {
          return err({ code: 'step_conflict', message: `步骤 ${stepKey} 已有记录，但请求内容不同` });
        }
        options.onEvent?.({ type: 'text', delta: done.result.text });
        return ok(done.result);
      }

      const startedAt = now();
      const result = await port.complete(request, options);
      const charge = chargeOf(request, result);
      await log.append({
        stepKey,
        requestHash: hash,
        task: request.task,
        provider: request.model.provider,
        model: request.model.model,
        templateId: request.template.id,
        templateVersion: request.template.version,
        params: {
          maxOutputTokens: request.maxOutputTokens,
          ...(request.effort !== undefined && { effort: request.effort }),
        },
        ...(request.repairOf !== undefined && { repairIssues: request.repairOf }),
        status: result.ok ? result.value.outcome : 'error',
        ...(result.ok ? { result: result.value } : { error: result.error }),
        cost: charge !== null && !charge.estimated ? charge.usd : null,
        costEstimate: charge !== null && charge.estimated ? charge.usd : null,
        startedAt,
        finishedAt: now(),
      });
      return result;
    },
  };
}

/** 内存中的调用记录，测试使用；M0-08 起由事件存储提供持久实现。 */
export function memoryCallLog() {
  const records: LlmCallRecord[] = [];
  return {
    findCompleted: (stepKey: string) =>
      Promise.resolve(records.findLast((r) => r.stepKey === stepKey && FINAL.has(r.status))),
    append: (record: LlmCallRecord) => {
      records.push(record);
      return Promise.resolve();
    },
    records: (): readonly LlmCallRecord[] => records,
  };
}
