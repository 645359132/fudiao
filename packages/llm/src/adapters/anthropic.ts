import Anthropic from '@anthropic-ai/sdk';
import type { BetaMessageStreamParams } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { err, ok, type Result } from '@fudiao/shared';
import { requestHash } from '../request-hash';
import type { CallOptions, LlmError, LlmPort, LlmRequest, LlmResult, LlmUsage } from '../types';
import { mapSdkError } from './errors';

export type AnthropicAdapterOptions = {
  readonly apiKey: string;
  readonly baseURL?: string;
  /** 桌面端替换为经 Rust 凭据代理转发的实现；M0 与测试用 Node 的 fetch。 */
  readonly fetch?: typeof fetch;
  /** 重试只做一层，由 SDK 负责（网络错误、429、5xx，遵守 Retry-After）。 */
  readonly maxRetries?: number;
  readonly timeoutMs?: number;
  /**
   * 在 WebView 中运行。SDK 默认拒绝在浏览器环境使用，以免 API Key 暴露在页面中；
   * 只有经凭据代理（apiKey 为占位值，真实凭据在 Rust 中注入）时才可开启。
   */
  readonly viaCredentialProxy?: boolean;
};

// 拒答时由服务端按拒答类别改用推荐的模型重试；该形式对应的 beta 头。
const SERVER_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** Anthropic Messages API 适配器。服务特有的字段只在这里转换，不越过端口。 */
export class AnthropicAdapter implements LlmPort {
  private readonly client: Anthropic;

  constructor(options: AnthropicAdapterOptions) {
    this.client = new Anthropic({
      apiKey: options.apiKey,
      ...(options.baseURL !== undefined && { baseURL: options.baseURL }),
      ...(options.fetch !== undefined && { fetch: options.fetch }),
      maxRetries: options.maxRetries ?? 2,
      ...(options.timeoutMs !== undefined && { timeout: options.timeoutMs }),
      ...(options.viaCredentialProxy === true && { dangerouslyAllowBrowser: true }),
    });
  }

  async complete(request: LlmRequest, options: CallOptions = {}): Promise<Result<LlmResult, LlmError>> {
    const hash = requestHash(request);
    const base = { provider: request.model.provider, requestHash: hash };
    let text = '';
    let servedModel = request.model.model;
    // 取消时返回已知用量；放在对象里，回调中的赋值才不会被类型收窄忽略。
    const known: { usage: LlmUsage | null } = { usage: null };
    const emitUsage = (next: LlmUsage) => {
      known.usage = next;
      options.onEvent?.({ type: 'usage', usage: next });
    };
    const cancelled = (): LlmResult => ({
      ...base,
      outcome: 'cancelled',
      text,
      usage: known.usage,
      servedModel,
      stopReason: null,
      fallbackUsed: false,
    });

    try {
      const stream = this.client.beta.messages.stream(buildParams(request), {
        ...(options.signal !== undefined && { signal: options.signal }),
      });
      for await (const event of stream) {
        switch (event.type) {
          case 'message_start':
            servedModel = event.message.model;
            emitUsage(toUsage(event.message.usage));
            break;
          case 'content_block_delta':
            if (event.delta.type === 'text_delta') {
              text += event.delta.text;
              options.onEvent?.({ type: 'text', delta: event.delta.text });
            }
            break;
          case 'message_delta': {
            const prev = known.usage;
            if (prev !== null) {
              emitUsage({
                inputTokens: event.usage.input_tokens ?? prev.inputTokens,
                outputTokens: event.usage.output_tokens,
                cacheReadTokens: event.usage.cache_read_input_tokens ?? prev.cacheReadTokens,
                cacheWriteTokens: event.usage.cache_creation_input_tokens ?? prev.cacheWriteTokens,
              });
            }
            break;
          }
          case 'content_block_start':
          case 'content_block_stop':
          case 'message_stop':
            break;
        }
      }

      if (options.signal?.aborted === true) return ok(cancelled());
      const message = await stream.finalMessage();
      const stopReason = message.stop_reason;
      const fallbackUsed =
        message.content.some((block) => block.type === 'fallback') ||
        (message.usage.iterations ?? []).some((entry) => entry.type === 'fallback_message');
      return ok({
        ...base,
        outcome: stopReason === 'refusal' ? 'refused' : stopReason === 'max_tokens' ? 'truncated' : 'completed',
        text,
        usage: toUsage(message.usage),
        servedModel: message.model,
        stopReason,
        fallbackUsed,
        ...(stopReason === 'refusal' && {
          refusal: {
            category: message.stop_details?.category ?? null,
            explanation: message.stop_details?.explanation ?? null,
          },
        }),
      });
    } catch (error) {
      if (options.signal?.aborted === true || error instanceof Anthropic.APIUserAbortError) {
        return ok(cancelled());
      }
      return err(mapSdkError(error));
    }
  }
}

function buildParams(request: LlmRequest): BetaMessageStreamParams {
  const caps = request.model.capabilities;
  const format = request.output !== undefined && caps.structuredOutput === 'native';
  const effort = request.effort !== undefined && caps.reasoningControl === 'effort';
  return {
    model: request.model.model,
    max_tokens: request.maxOutputTokens,
    system: request.system.map((block) => ({
      type: 'text' as const,
      text: block.text,
      ...(block.cache === true && caps.promptCaching && { cache_control: { type: 'ephemeral' as const } }),
    })),
    messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
    ...((format || effort) && {
      output_config: {
        ...(format && request.output && { format: { type: 'json_schema' as const, schema: request.output.schema } }),
        ...(effort && { effort: request.effort }),
      },
    }),
    ...(caps.refusalFallback === 'server_default' && {
      fallbacks: 'default' as const,
      betas: [SERVER_FALLBACK_BETA],
    }),
  };
}

type SdkUsage = {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_input_tokens: number | null;
  readonly cache_creation_input_tokens: number | null;
};

const toUsage = (u: SdkUsage): LlmUsage => ({
  inputTokens: u.input_tokens,
  outputTokens: u.output_tokens,
  cacheReadTokens: u.cache_read_input_tokens ?? 0,
  cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
});
