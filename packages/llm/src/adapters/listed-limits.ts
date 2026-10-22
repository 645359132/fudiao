// 兼容接口的模型列表里各家自带的上下文与最大输出字段（需求 B56）。OpenAI 的 /v1/models 本身只给名字，
// 但 OpenRouter 与 new-api 一类的中转站带 context_length 与 top_provider.max_completion_tokens，vLLM 带 max_model_len，
// LiteLLM 带 max_input_tokens 与 max_output_tokens，有的服务写 max_completion_tokens。LiteLLM 的 max_tokens 含义不定，不采用。
import { z } from 'zod';
import type { ModelCapabilities } from '../types';

const count = z.number().int().positive().nullish();

const Fields = z.object({
  context_length: count,
  max_model_len: count,
  max_context_length: count,
  max_input_tokens: count,
  max_output_tokens: count,
  max_completion_tokens: count,
  top_provider: z.object({ context_length: count, max_completion_tokens: count }).nullish(),
});

/** 列表里这个模型明确给出的上下文长度与最大输出；没有的字段不出现。 */
export function listedLimits(raw: unknown): Partial<Pick<ModelCapabilities, 'contextWindow' | 'maxOutputTokens'>> {
  const parsed = Fields.safeParse(raw);
  if (!parsed.success) return {};
  const f = parsed.data;
  const contextWindow = f.context_length ?? f.max_model_len ?? f.max_context_length ?? f.max_input_tokens ?? f.top_provider?.context_length;
  const maxOutputTokens = f.max_output_tokens ?? f.max_completion_tokens ?? f.top_provider?.max_completion_tokens;
  return {
    ...(contextWindow !== null && contextWindow !== undefined && { contextWindow }),
    ...(maxOutputTokens !== null && maxOutputTokens !== undefined && { maxOutputTokens }),
  };
}
