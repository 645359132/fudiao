// 网络中断的重试（需求 B15、B19）：SDK 只重试还没收到回复的请求（网络错误、429、5xx）；回复读到一半连接断了
// （例如凭据代理报“error decoding response body”），整次调用就失败了。这里把网络故障整次重新请求，
// 每次都照常写调用记录（包在调用记录外面）。重新请求前发出 retry 事件，界面丢掉中断前收到的半截文字。
import type { CallOptions, LlmError, LlmErrorCode, LlmPort, LlmRequest, LlmResult } from './types';
import type { Result } from '@fudiao/shared';

export type RetryPolicy = {
  /** 每次重试前等待的毫秒数；长度就是最多重试的次数。 */
  readonly delaysMs: readonly number[];
  /** 可取消的等待；被取消时返回 false。测试中注入不真等的实现。 */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<boolean>;
};

/** 网络中断通常过一会儿就好；限流与服务端错误已由 SDK 重试过（状态码在回复开头就知道），其余错误重试也一样。 */
const RETRYABLE: ReadonlySet<LlmErrorCode> = new Set(['network']);

export const DEFAULT_RETRY: RetryPolicy = { delaysMs: [3_000, 10_000] };

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve(false);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export const isRetryable = (error: LlmError): boolean => RETRYABLE.has(error.code);

export function withRetry(port: LlmPort, policy: RetryPolicy = DEFAULT_RETRY): LlmPort {
  const sleep = policy.sleep ?? abortableSleep;
  return {
    async complete(request: LlmRequest, options: CallOptions = {}): Promise<Result<LlmResult, LlmError>> {
      for (let attempt = 0; ; attempt++) {
        const result = await port.complete(request, options);
        const delay = policy.delaysMs[attempt];
        if (result.ok || !isRetryable(result.error) || delay === undefined || options.signal?.aborted === true) return result;
        options.onEvent?.({ type: 'retry', attempt: attempt + 1, reason: result.error.message });
        if (!(await sleep(delay, options.signal))) return result;
      }
    },
  };
}
