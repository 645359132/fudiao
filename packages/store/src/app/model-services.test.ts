import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { APP_DB_FILE, appMigrationsDir, loadMigrations, openProjectDb, type ProjectDb } from '../node/sqlite';
import {
  createModel,
  createProvider,
  deleteModel,
  deleteProvider,
  getDefaultModelId,
  listModels,
  listProviders,
  setDefaultModel,
  updateProvider,
  type StoredCapabilities,
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
  structuredOutput: 'prompt',
  promptCaching: false,
  reasoningControl: 'none',
  refusalFallback: 'none',
  contextWindow: 32_000,
  maxOutputTokens: 4_096,
  selfTestPassed: false,
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
});
