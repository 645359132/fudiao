import type { TaskModel } from '@novel-writer/engine';
import { costOf } from '@novel-writer/llm';

/**
 * 运行前的粗略费用估算（施工文档第六章“费用与速度”）：按每回合的调用次数、
 * 每次约 4000 输入 Token、1500 至 3500 输出 Token（含思考）估算。M0 实测后修正这些常数。
 */
export const ESTIMATE = { inputTokens: 4_000, outputLow: 1_500, outputHigh: 3_500 } as const;

export type CostEstimate = { readonly calls: number; readonly lowUsd: number | null; readonly highUsd: number | null };

export function estimateCalls(
  protocol: 'simultaneous' | 'turn_based',
  actors: number,
  rounds: number,
): { proposals: number; rulings: number; beliefs: number } {
  // 同时行动：每人一次提案、一次认知更新，约一次裁决；轮流对话：说话者一次提案、听者各一次回应。
  const perRound =
    protocol === 'simultaneous'
      ? { proposals: actors, rulings: 1, beliefs: actors }
      : { proposals: actors, rulings: 0, beliefs: actors };
  return { proposals: perRound.proposals * rounds, rulings: perRound.rulings * rounds, beliefs: perRound.beliefs * rounds };
}

export function estimateCost(models: readonly { readonly model: TaskModel; readonly calls: number }[]): CostEstimate {
  let low = 0;
  let high = 0;
  let unknown = false;
  let calls = 0;
  for (const { model, calls: n } of models) {
    calls += n;
    const prices = model.profile.prices;
    const usage = (output: number) => ({ inputTokens: ESTIMATE.inputTokens, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0 });
    const l = costOf(usage(Math.min(ESTIMATE.outputLow, model.maxOutputTokens)), prices);
    const h = costOf(usage(Math.min(ESTIMATE.outputHigh, model.maxOutputTokens)), prices);
    if (l === null || h === null) unknown = true;
    else {
      low += l * n;
      high += h * n;
    }
  }
  return { calls, lowUsd: unknown ? null : low, highUsd: unknown ? null : high };
}

export const formatUsd = (v: number | null) => (v === null ? '未知（价格未配置）' : `$${v.toFixed(2)}`);
