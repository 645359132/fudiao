import { rmSync } from 'node:fs';
import { openaiChunks } from '@fudiao/llm/testing';
import { renderConnectionTest, renderSelfTest, SELF_TEST_EXPECTED, SelfTestOutput, type RenderedPrompt } from '@fudiao/prompts';
import { afterEach, describe, expect, it } from 'vitest';
import type { RetryPolicy } from '@fudiao/llm';
import { fsDeps, type TestDeps } from '../testing/fs-deps';
import { createAppService } from './service';

const all: TestDeps[] = [];
afterEach(async () => {
  for (const d of all.splice(0)) {
    await d.dispose();
    rmSync(d.root, { recursive: true, force: true });
  }
});

function value<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

const prompt = (r: { ok: true; value: RenderedPrompt } | { ok: false; error: string }): RenderedPrompt => value(r);
const reply = (text: string, usage = { input: 1_000_000, output: 500_000, cacheRead: 0 }) => ({ chunks: openaiChunks('m', { text: [text], end: 'stop' as const, usage }) });

/** 打开一部作品，配置一个服务与默认模型。 */
async function setup(options: { prices?: boolean; selfTested?: boolean; retry?: RetryPolicy } = {}) {
  const deps = fsDeps(undefined, options.retry === undefined ? {} : { retry: options.retry });
  all.push(deps);
  const app = createAppService(deps);
  value(await app.loadLibrary());
  value(await app.createWork('雨夜'));
  const [p] = value(await app.saveProvider(null, { kind: 'openai_compatible', name: 'S', baseUrl: 'https://s.example.test/v1', authMethod: 'api_key', apiKey: 'sk-s' })).providers;
  const [m] = value(await app.addModel(p?.id ?? '', 'm')).models;
  if (m === undefined) throw new Error('样本');
  if (options.prices === true) value(await app.updateModel(m, { displayName: 'm', capabilities: m.capabilities, prices: { input: 2, output: 8 } }));
  if (options.selfTested === true) {
    for (let i = 0; i < 3; i++) deps.llmResponses.push(reply(JSON.stringify(SELF_TEST_EXPECTED)));
    expect(value(await app.runSelfTest(m.id)).report.passed).toBe(true);
  }
  return { deps, app };
}

describe('模型调用', () => {
  it('没有默认模型时说明原因', async () => {
    const deps = fsDeps();
    all.push(deps);
    const app = createAppService(deps);
    value(await app.loadLibrary());
    expect(await app.runner.text({ prompt: prompt(renderConnectionTest()), maxOutputTokens: 64 })).toEqual({
      ok: false,
      error: { code: 'settings', detail: '还没有设置默认模型：请在“模型服务”中添加服务与模型' },
    });
  });

  it('每次调用都写入作品库的调用记录：模板版本、用量与费用（价格未配置时为未知）', async () => {
    const { deps, app } = await setup();
    deps.llmResponses.push(reply('好'));
    const result = value(await app.runner.text({ prompt: prompt(renderConnectionTest()), maxOutputTokens: 64 }));
    expect(result.text).toBe('好');
    const { summary, recent } = value(await app.usage());
    expect(recent).toEqual([
      expect.objectContaining({
        stepKey: null,
        taskKind: 'connection_test',
        model: 'm',
        servedModel: 'm',
        templateId: 'connection_test',
        templateVersion: '1',
        status: 'completed',
        params: { maxOutputTokens: 64 },
        usage: { input: 1_000_000, output: 500_000, cacheRead: 0, cacheWrite: 0 },
        cost: null,
      }),
    ]);
    expect(summary.total).toMatchObject({ calls: 1, unknownCost: 1, cost: 0 });
  });

  it('读回复读到一半连接断了：整次重新请求，两次尝试各记一条调用记录，结果用重新请求的', async () => {
    const { deps, app } = await setup({ retry: { delaysMs: [3_000], sleep: () => Promise.resolve(true) } });
    deps.llmRequests.length = 0;
    deps.llmResponses.push({ chunks: openaiChunks('m', { text: ['写了一半'], end: 'stop' }).slice(0, 1), breakAfterChunks: true }, reply('雨下得更紧了。'));
    const deltas: string[] = [];
    let retried = 0;
    const result = value(
      await app.runner.text(
        { prompt: prompt(renderConnectionTest()), maxOutputTokens: 64 },
        { onEvent: (e) => (e.type === 'text' ? deltas.push(e.delta) : e.type === 'retry' ? retried++ : undefined) },
      ),
    );
    expect(result.text).toBe('雨下得更紧了。');
    expect(retried).toBe(1);
    expect(deps.llmRequests).toHaveLength(2);
    const calls = value(await app.usage()).recent;
    expect(calls.map((c) => c.status)).toEqual(['completed', 'error']);
  });

  it('配置了价格时记录费用', async () => {
    const { deps, app } = await setup({ prices: true });
    deps.llmResponses.push(reply('好'));
    value(await app.runner.text({ prompt: prompt(renderConnectionTest()), maxOutputTokens: 64 }));
    // 100 万输入 × 2 美元 + 50 万输出 × 8 美元。
    expect(value(await app.usage()).summary.total).toMatchObject({ cost: 6, unknownCost: 0 });
  });

  it('结构化任务只能用通过能力自检的模型', async () => {
    const { app } = await setup();
    expect(await app.runner.structured({ prompt: prompt(renderSelfTest()), maxOutputTokens: 1_000 }, SelfTestOutput)).toMatchObject({
      ok: false,
      error: { code: 'settings', detail: expect.stringContaining('没有通过能力自检') },
    });
  });

  it('结构化输出不合格时带着错误请求修正，修正调用同样记录；连续不合格时暂停并说明原因', async () => {
    const { deps, app } = await setup({ selfTested: true });
    deps.llmResponses.push(reply('{"scene":"雨夜当铺"}'), reply(JSON.stringify(SELF_TEST_EXPECTED)));
    const fixed = value(await app.runner.structured({ prompt: prompt(renderSelfTest()), maxOutputTokens: 1_000 }, SelfTestOutput));
    expect(fixed.value).toEqual(SELF_TEST_EXPECTED);
    expect(fixed.attempts).toHaveLength(2);
    expect(JSON.stringify(deps.llmRequests.at(-1)?.body)).toContain('characters');

    for (let i = 0; i < 3; i++) deps.llmResponses.push(reply('不是 JSON'));
    const paused = await app.runner.structured({ prompt: prompt(renderSelfTest()), maxOutputTokens: 1_000 }, SelfTestOutput);
    expect(paused).toMatchObject({ ok: false, error: { code: 'settings', detail: expect.stringMatching(/^“m”的输出连续 3 次不符合格式，任务已暂停/) } });
    // 自检的 3 次（未打开作品前不记录）+ 修正前后 2 次 + 连续失败 3 次。
    expect(value(await app.usage()).summary.total.calls).toBe(5);
  });

  it('带步骤键的调用已完成时直接复用，不再调用、不重复计费', async () => {
    const { deps, app } = await setup();
    deps.llmResponses.push(reply('第一次'), reply('第二次'));
    const request = { prompt: prompt(renderConnectionTest()), maxOutputTokens: 64, stepKey: 'run1:1:test:0' };
    expect(value(await app.runner.text(request)).text).toBe('第一次');
    expect(value(await app.runner.text(request)).text).toBe('第一次');
    expect(deps.llmRequests).toHaveLength(1);
    expect(value(await app.usage()).summary.total.calls).toBe(1);
  });
});
