// 联网搜索与读网页（需求 B84，施工文档 M7-01、M7-02）。
// 外部搜索服务（Tavily、Brave Search、DeepSeek 搜索）由作者自填 API Key，请求经凭据代理发出（凭据条目名是服务标识，
// 或沿用某个模型服务的条目；WebView 拿不到密钥，凭据只发往该服务的源）；“模型自带的联网搜索”（provider）用一个已配置的模型的
// 服务端搜索工具（Anthropic 与 OpenAI 官方接口），走该模型服务的凭据与调用器，记进调用记录。
// 读网页由 Rust 命令 web_fetch 做，不带任何凭据，只读公网主机；读不到时若有 DeepSeek 搜索服务，再用它的 Fetch 接口在服务端抓一次
// （有的网站拦截直接读取）。搜到的摘要与网页正文只是材料：交给 AI 助手与扫榜拆书的榜单，不进作品，怎样对待由提示词规定。
import { err, ok, type Result } from '@fudiao/shared';
import {
  createSearchService,
  listProviders,
  deleteSearchService,
  getDefaultSearchServiceId,
  listSearchServices,
  setDefaultSearchService,
  updateSearchService,
  type RepoError,
  type SearchKind,
  type SearchService,
  type SqlPort,
} from '@fudiao/store';
import { renderWebSearch } from '@fudiao/prompts';
import { z } from 'zod';
import type { AppError } from './errors';
import { describeCredentialError, type ModelServicesView } from './model-services';
import type { ModelChoice, modelRunner } from './model-runner';
import type { AppDeps, CredentialStatus, KeyHeader, WebPage } from './ports';
import { THINKING_ALLOWANCE } from './thinking';

/** 外部搜索服务的种类（要 API Key，经凭据代理）。 */
export type ExternalSearchKind = Exclude<SearchKind, 'provider'>;

export const SEARCH_PRESETS: Readonly<Record<SearchKind, { readonly label: string; readonly baseUrl: string; readonly keyHeader: KeyHeader | null; readonly hint: string }>> = {
  tavily: { label: 'Tavily', baseUrl: 'https://api.tavily.com', keyHeader: 'bearer', hint: '面向 AI 的搜索接口，有免费额度；Key 以 tvly- 开头' },
  brave: { label: 'Brave Search', baseUrl: 'https://api.search.brave.com', keyHeader: 'x_subscription_token', hint: 'Brave 的网页搜索接口，有免费额度' },
  deepseek: {
    label: 'DeepSeek 搜索',
    baseUrl: 'https://api.deepseek.com',
    keyHeader: 'bearer',
    hint: 'DeepSeek 开放平台的 Search 与 Fetch 接口（2026 年 10 月 17 日起开放）：每千次成功请求 5 元，无结果不计费；可以直接沿用已配好的 DeepSeek 模型服务的 Key。中转站一般转发不了这两个接口，地址要填官方的',
  },
  provider: {
    label: '模型自带的联网搜索',
    baseUrl: '',
    keyHeader: null,
    hint: '用 Anthropic 或 OpenAI 官方接口的模型自己联网搜索，不用另外的 API Key；按模型服务计费（两家都是每千次搜索约 10 美元，另计搜到内容的输入 Token），每次搜索记进“用量与费用”。只能选登记了联网搜索能力的模型。',
  },
};

/** DeepSeek 搜索的搜索词上限（接口要求 1 到 128 个字符）。 */
const DEEPSEEK_QUERY_CHARS = 128;

/** 每次搜索最多要几条结果。 */
export const MAX_SEARCH_HITS = 10;
/** 读到的网页交给调用方的字数上限（太长时给开头与结尾）。 */
export const PAGE_CHARS = 6_000;
/** 模型自带的搜索：一次最多搜几次（模型可以换个说法再搜），回答只列结果所以输出不多（另留思考的余量）。 */
export const PROVIDER_SEARCH_MAX_USES = 3;
const PROVIDER_SEARCH_OUTPUT_TOKENS = 1_500;

export type SearchHit = { readonly title: string; readonly url: string; readonly snippet: string };
/** 搜索服务连同凭据状态；沿用模型服务的 Key 时 credentialName 是那个模型服务的名称（找不到时为 null）。 */
export type SearchServiceView = SearchService & { readonly credential: CredentialStatus; readonly credentialName: string | null };
export type SearchServicesView = { readonly services: readonly SearchServiceView[]; readonly defaultServiceId: string | null };
export type SearchServiceForm = {
  readonly kind: SearchKind;
  readonly name: string;
  readonly baseUrl: string;
  readonly enabled?: boolean;
  readonly apiKey: string | null;
  /** 沿用这个模型服务的 API Key（两者的源须相同）；null 或省略为用自己填的 Key。 */
  readonly credentialRef?: string | null;
  /** kind 为 provider 时用哪个模型（模型记录的标识）。 */
  readonly modelId?: string | null;
};

/** 模型自带的搜索要用到的：按所选模型调用，模型与服务从模型服务里查。 */
export type WebSearchDeps = {
  readonly runner: Pick<ReturnType<typeof modelRunner>, 'text'>;
  readonly models: () => Promise<Result<ModelServicesView, AppError>>;
};

const Tavily = z.object({ results: z.array(z.object({ title: z.string().default(''), url: z.string(), content: z.string().default('') })) });
const Brave = z.object({ web: z.object({ results: z.array(z.object({ title: z.string().default(''), url: z.string(), description: z.string().default('') })) }).optional() });
const DeepSeek = z.object({ results: z.array(z.object({ title: z.string().default(''), url: z.string(), snippet: z.string().default(''), summary: z.string().default('') })) });
const DeepSeekPage = z.object({ title: z.string().default(''), content: z.string().default('') });

const repo = (error: RepoError): AppError => ({ code: 'repo', error });
const settings = (detail: string): AppError => ({ code: 'settings', detail });
const NO_CREDENTIAL: CredentialStatus = { stored: false, origin: null, hasSecret: false };

const originOf = (url: string): string | null => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

/** 去掉摘要里的标签与多余空白（搜索服务常把命中的词加粗）。 */
const plain = (text: string) => text.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

/**
 * 向外部搜索服务发请求并解析结果。请求里不带密钥：凭据代理按服务标识注入。
 * 三家的接口都是公开文档里的写法；结果统一成标题、网址与摘要。模型自带的搜索不走这里（见 providerSearch）。
 */
export async function runSearch(kind: ExternalSearchKind, baseUrl: string, fetch: typeof globalThis.fetch, query: string, count: number): Promise<Result<SearchHit[], string>> {
  const n = Math.max(1, Math.min(MAX_SEARCH_HITS, count));
  const json = { 'content-type': 'application/json', accept: 'application/json' };
  let response: Response;
  try {
    response =
      kind === 'tavily'
        ? await fetch(`${baseUrl}/search`, {
            method: 'POST',
            headers: json,
            body: JSON.stringify({ query, max_results: n, search_depth: 'basic', include_answer: false, include_raw_content: false }),
          })
        : kind === 'deepseek'
          ? await fetch(`${baseUrl}/v1/tools/search`, {
              method: 'POST',
              headers: json,
              body: JSON.stringify({ query: [...query].slice(0, DEEPSEEK_QUERY_CHARS).join(''), count: n, need_content: false }),
            })
          : await fetch(`${baseUrl}/res/v1/web/search?q=${encodeURIComponent(query)}&count=${n}`, { headers: { accept: 'application/json' } });
  } catch (e) {
    return err(`连不上搜索服务：${e instanceof Error ? e.message : String(e)}`);
  }
  if (!response.ok) return err(describeSearchStatus(response.status));
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return err('搜索服务返回的不是 JSON');
  }
  if (kind === 'tavily') {
    const parsed = Tavily.safeParse(body);
    if (!parsed.success) return err('搜索服务返回的格式不认识');
    return ok(parsed.data.results.map((r) => ({ title: plain(r.title) || r.url, url: r.url, snippet: plain(r.content) })));
  }
  if (kind === 'deepseek') {
    const parsed = DeepSeek.safeParse(body);
    if (!parsed.success) return err('搜索服务返回的格式不认识');
    // snippet 是给人看的短摘要，summary 是给模型读的长摘要；短的够用，没有时退到长的。
    return ok(parsed.data.results.map((r) => ({ title: plain(r.title) || r.url, url: r.url, snippet: plain(r.snippet) || plain(r.summary) })));
  }
  const parsed = Brave.safeParse(body);
  if (!parsed.success) return err('搜索服务返回的格式不认识');
  return ok((parsed.data.web?.results ?? []).map((r) => ({ title: plain(r.title) || r.url, url: r.url, snippet: plain(r.description) })));
}

function describeSearchStatus(status: number): string {
  if (status === 401 || status === 403) return `搜索服务拒绝了请求（${status}）：请检查 API Key`;
  if (status === 402) return '搜索服务返回 402：账户余额不足';
  if (status === 429) return '搜索服务返回 429：请求太频繁，稍后再试';
  return `搜索服务返回 ${status}`;
}

/** DeepSeek 的 Fetch 接口：在服务端抓一个网页，返回标题与 Markdown 正文；404 表示抓不到可用的正文。 */
export async function deepseekFetch(baseUrl: string, fetch: typeof globalThis.fetch, url: string): Promise<Result<WebPage, string>> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/v1/tools/fetch`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ url }) });
  } catch (e) {
    return err(`连不上 DeepSeek：${e instanceof Error ? e.message : String(e)}`);
  }
  if (response.status === 404) return err('DeepSeek 也抓不到这个网页的正文');
  if (response.status === 403) return err('DeepSeek 按安全策略拒绝抓取这个地址');
  if (!response.ok) return err(describeSearchStatus(response.status));
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return err('DeepSeek 返回的不是 JSON');
  }
  const parsed = DeepSeekPage.safeParse(body);
  if (!parsed.success) return err('DeepSeek 返回的格式不认识');
  const text = parsed.data.content.trim();
  if (text === '') return err('DeepSeek 抓到的网页没有正文');
  return ok({ url, title: parsed.data.title.trim() === '' ? null : parsed.data.title.trim(), text, truncated: false });
}

/** 太长的网页只留开头与结尾。 */
export function clipPage(page: WebPage, limit = PAGE_CHARS): WebPage & { readonly clipped: boolean } {
  const chars = [...page.text];
  if (chars.length <= limit) return { ...page, clipped: page.truncated };
  const half = Math.floor(limit / 2);
  return { ...page, text: `${chars.slice(0, half).join('')}\n……\n${chars.slice(-half).join('')}`, clipped: true };
}

/** 模型自带的搜索用的模型与服务；模型删掉或没登记能力时说明怎么办。 */
export function providerSearchModel(service: SearchService, view: ModelServicesView): Result<ModelChoice, AppError> {
  const model = view.models.find((m) => m.id === service.modelId);
  const provider = view.providers.find((p) => p.id === model?.providerId);
  if (service.modelId === null || model === undefined || provider === undefined) {
    return err(settings(`搜索服务“${service.name}”用的模型已删除：请在“模型服务”页的“联网搜索”里重新选择模型`));
  }
  if (!model.capabilities.webSearch) {
    return err(settings(`模型“${model.displayName}”没有登记“模型自带的联网搜索”能力：请在它的“能力与价格”里勾选，或给搜索服务换一个模型`));
  }
  return ok({ provider, model });
}

export function webUseCases(deps: AppDeps, search: WebSearchDeps) {
  let db: SqlPort | null = null;
  const ctx = () => ({ now: deps.clock.now() });

  async function port(): Promise<Result<SqlPort, AppError>> {
    if (db !== null) return ok(db);
    const opened = await deps.settingsDb.open(deps.clock.now());
    if (!opened.ok) return err(settings(`无法打开应用设置：${opened.error}`));
    db = opened.value;
    return ok(db);
  }

  async function view(): Promise<Result<SearchServicesView, AppError>> {
    const p = await port();
    if (!p.ok) return p;
    const services = await listSearchServices(p.value);
    if (!services.ok) return err(repo(services.error));
    const defaultServiceId = await getDefaultSearchServiceId(p.value);
    if (!defaultServiceId.ok) return err(repo(defaultServiceId.error));
    const providers = await listProviders(p.value);
    if (!providers.ok) return err(repo(providers.error));
    const withStatus: SearchServiceView[] = [];
    for (const s of services.value) {
      if (s.kind === 'provider') {
        // 模型自带的搜索没有自己的凭据：用的是模型服务的。
        withStatus.push({ ...s, credential: NO_CREDENTIAL, credentialName: null });
        continue;
      }
      // 沿用模型服务的 Key 时看那个条目；模型服务已删除就当没有凭据。
      const ref = s.credentialRef === null ? null : (providers.value.find((x) => x.id === s.credentialRef) ?? null);
      const status = s.credentialRef !== null && ref === null ? null : await deps.credentials.status(s.credentialRef ?? s.id);
      withStatus.push({ ...s, credential: status?.ok === true ? status.value : NO_CREDENTIAL, credentialName: ref?.name ?? null });
    }
    return ok({ services: withStatus, defaultServiceId: defaultServiceId.value });
  }

  /** 默认的搜索服务（启用且配置完整）；没有时说明怎么配。 */
  async function defaultService(): Promise<Result<SearchServiceView, AppError>> {
    const current = await view();
    if (!current.ok) return current;
    const service = current.value.services.find((s) => s.id === current.value.defaultServiceId) ?? current.value.services.find((s) => s.enabled);
    if (service === undefined) {
      return err(settings('还没有配置联网搜索服务：在“模型服务”页的“联网搜索”里添加 DeepSeek 搜索（可沿用模型服务的 Key）、Tavily、Brave Search，或选一个自带联网搜索的模型'));
    }
    if (!service.enabled) return err(settings(`搜索服务“${service.name}”已停用`));
    if (service.kind === 'provider') return ok(service);
    if (!usable(service)) {
      return err(
        settings(
          service.credentialRef === null
            ? `搜索服务“${service.name}”还没有填 API Key（或地址改过）：在“模型服务”页重新填写`
            : `搜索服务“${service.name}”沿用的模型服务没有 Key 或地址对不上：在“模型服务”页检查`,
        ),
      );
    }
    return ok(service);
  }

  /** 凭据在、且绑定的源与搜索服务的地址一致。 */
  const usable = (service: SearchServiceView) => service.credential.hasSecret && service.credential.origin === originOf(service.baseUrl);

  /**
   * 写凭据：模型自带的搜索不需要凭据（从别的种类改过来时把原来自己的条目删掉）；沿用模型服务的 Key 时不存自己的条目（原来有就删掉），
   * 只核对那个模型服务的凭据在、且源相同；否则给出了密钥就保存；没给且地址的源没变就沿用。
   */
  async function saveCredential(id: string, form: SearchServiceForm, current: SearchServiceView | null): Promise<Result<void, AppError>> {
    const header = SEARCH_PRESETS[form.kind].keyHeader;
    if (header === null) {
      if (current !== null && current.kind !== 'provider' && current.credentialRef === null) await deps.credentials.remove(id);
      return ok(undefined);
    }
    const origin = originOf(form.baseUrl.trim());
    if (form.credentialRef !== undefined && form.credentialRef !== null) {
      const status = await deps.credentials.status(form.credentialRef);
      if (!status.ok || !status.value.hasSecret) return err(settings('沿用的模型服务还没有填 API Key'));
      if (status.value.origin !== origin) return err(settings(`沿用的模型服务地址与搜索服务不是同一个源（${status.value.origin ?? ''}），不能共用 Key：改成相同的地址，或者单独填 Key`));
      if (current !== null && current.credentialRef === null) await deps.credentials.remove(id);
      return ok(undefined);
    }
    const key = form.apiKey?.trim() ?? '';
    if (key === '') {
      const own = current === null || current.kind === 'provider' || current.credentialRef !== null ? null : current.credential;
      if (own?.hasSecret === true && own.origin === origin) return ok(undefined);
      return err(settings(own?.hasSecret === true ? '更改服务地址后须重新填写 API Key' : '请填写 API Key'));
    }
    const saved = await deps.credentials.set(id, form.baseUrl, header, key);
    return saved.ok ? ok(undefined) : err(settings(describeCredentialError(saved.error)));
  }

  const fetchFor = (service: SearchService) => deps.web.searchFetch(service.credentialRef ?? service.id);

  /**
   * 模型自带的搜索：只搜不写 JSON 的一次调用（搜索工具的结果块与引用由适配器整理成标题、网址、摘要；
   * 模型的正文只是给作者看的转述，程序不解析它）。调用经调用器记进当前作品的调用记录。
   */
  async function providerSearch(service: SearchService, query: string, count: number): Promise<Result<SearchHit[], AppError>> {
    const models = await search.models();
    if (!models.ok) return models;
    const choice = providerSearchModel(service, models.value);
    if (!choice.ok) return choice;
    const prompt = renderWebSearch(query, count);
    if (!prompt.ok) return err(settings(prompt.error));
    const result = await search.runner.text({
      prompt: prompt.value,
      maxOutputTokens: PROVIDER_SEARCH_OUTPUT_TOKENS + THINKING_ALLOWANCE,
      effort: 'low',
      model: choice.value,
      tools: [{ type: 'web_search', maxUses: PROVIDER_SEARCH_MAX_USES }],
    });
    if (!result.ok) return result;
    const r = result.value;
    if (r.outcome === 'refused') return err(settings(`模型拒绝了这次搜索${r.refusal?.explanation ? `：${r.refusal.explanation}` : ''}`));
    if (r.outcome === 'cancelled') return err(settings('搜索已取消'));
    const found = r.webSearch;
    if (found === undefined) return err(settings(`模型“${choice.value.model.displayName}”没有执行搜索`));
    if (found.results.length === 0 && found.error !== undefined) return err(settings(`模型的搜索工具出错（${found.error}），没有搜到结果`));
    return ok(found.results.slice(0, count).map((h) => ({ title: h.title || h.url, url: h.url, snippet: h.snippet })));
  }

  async function doSearch(service: SearchServiceView, query: string, count: number): Promise<Result<SearchHit[], AppError>> {
    const q = query.trim();
    if (q === '') return err(settings('搜索词不能为空'));
    const n = Math.max(1, Math.min(MAX_SEARCH_HITS, count));
    if (service.kind === 'provider') return providerSearch(service, q, n);
    const hits = await runSearch(service.kind, service.baseUrl, fetchFor(service), q, n);
    return hits.ok ? hits : err(settings(hits.error));
  }

  /** 可用的 DeepSeek 搜索服务（默认的优先）：读网页读不到时用它的 Fetch 接口再试。 */
  async function deepseekService(): Promise<SearchServiceView | null> {
    const current = await view();
    if (!current.ok) return null;
    const candidates = current.value.services.filter((s) => s.kind === 'deepseek' && s.enabled && usable(s));
    return candidates.find((s) => s.id === current.value.defaultServiceId) ?? candidates[0] ?? null;
  }

  return {
    loadSearchServices: view,

    /** 新建（service 为 null）或修改搜索服务；API Key 写入系统凭据管理器。第一个服务成为默认。 */
    async saveSearchService(service: SearchServiceView | null, form: SearchServiceForm): Promise<Result<SearchServicesView, AppError>> {
      const p = await port();
      if (!p.ok) return p;
      const id = service?.id ?? deps.ids.next();
      const credential = await saveCredential(id, form, service);
      if (!credential.ok) return credential;
      const saved = service === null ? await createSearchService(p.value, id, form, ctx()) : await updateSearchService(p.value, id, service.version, form, ctx());
      if (!saved.ok) {
        if (service === null) await deps.credentials.remove(id);
        return err(repo(saved.error));
      }
      const current = await getDefaultSearchServiceId(p.value);
      if (current.ok && current.value === null) await setDefaultSearchService(p.value, id, ctx());
      return view();
    },

    /** 删除搜索服务；凭据管理器中的条目一并删除。 */
    async deleteSearchService(service: SearchServiceView): Promise<Result<SearchServicesView, AppError>> {
      const p = await port();
      if (!p.ok) return p;
      const removed = await deleteSearchService(p.value, service.id, service.version);
      if (!removed.ok) return err(repo(removed.error));
      // 沿用模型服务的 Key 或模型自带的搜索都没有自己的条目，模型服务的条目不动。
      if (service.kind !== 'provider' && service.credentialRef === null) {
        const credential = await deps.credentials.remove(service.id);
        if (!credential.ok) return err(settings(`服务已删除，但凭据管理器中的条目没有删掉：${credential.error}`));
      }
      return view();
    },

    async setDefaultSearchService(serviceId: string): Promise<Result<SearchServicesView, AppError>> {
      const p = await port();
      if (!p.ok) return p;
      const done = await setDefaultSearchService(p.value, serviceId, ctx());
      return done.ok ? view() : err(repo(done.error));
    },

    /** 用一个固定的搜索词试一次：凭据、地址与接口格式（或所选模型的搜索工具）都对才算通过。返回搜到几条与第一条的标题。 */
    async testSearchService(serviceId: string): Promise<Result<{ readonly hits: number; readonly first: string | null }, AppError>> {
      const current = await view();
      if (!current.ok) return current;
      const service = current.value.services.find((s) => s.id === serviceId);
      if (service === undefined) return err({ code: 'not_found' });
      const hits = await doSearch(service, '中文网络小说 月票榜', 3);
      return hits.ok ? ok({ hits: hits.value.length, first: hits.value[0]?.title ?? null }) : hits;
    },

    /** 用默认的搜索服务搜公开网页，返回标题、网址与摘要。 */
    async webSearch(query: string, count = 8): Promise<Result<{ readonly service: string; readonly hits: readonly SearchHit[] }, AppError>> {
      const service = await defaultService();
      if (!service.ok) return service;
      const hits = await doSearch(service.value, query, count);
      return hits.ok ? ok({ service: service.value.name, hits: hits.value }) : hits;
    },

    /**
     * 读一个公开网页的正文（不带凭据，由 Rust 校验地址）；太长时只给开头与结尾。
     * 直接读不到（网站拦截、不是文字、超时）而有 DeepSeek 搜索服务时，再用它的 Fetch 接口在服务端抓一次；
     * 地址本身不许读（本机、局域网、格式不对）的不再试。
     */
    async readWebPage(url: string, limit = PAGE_CHARS): Promise<Result<WebPage & { readonly clipped: boolean }, AppError>> {
      const target = url.trim();
      const page = await deps.web.readPage(target);
      if (page.ok) return ok(clipPage(page.value, limit));
      const kind = page.error.split(':', 1)[0];
      if (kind === 'host_not_allowed' || kind === 'invalid_url') return err(settings(describeWebError(page.error)));
      const deepseek = await deepseekService();
      if (deepseek === null) return err(settings(describeWebError(page.error)));
      const fetched = await deepseekFetch(deepseek.baseUrl, fetchFor(deepseek), target);
      if (!fetched.ok) return err(settings(`${describeWebError(page.error)}；${fetched.error}`));
      return ok(clipPage(fetched.value, limit));
    },
  };
}

/** Rust 的 WebError 转成给作者看的说明。 */
export function describeWebError(code: string): string {
  const [kind = '', detail] = code.split(':', 2);
  switch (kind) {
    case 'invalid_url':
      return detail === undefined || detail === '' ? '网址无效' : detail;
    case 'host_not_allowed':
      return `这个地址不能读（${detail ?? ''}）：只能读公网上的网页，不能是本机或局域网`;
    case 'too_many_redirects':
      return '网页跳转次数太多';
    case 'status':
      return `网页返回 ${detail ?? ''}`;
    case 'not_text':
      return `这个地址不是网页或纯文本（${detail ?? ''}）`;
    case 'timeout':
      return '读网页超时';
    case 'network':
      return `读网页失败：${detail ?? ''}`;
    default:
      return code;
  }
}

export type WebUseCases = ReturnType<typeof webUseCases>;
