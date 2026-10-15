// 经 Rust 凭据代理发出的 fetch（施工文档第五章“分工”）：桌面端把它交给适配器的 SDK，SDK 中的 API Key 填占位值，
// 由代理换成真实凭据，WebView 拿不到明文。传输层（Tauri 的 invoke 与 Channel）由桌面端实现，这里把事件流还原成标准的 Response。

/** 与 Rust 的 `NetRequest` 对应。 */
export type NetRequest = {
  readonly id: string;
  readonly providerId: string;
  readonly url: string;
  readonly method: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: string | null;
};

/** 与 Rust 的 `NetEvent` 对应：先是响应头，然后是若干块响应体，最后是结束或失败。 */
export type NetEvent =
  | { readonly event: 'head'; readonly status: number; readonly headers: readonly (readonly [string, string])[] }
  | { readonly event: 'chunk'; readonly data: readonly number[] | Uint8Array }
  | { readonly event: 'end'; readonly cancelled: boolean }
  | { readonly event: 'failed'; readonly message: string };

export interface NetTransport {
  /** 发出请求。代理拒绝时（目标不是该服务的地址、没有凭据等）reject，不会有任何事件。 */
  send(request: NetRequest, onEvent: (event: NetEvent) => void): Promise<void>;
  cancel(id: string): Promise<void>;
}

/** SDK 要求提供 API Key 才会发请求；真实凭据由代理注入，这个占位值不会离开本机。 */
export const PLACEHOLDER_API_KEY = 'fudiao-credential-proxy';

/** 代理拒绝了请求。按 fetch 的约定是 TypeError（网络错误），适配器据此归为 network。 */
export class ProxyRejectedError extends TypeError {
  constructor(readonly detail: unknown) {
    super(`凭据代理拒绝了请求：${describe(detail)}`);
    this.name = 'ProxyRejectedError';
  }
}

function describe(detail: unknown): string {
  if (detail !== null && typeof detail === 'object' && 'code' in detail) return String(detail.code);
  return String(detail);
}

const abortError = () => new DOMException('The operation was aborted.', 'AbortError');

/** 这些状态码的响应不能带响应体。 */
const NULL_BODY = new Set([101, 204, 205, 304]);

/** 为一个已配置的服务建立 fetch。newId 生成请求标识，用于取消。 */
export function createProxyFetch(transport: NetTransport, providerId: string, newId: () => string): typeof fetch {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const signal = init?.signal ?? request.signal;
    if (signal.aborted) throw abortError();
    const body = request.body === null ? null : await request.text();
    const headers: [string, string][] = [];
    request.headers.forEach((value, key) => headers.push([key, value]));
    const id = newId();

    return new Promise<Response>((resolve, reject) => {
      let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
      let responded = false;
      let finished = false;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
        cancel() {
          // SDK 不再读取响应体（读到流的结束标记，或自己中止）时，让代理也停下。
          // 流这时已经关闭：代理停下之前送来的数据与结束事件都要丢掉，再往里写会抛错。
          if (finished) return;
          finished = true;
          signal.removeEventListener('abort', onAbort);
          void transport.cancel(id);
        },
      });
      const finish = (error: Error | null) => {
        if (finished) return;
        finished = true;
        signal.removeEventListener('abort', onAbort);
        if (!responded) reject(error ?? new TypeError('凭据代理没有返回响应头'));
        else if (error === null) controller?.close();
        else controller?.error(error);
      };
      const onAbort = () => {
        void transport.cancel(id);
        finish(abortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });

      const onEvent = (e: NetEvent) => {
        if (finished) return;
        switch (e.event) {
          case 'head':
            responded = true;
            resolve(new Response(NULL_BODY.has(e.status) ? null : stream, { status: e.status, headers: e.headers.map(([k, v]): [string, string] => [k, v]) }));
            break;
          case 'chunk':
            controller?.enqueue(e.data instanceof Uint8Array ? e.data : Uint8Array.from(e.data));
            break;
          case 'end':
            finish(e.cancelled ? abortError() : null);
            break;
          case 'failed':
            finish(new TypeError(`网络请求失败：${e.message}`));
            break;
        }
      };
      transport.send({ id, providerId, url: request.url, method: request.method, headers, body }, onEvent).catch((error: unknown) => {
        finish(new ProxyRejectedError(error));
      });
    });
  };
}
