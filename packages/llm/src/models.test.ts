import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AnthropicAdapter } from './adapters/anthropic';
import { OpenAIChatAdapter } from './adapters/openai-chat';
import { OpenAIAdapter } from './adapters/openai-responses';
import { isModelLister, runSelfTest, SELF_TEST_RUNS } from './models';
import { anthropicChunks, errorBody, fakeFetch, openaiChunks } from './testing/fake-fetch';
import { CONSERVATIVE_CAPABILITIES, type ModelProfile } from './types';

const support = (supported: boolean) => ({ supported });
const anthropicModel = (id: string, structured: boolean, effort: boolean) => ({
  type: 'model',
  id,
  display_name: `显示名 ${id}`,
  created_at: '2026-01-01T00:00:00Z',
  max_input_tokens: 200_000,
  max_tokens: 64_000,
  capabilities: {
    batch: support(true),
    citations: support(true),
    code_execution: support(false),
    context_management: { supported: false },
    effort: { supported: effort, low: support(effort), medium: support(effort), high: support(effort), max: support(false), xhigh: null },
    image_input: support(true),
    pdf_input: support(true),
    structured_outputs: support(structured),
    thinking: { supported: true, types: {} },
  },
});

describe('模型列表', () => {
  it('Anthropic：采用服务返回的能力与上下文长度', async () => {
    const { fetch, requests } = fakeFetch([
      { body: JSON.stringify({ data: [anthropicModel('b-model', false, false), anthropicModel('a-model', true, true)], has_more: false, first_id: 'b-model', last_id: 'a-model' }) },
    ]);
    const adapter = new AnthropicAdapter({ apiKey: 'k', fetch, maxRetries: 0 });
    expect(isModelLister(adapter)).toBe(true);
    const listed = await adapter.listModels();
    expect(listed).toEqual({
      ok: true,
      value: [
        {
          id: 'a-model',
          displayName: '显示名 a-model',
          capabilities: { structuredOutput: 'native', reasoningControl: 'effort', contextWindow: 200_000, maxOutputTokens: 64_000 },
        },
        {
          id: 'b-model',
          displayName: '显示名 b-model',
          capabilities: { structuredOutput: 'prompt', reasoningControl: 'none', contextWindow: 200_000, maxOutputTokens: 64_000 },
        },
      ],
    });
    expect(requests[0]?.url).toMatch(/\/v1\/models\?limit=100$/);
  });

  it('OpenAI 写法的接口：只有模型标识；去重并排序', async () => {
    const body = JSON.stringify({ object: 'list', data: ['z-model', 'a-model', 'a-model'].map((id) => ({ id, object: 'model', created: 0, owned_by: 'x' })) });
    for (const adapter of [
      new OpenAIAdapter({ apiKey: 'k', fetch: fakeFetch([{ body }]).fetch, maxRetries: 0 }),
      new OpenAIChatAdapter({ baseURL: 'http://127.0.0.1:11434/v1', fetch: fakeFetch([{ body }]).fetch, maxRetries: 0 }),
    ]) {
      expect(await adapter.listModels()).toEqual({
        ok: true,
        value: [
          { id: 'a-model', displayName: null, capabilities: {} },
          { id: 'z-model', displayName: null, capabilities: {} },
        ],
      });
    }
  });

  it('获取失败时给出统一的错误', async () => {
    const adapter = new OpenAIAdapter({ apiKey: 'k', fetch: fakeFetch([{ status: 401, body: errorBody(401) }]).fetch, maxRetries: 0 });
    expect(await adapter.listModels()).toMatchObject({ ok: false, error: { code: 'auth', status: 401 } });
  });
});

describe('能力自检', () => {
  const schema = z.object({ name: z.string(), mood: z.enum(['calm', 'angry']), items: z.array(z.string()) });
  const expected = { name: '沈砚', mood: 'calm', items: ['旧伞'] };
  const check = (v: z.infer<typeof schema>) => (JSON.stringify(v) === JSON.stringify(expected) ? null : '内容与要求不符');
  const prompt = {
    template: { id: 'self_test', version: '1' },
    system: [{ text: '自检' }],
    messages: [{ role: 'user' as const, content: '按要求输出' }],
    output: { name: 'SelfTest', schema: { type: 'object' } },
  };
  const model: ModelProfile = { provider: 'p', model: 'm', capabilities: CONSERVATIVE_CAPABILITIES };
  const reply = (text: string) => ({ chunks: openaiChunks('m', { text: [text], end: 'stop' as const }) });
  const adapter = (replies: ReturnType<typeof reply>[]) =>
    new OpenAIChatAdapter({ baseURL: 'http://127.0.0.1:11434/v1', fetch: fakeFetch(replies).fetch, maxRetries: 0 });

  it(`连续 ${SELF_TEST_RUNS} 次输出合格且内容正确才通过；代码块包裹等常见格式问题由管线修复`, async () => {
    const good = JSON.stringify(expected);
    const report = await runSelfTest(adapter([reply(good), reply('```json\n' + good + '\n```'), reply(good)]), model, prompt, schema, check);
    expect(report).toEqual({ passed: true, runs: [null, null, null], reason: null });
  });

  it('任一次不合格即停止并给出原因：格式、内容、调用失败', async () => {
    const good = JSON.stringify(expected);
    expect(await runSelfTest(adapter([reply(good), reply('{"name":"沈砚","mood":"happy","items":[]}')]), model, prompt, schema, check)).toMatchObject({
      passed: false,
      runs: [null, expect.stringContaining('输出不符合格式')],
      reason: expect.stringMatching(/^第 2 次：输出不符合格式：mood/),
    });
    expect(await runSelfTest(adapter([reply(JSON.stringify({ ...expected, items: [] }))]), model, prompt, schema, check)).toMatchObject({
      passed: false,
      reason: '第 1 次：内容与要求不符',
    });
    const failing = new AnthropicAdapter({ apiKey: 'k', fetch: fakeFetch([{ status: 429, body: errorBody(429) }]).fetch, maxRetries: 0 });
    expect((await runSelfTest(failing, model, prompt, schema, check)).reason).toMatch(/^第 1 次：调用失败（rate_limited）/);
    const truncated = new AnthropicAdapter({ apiKey: 'k', fetch: fakeFetch([{ chunks: anthropicChunks('m', { text: ['{"na'], end: 'length' }) }]).fetch, maxRetries: 0 });
    expect((await runSelfTest(truncated, model, prompt, schema, check)).reason).toBe('第 1 次：输出被截断（思考或回答用完了输出上限）');
  });

  it('按调用方给的输出上限与思考深度发请求（思考计入输出的服务要留出余量）；不给时上限为 1,024', async () => {
    const good = JSON.stringify(expected);
    const thinking: ModelProfile = { provider: 'p', model: 'm', capabilities: { ...CONSERVATIVE_CAPABILITIES, reasoningControl: 'effort', maxOutputTokens: 384_000 } };
    const withBudget = fakeFetch([reply(good), reply(good), reply(good)]);
    const port = new OpenAIChatAdapter({ baseURL: 'http://127.0.0.1:11434/v1', fetch: withBudget.fetch, maxRetries: 0 });
    expect((await runSelfTest(port, thinking, prompt, schema, check, {}, { maxOutputTokens: 33_024, effort: 'low' })).passed).toBe(true);
    // 请求体里的输出上限：OpenAI 官方的写法是 max_completion_tokens，兼容接口是 max_tokens。
    const sent = (body: unknown) => {
      const b = (body ?? {}) as Record<string, unknown>;
      return [b['max_completion_tokens'] ?? b['max_tokens'], b['reasoning_effort']];
    };
    expect(withBudget.requests.map((r) => sent(r.body))).toEqual([
      [33_024, 'low'],
      [33_024, 'low'],
      [33_024, 'low'],
    ]);
    const plain = fakeFetch([reply(good), reply(good), reply(good)]);
    await runSelfTest(new OpenAIChatAdapter({ baseURL: 'http://127.0.0.1:11434/v1', fetch: plain.fetch, maxRetries: 0 }), thinking, prompt, schema, check);
    expect(sent(plain.requests[0]?.body)[0]).toBe(1_024);
  });
});
