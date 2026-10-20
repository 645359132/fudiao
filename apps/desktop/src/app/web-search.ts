// 联网搜索与读网页（需求 B84，施工文档 M7-01）。
// 搜索服务（Tavily、Brave Search）由作者自填 API Key，请求经凭据代理发出（服务标识即凭据条目名，WebView 拿不到密钥，
// 凭据只发往该服务的源）；读网页由 Rust 命令 web_fetch 做，不带任何凭据，只读公网主机。
// 搜到的摘要与网页正文只是材料：交给 AI 助手与扫榜拆书的榜单，不进作品，怎样对待由提示词规定。
import { err, ok, type Result } from '@fudiao/shared';
import {
  createSearchService,
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
import { z } from 'zod';
import type { AppError } from './errors';
import { describeCredentialError } from './model-services';
import type { AppDeps, CredentialStatus, KeyHeader, WebPage } from './ports';

export const SEARCH_PRESETS: Readonly<Record<SearchKind, { readonly label: string; readonly baseUrl: string; readonly keyHeader: KeyHeader; readonly hint: string }>> = {
  tavily: { label: 'Tavily', baseUrl: 'https://api.tavily.com', keyHeader: 'bearer', hint: '面向 AI 的搜索接口，有免费额度；Key 以 tvly- 开头' },
  brave: { label: 'Brave Search', baseUrl: 'https://api.search.brave.com', keyHeader: 'x_subscription_token', hint: 'Brave 的网页搜索接口，有免费额度' },
};

/** 每次搜索最多要几条结果。 */
export const MAX_SEARCH_HITS = 10;
/** 读到的网页交给调用方的字数上限（太长时给开头与结尾）。 */
export const PAGE_CHARS = 6_000;

export type SearchHit = { readonly title: string; readonly url: string; readonly snippet: string };
export type SearchServiceView = SearchService & { readonly credential: CredentialStatus };
export type SearchServicesView = { readonly services: readonly SearchServiceView[]; readonly defaultServiceId: string | null };
export type SearchServiceForm = { readonly kind: SearchKind; readonly name: string; readonly baseUrl: string; readonly enabled?: boolean; readonly apiKey: string | null };

const Tavily = z.object({ results: z.array(z.object({ title: z.string().default(''), url: z.string(), content: z.string().default('') })) });
const Brave = z.object({ web: z.object({ results: z.array(z.object({ title: z.string().default(''), url: z.string(), description: z.string().default('') })) }).optional() });

const repo = (error: RepoError): AppError => ({ code: 'repo', error });
const settings = (detail: string): AppError => ({ code: 'settings', detail });

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
 * 向搜索服务发请求并解析结果。请求里不带密钥：凭据代理按服务标识注入。
 * 两家的接口都是公开文档里的写法；结果统一成标题、网址与摘要。
 */
export async function runSearch(kind: SearchKind, baseUrl: string, fetch: typeof globalThis.fetch, query: string, count: number): Promise<Result<SearchHit[], string>> {
  const n = Math.max(1, Math.min(MAX_SEARCH_HITS, count));
  let response: Response;
  try {
    response =
      kind === 'tavily'
        ? await fetch(`${baseUrl}/search`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ query, max_results: n, search_depth: 'basic', include_answer: false, include_raw_content: false }),
          })
        : await fetch(`${baseUrl}/res/v1/web/search?q=${encodeURIComponent(query)}&count=${n}`, { headers: { accept: 'application/json' } });
  } catch (e) {
    return err(`连不上搜索服务：${e instanceof Error ? e.message : String(e)}`);
  }
  if (!response.ok) return err(response.status === 401 || response.status === 403 ? `搜索服务拒绝了请求（${response.status}）：请检查 API Key` : `搜索服务返回 ${response.status}`);
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
  const parsed = Brave.safeParse(body);
  if (!parsed.success) return err('搜索服务返回的格式不认识');
  return ok((parsed.data.web?.results ?? []).map((r) => ({ title: plain(r.title) || r.url, url: r.url, snippet: plain(r.description) })));
}

/** 太长的网页只留开头与结尾。 */
export function clipPage(page: WebPage, limit = PAGE_CHARS): WebPage & { readonly clipped: boolean } {
  const chars = [...page.text];
  if (chars.length <= limit) return { ...page, clipped: page.truncated };
  const half = Math.floor(limit / 2);
  return { ...page, text: `${chars.slice(0, half).join('')}\n……\n${chars.slice(-half).join('')}`, clipped: true };
}

export function webUseCases(deps: AppDeps) {
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
    const withStatus: SearchServiceView[] = [];
    for (const s of services.value) {
      const status = await deps.credentials.status(s.id);
      withStatus.push({ ...s, credential: status.ok ? status.value : { stored: false, origin: null, hasSecret: false } });
    }
    return ok({ services: withStatus, defaultServiceId: defaultServiceId.value });
  }

  /** 默认的搜索服务（启用且有凭据）；没有时说明怎么配。 */
  async function defaultService(): Promise<Result<SearchServiceView, AppError>> {
    const current = await view();
    if (!current.ok) return current;
    const service = current.value.services.find((s) => s.id === current.value.defaultServiceId) ?? current.value.services.find((s) => s.enabled);
    if (service === undefined) return err(settings('还没有配置联网搜索服务：在“模型服务”页的“联网搜索”里添加 Tavily 或 Brave Search 并填 API Key'));
    if (!service.enabled) return err(settings(`搜索服务“${service.name}”已停用`));
    if (!service.credential.hasSecret || service.credential.origin !== originOf(service.baseUrl)) return err(settings(`搜索服务“${service.name}”还没有填 API Key（或地址改过）：在“模型服务”页重新填写`));
    return ok(service);
  }

  async function saveCredential(id: string, form: SearchServiceForm, current: CredentialStatus | null): Promise<Result<void, AppError>> {
    const key = form.apiKey?.trim() ?? '';
    if (key === '') {
      if (current?.hasSecret === true && current.origin === originOf(form.baseUrl.trim())) return ok(undefined);
      return err(settings(current?.hasSecret === true ? '更改服务地址后须重新填写 API Key' : '请填写 API Key'));
    }
    const saved = await deps.credentials.set(id, form.baseUrl, SEARCH_PRESETS[form.kind].keyHeader, key);
    return saved.ok ? ok(undefined) : err(settings(describeCredentialError(saved.error)));
  }

  async function search(service: SearchServiceView, query: string, count: number): Promise<Result<SearchHit[], AppError>> {
    const q = query.trim();
    if (q === '') return err(settings('搜索词不能为空'));
    const hits = await runSearch(service.kind, service.baseUrl, deps.web.searchFetch(service.id), q, count);
    return hits.ok ? hits : err(settings(hits.error));
  }

  return {
    loadSearchServices: view,

    /** 新建（service 为 null）或修改搜索服务；API Key 写入系统凭据管理器。第一个服务成为默认。 */
    async saveSearchService(service: SearchServiceView | null, form: SearchServiceForm): Promise<Result<SearchServicesView, AppError>> {
      const p = await port();
      if (!p.ok) return p;
      const id = service?.id ?? deps.ids.next();
      const credential = await saveCredential(id, form, service?.credential ?? null);
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
      const credential = await deps.credentials.remove(service.id);
      if (!credential.ok) return err(settings(`服务已删除，但凭据管理器中的条目没有删掉：${credential.error}`));
      return view();
    },

    async setDefaultSearchService(serviceId: string): Promise<Result<SearchServicesView, AppError>> {
      const p = await port();
      if (!p.ok) return p;
      const done = await setDefaultSearchService(p.value, serviceId, ctx());
      return done.ok ? view() : err(repo(done.error));
    },

    /** 用一个固定的搜索词试一次：凭据、地址与接口格式都对才算通过。返回搜到几条与第一条的标题。 */
    async testSearchService(serviceId: string): Promise<Result<{ readonly hits: number; readonly first: string | null }, AppError>> {
      const current = await view();
      if (!current.ok) return current;
      const service = current.value.services.find((s) => s.id === serviceId);
      if (service === undefined) return err({ code: 'not_found' });
      const hits = await search(service, '中文网络小说 月票榜', 3);
      return hits.ok ? ok({ hits: hits.value.length, first: hits.value[0]?.title ?? null }) : hits;
    },

    /** 用默认的搜索服务搜公开网页，返回标题、网址与摘要。 */
    async webSearch(query: string, count = 8): Promise<Result<{ readonly service: string; readonly hits: readonly SearchHit[] }, AppError>> {
      const service = await defaultService();
      if (!service.ok) return service;
      const hits = await search(service.value, query, count);
      return hits.ok ? ok({ service: service.value.name, hits: hits.value }) : hits;
    },

    /** 读一个公开网页的正文（不带凭据，由 Rust 校验地址）；太长时只给开头与结尾。 */
    async readWebPage(url: string, limit = PAGE_CHARS): Promise<Result<WebPage & { readonly clipped: boolean }, AppError>> {
      const page = await deps.web.readPage(url.trim());
      if (!page.ok) return err(settings(describeWebError(page.error)));
      return ok(clipPage(page.value, limit));
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
