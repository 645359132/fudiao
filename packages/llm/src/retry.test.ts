import { err, ok, type Result } from '@fudiao/shared';
import { describe, expect, it } from 'vitest';
import { abortableSleep, withRetry } from './retry';
import type { LlmError, LlmPort, LlmRequest, LlmResult, LlmStreamEvent } from './types';
import { CONSERVATIVE_CAPABILITIES } from './types';

const request: LlmRequest = {
  task: 'writer',
  model: { provider: 'p', model: 'm', capabilities: CONSERVATIVE_CAPABILITIES },
  template: { id: 't', version: '1' },
  system: [],
  messages: [{ role: 'user', content: '写' }],
  maxOutputTokens: 100,
};
const success: LlmResult = { outcome: 'completed', text: '好', usage: null, provider: 'p', servedModel: 'm', stopReason: 'stop', fallbackUsed: false, requestHash: 'h' };

/** 按顺序给出结果的端口。 */
function scripted(results: readonly Result<LlmResult, LlmError>[]) {
  let calls = 0;
  const port: LlmPort = {
    complete: () => Promise.resolve(results[Math.min(calls++, results.length - 1)] ?? err({ code: 'unknown', message: '没有结果' })),
  };
  return { port, calls: () => calls };
}

const instant = { delaysMs: [3_000, 10_000], sleep: () => Promise.resolve(true) };

describe('网络中断的重试', () => {
  it('网络中断后整次重新请求，重新请求前发出 retry 事件；成功后返回成功的结果', async () => {
    const { port, calls } = scripted([err({ code: 'network', message: 'error decoding response body' }), ok(success)]);
    const events: LlmStreamEvent[] = [];
    const result = await withRetry(port, instant).complete(request, { onEvent: (e) => events.push(e) });
    expect(result).toEqual(ok(success));
    expect(calls()).toBe(2);
    expect(events).toEqual([{ type: 'retry', attempt: 1, reason: 'error decoding response body' }]);
  });

  it('重试用完仍失败时返回最后一次的错误', async () => {
    const { port, calls } = scripted([err({ code: 'network', message: 'reset 1' }), err({ code: 'network', message: 'reset 2' }), err({ code: 'network', message: 'reset 3' })]);
    expect(await withRetry(port, instant).complete(request)).toEqual(err({ code: 'network', message: 'reset 3' }));
    expect(calls()).toBe(3);
  });

  it('SDK 已经重试过的（限流、服务端错误）与请求本身的问题（格式、凭据、凭据代理拒绝）不再重试', async () => {
    for (const code of ['server', 'bad_request', 'auth', 'rate_limited', 'unknown'] as const) {
      const { port, calls } = scripted([err({ code, message: code }), ok(success)]);
      expect((await withRetry(port, instant).complete(request)).ok).toBe(false);
      expect(calls()).toBe(1);
    }
  });

  it('作者取消后不再重试：等待中取消时立即返回', async () => {
    const abort = new AbortController();
    const { port, calls } = scripted([err({ code: 'network', message: 'reset' }), ok(success)]);
    const waiting = withRetry(port, { delaysMs: [60_000] }).complete(request, { signal: abort.signal });
    abort.abort();
    expect((await waiting).ok).toBe(false);
    expect(calls()).toBe(1);
    expect(await abortableSleep(10, abort.signal)).toBe(false);
    expect(await abortableSleep(1)).toBe(true);
  });
});
