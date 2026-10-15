import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { ProxyRejectedError } from '../proxy-fetch';
import type { LlmError, LlmErrorCode } from '../types';

type StatusError = { readonly status: number; readonly headers: Headers | undefined; readonly message: string };

/** 两家 SDK 的错误类型结构相同；按类型分类，不匹配错误文字。消息中不含凭据。 */
export function mapSdkError(error: unknown): LlmError {
  if (error instanceof Anthropic.APIConnectionError || error instanceof OpenAI.APIConnectionError) {
    // SDK 只说“连接错误”，具体原因（例如凭据代理拒绝了目标地址）在 cause 中。
    const cause: unknown = error.cause;
    const message = cause instanceof Error && cause.message !== '' ? `${error.message} ${cause.message}` : error.message;
    // 凭据代理拒绝（目标地址不对、没有凭据等）是设置问题，重试也一样，不算网络故障。
    return { code: cause instanceof ProxyRejectedError ? 'bad_request' : 'network', message };
  }
  if (error instanceof Anthropic.APIError || error instanceof OpenAI.APIError) {
    const status: unknown = error.status;
    if (typeof status === 'number') return fromStatus(error as StatusError);
    return { code: 'unknown', message: error.message };
  }
  // 读流式回复时出的错：SDK 把底层的网络错误包成自己的错误类（没有状态码），多半是连接中途断了，算网络故障，可以重试。
  if (error instanceof Anthropic.AnthropicError || error instanceof OpenAI.OpenAIError) return { code: 'network', message: error.message };
  if (error instanceof ProxyRejectedError) return { code: 'bad_request', message: error.message };
  // 读流式回复时连接断了（fetch 的网络错误是 TypeError，例如凭据代理的“error decoding response body”）：网络故障，可以重试。
  if (error instanceof TypeError) return { code: 'network', message: error.message };
  return { code: 'unknown', message: error instanceof Error ? error.message : String(error) };
}

function fromStatus(error: StatusError): LlmError {
  const { status } = error;
  const code: LlmErrorCode =
    status === 429
      ? 'rate_limited'
      : status === 401 || status === 403
        ? 'auth'
        : status >= 500
          ? 'server'
          : status >= 400
            ? 'bad_request'
            : 'unknown';
  const retryAfterMs = code === 'rate_limited' ? retryAfter(error.headers) : undefined;
  return { code, status, message: error.message, ...(retryAfterMs !== undefined && { retryAfterMs }) };
}

function retryAfter(headers: Headers | undefined): number | undefined {
  const ms = Number(headers?.get('retry-after-ms'));
  if (Number.isFinite(ms) && ms > 0) return ms;
  const seconds = Number(headers?.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}
