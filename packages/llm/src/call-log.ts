import { err, ok, type Result } from '@novel-writer/shared';
import { costOf } from './budget';
import { requestHash } from './request-hash';
import type { CallOptions, Effort, LlmError, LlmOutcome, LlmPort, LlmRequest, LlmResult, TaskKind } from './types';

/** 调用记录（B19、B36），对应作品库的 llm_call 表。不含请求头与凭据。 */
export type LlmCallRecord = {
  readonly stepKey: string;
  readonly requestHash: string;
  readonly task: TaskKind;
  readonly provider: string;
  readonly model: string;
  readonly templateId: string;
  readonly templateVersion: string;
  readonly params: { readonly maxOutputTokens: number; readonly effort?: Effort };
  readonly status: LlmOutcome | 'error';
  readonly result?: LlmResult;
  readonly error?: LlmError;
  readonly cost: number | null;
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
 * 幂等步骤：带步骤键的调用先查完成记录，有则直接复用，恢复时不重复调用、不重复计费
 * （硬性规则 10）。失败与取消的步骤会重新调用。
 */
export function withCallLog(port: LlmPort, log: CallLog, now: () => string): LlmPort {
  return {
    async complete(request: LlmRequest, options: CallOptions = {}): Promise<Result<LlmResult, LlmError>> {
      const { stepKey } = request;
      if (stepKey === undefined) return port.complete(request, options);

      const hash = requestHash(request);
      const done = await log.findCompleted(stepKey);
      if (done?.result !== undefined) {
        if (done.requestHash !== hash) {
          return err({ code: 'step_conflict', message: `步骤 ${stepKey} 已有记录，但请求内容不同` });
        }
        options.onEvent?.({ type: 'text', delta: done.result.text });
        return ok(done.result);
      }

      const startedAt = now();
      const result = await port.complete(request, options);
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
        status: result.ok ? result.value.outcome : 'error',
        ...(result.ok ? { result: result.value } : { error: result.error }),
        cost: result.ok ? costOf(result.value.usage, request.model.prices) : null,
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
