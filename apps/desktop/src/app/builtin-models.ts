// 内置能力与价格表（需求 B56、施工文档第五章）：随应用更新发布，作者可以覆盖其中任何字段。
// 条目必须按服务的官方文档与价格页核实后再加入（价格为每百万 Token 的美元价）；写错的价格会让费用估算失真，
// 所以没有核实的模型不列：没有记录的模型按保守能力处理，费用记为未知（B19）。
import type { ProviderKind, StoredCapabilities, StoredPrices } from '@fudiao/store';

export type BuiltinModel = {
  readonly kind: ProviderKind;
  readonly modelId: string;
  readonly displayName?: string;
  readonly capabilities: Partial<Omit<StoredCapabilities, 'selfTestPassed'>>;
  readonly prices?: StoredPrices;
};

// DeepSeek（OpenAI 兼容写法）：按 https://api-docs.deepseek.com/quick_start/pricing 与 guides/thinking_mode、guides/kv_cache
// 核实（2026-10-14）。默认开启思考，reasoning_effort 支持 low、high、max（medium 按 high 处理）；上下文缓存自动生效，
// 只认相同的开头（不需要也不支持 cache_control 标记，故 promptCaching 为 false），命中部分按 cacheRead 计价。
// 价格分高峰与非高峰（非高峰为一半），这里按高峰价填写，费用估算宁高勿低。
const DEEPSEEK: BuiltinModel['capabilities'] = {
  structuredOutput: 'json_object',
  promptCaching: false,
  reasoningControl: 'effort',
  refusalFallback: 'none',
  contextWindow: 1_000_000,
  maxOutputTokens: 384_000,
};

export const BUILTIN_MODELS: readonly BuiltinModel[] = [
  { kind: 'openai_compatible', modelId: 'deepseek-flash', displayName: 'deepseek-flash', capabilities: DEEPSEEK, prices: { input: 0.3, output: 1.2, cacheRead: 0.006 } },
  { kind: 'openai_compatible', modelId: 'deepseek-v4-pro', displayName: 'deepseek-v4-pro', capabilities: DEEPSEEK, prices: { input: 1.32, output: 3.96, cacheRead: 0.044 } },
];

/** 内置表中这个模型的条目；没有时为 undefined。 */
export const builtinModel = (kind: ProviderKind, modelId: string): BuiltinModel | undefined => BUILTIN_MODELS.find((b) => b.kind === kind && b.modelId === modelId.trim());
