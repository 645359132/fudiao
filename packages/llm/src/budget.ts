import { err, type Result } from '@fudiao/shared';
import type { CallOptions, LlmError, LlmPort, LlmRequest, LlmResult, LlmUsage, Prices } from './types';

const PER_MILLION = 1_000_000;

/** 按价格表计算一次调用的费用（美元）。价格或用量未知时返回 null（B19）。 */
export function costOf(usage: LlmUsage | null, prices: Prices | undefined): number | null {
  if (usage === null || prices === undefined) return null;
  return (
    (usage.inputTokens * prices.input +
      usage.outputTokens * prices.output +
      usage.cacheReadTokens * (prices.cacheRead ?? prices.input) +
      usage.cacheWriteTokens * (prices.cacheWrite ?? prices.input)) /
    PER_MILLION
  );
}

/**
 * 粗略估算输入的 Token 数：按字符计，对中文偏保守。只用于调用前的预算检查，
 * M0 实测后按服务返回的用量校准。
 */
export function estimateInputTokens(request: LlmRequest): number {
  const chars =
    request.system.reduce((n, b) => n + b.text.length, 0) +
    request.messages.reduce((n, m) => n + m.content.length, 0) +
    (request.output === undefined ? 0 : JSON.stringify(request.output.schema).length);
  return chars;
}

export type Budget = {
  readonly limitUsd?: number;
  /** 价格未知时按 Token 数设上限。 */
  readonly limitTokens?: number;
};

/** 一个任务的预算。调用前按最坏情况估算，调用后按实际用量累计。 */
export class BudgetGuard {
  spentUsd = 0;
  spentTokens = 0;
  /** 费用未知的调用次数（价格未配置或用量缺失）。 */
  unknownCostCalls = 0;

  constructor(readonly budget: Budget) {}

  /** 预计将超出预算时返回错误。 */
  check(request: LlmRequest): LlmError | undefined {
    const input = estimateInputTokens(request);
    const tokens = input + request.maxOutputTokens;
    const { limitTokens, limitUsd } = this.budget;
    if (limitTokens !== undefined && this.spentTokens + tokens > limitTokens) {
      return { code: 'budget_exceeded', message: `预计用量将超过 ${limitTokens} Token 的预算` };
    }
    const estimate = costOf(
      { inputTokens: input, outputTokens: request.maxOutputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 },
      request.model.prices,
    );
    if (limitUsd !== undefined && estimate !== null && this.spentUsd + estimate > limitUsd) {
      return { code: 'budget_exceeded', message: `预计费用将超过 ${limitUsd} 美元的预算` };
    }
    return undefined;
  }

  record(request: LlmRequest, result: LlmResult): void {
    const u = result.usage;
    if (u !== null) this.spentTokens += u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;
    const cost = costOf(u, request.model.prices);
    if (cost === null) this.unknownCostCalls++;
    else this.spentUsd += cost;
  }
}

/** 预算守卫：累计值将超过预算时不再发起新调用，已完成的结果保留在调用方。 */
export function withBudget(port: LlmPort, guard: BudgetGuard): LlmPort {
  return {
    async complete(request: LlmRequest, options?: CallOptions): Promise<Result<LlmResult, LlmError>> {
      const blocked = guard.check(request);
      if (blocked !== undefined) return err(blocked);
      const result = await port.complete(request, options);
      if (result.ok) guard.record(request, result.value);
      return result;
    },
  };
}
