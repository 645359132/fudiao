// 连接测试（需求 B15、施工文档第五章）：向选定的模型发一个最小请求，给出延迟、实际提供服务的模型与错误原因。
// 提示词来自 packages/prompts 的 connection_test 模板（硬性规则 12），由调用方渲染后传入。
import type { LlmError, LlmMessage, LlmPort, ModelProfile, PromptBlock } from './types';

export type ConnectionPrompt = {
  readonly template: { readonly id: string; readonly version: string };
  readonly system: readonly PromptBlock[];
  readonly messages: readonly LlmMessage[];
};

export type ConnectionReport =
  | { readonly ok: true; readonly latencyMs: number; readonly servedModel: string; readonly reply: string }
  | { readonly ok: false; readonly latencyMs: number; readonly error: LlmError };

/** 推理模型可能先消耗一些输出额度；达到上限（truncated）同样说明连接可用。 */
const MAX_OUTPUT_TOKENS = 64;

export async function testConnection(
  port: LlmPort,
  model: ModelProfile,
  prompt: ConnectionPrompt,
  now: () => number,
  signal?: AbortSignal,
): Promise<ConnectionReport> {
  const started = now();
  const result = await port.complete(
    { task: 'connection_test', model, template: prompt.template, system: prompt.system, messages: prompt.messages, maxOutputTokens: MAX_OUTPUT_TOKENS },
    signal === undefined ? {} : { signal },
  );
  const latencyMs = Math.max(0, now() - started);
  if (!result.ok) return { ok: false, latencyMs, error: result.error };
  return { ok: true, latencyMs, servedModel: result.value.servedModel, reply: result.value.text.trim() };
}
