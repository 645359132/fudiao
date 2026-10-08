import { rmSync } from 'node:fs';
import { PLACEHOLDER_API_KEY } from '@fudiao/llm';
import { anthropicChunks, errorBody, openaiChunks } from '@fudiao/llm/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { fsDeps, type TestDeps } from '../testing/fs-deps';
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
    expect(report).toMatchObject({ ok: false, error: { code: 'network', message: expect.stringContaining('host_not_allowed') } });
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
});
