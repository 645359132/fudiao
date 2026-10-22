import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { APP_DB_FILE, appMigrationsDir, loadMigrations, openProjectDb, type ProjectDb } from '../node/sqlite';
import {
  CONSERVATIVE_CONTEXT_WINDOW,
  CONSERVATIVE_MAX_OUTPUT_TOKENS,
  createModel,
  createProvider,
  deleteModel,
  deleteProvider,
  getDefaultModelId,
  listModels,
  listProviders,
  recordSelfTest,
  setDefaultModel,
  updateModel,
  updateProvider,
  StoredCapabilities,
} from './model-services';

const ctx = { now: '2026-10-08T00:00:00.000Z' };
const root = mkdtempSync(join(tmpdir(), 'fudiao-app-'));
const opened: ProjectDb[] = [];
afterAll(() => {
  for (const db of opened) db.close();
  rmSync(root, { recursive: true, force: true });
});

function fresh(): ProjectDb {
  const result = openProjectDb(join(root, `a${opened.length}`), { migrations: loadMigrations(appMigrationsDir), now: ctx.now, file: APP_DB_FILE });
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  opened.push(result.value.db);
  return result.value.db;
}

function value<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

const caps: StoredCapabilities = {
  limitsKnown: { contextWindow: true, maxOutputTokens: true },
  structuredOutput: 'prompt',
  promptCaching: false,
  reasoningControl: 'none',
  refusalFallback: 'none',
  contextWindow: 32_000,
  maxOutputTokens: 4_096,
  selfTestPassed: false,
  webSearch: false,
};

describe('应用设置库：模型服务', () => {
  it('新建、修改与删除服务；地址去掉末尾斜杠，名称不能重复', async () => {
    const db = fresh();
    const p = value(await createProvider(db, 'p1', { kind: 'anthropic', name: ' Anthropic ', baseUrl: 'https://api.anthropic.com/', authMethod: 'api_key' }, ctx));
    expect(p).toEqual({
      id: 'p1',
      kind: 'anthropic',
      name: 'Anthropic',
      baseUrl: 'https://api.anthropic.com',
      authMethod: 'api_key',
      dialect: {},
      concurrency: 4,
      enabled: true,
      version: 1,
    });
    expect(await createProvider(db, 'p2', { kind: 'anthropic', name: 'Anthropic', baseUrl: 'https://x.test', authMethod: 'api_key' }, ctx)).toEqual({
      ok: false,
      error: { code: 'invalid', detail: '已有同名的服务' },
    });
    const updated = value(
      await updateProvider(db, 'p1', 1, { kind: 'openai_compatible', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', authMethod: 'api_key', dialect: { maxTokensField: 'max_tokens' }, concurrency: 8 }, ctx),
    );
    expect(updated).toMatchObject({ kind: 'openai_compatible', dialect: { maxTokensField: 'max_tokens' }, concurrency: 8, version: 2 });
    expect(await updateProvider(db, 'p1', 1, { kind: 'anthropic', name: 'X', baseUrl: 'https://x.test', authMethod: 'api_key' }, ctx)).toMatchObject({
      ok: false,
      error: { code: 'conflict' },
    });
    value(await deleteProvider(db, 'p1', 2));
    expect(value(await listProviders(db))).toEqual([]);
  });

  it('校验：名称、地址、并发上限', async () => {
    const db = fresh();
    const base = { kind: 'local' as const, name: '本机', baseUrl: 'http://127.0.0.1:11434/v1', authMethod: 'none' as const };
    expect(await createProvider(db, 'p', { ...base, name: ' ' }, ctx)).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(await createProvider(db, 'p', { ...base, baseUrl: 'ftp://x' }, ctx)).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(await createProvider(db, 'p', { ...base, concurrency: 0 }, ctx)).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect((await createProvider(db, 'p', base, ctx)).ok).toBe(true);
  });

  it('模型与默认模型；删除服务时模型与默认设置一并删除', async () => {
    const db = fresh();
    value(await createProvider(db, 'p1', { kind: 'openai_compatible', name: 'S', baseUrl: 'https://s.test/v1', authMethod: 'api_key' }, ctx));
    const m = value(await createModel(db, 'm1', { providerId: 'p1', modelId: ' some-model ', capabilities: caps, source: 'user' }, ctx));
    expect(m).toMatchObject({ modelId: 'some-model', displayName: 'some-model', prices: null, selfTest: null, source: 'user' });
    expect(await createModel(db, 'm2', { providerId: 'p1', modelId: 'some-model', capabilities: caps, source: 'user' }, ctx)).toEqual({
      ok: false,
      error: { code: 'invalid', detail: '这个服务下已有同名的模型' },
    });
    value(await createModel(db, 'm3', { providerId: 'p1', modelId: 'other', displayName: '另一个', capabilities: caps, prices: { input: 1, output: 2 }, source: 'user' }, ctx));
    expect(value(await getDefaultModelId(db))).toBeNull();
    value(await setDefaultModel(db, 'm1', ctx));
    value(await setDefaultModel(db, 'm3', ctx));
    expect(value(await getDefaultModelId(db))).toBe('m3');
    value(await deleteModel(db, 'm3', 1));
    expect(value(await getDefaultModelId(db))).toBeNull();
    value(await setDefaultModel(db, 'm1', ctx));
    value(await deleteProvider(db, 'p1', 1));
    expect(value(await listModels(db))).toEqual([]);
    expect(value(await getDefaultModelId(db))).toBeNull();
  });

  it('修改能力与价格记为作者编辑；改了结构化输出方式须重新自检', async () => {
    const db = fresh();
    value(await createProvider(db, 'p1', { kind: 'openai_compatible', name: 'S', baseUrl: 'https://s.test/v1', authMethod: 'api_key' }, ctx));
    let m = value(await createModel(db, 'm1', { providerId: 'p1', modelId: 'x', capabilities: caps, source: 'service' }, ctx));
    m = value(await recordSelfTest(db, m, { status: 'passed', at: ctx.now, reason: null }, ctx));
    expect(m).toMatchObject({ capabilities: { selfTestPassed: true }, selfTest: { status: 'passed' }, version: 2 });
    // 只改价格与上下文长度：自检结果保留。
    m = value(await updateModel(db, m, { displayName: '模型 X', capabilities: { ...caps, contextWindow: 64_000 }, prices: { input: 0.5, output: 2 } }, ctx));
    expect(m).toMatchObject({ displayName: '模型 X', source: 'user', prices: { input: 0.5, output: 2 }, capabilities: { contextWindow: 64_000, selfTestPassed: true }, selfTest: { status: 'passed' } });
    // 改结构化输出方式：自检作废。
    m = value(await updateModel(db, m, { displayName: '', capabilities: { ...caps, structuredOutput: 'native' }, prices: null }, ctx));
    expect(m).toMatchObject({ displayName: 'x', prices: null, capabilities: { structuredOutput: 'native', selfTestPassed: false }, selfTest: null });
    expect(await updateModel(db, m, { displayName: 'x', capabilities: caps, prices: { input: -1, output: 0 } }, ctx)).toMatchObject({ ok: false, error: { code: 'invalid' } });
    m = value(await recordSelfTest(db, m, { status: 'failed', at: ctx.now, reason: '第 1 次：输出不符合格式' }, ctx));
    expect(m).toMatchObject({ capabilities: { selfTestPassed: false }, selfTest: { status: 'failed', reason: '第 1 次：输出不符合格式' } });
  });
});

describe('能力记录里的 limitsKnown', () => {
  it('早先的记录没有这一项：与保守值不同的当作有依据；写了的照写', () => {
    const base = { structuredOutput: 'prompt' as const, promptCaching: false, reasoningControl: 'none' as const, refusalFallback: 'none' as const, selfTestPassed: false };
    expect(StoredCapabilities.parse({ ...base, contextWindow: CONSERVATIVE_CONTEXT_WINDOW, maxOutputTokens: CONSERVATIVE_MAX_OUTPUT_TOKENS }).limitsKnown).toEqual({ contextWindow: false, maxOutputTokens: false });
    expect(StoredCapabilities.parse({ ...base, contextWindow: 200_000, maxOutputTokens: CONSERVATIVE_MAX_OUTPUT_TOKENS }).limitsKnown).toEqual({ contextWindow: true, maxOutputTokens: false });
    expect(StoredCapabilities.parse({ ...base, contextWindow: 200_000, maxOutputTokens: 64_000, limitsKnown: { contextWindow: false, maxOutputTokens: true } }).limitsKnown).toEqual({
      contextWindow: false,
      maxOutputTokens: true,
    });
  });
});
