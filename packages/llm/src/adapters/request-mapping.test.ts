import { describe, expect, it } from 'vitest';
import { anthropicChunks, fakeFetch, openaiChunks, responsesChunks, type Scenario } from '../testing/fake-fetch';
import { CONSERVATIVE_CAPABILITIES, type LlmRequest, type ModelCapabilities } from '../types';
import { AnthropicAdapter } from './anthropic';
import { COMPATIBLE_DIALECT, OPENAI_DIALECT, OpenAIChatAdapter } from './openai-chat';
import { OpenAIAdapter } from './openai-responses';

const full: ModelCapabilities = {
  structuredOutput: 'native',
  promptCaching: true,
  reasoningControl: 'effort',
  refusalFallback: 'server_default',
  contextWindow: 1_000_000,
  maxOutputTokens: 128_000,
  selfTestPassed: true,
  webSearch: true,
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

describe('OpenAI 兼容接口的差异', () => {
  const adapter = (fetch: typeof globalThis.fetch, dialect = COMPATIBLE_DIALECT) =>
    new OpenAIChatAdapter({ baseURL: 'https://api.example.com/v1', apiKey: 'k', fetch, maxRetries: 0, dialect });
  const send = async (capabilities: ModelCapabilities, dialect = COMPATIBLE_DIALECT, effort: LlmRequest['effort'] = 'high') => {
    const { fetch, requests } = fakeFetch([{ chunks: openaiChunks('m', done) }]);
    await adapter(fetch, dialect).complete({ ...request(capabilities), effort });
    return requests[0]!.body as Record<string, unknown>;
  };

  it('兼容接口用 max_tokens；只支持 JSON 模式的服务发送 json_object', async () => {
    const body = await send({ ...full, structuredOutput: 'json_object' });
    expect(body['max_tokens']).toBe(4_000);
    expect(body).not.toHaveProperty('max_completion_tokens');
    expect(body['response_format']).toEqual({ type: 'json_object' });
  });

  it('不支持 stream_options 的接口不请求用量', async () => {
    const body = await send(full, { ...COMPATIBLE_DIALECT, streamUsage: false });
    expect(body).not.toHaveProperty('stream_options');
  });

  it('推理深度高于 high 时按 high 发送', async () => {
    expect((await send(full, OPENAI_DIALECT, 'max'))['reasoning_effort']).toBe('high');
    expect((await send(full, OPENAI_DIALECT, 'low'))['reasoning_effort']).toBe('low');
  });

  it('去掉正文开头的思考，增量中也不出现', async () => {
    const scenario: Scenario = { text: ['<think>', '先想想谁在说谎', '</think>\n', '{"kind":', '"wait"}'], end: 'stop' };
    const { fetch } = fakeFetch([{ chunks: openaiChunks('m', scenario) }]);
    const deltas: string[] = [];
    const result = await adapter(fetch).complete(request(full), { onEvent: (e) => e.type === 'text' && deltas.push(e.delta) });
    expect(result.ok && result.value.text).toBe('{"kind":"wait"}');
    expect(deltas.join('')).toBe('{"kind":"wait"}');
  });

  it('OpenAI 官方接口不处理思考标签', async () => {
    const { fetch } = fakeFetch([{ chunks: openaiChunks('m', { text: ['<think>x</think>y'], end: 'stop' }) }]);
    const result = await adapter(fetch, OPENAI_DIALECT).complete(request(full));
    expect(result.ok && result.value.text).toBe('<think>x</think>y');
  });
});

describe('OpenAIAdapter（Responses API）请求参数', () => {
  const send = async (capabilities: ModelCapabilities, effort: LlmRequest['effort'] = 'high') => {
    const { fetch, requests } = fakeFetch([{ chunks: responsesChunks('m', done) }]);
    await new OpenAIAdapter({ apiKey: 'k', fetch, maxRetries: 0 }).complete({ ...request(capabilities), ...(effort !== undefined && { effort }) });
    return requests[0]!;
  };

  it('系统提示合为 instructions，按能力描述传递 json_schema 与推理深度，不在服务端保存', async () => {
    const sent = await send(full);
    expect(sent.url).toBe('https://api.openai.com/v1/responses');
    expect(sent.body).toEqual({
      model: 'm',
      stream: true,
      store: false,
      max_output_tokens: 4_000,
      instructions: '通用规则与输出格式\n\n场景规则与角色卡\n\n本回合',
      input: [{ role: 'user', content: '请裁决' }],
      text: { format: { type: 'json_schema', name: 'ruling', schema: { type: 'object', properties: {} }, strict: true } },
      reasoning: { effort: 'high' },
    });
  });

  it('保守能力下不发送输出格式与推理深度；高于 high 的深度按 high 发送', async () => {
    const plain = await send(CONSERVATIVE_CAPABILITIES);
    expect(plain.body).not.toHaveProperty('text');
    expect(plain.body).not.toHaveProperty('reasoning');
    expect((await send(full, 'max')).body).toMatchObject({ reasoning: { effort: 'high' } });
    expect((await send({ ...full, structuredOutput: 'json_object' })).body).toMatchObject({ text: { format: { type: 'json_object' } } });
  });

  it('用量扣除缓存命中；服务端失败事件转为错误', async () => {
    const { fetch } = fakeFetch([{ chunks: responsesChunks('m', { text: ['{}'], end: 'stop', usage: { input: 70, output: 5, cacheRead: 30 } }) }]);
    const result = await new OpenAIAdapter({ apiKey: 'k', fetch, maxRetries: 0 }).complete(request(full));
    expect(result.ok && result.value.usage).toEqual({ inputTokens: 70, outputTokens: 5, cacheReadTokens: 30, cacheWriteTokens: 0 });

    const failed = `event: response.failed\ndata: ${JSON.stringify({ type: 'response.failed', response: { id: 'r', status: 'failed', error: { code: 'server_error', message: '服务出错' } } })}\n\n`;
    const { fetch: failing } = fakeFetch([{ chunks: [failed] }]);
    const bad = await new OpenAIAdapter({ apiKey: 'k', fetch: failing, maxRetries: 0 }).complete(request(full));
    // 服务已经开始回复，失败的这次可能已计费。
    expect(bad).toEqual({ ok: false, error: { code: 'server', message: '服务出错', partial: { usage: null } } });
  });
});

