// 模型服务的用例（需求 B15、施工文档第五章）：服务、凭据、模型、默认模型与连接测试。
// 服务配置在应用设置库 app.sqlite；API Key 经凭据端口写入系统凭据管理器，界面与这里都拿不到明文。
import {
  COMPATIBLE_DIALECT,
  CONSERVATIVE_CAPABILITIES,
  isModelLister,
  PLACEHOLDER_API_KEY,
  runSelfTest,
  testConnection,
  type ConnectionReport,
  type ListedModel,
  type LlmPort,
  type ModelCapabilities,
  type ModelLister,
  type SelfTestReport,
} from '@fudiao/llm';
import { checkSelfTest, renderConnectionTest, renderSelfTest, SelfTestOutput } from '@fudiao/prompts';
import { err, ok, type Result } from '@fudiao/shared';
import {
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
  type ModelPatch,
  type Provider,
  type ProviderInput,
  type ProviderKind,
  type RepoError,
  type SqlPort,
  type StoredCapabilities,
  type StoredModel,
  type StoredPrices,
} from '@fudiao/store';
import { BUILTIN_MODELS, builtinModel, type BuiltinModel } from './builtin-models';
import type { AppError } from './errors';
import type { AppDeps, CredentialStatus, KeyHeader } from './ports';

/** 新添加的模型按保守能力处理（施工文档第五章）。存储与模型端口的能力描述须一致，否则这里通不过类型检查。 */
const NEW_MODEL_CAPABILITIES: StoredCapabilities = CONSERVATIVE_CAPABILITIES satisfies ModelCapabilities;

/** 各服务种类的默认地址与认证方式。地址是服务的接口地址，不是模型名称（硬性规则 13 只禁止写死模型）。 */
export const PROVIDER_PRESETS: Readonly<Record<ProviderKind, { readonly label: string; readonly baseUrl: string; readonly keyHeader: KeyHeader | null }>> = {
  anthropic: { label: 'Anthropic', baseUrl: 'https://api.anthropic.com', keyHeader: 'x_api_key' },
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', keyHeader: 'bearer' },
  gemini: { label: 'Google Gemini（兼容模式）', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keyHeader: 'bearer' },
  openai_compatible: { label: 'OpenAI 兼容接口', baseUrl: '', keyHeader: 'bearer' },
  local: { label: '本地端点', baseUrl: 'http://127.0.0.1:11434/v1', keyHeader: null },
};

/**
 * 为服务建立适配器。SDK 的 API Key 填占位值，真实凭据由凭据代理注入。
 * 适配器连同官方 SDK（打包后约占界面脚本的一半）在第一次调用时才载入，启动时不必解析它们。
 */
export function buildAdapter(provider: Provider, fetch: typeof globalThis.fetch): LlmPort & ModelLister {
  let loaded: Promise<LlmPort & ModelLister> | null = null;
  const load = () =>
    (loaded ??= import('@fudiao/llm/adapters').then(({ AnthropicAdapter, OpenAIAdapter, OpenAIChatAdapter }) => {
      if (provider.kind === 'anthropic') return new AnthropicAdapter({ apiKey: PLACEHOLDER_API_KEY, baseURL: provider.baseUrl, fetch, viaCredentialProxy: true });
      // OpenAI 官方接口用 Responses API；Gemini（兼容模式）、兼容接口与本地端点用 Chat Completions。
      if (provider.kind === 'openai') return new OpenAIAdapter({ apiKey: PLACEHOLDER_API_KEY, baseURL: provider.baseUrl, fetch, viaCredentialProxy: true });
      // Gemini 的兼容端点不在正文中输出思考标签。
      const base = provider.kind === 'gemini' ? { ...COMPATIBLE_DIALECT, stripThinkTags: false } : COMPATIBLE_DIALECT;
      return new OpenAIChatAdapter({ apiKey: PLACEHOLDER_API_KEY, baseURL: provider.baseUrl, fetch, dialect: { ...base, ...provider.dialect }, viaCredentialProxy: true });
    }));
  return {
    complete: async (request, options) => (await load()).complete(request, options),
    listModels: async (options) => (await load()).listModels(options),
  };
}

/**
 * 新模型的能力与价格：保守能力 ← 内置能力表 ← 服务返回的信息（施工文档第五章的来源顺序）；价格只来自内置表。
 * 自检结果总是从“未通过”开始。
 */
export function resolveModel(
  kind: ProviderKind,
  modelId: string,
  listed: ListedModel | null,
  table: readonly BuiltinModel[] = BUILTIN_MODELS,
): { capabilities: StoredCapabilities; prices: StoredPrices | null; source: 'service' | 'builtin' | 'user'; displayName: string } {
  const builtin = table.find((b) => b.kind === kind && b.modelId === modelId);
  const fromService = listed !== null && Object.keys(listed.capabilities).length > 0;
  return {
    capabilities: { ...NEW_MODEL_CAPABILITIES, ...builtin?.capabilities, ...(listed?.capabilities ?? {}), selfTestPassed: false },
    prices: builtin?.prices ?? null,
    source: fromService ? 'service' : builtin !== undefined ? 'builtin' : listed !== null ? 'service' : 'user',
    displayName: listed?.displayName ?? builtin?.displayName ?? modelId,
  };
}

export type ProviderView = Provider & { readonly credential: CredentialStatus };
export type ModelServicesView = {
  readonly providers: readonly ProviderView[];
  readonly models: readonly StoredModel[];
  readonly defaultModelId: string | null;
};

/** 保存服务时一并给出的 API Key；null 表示不更改（地址的源不变时）。 */
export type ProviderForm = ProviderInput & { readonly apiKey: string | null };

/** 凭据端口的错误码（Rust 的 CredentialError 与 NetError）转为给作者看的说明。 */
export function describeCredentialError(code: string): string {
  if (code.startsWith('store:')) return `系统凭据管理器读写失败：${code.slice('store:'.length)}`;
  switch (code) {
    case 'insecure_scheme':
      return '需要 API Key 的服务必须使用 https 地址（本机地址除外）';
    case 'host_not_allowed':
      return '不需要 API Key 的本地端点只能是本机地址（127.0.0.1 或 localhost）';
    case 'invalid_request':
      return '服务地址无效';
    case 'missing_secret':
      return '请填写 API Key';
    default:
      return code;
  }
}

const originOf = (url: string): string | null => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

export function modelServices(deps: AppDeps) {
  let db: SqlPort | null = null;
  const ctx = () => ({ now: deps.clock.now() });
  const repo = (error: RepoError): AppError => ({ code: 'repo', error });
  const library = (detail: string): AppError => ({ code: 'settings', detail });

  async function port(): Promise<Result<SqlPort, AppError>> {
    if (db !== null) return ok(db);
    const opened = await deps.settingsDb.open(deps.clock.now());
    if (!opened.ok) return err(library(`无法打开应用设置：${opened.error}`));
    db = opened.value;
    return ok(db);
  }

  async function view(): Promise<Result<ModelServicesView, AppError>> {
    const p = await port();
    if (!p.ok) return p;
    const providers = await listProviders(p.value);
    if (!providers.ok) return err(repo(providers.error));
    const models = await listModels(p.value);
    if (!models.ok) return err(repo(models.error));
    const defaultModelId = await getDefaultModelId(p.value);
    if (!defaultModelId.ok) return err(repo(defaultModelId.error));
    const withStatus: ProviderView[] = [];
    for (const provider of providers.value) {
      const status = await deps.credentials.status(provider.id);
      withStatus.push({ ...provider, credential: status.ok ? status.value : { stored: false, origin: null, hasSecret: false } });
    }
    await deps.credentials.setLimits(providers.value.map((x) => [x.id, x.concurrency] as const));
    return ok({ providers: withStatus, models: models.value, defaultModelId: defaultModelId.value });
  }

  /** 写入凭据：给出了密钥就保存；没给且地址的源变了，要求重新填写；本地端点只记录绑定的地址。 */
  async function saveCredential(id: string, form: ProviderForm, current: CredentialStatus | null): Promise<Result<void, AppError>> {
    const header = PROVIDER_PRESETS[form.kind].keyHeader;
    if (form.authMethod === 'none') {
      const saved = await deps.credentials.set(id, form.baseUrl, null, null);
      return saved.ok ? ok(undefined) : err(library(describeCredentialError(saved.error)));
    }
    const key = form.apiKey?.trim() ?? '';
    if (key === '') {
      if (current?.hasSecret === true && current.origin === originOf(form.baseUrl.trim())) return ok(undefined);
      return err(library(current?.hasSecret === true ? '更改服务地址后须重新填写 API Key' : '请填写 API Key'));
    }
    const saved = await deps.credentials.set(id, form.baseUrl, header ?? 'bearer', key);
    return saved.ok ? ok(undefined) : err(library(describeCredentialError(saved.error)));
  }

  return {
    loadModelServices: view,

    /** 默认模型及其服务；没有设置时为 null。 */
    async defaultModel(): Promise<Result<{ provider: ProviderView; model: StoredModel } | null, AppError>> {
      const current = await view();
      if (!current.ok) return current;
      const model = current.value.models.find((m) => m.id === current.value.defaultModelId);
      const provider = current.value.providers.find((x) => x.id === model?.providerId);
      return ok(model === undefined || provider === undefined ? null : { provider, model });
    },

    /** 新建（provider 为 null）或修改服务；API Key 写入系统凭据管理器。 */
    async saveProvider(provider: ProviderView | null, form: ProviderForm): Promise<Result<ModelServicesView, AppError>> {
      const p = await port();
      if (!p.ok) return p;
      const id = provider?.id ?? deps.ids.next();
      // 先写凭据：凭据的地址检查（https、本地端点只允许回环地址）不通过时，服务也不保存。
      const credential = await saveCredential(id, form, provider?.credential ?? null);
      if (!credential.ok) return credential;
      const saved = provider === null ? await createProvider(p.value, id, form, ctx()) : await updateProvider(p.value, id, provider.version, form, ctx());
      if (!saved.ok) {
        if (provider === null) await deps.credentials.remove(id);
        return err(repo(saved.error));
      }
      return view();
    },

    /** 删除服务连同它的模型；凭据管理器中的条目一并删除。 */
    async deleteProvider(provider: ProviderView): Promise<Result<ModelServicesView, AppError>> {
      const p = await port();
      if (!p.ok) return p;
      const removed = await deleteProvider(p.value, provider.id, provider.version);
      if (!removed.ok) return err(repo(removed.error));
      const credential = await deps.credentials.remove(provider.id);
      if (!credential.ok) return err(library(`服务已删除，但凭据管理器中的条目没有删掉：${credential.error}`));
      return view();
    },

    /** 获取服务的可用模型（B56）。 */
    async fetchModelList(providerId: string): Promise<Result<readonly ListedModel[], AppError>> {
      const current = await view();
      if (!current.ok) return current;
      const provider = current.value.providers.find((x) => x.id === providerId);
      if (provider === undefined) return err({ code: 'not_found' });
      const adapter = deps.llm.forProvider(provider);
      if (!isModelLister(adapter)) return err(library('这类服务不支持获取模型列表，请手动填写模型名称'));
      const listed = await adapter.listModels();
      return listed.ok ? ok(listed.value) : err(library(`获取模型列表失败（${listed.error.code}）：${listed.error.message}`));
    },

    /**
     * 添加模型：从列表中选的带上服务返回的信息，手动填写的只有名称。能力与价格按 resolveModel 合并；
     * 还没有默认模型时设为默认。
     */
    async addModel(providerId: string, modelId: string, listed: ListedModel | null = null): Promise<Result<ModelServicesView, AppError>> {
      const p = await port();
      if (!p.ok) return p;
      const current = await view();
      if (!current.ok) return current;
      const provider = current.value.providers.find((x) => x.id === providerId);
      if (provider === undefined) return err({ code: 'not_found' });
      const resolved = resolveModel(provider.kind, modelId.trim(), listed);
      const created = await createModel(p.value, deps.ids.next(), { providerId, modelId, ...resolved }, ctx());
      if (!created.ok) return err(repo(created.error));
      if (current.value.defaultModelId === null) await setDefaultModel(p.value, created.value.id, ctx());
      return view();
    },

    /** 作者修改模型的能力与价格（B56 的用户覆盖）。 */
    async updateModel(model: StoredModel, patch: ModelPatch): Promise<Result<ModelServicesView, AppError>> {
      const p = await port();
      if (!p.ok) return p;
      const updated = await updateModel(p.value, model, patch, ctx());
      return updated.ok ? view() : err(repo(updated.error));
    },

    /**
     * 采用内置表中这个模型的能力与价格（内置表随应用更新；早先添加的模型不会自动跟上）。自检结果保留，
     * 结构化输出方式变了时须重新自检（与作者修改相同）。
     */
    async applyBuiltinModel(modelId: string): Promise<Result<ModelServicesView, AppError>> {
      const p = await port();
      if (!p.ok) return p;
      const current = await view();
      if (!current.ok) return current;
      const model = current.value.models.find((m) => m.id === modelId);
      const provider = current.value.providers.find((x) => x.id === model?.providerId);
      if (model === undefined || provider === undefined) return err({ code: 'not_found' });
      const builtin = builtinModel(provider.kind, model.modelId);
      if (builtin === undefined) return err(library('内置表中没有这个模型'));
      const updated = await updateModel(
        p.value,
        model,
        { displayName: model.displayName, capabilities: { ...model.capabilities, ...builtin.capabilities }, prices: builtin.prices ?? model.prices },
        ctx(),
      );
      return updated.ok ? view() : err(repo(updated.error));
    },

    /** 能力自检（B57）：连续三次通过才可用于必须输出结构化数据的任务；结果写入模型记录。 */
    async runSelfTest(modelId: string, signal?: AbortSignal): Promise<Result<{ view: ModelServicesView; report: SelfTestReport }, AppError>> {
      const p = await port();
      if (!p.ok) return p;
      const current = await view();
      if (!current.ok) return current;
      const model = current.value.models.find((m) => m.id === modelId);
      const provider = current.value.providers.find((x) => x.id === model?.providerId);
      if (model === undefined || provider === undefined) return err({ code: 'not_found' });
      const prompt = renderSelfTest();
      if (!prompt.ok || prompt.value.output === undefined) return err(library(prompt.ok ? '自检模板缺少输出结构' : prompt.error));
      const report = await runSelfTest(
        deps.llm.forProvider(provider),
        { provider: provider.id, model: model.modelId, capabilities: model.capabilities, ...(model.prices !== null && { prices: model.prices }) },
        { template: prompt.value.template, system: prompt.value.system, messages: prompt.value.messages, output: prompt.value.output },
        SelfTestOutput,
        checkSelfTest,
        signal === undefined ? {} : { signal },
      );
      const recorded = await recordSelfTest(p.value, model, { status: report.passed ? 'passed' : 'failed', at: deps.clock.now(), reason: report.reason }, ctx());
      if (!recorded.ok) return err(repo(recorded.error));
      const next = await view();
      return next.ok ? ok({ view: next.value, report }) : next;
    },

    async deleteModel(model: StoredModel): Promise<Result<ModelServicesView, AppError>> {
      const p = await port();
      if (!p.ok) return p;
      const removed = await deleteModel(p.value, model.id, model.version);
      return removed.ok ? view() : err(repo(removed.error));
    },

    async setDefaultModel(modelId: string): Promise<Result<ModelServicesView, AppError>> {
      const p = await port();
      if (!p.ok) return p;
      const done = await setDefaultModel(p.value, modelId, ctx());
      return done.ok ? view() : err(repo(done.error));
    },

    /** 连接测试：向这个模型发一个最小请求，给出延迟、实际模型与错误原因。 */
    async testConnection(modelId: string, signal?: AbortSignal): Promise<Result<ConnectionReport, AppError>> {
      const current = await view();
      if (!current.ok) return current;
      const model = current.value.models.find((m) => m.id === modelId);
      const provider = current.value.providers.find((x) => x.id === model?.providerId);
      if (model === undefined || provider === undefined) return err({ code: 'not_found' });
      const prompt = renderConnectionTest();
      if (!prompt.ok) return err(library(prompt.error));
      const report = await testConnection(
        deps.llm.forProvider(provider),
        { provider: provider.id, model: model.modelId, capabilities: model.capabilities, ...(model.prices !== null && { prices: model.prices }) },
        prompt.value,
        () => Date.parse(deps.clock.now()),
        signal,
      );
      return ok(report);
    },
  };
}
