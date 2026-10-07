import { err, ok, type Result } from '@novel-writer/shared';
import OpenAI from 'openai';
import type { ChatCompletionCreateParamsStreaming } from 'openai/resources/chat/completions';
import { requestHash } from '../request-hash';
import type { CallOptions, LlmError, LlmPort, LlmRequest, LlmResult, LlmUsage } from '../types';
import { mapSdkError } from './errors';

export type OpenAIChatAdapterOptions = {
  /** 本地端点可免密钥。 */
  readonly apiKey?: string;
  readonly baseURL: string;
  readonly fetch?: typeof fetch;
  readonly maxRetries?: number;
  readonly timeoutMs?: number;
};

/**
 * Chat Completions 适配器：覆盖 OpenAI 兼容接口、Gemini 兼容模式与本地端点。
 * 结构化输出能力为 prompt 时不发送 response_format，格式约束由调用方的提示词模板给出。
 */
export class OpenAIChatAdapter implements LlmPort {
  private readonly client: OpenAI;

  constructor(options: OpenAIChatAdapterOptions) {
    this.client = new OpenAI({
      // SDK 要求非空的密钥；本地端点不校验，填占位值。
      apiKey: options.apiKey ?? 'no-key',
      baseURL: options.baseURL,
      ...(options.fetch !== undefined && { fetch: options.fetch }),
      maxRetries: options.maxRetries ?? 2,
      ...(options.timeoutMs !== undefined && { timeout: options.timeoutMs }),
    });
  }

  async complete(request: LlmRequest, options: CallOptions = {}): Promise<Result<LlmResult, LlmError>> {
    const base = { provider: request.model.provider, requestHash: requestHash(request), fallbackUsed: false };
    let text = '';
    let refusalText = '';
    let servedModel = request.model.model;
    let usage: LlmUsage | null = null;
    let finish: string | null = null;

    try {
      const stream = await this.client.chat.completions.create(buildParams(request), {
        ...(options.signal !== undefined && { signal: options.signal }),
      });
      for await (const chunk of stream) {
        if (chunk.model) servedModel = chunk.model;
        const choice = chunk.choices[0];
        const delta = choice?.delta;
        if (delta?.content) {
          text += delta.content;
          options.onEvent?.({ type: 'text', delta: delta.content });
        }
        if (delta?.refusal) refusalText += delta.refusal;
        if (choice?.finish_reason) finish = choice.finish_reason;
        if (chunk.usage) {
          const cached = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
          usage = {
            inputTokens: chunk.usage.prompt_tokens - cached,
            outputTokens: chunk.usage.completion_tokens,
            cacheReadTokens: cached,
            cacheWriteTokens: 0,
          };
          options.onEvent?.({ type: 'usage', usage });
        }
      }
    } catch (error) {
      if (options.signal?.aborted === true || error instanceof OpenAI.APIUserAbortError) {
        return ok({ ...base, outcome: 'cancelled', text, usage, servedModel, stopReason: null });
      }
      return err(mapSdkError(error));
    }

    // SDK 的流在取消时直接结束而不抛出异常。
    if (options.signal?.aborted === true) {
      return ok({ ...base, outcome: 'cancelled', text, usage, servedModel, stopReason: null });
    }

    // 各服务的拒答表示不同：专门的拒答字段、内容过滤结束原因，统一转换为拒答结果。
    const refused = refusalText !== '' || finish === 'content_filter';
    return ok({
      ...base,
      outcome: refused ? 'refused' : finish === 'length' ? 'truncated' : 'completed',
      text,
      usage,
      servedModel,
      stopReason: finish,
      ...(refused && { refusal: { category: null, explanation: refusalText || null } }),
    });
  }
}

function buildParams(request: LlmRequest): ChatCompletionCreateParamsStreaming {
  const caps = request.model.capabilities;
  const system = request.system.map((b) => b.text).join('\n\n');
  return {
    model: request.model.model,
    max_completion_tokens: request.maxOutputTokens,
    stream: true,
    stream_options: { include_usage: true },
    messages: [
      ...(system !== '' ? [{ role: 'system' as const, content: system }] : []),
      ...request.messages.map((m) => ({ role: m.role, content: m.content })),
    ],
    ...(request.output !== undefined &&
      caps.structuredOutput === 'native' && {
        response_format: {
          type: 'json_schema' as const,
          json_schema: { name: request.output.name, schema: request.output.schema, strict: true },
        },
      }),
    ...(request.effort !== undefined && caps.reasoningControl === 'effort' && { reasoning_effort: request.effort }),
  };
}
