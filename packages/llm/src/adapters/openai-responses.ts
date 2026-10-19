import OpenAI from 'openai';
import type { ResponseCreateParamsStreaming } from 'openai/resources/responses/responses';
import { err, ok, type Result } from '@fudiao/shared';
import { requestHash } from '../request-hash';
import type { CallOptions, Effort, LlmError, LlmPort, LlmRequest, LlmResult, LlmUsage } from '../types';
import { errList, MAX_LISTED_MODELS, okList, type ListedModel, type ModelLister } from '../models';
import { mapSdkError, streamError } from './errors';

export type OpenAIAdapterOptions = {
  readonly apiKey: string;
  readonly baseURL?: string;
  readonly fetch?: typeof fetch;
  readonly maxRetries?: number;
  readonly timeoutMs?: number;
  /** 在 WebView 中经凭据代理运行（见 AnthropicAdapterOptions.viaCredentialProxy）。 */
  readonly viaCredentialProxy?: boolean;
};

/**
 * OpenAI 官方接口的 Responses API 适配器（施工文档第六章：OpenAI 新模型的推理控制与结构化输出以 Responses API 为主）。
 * 不在服务端保存对话（store: false）；结构化输出按能力描述：native 发送 json_schema，json_object 只要求合法 JSON。
 */
export class OpenAIAdapter implements LlmPort, ModelLister {
  private readonly client: OpenAI;

  constructor(options: OpenAIAdapterOptions) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      ...(options.baseURL !== undefined && { baseURL: options.baseURL }),
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
    const base = { provider: request.model.provider, requestHash: requestHash(request), fallbackUsed: false };
    let text = '';
    let refusalText = '';
    let servedModel = request.model.model;
    let usage: LlmUsage | null = null;
    let status: string | null = null;
    let incomplete: string | null = null;
    let failure: LlmError | null = null;
    // 收到第一个事件后服务就开始回复了，之后出错可能已经计费（LlmError.partial）。
    let started = false;
    let ended = false;

    try {
      const stream = await this.client.responses.create(buildResponseParams(request), {
        ...(options.signal !== undefined && { signal: options.signal }),
      });
      // 只处理文字、拒答、结束与失败事件；工具调用、推理摘要等事件与这里的用途无关。
      for await (const event of stream) {
        started = true;
        if (event.type === 'response.created') {
          if (event.response.model) servedModel = event.response.model;
        } else if (event.type === 'response.output_text.delta') {
          text += event.delta;
          options.onEvent?.({ type: 'text', delta: event.delta });
        } else if (event.type === 'response.refusal.delta') {
          refusalText += event.delta;
        } else if (event.type === 'response.completed' || event.type === 'response.incomplete') {
          ended = true;
          const r = event.response;
          if (r.model) servedModel = r.model;
          status = r.status ?? null;
          incomplete = r.incomplete_details?.reason ?? null;
          if (r.usage) {
            const cached = r.usage.input_tokens_details.cached_tokens;
            usage = { inputTokens: r.usage.input_tokens - cached, outputTokens: r.usage.output_tokens, cacheReadTokens: cached, cacheWriteTokens: 0 };
            options.onEvent?.({ type: 'usage', usage });
          }
        } else if (event.type === 'response.failed') {
          failure = { code: 'server', message: event.response.error?.message ?? '服务返回失败' };
        } else if (event.type === 'error') {
          failure = { code: 'unknown', message: event.message };
        }
      }
    } catch (error) {
      if (options.signal?.aborted === true || error instanceof OpenAI.APIUserAbortError) {
        return ok({ ...base, outcome: 'cancelled', text, usage, servedModel, stopReason: null });
      }
      const mapped = mapSdkError(error);
      return err(started ? { ...mapped, partial: { usage } } : mapped);
    }
    if (options.signal?.aborted === true) return ok({ ...base, outcome: 'cancelled', text, usage, servedModel, stopReason: null });
    if (failure !== null) return err(started ? { ...failure, partial: { usage } } : failure);
    // 正常结束一定有 completed 或 incomplete 事件；没有就关闭的流是半截。
    if (!ended) return err(streamError(usage));

    const refused = refusalText !== '' || incomplete === 'content_filter';
    return ok({
      ...base,
      outcome: refused ? 'refused' : incomplete === 'max_output_tokens' ? 'truncated' : 'completed',
      text,
      usage,
      servedModel,
      stopReason: incomplete ?? status,
      ...(refused && { refusal: { category: null, explanation: refusalText || null } }),
    });
  }
}

/** Responses API 的 reasoning.effort 只保证 low、medium、high；更高的深度按 high 发送。 */
const responsesEffort = (effort: Effort): 'low' | 'medium' | 'high' => (effort === 'xhigh' || effort === 'max' ? 'high' : effort);

export function buildResponseParams(request: LlmRequest): ResponseCreateParamsStreaming {
  const caps = request.model.capabilities;
  const instructions = request.system.map((b) => b.text).join('\n\n');
  const output = request.output;
  return {
    model: request.model.model,
    stream: true,
    // 不让服务端保存对话内容。
    store: false,
    max_output_tokens: request.maxOutputTokens,
    ...(instructions !== '' && { instructions }),
    input: request.messages.map((m) => ({ role: m.role, content: m.content })),
    ...(output !== undefined &&
      caps.structuredOutput === 'native' && {
        text: { format: { type: 'json_schema' as const, name: output.name, schema: { ...output.schema }, strict: true } },
      }),
    ...(output !== undefined && caps.structuredOutput === 'json_object' && { text: { format: { type: 'json_object' as const } } }),
    ...(request.effort !== undefined && caps.reasoningControl === 'effort' && { reasoning: { effort: responsesEffort(request.effort) } }),
  };
}
