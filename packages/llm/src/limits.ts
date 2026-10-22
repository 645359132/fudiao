// 从服务的超限报错里学到模型的上限（需求 B56，施工文档第六章）。
// 服务没有统一的接口给出上下文长度与最大输出，但拒绝超限请求时几乎都在报错里写明了上限：这里只认几家公开文档里的写法，
// 对不上的返回 null，由调用方照旧按保守值处理。中转站一般原样转发上游的报错，所以同样适用。
import type { CallOptions, LlmMessage, LlmPort, ModelProfile, PromptBlock } from './types';

/** 从报错里学到的上限（Token）。 */
export type LearnedLimits = { readonly maxOutputTokens?: number; readonly contextWindow?: number };

const MAX_OUTPUT_PATTERNS: readonly RegExp[] = [
  // OpenAI：max_tokens is too large: 300000. This model supports at most 32768 completion tokens, whereas you provided 300000.
  /supports at most (\d[\d,]*) (?:completion|output) tokens/i,
  // OpenAI 的参数校验：Invalid 'max_tokens': integer above maximum value. Expected a value <= 4096, but got 8192 instead.
  /max_(?:completion_|output_)?tokens'?:? integer above maximum value\. Expected a value <= (\d[\d,]*)/i,
  // Anthropic：max_tokens: 300000 > 128000, which is the maximum allowed number of output tokens for claude-...
  /max_tokens: \d[\d,]* > (\d[\d,]*), which is the maximum allowed number of output tokens/i,
  // DeepSeek：Invalid max_tokens value, the valid range of max_tokens is [1, 8192]
  /valid range of max_tokens is \[\d+,\s*(\d[\d,]*)\]/i,
];

const CONTEXT_PATTERNS: readonly RegExp[] = [
  // OpenAI、DeepSeek、vLLM：This model's maximum context length is 128000 tokens. However, you requested 130000 tokens ...
  /maximum context length is (\d[\d,]*) tokens/i,
  // Anthropic：prompt is too long: 213000 tokens > 200000 maximum
  /prompt is too long: \d[\d,]* tokens > (\d[\d,]*) maximum/i,
  // Anthropic：input length and `max_tokens` exceed context limit: 190000 + 20000 > 200000
  /exceed context limit: \d[\d,]* \+ \d[\d,]* > (\d[\d,]*)/i,
];

function firstNumber(message: string, patterns: readonly RegExp[]): number | undefined {
  for (const pattern of patterns) {
    const found = pattern.exec(message)?.[1];
    if (found === undefined) continue;
    const n = Number(found.replace(/,/g, ''));
    if (Number.isInteger(n) && n > 0) return n;
  }
  return undefined;
}

/** 报错文字里写明的上限；一个也没有时为 null。 */
export function parseLimitError(message: string): LearnedLimits | null {
  const maxOutputTokens = firstNumber(message, MAX_OUTPUT_PATTERNS);
  const contextWindow = firstNumber(message, CONTEXT_PATTERNS);
  if (maxOutputTokens === undefined && contextWindow === undefined) return null;
  return { ...(maxOutputTokens !== undefined && { maxOutputTokens }), ...(contextWindow !== undefined && { contextWindow }) };
}

/** 探测用的输出上限：故意大到任何服务都不会接受。 */
export const PROBE_MAX_OUTPUT_TOKENS = 1_000_000;

export type ProbePrompt = {
  readonly template: { readonly id: string; readonly version: string };
  readonly system: readonly PromptBlock[];
  readonly messages: readonly LlmMessage[];
};

/**
 * 探测最大输出（能力自检时用）：用连接测试的提示词发一个输出上限极大的最小请求，服务拒绝时的报错里写着真正的上限。
 * 服务照单全收（自己悄悄压下上限并回答了）时学不到，返回 null；别的错误（凭据、网络）也返回 null，由自检本身去报。
 */
export async function probeMaxOutput(port: LlmPort, model: ModelProfile, prompt: ProbePrompt, options: CallOptions = {}): Promise<number | null> {
  const result = await port.complete(
    { task: 'connection_test', model, template: prompt.template, system: prompt.system, messages: prompt.messages, maxOutputTokens: PROBE_MAX_OUTPUT_TOKENS, effort: 'low' },
    options,
  );
  if (result.ok) return null;
  return parseLimitError(result.error.message)?.maxOutputTokens ?? null;
}
