// 测试辅助：给已打开的作品配一个服务与默认模型，并让它通过能力自检（结构化任务需要）。不联网，响应由 fsDeps 的队列提供。
import { openaiChunks } from '@fudiao/llm/testing';
import { SELF_TEST_EXPECTED } from '@fudiao/prompts';
import type { AppService } from '../app/service';
import type { TestDeps } from './fs-deps';

/** 一次模型回复：OpenAI 兼容服务的流式片段。 */
export const reply = (text: string, usage = { input: 1_000, output: 500, cacheRead: 0 }) => ({ chunks: openaiChunks('m', { text: [text], end: 'stop' as const, usage }) });

/**
 * 配一个通过自检的默认模型。没有登记能力的模型最大输出按保守的 4,096 计（推演的测试依赖它）；
 * 要走一键成书这类一步要写几万 Token 的流程时，用 maxOutputTokens 登记更大的最大输出。
 */
export async function addTestedModel(app: AppService, deps: TestDeps, options: { readonly maxOutputTokens?: number } = {}): Promise<void> {
  const providers = await app.saveProvider(null, { kind: 'openai_compatible', name: 'S', baseUrl: 'https://s.example.test/v1', authMethod: 'api_key', apiKey: 'sk-s' });
  if (!providers.ok) throw new Error(JSON.stringify(providers.error));
  const models = await app.addModel(providers.value.providers[0]?.id ?? '', 'm');
  if (!models.ok) throw new Error(JSON.stringify(models.error));
  const model = models.value.models[0];
  if (model === undefined) throw new Error('没有模型');
  for (let i = 0; i < 3; i++) deps.llmResponses.push(reply(JSON.stringify(SELF_TEST_EXPECTED)));
  const tested = await app.runSelfTest(model.id);
  if (!tested.ok || !tested.value.report.passed) throw new Error('能力自检没有通过');
  if (options.maxOutputTokens !== undefined) {
    const current = tested.value.view.models.find((m) => m.id === model.id);
    if (current === undefined) throw new Error('没有模型');
    const updated = await app.updateModel(current, { displayName: current.displayName, capabilities: { ...current.capabilities, maxOutputTokens: options.maxOutputTokens }, prices: current.prices });
    if (!updated.ok) throw new Error(JSON.stringify(updated.error));
  }
}
