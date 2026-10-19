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

const tokensOf = (u: LlmUsage) => u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;

/**
 * 一次请求的最坏估计：输入按估计（已知部分用量时取实际的输入），输出按上限。
 * 调用前的预算预留，以及用量缺失、可能已经计费的调用都按它计。价格未配置时费用为 null。
 */
export function worstCase(request: LlmRequest, known: LlmUsage | null = null): { readonly tokens: number; readonly usd: number | null } {
  const usage: LlmUsage =
    known === null
      ? { inputTokens: estimateInputTokens(request), outputTokens: request.maxOutputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 }
      : { ...known, outputTokens: Math.max(known.outputTokens, request.maxOutputTokens) };
  return { tokens: tokensOf(usage), usd: costOf(usage, request.model.prices) };
}

/**
 * 一次调用的花费（B19）。有用量时按实际；服务没有返回用量、或已经开始回复后出错（可能已计费）时按最坏估计，
 * estimated 为真；还没开始回复就失败的不计。usd 为 null 表示价格未配置、费用未知。
 */
export type Charge = { readonly tokens: number; readonly usd: number | null; readonly estimated: boolean };

export function chargeOf(request: LlmRequest, result: Result<LlmResult, LlmError>): Charge | null {
  if (result.ok) {
    const { usage } = result.value;
    if (usage !== null) return { tokens: tokensOf(usage), usd: costOf(usage, request.model.prices), estimated: false };
    return { ...worstCase(request), estimated: true };
  }
  const partial = result.error.partial;
  return partial === undefined ? null : { ...worstCase(request, partial.usage), estimated: true };
}

export type Budget = {
  readonly limitUsd?: number;
  /** 价格未知时按 Token 数设上限。 */
  readonly limitTokens?: number;
};

/** 一次调用开始时的预留，结束时交回 settle。 */
export type Reservation = { readonly tokens: number; readonly usd: number };

/**
 * 一个任务的预算。调用前按最坏情况估算并预留（同时进行的调用各占一份），调用结束后把预留换成实际花费，
 * 预算因此是硬上限。
 */
export class BudgetGuard {
  /** 已花的费用，含按估计计入的部分（estimatedCalls）。 */
  spentUsd = 0;
  spentTokens = 0;
  /** 进行中的调用预留的费用与 Token。 */
  reservedUsd = 0;
  reservedTokens = 0;
  /** 价格未配置、费用未知的调用次数。 */
  unknownCostCalls = 0;
  /** 服务没有返回用量、按请求的最坏估计计入的调用次数。 */
  estimatedCalls = 0;

  constructor(readonly budget: Budget) {}

  /** 预计将超出预算时返回错误；否则预留这次的最坏估计，调用结束后必须交给 settle。 */
  reserve(request: LlmRequest): Result<Reservation, LlmError> {
    const { tokens, usd } = worstCase(request);
    const { limitTokens, limitUsd } = this.budget;
    if (limitTokens !== undefined && this.spentTokens + this.reservedTokens + tokens > limitTokens) {
      return err({ code: 'budget_exceeded', message: `预计用量将超过 ${limitTokens} Token 的预算` });
    }
    if (limitUsd !== undefined && usd !== null && this.spentUsd + this.reservedUsd + usd > limitUsd) {
      return err({ code: 'budget_exceeded', message: `预计费用将超过 ${limitUsd} 美元的预算` });
    }
    const reservation = { tokens, usd: usd ?? 0 };
    this.reservedTokens += reservation.tokens;
    this.reservedUsd += reservation.usd;
    return { ok: true, value: reservation };
  }

  /** 释放预留，计入这次的实际花费（用量缺失时按估计；还没开始回复就失败的不计）。 */
  settle(reservation: Reservation, request: LlmRequest, result: Result<LlmResult, LlmError>): void {
    this.reservedTokens -= reservation.tokens;
    this.reservedUsd -= reservation.usd;
    // 浮点相减可能留下极小的负数或残差；没有进行中的调用时归零。
    if (this.reservedTokens <= 0) this.reservedTokens = 0;
    if (this.reservedUsd <= 1e-12) this.reservedUsd = 0;
    const charge = chargeOf(request, result);
    if (charge === null) return;
    this.spentTokens += charge.tokens;
    if (charge.usd === null) this.unknownCostCalls++;
    else {
      this.spentUsd += charge.usd;
      if (charge.estimated) this.estimatedCalls++;
    }
  }
}

/** 预算守卫：累计值加上进行中调用的预留将超过预算时不再发起新调用，已完成的结果保留在调用方。 */
export function withBudget(port: LlmPort, guard: BudgetGuard): LlmPort {
  return {
    async complete(request: LlmRequest, options?: CallOptions): Promise<Result<LlmResult, LlmError>> {
      const reserved = guard.reserve(request);
      if (!reserved.ok) return reserved;
      let result: Result<LlmResult, LlmError> | undefined;
      try {
        result = await port.complete(request, options);
        return result;
      } finally {
        // 抛出异常（程序错误）时也释放预留，按没有计费处理。
        guard.settle(reserved.value, request, result ?? err({ code: 'unknown', message: '调用抛出异常' }));
      }
    },
  };
}
