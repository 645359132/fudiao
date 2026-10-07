import { err, ok, type Result } from '@fudiao/shared';
import OpenAI from 'openai';
import type { ChatCompletionCreateParamsStreaming } from 'openai/resources/chat/completions';
import { requestHash } from '../request-hash';
import type { CallOptions, Effort, LlmError, LlmPort, LlmRequest, LlmResult, LlmUsage } from '../types';
import { mapSdkError } from './errors';
import { ThinkFilter } from './think-filter';

/**
 * 各家 OpenAI 兼容接口在细节上的差异，按服务配置（不按模型），由服务配置给出。
 */
export type ChatDialect = {
  /** 输出上限的参数名：OpenAI 官方的推理模型只接受 max_completion_tokens，多数兼容接口只认 max_tokens。 */
  readonly maxTokensField: 'max_completion_tokens' | 'max_tokens';
  /** 是否发送 stream_options.include_usage；个别接口不认识该参数而报错，关闭后用量记为未知。 */
  readonly streamUsage: boolean;
  /** 去掉正文开头的 <think>…</think>（见 ThinkFilter）。 */
  readonly stripThinkTags: boolean;
};

/** OpenAI 官方接口。 */
export const OPENAI_DIALECT: ChatDialect = { maxTokensField: 'max_completion_tokens', streamUsage: true, stripThinkTags: false };

/** 其他 OpenAI 兼容接口与本地端点的默认值。 */
export const COMPATIBLE_DIALECT: ChatDialect = { maxTokensField: 'max_tokens', streamUsage: true, stripThinkTags: true };

export type OpenAIChatAdapterOptions = {
  /** 本地端点可免密钥。 */
  readonly apiKey?: string;
  readonly baseURL: string;
  readonly fetch?: typeof fetch;
  readonly maxRetries?: number;
  readonly timeoutMs?: number;
  /** 未给出时按 OpenAI 官方接口处理。 */
  readonly dialect?: ChatDialect;
};

/**
 * Chat Completions 适配器：覆盖 OpenAI 兼容接口、Gemini 兼容模式与本地端点。
 * 结构化输出按能力描述：native 发送 json_schema，json_object 只要求合法 JSON，prompt 不发送 response_format；
 * 后两者的字段约束由调用方的提示词模板给出。
 */
export class OpenAIChatAdapter implements LlmPort {
  private readonly client: OpenAI;
  private readonly dialect: ChatDialect;

  constructor(options: OpenAIChatAdapterOptions) {
    this.dialect = options.dialect ?? OPENAI_DIALECT;
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
    const think = this.dialect.stripThinkTags ? new ThinkFilter() : null;
    const emit = (delta: string) => {
      if (delta === '') return;
      text += delta;
      options.onEvent?.({ type: 'text', delta });
    };

    try {
      const stream = await this.client.chat.completions.create(buildParams(request, this.dialect), {
        ...(options.signal !== undefined && { signal: options.signal }),
      });
      for await (const chunk of stream) {
        if (chunk.model) servedModel = chunk.model;
        const choice = chunk.choices[0];
        const delta = choice?.delta;
        if (delta?.content) emit(think ? think.push(delta.content) : delta.content);
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
      if (think) emit(think.end());
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

/** Chat Completions 的 reasoning_effort 只保证 low、medium、high；更高的深度按 high 发送。 */
const chatEffort = (effort: Effort): 'low' | 'medium' | 'high' => (effort === 'xhigh' || effort === 'max' ? 'high' : effort);

function buildParams(request: LlmRequest, dialect: ChatDialect): ChatCompletionCreateParamsStreaming {
  const caps = request.model.capabilities;
  const system = request.system.map((b) => b.text).join('\n\n');
  const output = request.output;
  return {
    model: request.model.model,
    ...(dialect.maxTokensField === 'max_tokens'
      ? { max_tokens: request.maxOutputTokens }
      : { max_completion_tokens: request.maxOutputTokens }),
    stream: true,
    ...(dialect.streamUsage && { stream_options: { include_usage: true } }),
    messages: [
      ...(system !== '' ? [{ role: 'system' as const, content: system }] : []),
      ...request.messages.map((m) => ({ role: m.role, content: m.content })),
    ],
    ...(output !== undefined &&
      caps.structuredOutput === 'native' && {
        response_format: {
          type: 'json_schema' as const,
          json_schema: { name: output.name, schema: output.schema, strict: true },
        },
      }),
    ...(output !== undefined && caps.structuredOutput === 'json_object' && { response_format: { type: 'json_object' as const } }),
    ...(request.effort !== undefined && caps.reasoningControl === 'effort' && { reasoning_effort: chatEffort(request.effort) }),
  };
}
