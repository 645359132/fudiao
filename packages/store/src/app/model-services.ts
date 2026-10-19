// 应用设置库 app.sqlite 的仓储（施工文档第六章“服务、模型与任务分配的配置”，需求 B15）。
// 只保存服务、模型与任务分配；API Key 在系统凭据管理器中，以服务标识为条目名。
import { err, ok, type Result } from '@fudiao/shared';
import { z } from 'zod';
import { guardedUpdate, insertReturning, queryAll, queryOne, type RepoError, type WriteContext } from '../repos/common';
import type { SqlPort } from '../sql';

export const PROVIDER_KINDS = ['anthropic', 'openai', 'gemini', 'openai_compatible', 'local'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];
export type AuthMethod = 'api_key' | 'none';

/** OpenAI 写法差异的覆盖项（packages/llm 的 ChatDialect）；不填的用该服务种类的默认值。 */
export const DialectOverrides = z
  .object({
    maxTokensField: z.enum(['max_tokens', 'max_completion_tokens']).optional(),
    streamUsage: z.boolean().optional(),
    stripThinkTags: z.boolean().optional(),
  })
  .strict();
export type DialectOverrides = z.infer<typeof DialectOverrides>;

/** 与 packages/llm 的 ModelCapabilities 相同（应用层以类型检查保证两者一致）。 */
export const StoredCapabilities = z.object({
  structuredOutput: z.enum(['native', 'json_object', 'prompt', 'none']),
  promptCaching: z.boolean(),
  reasoningControl: z.enum(['effort', 'none']),
  refusalFallback: z.enum(['server_default', 'none']),
  contextWindow: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  selfTestPassed: z.boolean(),
});
export type StoredCapabilities = z.infer<typeof StoredCapabilities>;

export const StoredPrices = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative().optional(),
  cacheWrite: z.number().nonnegative().optional(),
});
export type StoredPrices = z.infer<typeof StoredPrices>;

const json = <T>(schema: z.ZodType<T>, what: string) =>
  z.string().transform((text, ctx): T => {
    try {
      const parsed = schema.safeParse(JSON.parse(text));
      if (parsed.success) return parsed.data;
    } catch {
      // 落到下面的错误
    }
    ctx.addIssue({ code: 'custom', message: `${what}格式无效` });
    return z.NEVER;
  });

const ProviderRow = z
  .object({
    id: z.string(),
    kind: z.enum(PROVIDER_KINDS),
    name: z.string(),
    base_url: z.string(),
    auth_method: z.enum(['api_key', 'none']),
    dialect: json(DialectOverrides, '写法差异'),
    concurrency: z.number().int(),
    enabled: z.number().int(),
    version: z.number().int(),
  })
  .transform((r) => ({
    id: r.id,
    kind: r.kind,
    name: r.name,
    baseUrl: r.base_url,
    authMethod: r.auth_method,
    dialect: r.dialect,
    concurrency: r.concurrency,
    enabled: r.enabled === 1,
    version: r.version,
  }));
export type Provider = z.output<typeof ProviderRow>;

export type ProviderInput = {
  readonly kind: ProviderKind;
  readonly name: string;
  readonly baseUrl: string;
  readonly authMethod: AuthMethod;
  readonly dialect?: DialectOverrides;
  readonly concurrency?: number;
  readonly enabled?: boolean;
};

const PROVIDER_COLUMNS = 'id, kind, name, base_url, auth_method, dialect, concurrency, enabled, version';

function checkProvider(input: ProviderInput): Result<ProviderInput, RepoError> {
  const name = input.name.trim();
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, '');
  if (name === '') return err({ code: 'invalid', detail: '服务名称不能为空' });
  if (!/^https?:\/\/[^/\s]+/.test(baseUrl)) return err({ code: 'invalid', detail: '服务地址须以 http:// 或 https:// 开头' });
  const concurrency = input.concurrency ?? 4;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64) return err({ code: 'invalid', detail: '并发上限须为 1 到 64 的整数' });
  const dialect = DialectOverrides.safeParse(input.dialect ?? {});
  if (!dialect.success) return err({ code: 'invalid', detail: '写法差异设置无效' });
  return ok({ ...input, name, baseUrl, concurrency, dialect: dialect.data });
}

/** 名称重复时数据库报唯一约束；转为给作者看的说明。 */
const duplicateName = <T>(r: Result<T, RepoError>): Result<T, RepoError> =>
  !r.ok && r.error.code === 'sql' && r.error.error.code === 'constraint' && /provider_by_name|provider\.name/.test(JSON.stringify(r.error.error))
    ? err({ code: 'invalid', detail: '已有同名的服务' })
    : r;

export function listProviders(port: SqlPort): Promise<Result<Provider[], RepoError>> {
  return queryAll(port, ProviderRow, `SELECT ${PROVIDER_COLUMNS} FROM provider ORDER BY created_at, id`);
}

export async function getProvider(port: SqlPort, id: string): Promise<Result<Provider, RepoError>> {
  const row = await queryOne(port, ProviderRow, `SELECT ${PROVIDER_COLUMNS} FROM provider WHERE id = ?`, [id]);
  if (!row.ok) return row;
  return row.value === null ? err({ code: 'not_found' }) : ok(row.value);
}

export async function createProvider(port: SqlPort, id: string, input: ProviderInput, ctx: WriteContext): Promise<Result<Provider, RepoError>> {
  const checked = checkProvider(input);
  if (!checked.ok) return checked;
  const p = checked.value;
  return duplicateName(
    await insertReturning(port, ProviderRow, {
      sql: `INSERT INTO provider (id, kind, name, base_url, auth_method, dialect, concurrency, enabled, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${PROVIDER_COLUMNS}`,
      params: [id, p.kind, p.name, p.baseUrl, p.authMethod, JSON.stringify(p.dialect), p.concurrency ?? 4, p.enabled === false ? 0 : 1, ctx.now, ctx.now],
    }),
  );
}

export async function updateProvider(
  port: SqlPort,
  id: string,
  expectedVersion: number,
  input: ProviderInput,
  ctx: WriteContext,
): Promise<Result<Provider, RepoError>> {
  const checked = checkProvider(input);
  if (!checked.ok) return checked;
  const p = checked.value;
  return duplicateName(
    await guardedUpdate(port, ProviderRow, 'provider', id, {
      sql: `UPDATE provider SET kind = ?, name = ?, base_url = ?, auth_method = ?, dialect = ?, concurrency = ?, enabled = ?,
              version = version + 1, updated_at = ?
            WHERE id = ? AND version = ? RETURNING ${PROVIDER_COLUMNS}`,
      params: [p.kind, p.name, p.baseUrl, p.authMethod, JSON.stringify(p.dialect), p.concurrency ?? 4, p.enabled === false ? 0 : 1, ctx.now, id, expectedVersion],
    }),
  );
}

/** 删除服务连同它的模型与任务分配。凭据管理器中的条目由调用方删除。 */
export async function deleteProvider(port: SqlPort, id: string, expectedVersion: number): Promise<Result<void, RepoError>> {
  const done = await port.transaction([{ sql: 'DELETE FROM provider WHERE id = ? AND version = ?', params: [id, expectedVersion], expectChanges: 1 }]);
  if (done.ok) return ok(undefined);
  return err(done.error.code === 'guard_failed' ? { code: 'conflict' } : { code: 'sql', error: done.error });
}

const SelfTest = z.object({ status: z.enum(['passed', 'failed']), at: z.string(), reason: z.string().nullable() });
export type SelfTest = z.infer<typeof SelfTest>;

const ModelRow = z
  .object({
    id: z.string(),
    provider_id: z.string(),
    model_id: z.string(),
    display_name: z.string(),
    capabilities: json(StoredCapabilities, '模型能力'),
    prices: json(StoredPrices, '价格').nullable(),
    source: z.enum(['service', 'builtin', 'user']),
    self_test: json(SelfTest, '自检结果').nullable(),
    version: z.number().int(),
  })
  .transform((r) => ({
    id: r.id,
    providerId: r.provider_id,
    modelId: r.model_id,
    displayName: r.display_name,
    capabilities: r.capabilities,
    prices: r.prices,
    source: r.source,
    selfTest: r.self_test,
    version: r.version,
  }));
export type StoredModel = z.output<typeof ModelRow>;

export type ModelInput = {
  readonly providerId: string;
  readonly modelId: string;
  readonly displayName?: string;
  readonly capabilities: StoredCapabilities;
  readonly prices?: StoredPrices | null;
  readonly source: 'service' | 'builtin' | 'user';
};

const MODEL_COLUMNS = 'id, provider_id, model_id, display_name, capabilities, prices, source, self_test, version';

export function listModels(port: SqlPort): Promise<Result<StoredModel[], RepoError>> {
  return queryAll(port, ModelRow, `SELECT ${MODEL_COLUMNS} FROM model_profile ORDER BY provider_id, display_name, model_id`);
}

export async function createModel(port: SqlPort, id: string, input: ModelInput, ctx: WriteContext): Promise<Result<StoredModel, RepoError>> {
  const modelId = input.modelId.trim();
  if (modelId === '') return err({ code: 'invalid', detail: '模型名称不能为空' });
  const capabilities = StoredCapabilities.safeParse(input.capabilities);
  if (!capabilities.success) return err({ code: 'invalid', detail: '模型能力无效' });
  const created = await insertReturning(port, ModelRow, {
    sql: `INSERT INTO model_profile (id, provider_id, model_id, display_name, capabilities, prices, source, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${MODEL_COLUMNS}`,
    params: [
      id,
      input.providerId,
      modelId,
      input.displayName?.trim() || modelId,
      JSON.stringify(capabilities.data),
      input.prices === undefined || input.prices === null ? null : JSON.stringify(input.prices),
      input.source,
      ctx.now,
      ctx.now,
    ],
  });
  if (!created.ok && created.error.code === 'sql' && created.error.error.code === 'constraint') {
    return err({ code: 'invalid', detail: '这个服务下已有同名的模型' });
  }
  return created;
}

export type ModelPatch = {
  readonly displayName: string;
  readonly capabilities: StoredCapabilities;
  readonly prices: StoredPrices | null;
};

/**
 * 作者修改模型的能力与价格（B56 的用户覆盖）：来源记为 user。结构化输出方式改变时，原来的自检结果不再适用，
 * 清除自检记录并标记为未通过。
 */
export async function updateModel(port: SqlPort, model: StoredModel, patch: ModelPatch, ctx: WriteContext): Promise<Result<StoredModel, RepoError>> {
  const capabilities = StoredCapabilities.safeParse(patch.capabilities);
  if (!capabilities.success) return err({ code: 'invalid', detail: '模型能力无效' });
  const prices = patch.prices === null ? null : StoredPrices.safeParse(patch.prices);
  if (prices !== null && !prices.success) return err({ code: 'invalid', detail: '价格须为非负数' });
  const retest = capabilities.data.structuredOutput !== model.capabilities.structuredOutput;
  const caps = retest ? { ...capabilities.data, selfTestPassed: false } : { ...capabilities.data, selfTestPassed: model.capabilities.selfTestPassed };
  return guardedUpdate(port, ModelRow, 'model_profile', model.id, {
    sql: `UPDATE model_profile SET display_name = ?, capabilities = ?, prices = ?, source = 'user', ${retest ? 'self_test = NULL, ' : ''}
            version = version + 1, updated_at = ?
          WHERE id = ? AND version = ? RETURNING ${MODEL_COLUMNS}`,
    params: [patch.displayName.trim() || model.modelId, JSON.stringify(caps), prices === null ? null : JSON.stringify(prices.data), ctx.now, model.id, model.version],
  });
}

/** 记录能力自检的结果（B57）：通过时模型才能用于必须输出结构化数据的任务。 */
export function recordSelfTest(port: SqlPort, model: StoredModel, result: SelfTest, ctx: WriteContext): Promise<Result<StoredModel, RepoError>> {
  const caps = { ...model.capabilities, selfTestPassed: result.status === 'passed' };
  return guardedUpdate(port, ModelRow, 'model_profile', model.id, {
    sql: `UPDATE model_profile SET capabilities = ?, self_test = ?, version = version + 1, updated_at = ?
          WHERE id = ? AND version = ? RETURNING ${MODEL_COLUMNS}`,
    params: [JSON.stringify(caps), JSON.stringify(result), ctx.now, model.id, model.version],
  });
}

export async function deleteModel(port: SqlPort, id: string, expectedVersion: number): Promise<Result<void, RepoError>> {
  const done = await port.transaction([{ sql: 'DELETE FROM model_profile WHERE id = ? AND version = ?', params: [id, expectedVersion], expectChanges: 1 }]);
  if (done.ok) return ok(undefined);
  return err(done.error.code === 'guard_failed' ? { code: 'conflict' } : { code: 'sql', error: done.error });
}

const RouteRow = z.object({ model_ref: z.string() });

/** 首版只有一个默认模型，所有任务共用（B58 的按任务分配在 P1）。 */
export async function getDefaultModelId(port: SqlPort): Promise<Result<string | null, RepoError>> {
  const row = await queryOne(port, RouteRow, "SELECT model_ref FROM task_routing WHERE task = 'default'");
  return row.ok ? ok(row.value?.model_ref ?? null) : row;
}

export async function setDefaultModel(port: SqlPort, modelRef: string | null, ctx: WriteContext): Promise<Result<void, RepoError>> {
  const done = await port.transaction(
    modelRef === null
      ? [{ sql: "DELETE FROM task_routing WHERE task = 'default'" }]
      : [
          {
            sql: `INSERT INTO task_routing (task, model_ref, updated_at) VALUES ('default', ?, ?)
                  ON CONFLICT (task) DO UPDATE SET model_ref = excluded.model_ref, updated_at = excluded.updated_at`,
            params: [modelRef, ctx.now],
          },
        ],
  );
  return done.ok ? ok(undefined) : err({ code: 'sql', error: done.error });
}
