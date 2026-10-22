import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { APP_DB_FILE, appMigrationsDir, loadMigrations, openProjectDb, type ProjectDb } from '../node/sqlite';
import { createModel, createProvider, deleteModel, type StoredCapabilities } from './model-services';
import { createSearchService, deleteSearchService, getDefaultSearchServiceId, listSearchServices, setDefaultSearchService, updateSearchService } from './search-services';

const ctx = { now: '2026-10-20T00:00:00.000Z' };
const root = mkdtempSync(join(tmpdir(), 'fudiao-search-'));
const opened: ProjectDb[] = [];
afterAll(() => {
  for (const db of opened) db.close();
  rmSync(root, { recursive: true, force: true });
});

const all = loadMigrations(appMigrationsDir);

function open(dir: string, upTo = Number.MAX_SAFE_INTEGER): ProjectDb {
  const result = openProjectDb(dir, { migrations: all.filter((m) => m.version <= upTo), now: ctx.now, file: APP_DB_FILE });
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  opened.push(result.value.db);
  return result.value.db;
}

function value<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

const caps: StoredCapabilities = { limitsKnown: { contextWindow: true, maxOutputTokens: true }, structuredOutput: 'native', promptCaching: true, reasoningControl: 'effort', refusalFallback: 'none', contextWindow: 1_000_000, maxOutputTokens: 128_000, selfTestPassed: false, webSearch: true };

describe('应用设置库：搜索服务（B84，app 迁移 0002 至 0004）', () => {
  it('从 0003 升级到 0004：已有的服务（含沿用的 Key）与默认项保留，model_id 为空', async () => {
    const dir = join(root, 'upgrade');
    const old = open(dir, 3);
    value(await old.transaction([
      { sql: "INSERT INTO search_service (id, kind, name, base_url, credential_ref, enabled, created_at, updated_at) VALUES ('s1', 'deepseek', 'DeepSeek', 'https://api.deepseek.com', 'p9', 1, ?, ?)", params: [ctx.now, ctx.now] },
      { sql: "INSERT INTO search_default (key, service_id, updated_at) VALUES ('default', 's1', ?)", params: [ctx.now] },
    ]));
    old.close();
    opened.splice(opened.indexOf(old), 1);
    const db = open(dir);
    expect(value(await listSearchServices(db))).toEqual([{ id: 's1', kind: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', credentialRef: 'p9', modelId: null, enabled: true, version: 1 }]);
    expect(value(await getDefaultSearchServiceId(db))).toBe('s1');
    // 默认项仍随服务删除。
    value(await deleteSearchService(db, 's1', 1));
    expect(value(await getDefaultSearchServiceId(db))).toBeNull();
  });

  it('模型自带的搜索：须选模型、没有地址、不沿用 Key；模型删除后 model_id 置空；外部服务不能带模型、须是 https', async () => {
    const db = open(join(root, 'provider'));
    value(await createProvider(db, 'p1', { kind: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com', authMethod: 'api_key' }, ctx));
    const m = value(await createModel(db, 'm1', { providerId: 'p1', modelId: 'claude-sonnet-5-5', capabilities: caps, source: 'builtin' }, ctx));
    expect(await createSearchService(db, 's1', { kind: 'provider', name: '模型搜索', baseUrl: '' }, ctx)).toMatchObject({ ok: false, error: { code: 'invalid', detail: '请选择用来搜索的模型' } });
    expect(await createSearchService(db, 's1', { kind: 'provider', name: '模型搜索', baseUrl: '', modelId: 'missing' }, ctx)).toMatchObject({ ok: false, error: { code: 'invalid', detail: '所选的模型已不存在，请重新选择' } });
    const s = value(await createSearchService(db, 's1', { kind: 'provider', name: '模型搜索', baseUrl: 'https://ignored.example', modelId: ' m1 ', credentialRef: 'p1' }, ctx));
    expect(s).toEqual({ id: 's1', kind: 'provider', name: '模型搜索', baseUrl: '', credentialRef: null, modelId: 'm1', enabled: true, version: 1 });
    value(await setDefaultSearchService(db, 's1', ctx));

    // 外部服务：模型字段忽略、地址须是 https。
    const t = value(await createSearchService(db, 's2', { kind: 'tavily', name: 'Tavily', baseUrl: 'https://api.tavily.com/', modelId: 'm1' }, ctx));
    expect(t.modelId).toBeNull();
    expect(await updateSearchService(db, 's2', 1, { kind: 'brave', name: 'Brave', baseUrl: 'http://api.search.brave.com' }, ctx)).toMatchObject({ ok: false, error: { code: 'invalid' } });

    value(await deleteModel(db, m.id, m.version));
    const after = value(await listSearchServices(db));
    expect(after.find((x) => x.id === 's1')).toMatchObject({ kind: 'provider', modelId: null });
    // 默认项不受模型删除影响。
    expect(value(await getDefaultSearchServiceId(db))).toBe('s1');
  });
});
