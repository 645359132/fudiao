import type { TaskModel } from '@fudiao/engine';
import { costOf } from '@fudiao/llm';

/**
 * 运行前的粗略费用估算（施工文档第六章“费用与速度”）。常数取自 M0-13 的实测（DeepSeek flash，35 次推演、2400 次调用）：
 * 每次输入约 5000 Token；输出（含思考）的中位数约 2800、上四分位数约 5500。
 */
export const ESTIMATE = { inputTokens: 5_000, outputLow: 2_800, outputHigh: 5_500 } as const;

/** 格式修正与重试另算约一成调用（实测约 9%）。 */
const REPAIR_SHARE = 0.1;

export type CostEstimate = { readonly calls: number; readonly lowUsd: number | null; readonly highUsd: number | null };

export function estimateCalls(
  protocol: 'simultaneous' | 'turn_based',
  actors: number,
  rounds: number,
): { proposals: number; rulings: number; beliefs: number; evidence: number } {
  // 同时行动：每人一次提案、一次认知更新，约一次裁决；轮流对话：说话者一次提案、听者各一次回应。
  const perRound =
    protocol === 'simultaneous'
      ? { proposals: actors, rulings: 1, beliefs: actors }
      : { proposals: actors, rulings: 0, beliefs: actors };
  return {
    proposals: perRound.proposals * rounds,
    rulings: perRound.rulings * rounds,
    beliefs: perRound.beliefs * rounds,
    // 证据链判断只在新推测涉及秘密时发出，实测约每人每两回合一次。
    evidence: Math.ceil((actors * rounds) / 2),
  };
}

export function estimateCost(models: readonly { readonly model: TaskModel; readonly calls: number }[]): CostEstimate {
  let low = 0;
  let high = 0;
  let unknown = false;
  let calls = 0;
  for (const { model, calls: planned } of models) {
    const n = Math.ceil(planned * (1 + REPAIR_SHARE));
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
