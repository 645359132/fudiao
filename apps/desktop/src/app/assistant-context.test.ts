import { rmSync } from 'node:fs';
import { SELF_TEST_EXPECTED, type AssistantTurnOutput } from '@fudiao/prompts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fsDeps, type TestDeps } from '../testing/fs-deps';
import { addTestedModel, reply } from '../testing/models';
import { createAppService } from './service';

// 每个用例要建好几部 150 章、250 项设定的作品，比默认的 5 秒久。
vi.setConfig({ testTimeout: 60_000 });

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

/** 不报用量的回复：每字的 Token 数保持起初的估计，测试的结果不随回复变化。 */
const said = (output: AssistantTurnOutput) => reply(JSON.stringify(output), { input: 0, output: 10, cacheRead: 0 });
const lastBody = (deps: TestDeps) => JSON.stringify(deps.llmRequests.at(-1)?.body ?? {});

/** 一部大作品：150 章、250 项设定；之前聊过 6 轮，每轮作者说了很长一段。 */
async function bigWork() {
  const deps = fsDeps();
  all.push(deps);
  const app = createAppService(deps);
  value(await app.loadLibrary());
  value(await app.createWork('长河'));
  await addTestedModel(app, deps);
  for (let i = 1; i <= 150; i++) value(await app.createChapter(`第${i}章 河上的第${i}个夜晚`));
  for (let i = 1; i <= 250; i++) value(await app.createEntity('character', `人物${i}号`));
  for (let i = 1; i <= 6; i++) {
    deps.llmResponses.push(said({ message: `记下了第${i}段。`, actions: [], done: true }));
    value(await app.sendToAssistant(`【第${i}段设想】${'河水向东流，船上的人各有心事。'.repeat(300)}`));
  }
  return { deps, app };
}

type Big = Awaited<ReturnType<typeof bigWork>>;

async function setWindow({ app, deps }: Big, contextWindow: number, structuredOutput?: 'native' | 'prompt') {
  const model = value(await app.loadModelServices()).models[0]!;
  const output = structuredOutput ?? model.capabilities.structuredOutput;
  value(await app.updateModel(model, { displayName: model.displayName, capabilities: { ...model.capabilities, contextWindow, maxOutputTokens: 8_000, structuredOutput: output, limitsKnown: { contextWindow: true, maxOutputTokens: true } }, prices: model.prices }));
  // 改了结构化输出方式须重新自检。
  if (output !== model.capabilities.structuredOutput) {
    // 自检先探测最大输出：服务照单全收，什么也学不到，登记的 8,000 保持原样。
    deps.llmResponses.push(reply('OK'));
    for (let i = 0; i < 3; i++) deps.llmResponses.push(reply(JSON.stringify(SELF_TEST_EXPECTED)));
    if (!value(await app.runSelfTest(model.id)).report.passed) throw new Error('能力自检没有通过');
  }
}

type Body = { messages: { content: string }[]; response_format?: { json_schema?: { schema: unknown } } };
const lastRequest = (deps: TestDeps) => deps.llmRequests.at(-1)?.body as Body;
const textChars = (body: Body) => body.messages.reduce((n, m) => n + m.content.length, 0);
const TRIMMED = '超出了模型一次能读的量';

describe('AI 助手的请求按模型的上下文上限缩减（M5-21）', () => {
  it('上下文够大时带上全部近期对话与 120 章、200 项设定；不写缩减的说明', async () => {
    const big = await bigWork();
    const { deps, app } = big;
    await setWindow(big, 1_000_000);
    deps.llmResponses.push(said({ message: '好的。', actions: [], done: true }));
    value(await app.sendToAssistant('现在写到哪了？'));
    const body = lastBody(deps);
    expect(body).toContain('【第1段设想】');
    expect(body).toContain('只列出前后部分');
    expect(body).toContain('第1章 河上的第1个夜晚');
    expect(body).toContain('设定（共 250 项，只列出前面的部分');
    expect(body).not.toContain('超出了模型一次能读的量');
  });

  it('上下文小时依次换更少的一级：较早的对话略去，章节、设定与关系少列，现状里写明缩减过；这一轮的话照样带上', async () => {
    const big = await bigWork();
    const { deps, app } = big;
    await setWindow(big, 40_000);
    deps.llmResponses.push(said({ message: '好的。', actions: [], done: true }));
    value(await app.sendToAssistant('现在写到哪了？'));
    const body = lastBody(deps);
    expect(body).toContain('超出了模型一次能读的量');
    expect(body).not.toContain('【第1段设想】');
    expect(body).toContain('现在写到哪了？');
    expect(body).toContain('章节（共 150 章');
    // 列出的章节与设定比第一级少。
    const listed = (body.match(/河上的第\d+个夜晚/g) ?? []).length;
    expect(listed).toBeLessThan(120);
    expect(listed).toBeGreaterThan(0);
    expect((body.match(/人物\d+号/g) ?? []).length).toBeLessThan(200);
    // 请求按估算放得进上下文（起初按每字 1.3 个 Token 估）。
    const request = deps.llmRequests.at(-1)?.body as { messages: { content: string }[]; max_tokens?: number; max_completion_tokens?: number };
    const chars = request.messages.reduce((n, m) => n + m.content.length, 0);
    expect(chars * 1.3).toBeLessThan(40_000 * 0.95 - 8_000);
  });

  it('原生结构化输出时输出结构也算进请求：同样的上下文上限，原生方式要缩减、提示词方式不用', async () => {
    // 先在很大的上限下量出第一级的字数与输出结构的大小（每部作品的内容与字数相同）。
    const probe = await bigWork();
    await setWindow(probe, 1_000_000, 'native');
    probe.deps.llmResponses.push(said({ message: '好的。', actions: [], done: true }));
    value(await probe.app.sendToAssistant('现在写到哪了？'));
    const first = lastRequest(probe.deps);
    const schema = JSON.stringify(first.response_format?.json_schema?.schema ?? null).length;
    expect(schema).toBeGreaterThan(5_000);
    // 只算正文时放得下、加上输出结构（按每字 0.5 估）时放不下的上限：留出输出上限 8,000 与修正余量 2,000。
    const window = Math.ceil((textChars(first) * 1.3 + 10_000 + schema * 0.25) / 0.95);

    for (const [mode, trimmed] of [['native', true], ['prompt', false]] as const) {
      const big = await bigWork();
      await setWindow(big, window, mode);
      big.deps.llmResponses.push(said({ message: '好的。', actions: [], done: true }));
      value(await big.app.sendToAssistant('现在写到哪了？'));
      expect(JSON.stringify(lastRequest(big.deps)).includes(TRIMMED), mode).toBe(trimmed);
    }
  });

  it('缩减时作品大纲只给开头与结尾，get_work 给出全文', async () => {
    const big = await bigWork();
    const { deps, app } = big;
    const outline = `【大纲开头】${'甲'.repeat(6_000)}【大纲中段】${'乙'.repeat(6_000)}【大纲结尾】`;
    value(await app.updateWorkInfo({ outline }));
    await setWindow(big, 40_000);
    deps.llmResponses.push(said({ message: '先看看大纲。', actions: [{ tool: 'get_work' }], done: false }));
    deps.llmResponses.push(said({ message: '看完了。', actions: [], done: true }));
    value(await app.sendToAssistant('大纲中段写了什么？'));
    const asked = JSON.stringify(deps.llmRequests.at(-2)?.body ?? {});
    expect(asked).toContain(TRIMMED);
    expect(asked).toContain('get_work');
    expect(asked).toContain('【大纲开头】');
    expect(asked).toContain('【大纲结尾】');
    expect(asked).not.toContain('【大纲中段】');
    // 这一轮最新的动作结果照原样给出：大纲全文都在。
    expect(lastBody(deps)).toContain('【大纲中段】');
  });
});
