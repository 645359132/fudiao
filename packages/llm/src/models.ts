// 模型列表与能力自检（需求 B56、B57，施工文档第五章）。
import { err, ok, type Result } from '@fudiao/shared';
import type { z } from 'zod';
import { structured, type StructuredError } from './structured';
import type { CallOptions, Effort, LlmError, LlmMessage, LlmPort, ModelCapabilities, ModelProfile, OutputSchema, PromptBlock } from './types';

/** 服务返回的一个模型。capabilities 只含服务明确给出的项，其余由内置能力表或保守能力补齐。 */
export type ListedModel = {
  readonly id: string;
  readonly displayName: string | null;
  readonly capabilities: Partial<ModelCapabilities>;
};

/** 能列出可用模型的适配器。 */
export interface ModelLister {
  listModels(options?: CallOptions): Promise<Result<readonly ListedModel[], LlmError>>;
}

export const isModelLister = (port: LlmPort): port is LlmPort & ModelLister =>
  typeof (port as Partial<ModelLister>).listModels === 'function';

/** 列表过长时只取前若干个（聚合服务可能有上千个模型）。 */
export const MAX_LISTED_MODELS = 2_000;

export type SelfTestPrompt = {
  readonly template: { readonly id: string; readonly version: string };
  readonly system: readonly PromptBlock[];
  readonly messages: readonly LlmMessage[];
  readonly output: OutputSchema;
};

export type SelfTestReport = {
  readonly passed: boolean;
  /** 每次的结果：null 为通过，否则是原因。 */
  readonly runs: readonly (string | null)[];
  /** 未通过时给作者看的原因（第一次失败的原因）。 */
  readonly reason: string | null;
};

/** 连续通过的次数达到这个数才算自检通过（施工文档第五章）。 */
export const SELF_TEST_RUNS = 3;

/**
 * 自检请求的输出上限与思考深度。答案本身很短，但有的服务把思考计入输出（DeepSeek 默认先思考）：
 * 上限只够答案时，偶尔一次思考得长就会被截断而判为未通过。调用方按自己的思考余量给出，实际请求不超过模型的最大输出。
 */
export type SelfTestBudget = { readonly maxOutputTokens: number; readonly effort?: Effort };
export const DEFAULT_SELF_TEST_BUDGET: SelfTestBudget = { maxOutputTokens: 1_024 };

/**
 * 能力自检（B57）：按模型的能力描述发出固定的结构化输出测试，经结构化输出管线校验（不请求修正），
 * 再由 check 比对内容；连续 SELF_TEST_RUNS 次通过才算通过，一次失败即停止。
 */
export async function runSelfTest<T>(
  port: LlmPort,
  model: ModelProfile,
  prompt: SelfTestPrompt,
  schema: z.ZodType<T>,
  check: (value: T) => string | null,
  options: CallOptions = {},
  budget: SelfTestBudget = DEFAULT_SELF_TEST_BUDGET,
): Promise<SelfTestReport> {
  const runs: (string | null)[] = [];
  for (let i = 0; i < SELF_TEST_RUNS; i++) {
    const result = await structured(
      port,
      schema,
      {
        task: 'self_test',
        model,
        template: prompt.template,
        system: prompt.system,
        messages: prompt.messages,
        output: prompt.output,
        // 加上思考余量后可能超过模型的最大输出，超过的请求会被服务拒绝。
        maxOutputTokens: Math.min(budget.maxOutputTokens, model.capabilities.maxOutputTokens),
        ...(budget.effort !== undefined && { effort: budget.effort }),
      },
      { ...options, maxRepairs: 0, repairMessage: () => '' },
    );
    const reason = result.ok ? check(result.value.value) : describe(result.error);
    runs.push(reason);
    if (reason !== null) return { passed: false, runs, reason: `第 ${i + 1} 次：${reason}` };
  }
  return { passed: true, runs, reason: null };
}

function describe(error: StructuredError): string {
  switch (error.code) {
    case 'call_failed':
      return `调用失败（${error.error.code}）：${error.error.message}`;
    case 'refused':
      return '模型拒绝回答';
    case 'truncated':
      return '输出被截断（思考或回答用完了输出上限）';
    case 'cancelled':
      return '已取消';
    case 'invalid_output':
      return `输出不符合格式：${error.issues.slice(0, 3).join('；')}`;
  }
}

/** 列表结果按标识排序、去重，并截到上限。 */
export function tidyListed(models: readonly ListedModel[]): ListedModel[] {
  const seen = new Set<string>();
  const out: ListedModel[] = [];
  for (const m of [...models].sort((a, b) => a.id.localeCompare(b.id))) {
    if (m.id === '' || seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
    if (out.length === MAX_LISTED_MODELS) break;
  }
  return out;
}

export const okList = (models: readonly ListedModel[]): Result<readonly ListedModel[], LlmError> => ok(tidyListed(models));
export const errList = (error: LlmError): Result<readonly ListedModel[], LlmError> => err(error);
