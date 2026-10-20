import { describe, expect, it } from 'vitest';
import { AnthropicAdapter } from './adapters/anthropic';
import { OpenAIChatAdapter } from './adapters/openai-chat';
import { testConnection } from './connection';
import { createProxyFetch, PLACEHOLDER_API_KEY, ProxyRejectedError, type NetEvent, type NetRequest, type NetTransport } from './proxy-fetch';
import { anthropicChunks, errorBody, fakeFetch, openaiChunks } from './testing/fake-fetch';
import { fakeNet } from './testing/fake-net';
import { CONSERVATIVE_CAPABILITIES, type ModelProfile } from './types';

let n = 0;
const newId = () => `r${++n}`;

/** 手动驱动事件的传输层。 */
function manual() {
  const sent: { request: NetRequest; emit: (e: NetEvent) => void }[] = [];
  const cancelled: string[] = [];
  const transport: NetTransport = {
    send: (request, emit) => {
      sent.push({ request, emit });
      return Promise.resolve();
    },
    cancel: (id) => {
      cancelled.push(id);
      return Promise.resolve();
    },
  };
  return { transport, sent, cancelled };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('经凭据代理的 fetch', () => {
  it('把请求交给代理：服务标识、方法、地址、请求头与正文', async () => {
    const net = fakeNet(fakeFetch([{ body: '{"ok":true}' }]).fetch);
    const fetch = createProxyFetch(net, 'anthropic-1', newId);
    const response = await fetch('https://api.example.test/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': PLACEHOLDER_API_KEY },
      body: '{"model":"m"}',
    });
    expect(await response.json()).toEqual({ ok: true });
    expect(net.requests[0]).toMatchObject({
      providerId: 'anthropic-1',
      method: 'POST',
      url: 'https://api.example.test/v1/messages',
      headers: expect.arrayContaining([
        ['content-type', 'application/json'],
        ['x-api-key', PLACEHOLDER_API_KEY],
      ]),
      body: '{"model":"m"}',
    });
  });

  it('响应体按块流式到达', async () => {
    const { transport, sent } = manual();
    const pending = createProxyFetch(transport, 'p', newId)('https://a.test/x');
    await tick();
    const emit = sent[0]?.emit ?? (() => undefined);
    emit({ event: 'head', status: 200, headers: [['content-type', 'text/event-stream']] });
    const response = await pending;
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const reader = response.body?.getReader();
    emit({ event: 'chunk', data: [...new TextEncoder().encode('第一块')] });
    expect(new TextDecoder().decode((await reader?.read())?.value)).toBe('第一块');
    emit({ event: 'chunk', data: new TextEncoder().encode('第二块') });
    emit({ event: 'end', cancelled: false });
    expect(new TextDecoder().decode((await reader?.read())?.value)).toBe('第二块');
    expect((await reader?.read())?.done).toBe(true);
  });

  it('代理拒绝时按网络错误处理，适配器给出 network 与原因', async () => {
    const net = fakeNet(fakeFetch([]).fetch, { code: 'host_not_allowed', origin: 'https://evil.test' });
    const fetch = createProxyFetch(net, 'p', newId);
    await expect(fetch('https://evil.test/v1')).rejects.toBeInstanceOf(ProxyRejectedError);
    const adapter = new OpenAIChatAdapter({ apiKey: PLACEHOLDER_API_KEY, baseURL: 'https://evil.test/v1', fetch, maxRetries: 0 });
    const result = await adapter.complete({
      task: 'connection_test',
      model: { provider: 'p', model: 'm', capabilities: CONSERVATIVE_CAPABILITIES },
      template: { id: 'connection_test', version: '1' },
      system: [],
      messages: [{ role: 'user', content: '测试' }],
      maxOutputTokens: 16,
    });
    expect(result.ok ? null : result.error).toMatchObject({ code: 'bad_request', message: expect.stringContaining('host_not_allowed') });
  });

  it('响应头到达前取消：fetch 以 AbortError 结束并通知代理', async () => {
    const { transport, cancelled } = manual();
    const abort = new AbortController();
    const pending = createProxyFetch(transport, 'p', newId)('https://a.test/x', { signal: abort.signal });
    await tick();
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancelled).toHaveLength(1);
  });

  it('代理还没受理请求时取消：照样把同一标识的取消发给代理（由代理记下，开始时不发出）', async () => {
    const sent: NetRequest[] = [];
    const cancelled: string[] = [];
    const transport: NetTransport = {
      send: (request) => {
        sent.push(request);
        return new Promise(() => undefined);
      },
      cancel: (id) => {
        cancelled.push(id);
        return Promise.resolve();
      },
    };
    const abort = new AbortController();
    const pending = createProxyFetch(transport, 'p', newId)('https://a.test/x', { signal: abort.signal });
    await tick();
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancelled).toEqual([sent[0]?.id]);
  });

  it('已经取消的信号不发出请求', async () => {
    const { transport, sent } = manual();
    const abort = new AbortController();
    abort.abort();
    await expect(createProxyFetch(transport, 'p', newId)('https://a.test/x', { signal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(sent).toHaveLength(0);
  });

  it('读取方放弃响应体时通知代理停下；204 没有响应体', async () => {
    const { transport, sent, cancelled } = manual();
    const fetch = createProxyFetch(transport, 'p', newId);
    const pending = fetch('https://a.test/x');
    await tick();
    sent[0]?.emit({ event: 'head', status: 200, headers: [] });
    await (await pending).body?.cancel();
    expect(cancelled).toEqual([sent[0]?.request.id]);
    // 取消与服务的结束是并发的：代理在停下之前可能还会送来已经在路上的数据与结束事件，这些都要丢掉。
    // （SDK 读到流的结束标记后就放弃响应体，真实服务随后才关闭连接。）
    expect(() => {
      sent[0]?.emit({ event: 'chunk', data: [1] });
      sent[0]?.emit({ event: 'end', cancelled: false });
      sent[0]?.emit({ event: 'failed', message: '迟到的失败' });
    }).not.toThrow();
    expect(cancelled).toEqual([sent[0]?.request.id]);

    const empty = fetch('https://a.test/y');
    await tick();
    sent[1]?.emit({ event: 'head', status: 204, headers: [] });
    expect((await empty).body).toBeNull();
  });

  it('代理报告失败：响应头之前为网络错误，之后为读取错误', async () => {
    const { transport, sent } = manual();
    const fetch = createProxyFetch(transport, 'p', newId);
    const before = fetch('https://a.test/x');
    await tick();
    sent[0]?.emit({ event: 'failed', message: '连接被重置' });
    await expect(before).rejects.toThrow('连接被重置');

    const after = fetch('https://a.test/y');
    await tick();
    sent[1]?.emit({ event: 'head', status: 200, headers: [] });
    const reader = (await after).body?.getReader();
    sent[1]?.emit({ event: 'failed', message: '读取超时' });
    await expect(reader?.read()).rejects.toThrow('读取超时');

    // 读到一半失败：失败之前已经到达、还没读走的数据块先交给读取方，读完才报错（适配器据此拿到已收到的部分）。
    const mid = fetch('https://a.test/z');
    await tick();
    sent[2]?.emit({ event: 'head', status: 200, headers: [] });
    sent[2]?.emit({ event: 'chunk', data: [1, 2] });
    sent[2]?.emit({ event: 'chunk', data: [3] });
    sent[2]?.emit({ event: 'failed', message: '连接断开' });
    const midReader = (await mid).body?.getReader();
    expect(Array.from((await midReader?.read())?.value ?? [])).toEqual([1, 2]);
    expect(Array.from((await midReader?.read())?.value ?? [])).toEqual([3]);
    await expect(midReader?.read()).rejects.toThrow('连接断开');
  });
});

describe('连接测试', () => {
  const model = (provider: string): ModelProfile => ({ provider, model: 'test-model', capabilities: CONSERVATIVE_CAPABILITIES });
  const prompt = { template: { id: 'connection_test', version: '1' }, system: [], messages: [{ role: 'user' as const, content: '请只回复一个字：好' }] };
  const clock = (...times: number[]) => () => times.shift() ?? 0;

  it('成功：延迟、实际模型与回复', async () => {
    const net = fakeNet(fakeFetch([{ chunks: anthropicChunks('test-model', { text: ['好'], end: 'stop', usage: { input: 10, output: 1, cacheRead: 0 } }) }]).fetch);
    const adapter = new AnthropicAdapter({ apiKey: PLACEHOLDER_API_KEY, fetch: createProxyFetch(net, 'a', newId), maxRetries: 0 });
    expect(await testConnection(adapter, model('anthropic'), prompt, clock(1_000, 1_420))).toEqual({ ok: true, latencyMs: 420, servedModel: 'test-model', reply: '好' });
    expect(net.requests[0]?.body).toContain('请只回复一个字');
  });

  it('失败：给出错误种类（例如 API Key 无效）', async () => {
    const net = fakeNet(fakeFetch([{ status: 401, body: errorBody(401) }]).fetch);
    const adapter = new OpenAIChatAdapter({ apiKey: PLACEHOLDER_API_KEY, baseURL: 'https://a.test/v1', fetch: createProxyFetch(net, 'o', newId), maxRetries: 0 });
    const report = await testConnection(adapter, model('compatible'), prompt, clock(0, 80));
    expect(report).toMatchObject({ ok: false, latencyMs: 80, error: { code: 'auth', status: 401 } });
  });

  it('达到输出上限也算连接可用', async () => {
    const net = fakeNet(fakeFetch([{ chunks: openaiChunks('test-model', { text: ['好'], end: 'length', usage: { input: 10, output: 64, cacheRead: 0 } }) }]).fetch);
    const adapter = new OpenAIChatAdapter({ apiKey: PLACEHOLDER_API_KEY, baseURL: 'https://a.test/v1', fetch: createProxyFetch(net, 'o', newId), maxRetries: 0 });
    expect((await testConnection(adapter, model('compatible'), prompt, clock(0, 5))).ok).toBe(true);
  });
});
