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

export const BUILTIN_MODELS: readonly BuiltinModel[] = [];
