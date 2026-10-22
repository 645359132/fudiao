// 模型的有效上限（需求 B56，施工文档第六章）：没有依据的上下文长度与最大输出是保守值，不能当作模型的真实上限用——
// 调用器不按保守的最大输出压请求，上下文按常见的大小估算，再从服务的超限报错里学到真正的上限（packages/llm 的 parseLimitError）。
import type { ModelCapabilities } from '@fudiao/llm';
import type { StoredCapabilities } from '@fudiao/store';

/** 上下文长度没有依据时按它估算：当前主流模型都不小于这个数；真实上限从服务的超限报错里学到后替换。 */
export const ASSUMED_CONTEXT_WINDOW = 128_000;

export type EffectiveLimits = {
  /** 估算用的上下文长度：有依据时是登记值，否则是 ASSUMED_CONTEXT_WINDOW。 */
  readonly contextWindow: number;
  readonly contextWindowKnown: boolean;
  /** 有依据的最大输出；没有依据时为 null，请求不按它压。 */
  readonly maxOutputTokens: number | null;
};

export function effectiveLimits(c: StoredCapabilities): EffectiveLimits {
  return {
    contextWindow: c.limitsKnown.contextWindow ? c.contextWindow : ASSUMED_CONTEXT_WINDOW,
    contextWindowKnown: c.limitsKnown.contextWindow,
    maxOutputTokens: c.limitsKnown.maxOutputTokens ? c.maxOutputTokens : null,
  };
}

/** 请求的输出上限：最大输出有依据时不超过它，否则按请求本身的需要发出。 */
export const clipOutput = (c: StoredCapabilities, requested: number): number => (c.limitsKnown.maxOutputTokens ? Math.min(requested, c.maxOutputTokens) : requested);

/** 交给模型端口的能力：只带 packages/llm 认识的字段（limitsKnown 是应用层的记号，不进请求哈希）。 */
export function portCapabilities(c: StoredCapabilities): ModelCapabilities {
  return {
    structuredOutput: c.structuredOutput,
    promptCaching: c.promptCaching,
    reasoningControl: c.reasoningControl,
    refusalFallback: c.refusalFallback,
    contextWindow: c.contextWindow,
    maxOutputTokens: c.maxOutputTokens,
    selfTestPassed: c.selfTestPassed,
    webSearch: c.webSearch,
  };
}
