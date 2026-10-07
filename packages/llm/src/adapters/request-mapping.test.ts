import { describe, expect, it } from 'vitest';
import { anthropicChunks, fakeFetch, openaiChunks, type Scenario } from '../testing/fake-fetch';
import { CONSERVATIVE_CAPABILITIES, type LlmRequest, type ModelCapabilities } from '../types';
import { AnthropicAdapter } from './anthropic';
import { OpenAIChatAdapter } from './openai-chat';

const full: ModelCapabilities = {
  structuredOutput: 'native',
  promptCaching: true,
  reasoningControl: 'effort',
  refusalFallback: 'server_default',
  contextWindow: 1_000_000,
  maxOutputTokens: 128_000,
  selfTestPassed: true,
};

const request = (capabilities: ModelCapabilities): LlmRequest => ({
  task: 'semantic_ruling',
  model: { provider: 'p', model: 'm', capabilities },
  template: { id: 'semantic_ruling', version: '3' },
  system: [{ text: '通用规则与输出格式' }, { text: '场景规则与角色卡', cache: true }, { text: '本回合' }],
  messages: [{ role: 'user', content: '请裁决' }],
  output: { name: 'ruling', schema: { type: 'object', properties: {} } },
  maxOutputTokens: 4_000,
  effort: 'high',
});

const done: Scenario = { text: ['{}'], end: 'stop', usage: { input: 1, output: 1, cacheRead: 0 } };

describe('AnthropicAdapter 请求参数', () => {
  const send = async (capabilities: ModelCapabilities) => {
    const { fetch, requests } = fakeFetch([{ chunks: anthropicChunks('m', done) }]);
    await new AnthropicAdapter({ apiKey: 'k', fetch, maxRetries: 0 }).complete(request(capabilities));
    return requests[0]!;
  };

  it('按能力描述传递结构化输出、思考深度、缓存断点与服务端回退', async () => {
    const sent = await send(full);
    expect(sent.body).toEqual({
      model: 'm',
      max_tokens: 4_000,
      stream: true,
      system: [
        { type: 'text', text: '通用规则与输出格式' },
        { type: 'text', text: '场景规则与角色卡', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: '本回合' },
      ],
      messages: [{ role: 'user', content: '请裁决' }],
      output_config: { format: { type: 'json_schema', schema: { type: 'object', properties: {} } }, effort: 'high' },
      fallbacks: 'default',
    });
    expect(sent.headers['anthropic-beta']).toBe('server-side-fallback-2026-07-01');
    // 思考无法关闭，深度只由 effort 控制，因此不发送 thinking。
    expect(sent.body).not.toHaveProperty('thinking');
  });

  it('保守能力下不传任何可选参数', async () => {
    const sent = await send(CONSERVATIVE_CAPABILITIES);
    expect(sent.body).not.toHaveProperty('output_config');
    expect(sent.body).not.toHaveProperty('fallbacks');
    expect(JSON.stringify(sent.body)).not.toContain('cache_control');
    expect(sent.headers['anthropic-beta']).toBeUndefined();
  });

  it('服务端改用其他模型时记录实际提供服务的模型', async () => {
    const { fetch } = fakeFetch([{ chunks: anthropicChunks('m', { ...done, servedModel: 'fallback-model' }) }]);
    const result = await new AnthropicAdapter({ apiKey: 'k', fetch, maxRetries: 0 }).complete(request(full));
    expect(result.ok && result.value).toMatchObject({ fallbackUsed: true, servedModel: 'fallback-model' });
  });
});

describe('OpenAIChatAdapter 请求参数', () => {
  const send = async (capabilities: ModelCapabilities) => {
    const { fetch, requests } = fakeFetch([{ chunks: openaiChunks('m', done) }]);
    await new OpenAIChatAdapter({ baseURL: 'http://127.0.0.1:11434/v1', fetch, maxRetries: 0 }).complete(
      request(capabilities),
    );
    return requests[0]!;
  };

  it('按能力描述传递 response_format 与推理深度，请求用量', async () => {
    const sent = await send(full);
    expect(sent.url).toBe('http://127.0.0.1:11434/v1/chat/completions');
    expect(sent.body).toEqual({
      model: 'm',
      max_completion_tokens: 4_000,
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: 'system', content: '通用规则与输出格式\n\n场景规则与角色卡\n\n本回合' },
        { role: 'user', content: '请裁决' },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'ruling', schema: { type: 'object', properties: {} }, strict: true },
      },
      reasoning_effort: 'high',
    });
  });

  it('提示词约束的模型不发送 response_format，也不传推理深度', async () => {
    const sent = await send(CONSERVATIVE_CAPABILITIES);
    expect(sent.body).not.toHaveProperty('response_format');
    expect(sent.body).not.toHaveProperty('reasoning_effort');
  });

  it('服务未返回用量时用量为 null', async () => {
    const { fetch } = fakeFetch([{ chunks: openaiChunks('m', done, { omitUsage: true }) }]);
    const result = await new OpenAIChatAdapter({ baseURL: 'http://127.0.0.1:11434/v1', fetch, maxRetries: 0 }).complete(
      request(CONSERVATIVE_CAPABILITIES),
    );
    expect(result.ok && result.value).toMatchObject({ outcome: 'completed', usage: null });
  });

  it('内容过滤视为拒答', async () => {
    const chunks = openaiChunks('m', done).map((c) => c.replace('"finish_reason":"stop"', '"finish_reason":"content_filter"'));
    const { fetch } = fakeFetch([{ chunks }]);
    const result = await new OpenAIChatAdapter({ baseURL: 'http://127.0.0.1:11434/v1', fetch, maxRetries: 0 }).complete(
      request(full),
    );
    expect(result.ok && result.value).toMatchObject({ outcome: 'refused', refusal: { category: null } });
  });
});
