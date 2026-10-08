// 测试辅助：模拟 Rust 凭据代理的传输层，把请求交给给定的 fetch（通常是 fakeFetch），按代理的事件格式回传。仅供测试使用。
import type { NetEvent, NetRequest, NetTransport } from '../proxy-fetch';

export type FakeNet = NetTransport & {
  readonly requests: NetRequest[];
  readonly cancelled: string[];
};

/** reject 不为空时，代理拒绝所有请求（例如目标不是该服务的地址）。 */
export function fakeNet(inner: typeof fetch, reject: unknown = null): FakeNet {
  const requests: NetRequest[] = [];
  const cancelled: string[] = [];
  const running = new Map<string, AbortController>();
  return {
    requests,
    cancelled,
    send(request, onEvent) {
      // Tauri 的 invoke 以序列化后的错误对象（不是 Error）拒绝，这里照样模拟。
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      if (reject !== null) return Promise.reject(reject);
      requests.push(request);
      const abort = new AbortController();
      running.set(request.id, abort);
      void (async () => {
        let last: NetEvent;
        try {
          const response = await inner(request.url, {
            method: request.method,
            headers: request.headers.map(([k, v]) => [k, v]),
            ...(request.body !== null && { body: request.body }),
            signal: abort.signal,
          });
          const headers: [string, string][] = [];
          response.headers.forEach((value, key) => headers.push([key, value]));
          onEvent({ event: 'head', status: response.status, headers });
          const reader = response.body?.getReader();
          for (;;) {
            const next = await reader?.read();
            if (next === undefined || next.done) break;
            // Tauri 的 Channel 把字节序列化为数字数组。
            onEvent({ event: 'chunk', data: [...next.value] });
          }
          last = { event: 'end', cancelled: false };
        } catch (error) {
          last = abort.signal.aborted ? { event: 'end', cancelled: true } : { event: 'failed', message: String(error) };
        }
        running.delete(request.id);
        onEvent(last);
      })();
      return Promise.resolve();
    },
    cancel(id) {
      cancelled.push(id);
      running.get(id)?.abort();
      return Promise.resolve();
    },
  };
}
