import { createProxyFetch, type NetEvent } from '@fudiao/llm';
import { describe, expect, it } from 'vitest';
import { tauriNet, type ChannelLike } from './tauri-net';

describe('凭据代理的 Tauri 传输层', () => {
  it('net_fetch 带上请求与 Channel，事件经 Channel 回到 fetch；取消调用 net_cancel', async () => {
    const calls: { command: string; args: Record<string, unknown> | undefined }[] = [];
    let channel: ChannelLike<NetEvent> | null = null;
    const invoke = <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
      calls.push({ command, args });
      if (command === 'net_fetch') {
        channel = args?.['channel'] as ChannelLike<NetEvent>;
        queueMicrotask(() => {
          channel?.onmessage({ event: 'head', status: 200, headers: [['content-type', 'text/plain']] });
          channel?.onmessage({ event: 'chunk', data: [...new TextEncoder().encode('好')] });
          channel?.onmessage({ event: 'end', cancelled: false });
        });
      }
      return Promise.resolve(undefined as T);
    };
    const transport = tauriNet(invoke, () => ({ onmessage: () => undefined }));
    const fetch = createProxyFetch(transport, 'anthropic-1', () => 'req-1');
    const response = await fetch('https://api.example.test/v1/messages', { method: 'POST', body: '{}' });
    expect(await response.text()).toBe('好');
    expect(calls[0]).toMatchObject({ command: 'net_fetch', args: { request: { id: 'req-1', providerId: 'anthropic-1', method: 'POST', body: '{}' } } });
    await transport.cancel('req-1');
    expect(calls[1]).toEqual({ command: 'net_cancel', args: { id: 'req-1' } });
  });

  it('代理拒绝时 fetch 失败，原因带上错误码', async () => {
    // Rust 命令返回 Err 时，invoke 以序列化后的错误对象拒绝。
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    const invoke = <T,>(): Promise<T> => Promise.reject({ code: 'host_not_allowed', origin: 'https://evil.test' });
    const fetch = createProxyFetch(tauriNet(invoke, () => ({ onmessage: () => undefined })), 'p', () => 'r');
    await expect(fetch('https://evil.test/')).rejects.toThrow('host_not_allowed');
  });
});
