import { err, ok, type Result } from '@fudiao/shared';
import OpenAI from 'openai';
import type { ChatCompletionCreateParamsStreaming } from 'openai/resources/chat/completions';
import { requestHash } from '../request-hash';
import type { CallOptions, Effort, LlmError, LlmPort, LlmRequest, LlmResult, LlmUsage } from '../types';
import { errList, MAX_LISTED_MODELS, okList, type ListedModel, type ModelLister } from '../models';
import { mapSdkError, streamError } from './errors';
import { unsupportedTools } from './server-tools';
import { ThinkFilter } from './think-filter';
import { OPENAI_DIALECT, type ChatDialect } from './dialect';

export type { ChatDialect } from './dialect';
export { COMPATIBLE_DIALECT, OPENAI_DIALECT } from './dialect';

export type OpenAIChatAdapterOptions = {
  /** 本地端点可免密钥。 */
  readonly apiKey?: string;
  readonly baseURL: string;
  readonly fetch?: typeof fetch;
  readonly maxRetries?: number;
  readonly timeoutMs?: number;
  /** 未给出时按 OpenAI 官方接口处理。 */
  readonly dialect?: ChatDialect;
  /** 在 WebView 中经凭据代理运行（见 AnthropicAdapterOptions.viaCredentialProxy）。 */
  readonly viaCredentialProxy?: boolean;
};

/**
 * Chat Completions 适配器：覆盖 OpenAI 兼容接口、Gemini 兼容模式与本地端点。
 * 结构化输出按能力描述：native 发送 json_schema，json_object 只要求合法 JSON，prompt 不发送 response_format；
 * 后两者的字段约束由调用方的提示词模板给出。
 */
export class OpenAIChatAdapter implements LlmPort, ModelLister {
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
      ...(options.viaCredentialProxy === true && { dangerouslyAllowBrowser: true }),
    });
  }

  /** 模型列表（B56）。OpenAI 写法的接口只返回模型标识，能力由内置能力表或保守能力补齐。 */
  async listModels(options: CallOptions = {}): Promise<Result<readonly ListedModel[], LlmError>> {
    const out: ListedModel[] = [];
    try {
      for await (const m of this.client.models.list(options.signal === undefined ? {} : { signal: options.signal })) {
        out.push({ id: m.id, displayName: null, capabilities: {} });
        if (out.length >= MAX_LISTED_MODELS) break;
      }
    } catch (error) {
      return errList(mapSdkError(error));
    }
    return okList(out);
  }

  async complete(request: LlmRequest, options: CallOptions = {}): Promise<Result<LlmResult, LlmError>> {
    // Chat Completions 没有服务端的联网搜索工具（OpenAI 只在 Responses API 提供）：声明了就明确拒绝，不发请求。
    const unsupported = unsupportedTools(request, 'Chat Completions 写法的服务不支持模型自带的联网搜索：请改用 OpenAI 官方服务（Responses API）或 Anthropic 的模型');
    if (unsupported !== null) return err(unsupported);
    const base = { provider: request.model.provider, requestHash: requestHash(request), fallbackUsed: false };
    let text = '';
    let refusalText = '';
    let servedModel = request.model.model;
    let usage: LlmUsage | null = null;
    let finish: string | null = null;
    // 收到第一块后服务就开始回复了，之后出错可能已经计费（LlmError.partial）。
    let started = false;
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
        started = true;
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
      const mapped = mapSdkError(error);
      return err(started ? { ...mapped, partial: { usage } } : mapped);
    }

    // SDK 的流在取消时直接结束而不抛出异常。
    if (options.signal?.aborted === true) {
      return ok({ ...base, outcome: 'cancelled', text, usage, servedModel, stopReason: null });
    }
    // 每个选项都以 finish_reason 结束；没有它就关闭的流是半截。
    if (finish === null) return err(streamError(usage));

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
