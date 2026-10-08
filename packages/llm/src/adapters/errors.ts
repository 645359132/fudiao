import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { LlmError, LlmErrorCode } from '../types';

type StatusError = { readonly status: number; readonly headers: Headers | undefined; readonly message: string };

/** 两家 SDK 的错误类型结构相同；按类型分类，不匹配错误文字。消息中不含凭据。 */
export function mapSdkError(error: unknown): LlmError {
  if (error instanceof Anthropic.APIConnectionError || error instanceof OpenAI.APIConnectionError) {
    // SDK 只说“连接错误”，具体原因（例如凭据代理拒绝了目标地址）在 cause 中。
    const cause: unknown = error.cause;
    return { code: 'network', message: cause instanceof Error && cause.message !== '' ? `${error.message} ${cause.message}` : error.message };
  }
  if (error instanceof Anthropic.APIError || error instanceof OpenAI.APIError) {
    const status: unknown = error.status;
    if (typeof status === 'number') return fromStatus(error as StatusError);
    return { code: 'unknown', message: error.message };
  }
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
