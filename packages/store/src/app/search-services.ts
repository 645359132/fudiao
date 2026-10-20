// 应用设置库里的联网搜索服务（需求 B84，M7-01，app 迁移 0002、0003）。只保存服务与默认项；API Key 在系统凭据管理器中：
// 条目名为服务标识，或者沿用某个模型服务的条目（credential_ref）。
import { err, ok, type Result } from '@fudiao/shared';
import { z } from 'zod';
import { guardedUpdate, insertReturning, queryAll, queryOne, type RepoError, type WriteContext } from '../repos/common';
import type { SqlPort } from '../sql';

export const SEARCH_KINDS = ['tavily', 'brave', 'deepseek'] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];

const SearchServiceRow = z
  .object({
    id: z.string(),
    kind: z.enum(SEARCH_KINDS),
    name: z.string(),
    base_url: z.string(),
    credential_ref: z.string().nullable(),
    enabled: z.number().int(),
    version: z.number().int(),
  })
  .transform((r) => ({ id: r.id, kind: r.kind, name: r.name, baseUrl: r.base_url, credentialRef: r.credential_ref, enabled: r.enabled === 1, version: r.version }));
export type SearchService = z.output<typeof SearchServiceRow>;

export type SearchServiceInput = {
  readonly kind: SearchKind;
  readonly name: string;
  readonly baseUrl: string;
  /** 沿用哪个模型服务的 API Key；省略或 null 为用自己的凭据条目。 */
  readonly credentialRef?: string | null;
  readonly enabled?: boolean;
};

const COLUMNS = 'id, kind, name, base_url, credential_ref, enabled, version';

function check(input: SearchServiceInput): Result<SearchServiceInput, RepoError> {
  const name = input.name.trim();
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, '');
  if (name === '') return err({ code: 'invalid', detail: '搜索服务的名称不能为空' });
  if (!/^https:\/\/[^/\s]+/.test(baseUrl)) return err({ code: 'invalid', detail: '搜索服务的地址须以 https:// 开头' });
  return ok({ ...input, name, baseUrl, credentialRef: input.credentialRef ?? null });
}

const duplicateName = <T>(r: Result<T, RepoError>): Result<T, RepoError> =>
  !r.ok && r.error.code === 'sql' && r.error.error.code === 'constraint' && /search_service_by_name|search_service\.name/.test(JSON.stringify(r.error.error))
    ? err({ code: 'invalid', detail: '已有同名的搜索服务' })
    : r;

export function listSearchServices(port: SqlPort): Promise<Result<SearchService[], RepoError>> {
  return queryAll(port, SearchServiceRow, `SELECT ${COLUMNS} FROM search_service ORDER BY created_at, id`);
}

export async function createSearchService(port: SqlPort, id: string, input: SearchServiceInput, ctx: WriteContext): Promise<Result<SearchService, RepoError>> {
  const checked = check(input);
  if (!checked.ok) return checked;
  const s = checked.value;
  return duplicateName(
    await insertReturning(port, SearchServiceRow, {
      sql: `INSERT INTO search_service (id, kind, name, base_url, credential_ref, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${COLUMNS}`,
      params: [id, s.kind, s.name, s.baseUrl, s.credentialRef ?? null, s.enabled === false ? 0 : 1, ctx.now, ctx.now],
    }),
  );
}

export async function updateSearchService(port: SqlPort, id: string, expectedVersion: number, input: SearchServiceInput, ctx: WriteContext): Promise<Result<SearchService, RepoError>> {
  const checked = check(input);
  if (!checked.ok) return checked;
  const s = checked.value;
  return duplicateName(
    await guardedUpdate(port, SearchServiceRow, 'search_service', id, {
      sql: `UPDATE search_service SET kind = ?, name = ?, base_url = ?, credential_ref = ?, enabled = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ? RETURNING ${COLUMNS}`,
      params: [s.kind, s.name, s.baseUrl, s.credentialRef ?? null, s.enabled === false ? 0 : 1, ctx.now, id, expectedVersion],
    }),
  );
}

/** 删除搜索服务（默认项随之删除）。凭据管理器中的条目由调用方删除。 */
export async function deleteSearchService(port: SqlPort, id: string, expectedVersion: number): Promise<Result<void, RepoError>> {
  const done = await port.transaction([{ sql: 'DELETE FROM search_service WHERE id = ? AND version = ?', params: [id, expectedVersion], expectChanges: 1 }]);
  if (done.ok) return ok(undefined);
  return err(done.error.code === 'guard_failed' ? { code: 'conflict' } : { code: 'sql', error: done.error });
}

const DefaultRow = z.object({ service_id: z.string() });

export async function getDefaultSearchServiceId(port: SqlPort): Promise<Result<string | null, RepoError>> {
  const row = await queryOne(port, DefaultRow, "SELECT service_id FROM search_default WHERE key = 'default'");
  return row.ok ? ok(row.value?.service_id ?? null) : row;
}

export async function setDefaultSearchService(port: SqlPort, serviceId: string | null, ctx: WriteContext): Promise<Result<void, RepoError>> {
  const done = await port.transaction(
    serviceId === null
      ? [{ sql: "DELETE FROM search_default WHERE key = 'default'", params: [] }]
      : [{ sql: "INSERT INTO search_default (key, service_id, updated_at) VALUES ('default', ?, ?) ON CONFLICT (key) DO UPDATE SET service_id = excluded.service_id, updated_at = excluded.updated_at", params: [serviceId, ctx.now] }],
  );
  return done.ok ? ok(undefined) : err({ code: 'sql', error: done.error });
}
