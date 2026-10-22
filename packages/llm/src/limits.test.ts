import { describe, expect, it } from 'vitest';
import { OpenAIChatAdapter } from './adapters/openai-chat';
import { parseLimitError, probeMaxOutput, PROBE_MAX_OUTPUT_TOKENS } from './limits';
import { errorBody, fakeFetch, openaiChunks } from './testing/fake-fetch';
import { CONSERVATIVE_CAPABILITIES, type ModelProfile } from './types';

describe('从服务的超限报错里学到上限（B56）', () => {
  it('认得几家公开文档里的最大输出写法', () => {
    expect(parseLimitError('400 max_tokens is too large: 1000000. This model supports at most 32768 completion tokens, whereas you provided 1000000.')).toEqual({ maxOutputTokens: 32_768 });
    expect(parseLimitError('max_output_tokens is too large: 1000000. This model supports at most 128,000 output tokens.')).toEqual({ maxOutputTokens: 128_000 });
    expect(parseLimitError("Invalid 'max_tokens': integer above maximum value. Expected a value <= 4096, but got 8192 instead.")).toEqual({ maxOutputTokens: 4_096 });
    expect(parseLimitError("Invalid 'max_completion_tokens': integer above maximum value. Expected a value <= 16384, but got 40000 instead.")).toEqual({ maxOutputTokens: 16_384 });
    expect(parseLimitError('max_tokens: 1000000 > 128000, which is the maximum allowed number of output tokens for claude-sonnet-5-5')).toEqual({ maxOutputTokens: 128_000 });
    expect(parseLimitError('Invalid max_tokens value, the valid range of max_tokens is [1, 8192]')).toEqual({ maxOutputTokens: 8_192 });
  });

  it('认得上下文超限的写法；两种都写明时都学到', () => {
    expect(parseLimitError("This model's maximum context length is 128000 tokens. However, you requested 130000 tokens (120000 in the messages, 10000 in the completion).")).toEqual({ contextWindow: 128_000 });
    expect(parseLimitError('prompt is too long: 213,000 tokens > 200,000 maximum')).toEqual({ contextWindow: 200_000 });
    expect(parseLimitError('input length and `max_tokens` exceed context limit: 190000 + 20000 > 200000')).toEqual({ contextWindow: 200_000 });
    expect(parseLimitError('max_tokens: 500000 > 64000, which is the maximum allowed number of output tokens; prompt is too long: 300000 tokens > 200000 maximum')).toEqual({
      maxOutputTokens: 64_000,
      contextWindow: 200_000,
    });
  });

  it('对不上的报错与不成数的数字返回 null', () => {
    expect(parseLimitError('Incorrect API key provided')).toBeNull();
    expect(parseLimitError('')).toBeNull();
    expect(parseLimitError('valid range of max_tokens is [1, 0]')).toBeNull();
  });

  const profile: ModelProfile = { provider: 'p', model: 'm', capabilities: CONSERVATIVE_CAPABILITIES };
  const prompt = { template: { id: 'connection_test', version: '1' }, system: [{ text: '只回答 OK' }], messages: [{ role: 'user' as const, content: 'OK？' }] };

  it('探测：故意超限的请求被拒绝时，从报错里学到最大输出', async () => {
    const { fetch, requests } = fakeFetch([
      { status: 400, body: JSON.stringify({ error: { message: 'max_tokens is too large: 1000000. This model supports at most 65536 completion tokens, whereas you provided 1000000.', type: 'invalid_request_error' } }) },
    ]);
    const adapter = new OpenAIChatAdapter({ baseURL: 'https://relay.example.test/v1', apiKey: 'k', fetch, maxRetries: 0 });
    expect(await probeMaxOutput(adapter, profile, prompt)).toBe(65_536);
    const body = requests[0]?.body as { max_tokens?: number; max_completion_tokens?: number };
    expect(body.max_tokens ?? body.max_completion_tokens).toBe(PROBE_MAX_OUTPUT_TOKENS);
  });

  it('探测：服务照单全收或报别的错时学不到，返回 null', async () => {
    const accepted = new OpenAIChatAdapter({
      baseURL: 'https://relay.example.test/v1',
      apiKey: 'k',
      fetch: fakeFetch([{ chunks: openaiChunks('m', { text: ['OK'], end: 'stop', usage: { input: 10, output: 1, cacheRead: 0 } }) }]).fetch,
      maxRetries: 0,
    });
    expect(await probeMaxOutput(accepted, profile, prompt)).toBeNull();
    const denied = new OpenAIChatAdapter({ baseURL: 'https://relay.example.test/v1', apiKey: 'k', fetch: fakeFetch([{ status: 401, body: errorBody(401) }]).fetch, maxRetries: 0 });
    expect(await probeMaxOutput(denied, profile, prompt)).toBeNull();
  });
});
