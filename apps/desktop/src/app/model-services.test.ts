import { rmSync } from 'node:fs';
import { PLACEHOLDER_API_KEY } from '@fudiao/llm';
import { anthropicChunks, errorBody, openaiChunks, responsesChunks } from '@fudiao/llm/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { fsDeps, type TestDeps } from '../testing/fs-deps';
import { SELF_TEST_EXPECTED } from '@fudiao/prompts';
import { resolveModel } from './model-services';
import { deepseekAlias } from './builtin-models';
import { createAppService } from './service';

const all: TestDeps[] = [];
afterEach(async () => {
  for (const d of all.splice(0)) {
    await d.dispose();
    rmSync(d.root, { recursive: true, force: true });
  }
});

function setup() {
  const deps = fsDeps();
  all.push(deps);
  return { deps, app: createAppService(deps) };
}

function value<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

const SECRET = 'sk-ant-real-secret';
const anthropic = { kind: 'anthropic' as const, name: 'Anthropic', baseUrl: 'https://api.anthropic.com', authMethod: 'api_key' as const };

describe('模型服务', () => {
  it('添加服务：API Key 只写入凭据管理器，界面拿到的只有是否已保存与绑定的地址', async () => {
    const { deps, app } = setup();
    const view = value(await app.saveProvider(null, { ...anthropic, apiKey: ` ${SECRET} ` }));
    expect(view.providers).toHaveLength(1);
    expect(view.providers[0]?.credential).toEqual({ stored: true, origin: 'https://api.anthropic.com', hasSecret: true });
    expect(JSON.stringify(view)).not.toContain(SECRET);
    expect(deps.secrets.get(view.providers[0]?.id ?? '')).toEqual({ origin: 'https://api.anthropic.com', header: 'x_api_key', secret: SECRET });
    // 并发上限交给凭据代理。
    expect(deps.limits.at(-1)).toEqual([[view.providers[0]?.id, 4]]);
  });

  it('修改服务：地址的源不变时可以不填 API Key；改了地址必须重新填写', async () => {
    const { deps, app } = setup();
    const [p] = value(await app.saveProvider(null, { ...anthropic, apiKey: SECRET })).providers;
    if (p === undefined) throw new Error('样本');
    const renamed = value(await app.saveProvider(p, { ...anthropic, name: 'Claude', concurrency: 2, apiKey: null }));
    expect(renamed.providers[0]).toMatchObject({ name: 'Claude', concurrency: 2 });
    const moved = await app.saveProvider(renamed.providers[0] ?? null, { ...anthropic, baseUrl: 'https://proxy.example.test', apiKey: null });
    expect(moved).toEqual({ ok: false, error: { code: 'settings', detail: '更改服务地址后须重新填写 API Key' } });
    expect(deps.secrets.get(p.id)?.origin).toBe('https://api.anthropic.com');
    const reKeyed = value(await app.saveProvider(renamed.providers[0] ?? null, { ...anthropic, baseUrl: 'https://proxy.example.test', apiKey: 'sk-new' }));
    expect(reKeyed.providers[0]?.credential.origin).toBe('https://proxy.example.test');
  });

  it('地址检查：需要 API Key 的服务必须是 https；本地端点只能是本机地址；不保存不合格的服务', async () => {
    const { app } = setup();
    expect(await app.saveProvider(null, { kind: 'openai_compatible', name: 'X', baseUrl: 'http://api.example.test/v1', authMethod: 'api_key', apiKey: 'k' })).toMatchObject({
      ok: false,
      error: { detail: '需要 API Key 的服务必须使用 https 地址（本机地址除外）' },
    });
    expect(await app.saveProvider(null, { kind: 'local', name: '远程', baseUrl: 'http://192.168.1.5:11434/v1', authMethod: 'none', apiKey: null })).toMatchObject({
      ok: false,
      error: { detail: '不需要 API Key 的本地端点只能是本机地址（127.0.0.1 或 localhost）' },
    });
    expect(await app.saveProvider(null, { ...anthropic, apiKey: '  ' })).toMatchObject({ ok: false, error: { detail: '请填写 API Key' } });
    expect(value(await app.loadModelServices()).providers).toEqual([]);
    const local = value(await app.saveProvider(null, { kind: 'local', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', authMethod: 'none', apiKey: null }));
    expect(local.providers[0]?.credential).toEqual({ stored: true, origin: 'http://127.0.0.1:11434', hasSecret: false });
  });

  it('内置表中的 DeepSeek：添加时带上可调思考深度与价格；早先添加、能力过时的模型可以一键采用内置的能力与价格', async () => {
    const { app } = setup();
    const deepseek = { kind: 'openai_compatible' as const, name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', authMethod: 'api_key' as const, apiKey: 'sk-ds' };
    const [p] = value(await app.saveProvider(null, deepseek)).providers;
    const added = value(await app.addModel(p?.id ?? '', 'deepseek-flash')).models[0]!;
    expect(added).toMatchObject({ source: 'builtin', prices: { input: 0.3, output: 1.2, cacheRead: 0.006 }, capabilities: { reasoningControl: 'effort', structuredOutput: 'json_object' } });

    // 模拟早先添加的模型：不能调思考深度、没有价格。
    const old = value(await app.updateModel(added, { displayName: added.displayName, capabilities: { ...added.capabilities, reasoningControl: 'none' }, prices: null })).models[0]!;
    const refreshed = value(await app.applyBuiltinModel(old.id)).models[0]!;
    expect(refreshed).toMatchObject({ prices: { input: 0.3, output: 1.2, cacheRead: 0.006 }, capabilities: { reasoningControl: 'effort', structuredOutput: 'json_object' } });

    const plain = value(await app.addModel(p?.id ?? '', 'some-other-model')).models.find((m) => m.modelId === 'some-other-model')!;
    expect(await app.applyBuiltinModel(plain.id)).toMatchObject({ ok: false, error: { detail: expect.stringContaining('内置表中没有') } });

    // 中转站给 DeepSeek 起的名字带版本与构建后缀：按名字里的 flash 或 pro 对到内置条目，显示名保留原名。
    const relay = value(await app.saveProvider(null, { ...deepseek, name: '中转站', baseUrl: 'https://relay.example.test/v1' })).providers.find((x) => x.name === '中转站')!;
    const flash = value(await app.addModel(relay.id, 'deepseek-v4.1-flash:1017')).models.find((m) => m.modelId === 'deepseek-v4.1-flash:1017')!;
    expect(flash).toMatchObject({ source: 'builtin', displayName: 'deepseek-v4.1-flash:1017', prices: { input: 0.3, output: 1.2 }, capabilities: { reasoningControl: 'effort', maxOutputTokens: 384_000 } });
    const pro = value(await app.addModel(relay.id, 'deepseek/DeepSeek-V4-Pro')).models.find((m) => m.modelId === 'deepseek/DeepSeek-V4-Pro')!;
    expect(pro).toMatchObject({ source: 'builtin', prices: { input: 1.32, output: 3.96 } });
    const chat = value(await app.addModel(relay.id, 'deepseek-chat')).models.find((m) => m.modelId === 'deepseek-chat')!;
    expect(chat.source).toBe('user');
    // 早先添加、只有保守能力的中转站模型同样可以一键采用。
    const stale = value(await app.updateModel(flash, { displayName: flash.displayName, capabilities: { ...flash.capabilities, maxOutputTokens: 4_096 }, prices: null })).models.find((m) => m.id === flash.id)!;
    expect(value(await app.applyBuiltinModel(stale.id)).models.find((m) => m.id === flash.id)).toMatchObject({ prices: { input: 0.3 }, capabilities: { maxOutputTokens: 384_000 } });
  });

  it('模型：第一个模型成为默认模型；可以改默认、删除模型', async () => {
    const { app } = setup();
    const [p] = value(await app.saveProvider(null, { ...anthropic, apiKey: SECRET })).providers;
    const first = value(await app.addModel(p?.id ?? '', 'model-a'));
    const a = first.models[0];
    expect(first.defaultModelId).toBe(a?.id);
    expect(a).toMatchObject({ modelId: 'model-a', source: 'user', capabilities: { structuredOutput: 'prompt', selfTestPassed: false } });
    const second = value(await app.addModel(p?.id ?? '', 'model-b'));
    expect(second.defaultModelId).toBe(a?.id);
    const b = second.models.find((m) => m.modelId === 'model-b');
    expect(value(await app.setDefaultModel(b?.id ?? '')).defaultModelId).toBe(b?.id);
    expect(value(await app.deleteModel(b ?? second.models[0]!)).defaultModelId).toBeNull();
  });

  it('连接测试经凭据代理：服务收到真实的 API Key，界面与 SDK 只有占位值；给出延迟与实际模型', async () => {
    const { deps, app } = setup();
    const [p] = value(await app.saveProvider(null, { ...anthropic, apiKey: SECRET })).providers;
    const [m] = value(await app.addModel(p?.id ?? '', 'model-a')).models;
    deps.llmResponses.push({ chunks: anthropicChunks('model-a', { text: ['好'], end: 'stop', usage: { input: 12, output: 1, cacheRead: 0 } }) });
    const report = value(await app.testConnection(m?.id ?? ''));
    expect(report).toMatchObject({ ok: true, servedModel: 'model-a', reply: '好' });
    expect(report.latencyMs).toBeGreaterThan(0);
    expect(deps.llmRequests[0]?.headers['x-api-key']).toBe(SECRET);
    expect(JSON.stringify(deps.llmRequests)).not.toContain(PLACEHOLDER_API_KEY);
    expect(JSON.stringify(deps.llmRequests[0]?.body)).toContain('连接测试');
  });

  it('连接测试失败时给出原因；设置库中的地址被改到别处时，凭据代理拒绝发出', async () => {
    const { deps, app } = setup();
    const [p] = value(await app.saveProvider(null, { kind: 'openai_compatible', name: 'S', baseUrl: 'https://s.example.test/v1', authMethod: 'api_key', apiKey: 'sk-s' })).providers;
    const [m] = value(await app.addModel(p?.id ?? '', 'm')).models;
    deps.llmResponses.push({ status: 401, body: errorBody(401) });
    expect(value(await app.testConnection(m?.id ?? ''))).toMatchObject({ ok: false, error: { code: 'auth', status: 401 } });

    const db = value(await deps.settingsDb.open(deps.clock.now()));
    value(await db.transaction([{ sql: "UPDATE provider SET base_url = 'https://evil.example.test/v1'" }]));
    deps.llmResponses.push({ chunks: openaiChunks('m', { text: ['好'], end: 'stop' }) });
    const report = value(await app.testConnection(m?.id ?? ''));
    expect(report).toMatchObject({ ok: false, error: { code: 'bad_request', message: expect.stringContaining('host_not_allowed') } });
    expect(deps.llmRequests).toHaveLength(1);
  });

  it('删除服务：模型、默认设置与凭据管理器中的条目一并删除', async () => {
    const { deps, app } = setup();
    const [p] = value(await app.saveProvider(null, { ...anthropic, apiKey: SECRET })).providers;
    value(await app.addModel(p?.id ?? '', 'model-a'));
    const after = value(await app.deleteProvider(value(await app.loadModelServices()).providers[0]!));
    expect(after).toEqual({ providers: [], models: [], defaultModelId: null });
    expect(deps.secrets.size).toBe(0);
  });

  it('五类服务各一个实例：按服务种类选用适配器与接口，连接测试都经凭据代理', async () => {
    const { deps, app } = setup();
    const cases = [
      { kind: 'anthropic', baseUrl: 'https://api.anthropic.com', path: 'https://api.anthropic.com/v1/messages?beta=true', chunks: anthropicChunks },
      { kind: 'openai', baseUrl: 'https://api.openai.com/v1', path: 'https://api.openai.com/v1/responses', chunks: responsesChunks },
      {
        kind: 'gemini',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        path: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
        chunks: openaiChunks,
      },
      { kind: 'openai_compatible', baseUrl: 'https://api.deepseek.com/v1', path: 'https://api.deepseek.com/v1/chat/completions', chunks: openaiChunks },
      { kind: 'local', baseUrl: 'http://127.0.0.1:11434/v1', path: 'http://127.0.0.1:11434/v1/chat/completions', chunks: openaiChunks },
    ] as const;
    for (const c of cases) {
      const local = c.kind === 'local';
      const view = value(await app.saveProvider(null, { kind: c.kind, name: c.kind, baseUrl: c.baseUrl, authMethod: local ? 'none' : 'api_key', apiKey: local ? null : `key-${c.kind}` }));
      const provider = view.providers.find((p) => p.name === c.kind);
      const model = value(await app.addModel(provider?.id ?? '', `${c.kind}-model`)).models.find((m) => m.modelId === `${c.kind}-model`);
      deps.llmResponses.push({ chunks: c.chunks(`${c.kind}-model`, { text: ['好'], end: 'stop', usage: { input: 5, output: 1, cacheRead: 0 } }) });
      expect(value(await app.testConnection(model?.id ?? '')), c.kind).toMatchObject({ ok: true, servedModel: `${c.kind}-model`, reply: '好' });
      const sent = deps.llmRequests.at(-1);
      expect(sent?.url, c.kind).toBe(c.path);
      const auth = sent?.headers['x-api-key'] ?? sent?.headers['authorization'];
      expect(auth, c.kind).toBe(local ? undefined : c.kind === 'anthropic' ? 'key-anthropic' : `Bearer key-${c.kind}`);
    }
  });

  it('新模型的能力：保守能力 ← 内置表 ← 服务返回；价格只来自内置表', () => {
    const table = [{ kind: 'openai' as const, modelId: 'known', capabilities: { structuredOutput: 'native' as const, contextWindow: 400_000 }, prices: { input: 1, output: 4 } }];
    expect(resolveModel('openai', 'unknown', null, table)).toMatchObject({ source: 'user', prices: null, capabilities: { structuredOutput: 'prompt', contextWindow: 32_000 } });
    expect(resolveModel('openai', 'known', { id: 'known', displayName: null, capabilities: {} }, table)).toMatchObject({
      source: 'builtin',
      prices: { input: 1, output: 4 },
      capabilities: { structuredOutput: 'native', contextWindow: 400_000, selfTestPassed: false },
    });
    expect(resolveModel('openai', 'known', { id: 'known', displayName: '已知', capabilities: { contextWindow: 128_000 } }, table)).toMatchObject({
      source: 'service',
      displayName: '已知',
      capabilities: { structuredOutput: 'native', contextWindow: 128_000 },
    });
    expect(resolveModel('anthropic', 'known', null, table).source).toBe('user');
    // 内置表给 Anthropic 与 OpenAI 官方接口的主流模型标上了模型自带的联网搜索，来源记为内置。
    expect(resolveModel('anthropic', 'claude-sonnet-5-5', null)).toMatchObject({ source: 'builtin', capabilities: { webSearch: true, promptCaching: true }, prices: { input: 2, output: 10, webSearch: 10 } });
    expect(resolveModel('openai', 'gpt-4.1', null)).toMatchObject({ source: 'builtin', capabilities: { webSearch: true, reasoningControl: 'none', contextWindow: 1_047_576 } });
    expect(resolveModel('openai_compatible', 'deepseek-flash', null).capabilities.webSearch).toBe(false);
    // 兼容接口上带后缀的 DeepSeek 模型名对到内置条目；其他种类的服务只按完整的模型名。
    expect(resolveModel('openai_compatible', 'DeepSeek-V4-Flash', null)).toMatchObject({ source: 'builtin', displayName: 'DeepSeek-V4-Flash', prices: { input: 0.3 } });
    expect(resolveModel('openai', 'deepseek-flash:1017', null).source).toBe('user');
    expect(deepseekAlias('deepseek-chat')).toBeNull();
    expect(deepseekAlias('deepseek-v4.1-flash:1017')).toBe('deepseek-flash');
  });

  it('获取模型列表并从中添加：带上服务返回的能力', async () => {
    const { deps, app } = setup();
    const [p] = value(await app.saveProvider(null, { ...anthropic, apiKey: SECRET })).providers;
    const model = {
      type: 'model', id: 'model-x', display_name: '模型 X', created_at: '2026-01-01T00:00:00Z', max_input_tokens: 100_000, max_tokens: 8_000,
      capabilities: { structured_outputs: { supported: true }, effort: { supported: true } },
    };
    deps.llmResponses.push({ body: JSON.stringify({ data: [model], has_more: false, first_id: 'model-x', last_id: 'model-x' }) });
    const listed = value(await app.fetchModelList(p?.id ?? ''));
    expect(listed).toEqual([{ id: 'model-x', displayName: '模型 X', capabilities: { structuredOutput: 'native', reasoningControl: 'effort', contextWindow: 100_000, maxOutputTokens: 8_000 } }]);
    expect(deps.llmRequests.at(-1)?.headers['x-api-key']).toBe(SECRET);
    const view = value(await app.addModel(p?.id ?? '', 'model-x', listed[0] ?? null));
    expect(view.models[0]).toMatchObject({ modelId: 'model-x', displayName: '模型 X', source: 'service', capabilities: { structuredOutput: 'native', selfTestPassed: false } });

    deps.llmResponses.push({ status: 401, body: errorBody(401) });
    expect(await app.fetchModelList(p?.id ?? '')).toMatchObject({ ok: false, error: { code: 'settings', detail: expect.stringContaining('获取模型列表失败（auth）') } });
  });

  it('能力自检：连续三次输出合格才通过并记录；不合格时记录原因；修改结构化输出方式后须重测', async () => {
    const { deps, app } = setup();
    const [p] = value(await app.saveProvider(null, { kind: 'openai_compatible', name: 'S', baseUrl: 'https://s.example.test/v1', authMethod: 'api_key', apiKey: 'sk-s' })).providers;
    const [m] = value(await app.addModel(p?.id ?? '', 'm')).models;
    const reply = (text: string) => ({ chunks: openaiChunks('m', { text: [text], end: 'stop' as const }) });
    for (let i = 0; i < 3; i++) deps.llmResponses.push(reply(JSON.stringify(SELF_TEST_EXPECTED)));
    const passed = value(await app.runSelfTest(m?.id ?? ''));
    expect(passed.report).toEqual({ passed: true, runs: [null, null, null], reason: null });
    expect(passed.view.models[0]).toMatchObject({ capabilities: { selfTestPassed: true }, selfTest: { status: 'passed', reason: null } });
    expect(JSON.stringify(deps.llmRequests.at(-1)?.body)).toContain('能力自检');

    const tested = passed.view.models[0];
    if (tested === undefined) throw new Error('样本');
    const changed = value(await app.updateModel(tested, { displayName: 'm', capabilities: { ...tested.capabilities, structuredOutput: 'json_object' }, prices: { input: 0.3, output: 1.2 } }));
    expect(changed.models[0]).toMatchObject({ source: 'user', capabilities: { structuredOutput: 'json_object', selfTestPassed: false }, selfTest: null, prices: { input: 0.3, output: 1.2 } });

    deps.llmResponses.push(reply('{"scene":"雨夜当铺"}'));
    const failed = value(await app.runSelfTest(m?.id ?? ''));
    expect(failed.report.passed).toBe(false);
    expect(failed.view.models[0]).toMatchObject({ capabilities: { selfTestPassed: false }, selfTest: { status: 'failed', reason: expect.stringMatching(/^第 1 次：输出不符合格式/) } });
  });
});
