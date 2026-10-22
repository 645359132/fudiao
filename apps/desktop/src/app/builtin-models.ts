// 内置能力与价格表（需求 B56、施工文档第六章）：随应用更新发布，作者可以覆盖其中任何字段。
// 条目必须按服务的官方文档与价格页核实后再加入（价格为每百万 Token 的美元价；webSearch 为模型自带联网搜索每千次的美元价）；
// 写错的价格会让费用估算失真，所以没有核实的模型不列、没有核实的字段不填：没有记录的模型按保守能力处理，费用记为未知（B19）。
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

// Anthropic：按 platform.claude.com 的价格页（docs/en/about-claude/pricing）与联网搜索工具文档核实（2026-10-20）。
// 这几个模型都是 1,000,000 上下文、128,000 最大输出，支持结构化输出、思考深度（effort）、提示词缓存与服务端的
// web_search 工具（每千次 10 美元，搜到的内容另按输入 Token 计）。cacheWrite 填 5 分钟缓存的写入价。
// 从服务的模型列表添加时，上下文、最大输出与结构化输出以服务返回的为准（resolveModel），这里只补上服务没有说的项。
const ANTHROPIC: BuiltinModel['capabilities'] = {
  structuredOutput: 'native',
  promptCaching: true,
  reasoningControl: 'effort',
  contextWindow: 1_000_000,
  maxOutputTokens: 128_000,
  webSearch: true,
};
const anthropic = (modelId: string, displayName: string, input: number, output: number, cacheRead: number, cacheWrite: number): BuiltinModel => ({
  kind: 'anthropic',
  modelId,
  displayName,
  capabilities: ANTHROPIC,
  prices: { input, output, cacheRead, cacheWrite, webSearch: 10 },
});

// OpenAI 官方接口（Responses API）：按 developers.openai.com 的价格页与各模型页核实（2026-10-20）。
// web_search 工具每千次 10 美元，搜到的内容另按输入 Token 计；提示词缓存自动按相同开头命中（不支持 cache_control，
// promptCaching 为 false），命中部分按 cacheRead 计价。gpt-5.5 的模型页没有读到，上下文与最大输出沿用保守值，作者可改。
const OPENAI_REASONING: BuiltinModel['capabilities'] = { structuredOutput: 'native', promptCaching: false, reasoningControl: 'effort', webSearch: true };
const openai = (modelId: string, capabilities: BuiltinModel['capabilities'], input: number, output: number, cacheRead: number): BuiltinModel => ({
  kind: 'openai',
  modelId,
  displayName: modelId,
  capabilities,
  prices: { input, output, cacheRead, webSearch: 10 },
});

export const BUILTIN_MODELS: readonly BuiltinModel[] = [
  { kind: 'openai_compatible', modelId: 'deepseek-flash', displayName: 'deepseek-flash', capabilities: DEEPSEEK, prices: { input: 0.3, output: 1.2, cacheRead: 0.006 } },
  { kind: 'openai_compatible', modelId: 'deepseek-v4-pro', displayName: 'deepseek-v4-pro', capabilities: DEEPSEEK, prices: { input: 1.32, output: 3.96, cacheRead: 0.044 } },
  anthropic('claude-fable-5-1', 'Claude Fable 5.1', 10, 50, 0.25, 12.5),
  anthropic('claude-fable-5', 'Claude Fable 5', 10, 50, 1, 12.5),
  anthropic('claude-opus-5-5', 'Claude Opus 5.5', 4, 20, 0.2, 5),
  anthropic('claude-opus-5', 'Claude Opus 5', 5, 25, 0.5, 6.25),
  anthropic('claude-opus-4-8', 'Claude Opus 4.8', 5, 25, 0.5, 6.25),
  anthropic('claude-opus-4-7', 'Claude Opus 4.7', 5, 25, 0.5, 6.25),
  anthropic('claude-opus-4-6', 'Claude Opus 4.6', 5, 25, 0.5, 6.25),
  anthropic('claude-sonnet-5-5', 'Claude Sonnet 5.5', 2, 10, 0.1, 2.5),
  anthropic('claude-sonnet-5', 'Claude Sonnet 5', 2, 10, 0.2, 2.5),
  anthropic('claude-sonnet-4-6', 'Claude Sonnet 4.6', 3, 15, 0.3, 3.75),
  // Haiku 5.5 的价格分提示是否超过 100,000 Token（超过为 5 倍），这里按超过的价填写，费用估算宁高勿低。
  anthropic('claude-haiku-5-5', 'Claude Haiku 5.5', 0.5, 2.5, 0.05, 0.625),
  openai('gpt-5.5', OPENAI_REASONING, 5, 30, 0.5),
  openai('gpt-5.4', { ...OPENAI_REASONING, contextWindow: 1_050_000, maxOutputTokens: 128_000 }, 2.5, 15, 0.25),
  openai('gpt-5', { ...OPENAI_REASONING, contextWindow: 400_000, maxOutputTokens: 128_000 }, 1.25, 10, 0.125),
  openai('gpt-4.1', { structuredOutput: 'native', promptCaching: false, reasoningControl: 'none', contextWindow: 1_047_576, maxOutputTokens: 32_768, webSearch: true }, 2, 8, 0.5),
];

/**
 * 内置表中这个模型的条目；没有时为 undefined。
 * 中转站给 DeepSeek 起的名字常带版本与构建后缀（deepseek-v4.1-flash:1017、deepseek/DeepSeek-V4-Pro）：
 * 兼容接口的服务按名字里的 deepseek 加 flash 或 pro 对到内置条目（deepseekAlias）；其他种类的服务只按完整的模型名。
 */
export function builtinModel(kind: ProviderKind, modelId: string, table: readonly BuiltinModel[] = BUILTIN_MODELS): BuiltinModel | undefined {
  const id = modelId.trim();
  const exact = table.find((b) => b.kind === kind && b.modelId === id);
  if (exact !== undefined || kind !== 'openai_compatible') return exact;
  const alias = deepseekAlias(id);
  return alias === null ? undefined : table.find((b) => b.kind === kind && b.modelId === alias);
}

/** 兼容接口上 DeepSeek 模型名的归一：去掉厂商前缀与冒号后的构建号，按 flash 或 pro 对到官方的模型名；对不上时为 null。 */
export function deepseekAlias(modelId: string): 'deepseek-flash' | 'deepseek-v4-pro' | null {
  const name = modelId
    .trim()
    .toLowerCase()
    .replace(/^.*\//, '')
    .replace(/:.*$/, '');
  if (!name.includes('deepseek')) return null;
  if (/(^|[^a-z])flash([^a-z]|$)/.test(name)) return 'deepseek-flash';
  if (/(^|[^a-z])pro([^a-z]|$)/.test(name)) return 'deepseek-v4-pro';
  return null;
}
