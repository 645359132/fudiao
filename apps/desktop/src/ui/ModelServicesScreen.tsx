import { useState } from 'react';
import { PROVIDER_KINDS, SEARCH_KINDS, type ProviderKind, type SearchKind } from '@fudiao/store';
import { PROVIDER_PRESETS, type ProviderForm, type ProviderView } from '../app/model-services';
import { SEARCH_PRESETS, type SearchServiceForm, type SearchServiceView } from '../app/web-search';
import { ListedModels, ModelRow } from './ModelDetails';
import { useApp } from './store-context';

/** 凭据状态：没有保存、已保存，或服务地址改了但还没重新填写 API Key。 */
function credentialText(p: ProviderView): string {
  if (p.authMethod === 'none') return '本地端点，不需要 API Key';
  if (!p.credential.hasSecret) return '还没有填写 API Key';
  let origin: string | null = null;
  try {
    origin = new URL(p.baseUrl).origin;
  } catch {
    // 地址无效时按不一致处理
  }
  return origin === p.credential.origin ? 'API Key 已保存在系统凭据管理器' : '服务地址已更改，须重新填写 API Key';
}

function ProviderEditor({ provider, onDone }: { readonly provider: ProviderView | null; readonly onDone: () => void }) {
  const save = useApp((s) => s.saveProvider);
  const busy = useApp((s) => s.busy);
  const [kind, setKind] = useState<ProviderKind>(provider?.kind ?? 'anthropic');
  const [name, setName] = useState(provider?.name ?? PROVIDER_PRESETS.anthropic.label);
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? PROVIDER_PRESETS.anthropic.baseUrl);
  const [concurrency, setConcurrency] = useState(String(provider?.concurrency ?? 4));
  const [maxTokensField, setMaxTokensField] = useState(provider?.dialect.maxTokensField ?? '');
  const [stripThinkTags, setStripThinkTags] = useState(provider?.dialect.stripThinkTags ?? null);
  // API Key 只在提交时交给凭据端口，不进入应用状态；提交后清空。
  const [apiKey, setApiKey] = useState('');
  const needsKey = PROVIDER_PRESETS[kind].keyHeader !== null;
  const chat = kind !== 'anthropic';

  const choose = (next: ProviderKind) => {
    // 名称与地址还是上一个种类的默认值时，换成新种类的默认值。
    if (name === PROVIDER_PRESETS[kind].label || name.trim() === '') setName(PROVIDER_PRESETS[next].label);
    if (baseUrl === PROVIDER_PRESETS[kind].baseUrl || baseUrl.trim() === '') setBaseUrl(PROVIDER_PRESETS[next].baseUrl);
    setKind(next);
  };

  return (
    <form
      className="provider-form"
      aria-label={provider === null ? '添加服务' : `编辑 ${provider.name}`}
      onSubmit={(e) => {
        e.preventDefault();
        const form: ProviderForm = {
          kind,
          name,
          baseUrl,
          authMethod: needsKey ? 'api_key' : 'none',
          concurrency: Number(concurrency),
          dialect: {
            ...(maxTokensField !== '' && { maxTokensField: maxTokensField as 'max_tokens' | 'max_completion_tokens' }),
            ...(stripThinkTags !== null && { stripThinkTags }),
          },
          apiKey: needsKey && apiKey.trim() !== '' ? apiKey : null,
        };
        void save(provider, form).then((done) => {
          setApiKey('');
          if (done) onDone();
        });
      }}
    >
      <label>
        服务种类
        <select value={kind} onChange={(e) => choose(e.currentTarget.value as ProviderKind)}>
          {PROVIDER_KINDS.map((k) => (
            <option key={k} value={k}>
              {PROVIDER_PRESETS[k].label}
            </option>
          ))}
        </select>
      </label>
      <label>
        名称
        <input value={name} onChange={(e) => setName(e.currentTarget.value)} />
      </label>
      <label>
        服务地址
        <input value={baseUrl} placeholder="https://…" onChange={(e) => setBaseUrl(e.currentTarget.value)} />
      </label>
      {needsKey && (
        <label>
          API Key
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={apiKey}
            placeholder={provider?.credential.hasSecret === true ? '已保存；不更改请留空' : '粘贴 API Key'}
            onChange={(e) => setApiKey(e.currentTarget.value)}
          />
        </label>
      )}
      <label>
        同时请求数上限
        <input type="number" min={1} max={64} value={concurrency} onChange={(e) => setConcurrency(e.currentTarget.value)} />
      </label>
      {chat && (
        <details>
          <summary>OpenAI 写法的差异</summary>
          <label>
            输出上限的参数名
            <select value={maxTokensField} onChange={(e) => setMaxTokensField(e.currentTarget.value)}>
              <option value="">按服务种类的默认值</option>
              <option value="max_tokens">max_tokens（多数兼容接口）</option>
              <option value="max_completion_tokens">max_completion_tokens（OpenAI 推理模型）</option>
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={stripThinkTags ?? kind !== 'openai'} onChange={(e) => setStripThinkTags(e.currentTarget.checked)} />
            去掉正文开头的思考过程（&lt;think&gt;…&lt;/think&gt;）
          </label>
        </details>
      )}
      <p className="muted">API Key 保存在 Windows 凭据管理器中，只会附加到上面这个地址的请求；复调不会显示、记录或导出它。更改服务地址须重新填写。</p>
      <div className="form-actions">
        <button type="submit" disabled={busy}>
          保存
        </button>
        <button type="button" onClick={onDone}>
          取消
        </button>
      </div>
    </form>
  );
}

function ProviderCard({ provider }: { readonly provider: ProviderView }) {
  // 选择器返回状态中的原数组，过滤放在外面：每次返回新数组会让订阅不停地重新渲染。
  const allModels = useApp((s) => s.modelServices?.models);
  const models = allModels?.filter((m) => m.providerId === provider.id) ?? [];
  const defaultModelId = useApp((s) => s.modelServices?.defaultModelId ?? null);
  const addModel = useApp((s) => s.addModel);
  const fetchList = useApp((s) => s.fetchModelList);
  const listed = useApp((s) => s.listedModels[provider.id]);
  const remove = useApp((s) => s.deleteProvider);
  const busy = useApp((s) => s.busy);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [modelId, setModelId] = useState('');

  if (editing) return <ProviderEditor provider={provider} onDone={() => setEditing(false)} />;
  return (
    <section className="provider-card" aria-label={provider.name}>
      <div className="provider-head">
        <h3>{provider.name}</h3>
        <span className="muted">{PROVIDER_PRESETS[provider.kind].label}</span>
        <span className="spacer" />
        <button type="button" onClick={() => setEditing(true)}>
          编辑
        </button>
        {confirming ? (
          <span className="confirm" role="group" aria-label="确认删除服务">
            <span>删除服务、它的模型与保存的 API Key？</span>
            <button type="button" disabled={busy} onClick={() => void remove(provider)}>
              确定删除
            </button>
            <button type="button" onClick={() => setConfirming(false)}>
              取消
            </button>
          </span>
        ) : (
          <button type="button" onClick={() => setConfirming(true)}>
            删除
          </button>
        )}
      </div>
      <p className="muted">
        {provider.baseUrl} · {credentialText(provider)} · 同时请求数上限 {provider.concurrency}
      </p>
      <ul className="model-list" aria-label={`${provider.name} 的模型`}>
        {models.map((m) => (
          <ModelRow key={m.id} model={m} isDefault={m.id === defaultModelId} />
        ))}
      </ul>
      <button type="button" disabled={listed === 'loading'} onClick={() => void fetchList(provider.id)}>
        {listed === 'loading' ? '获取中……' : '获取模型列表'}
      </button>
      {listed !== undefined && listed !== 'loading' && <ListedModels providerId={provider.id} listed={listed} added={new Set(models.map((m) => m.modelId))} />}
      <form
        className="text-form"
        onSubmit={(e) => {
          e.preventDefault();
          void addModel(provider.id, modelId).then((done) => {
            if (done) setModelId('');
          });
        }}
      >
        <input aria-label={`${provider.name} 的模型名称`} placeholder="或手动填写模型名称（服务文档中的模型标识）" value={modelId} onChange={(e) => setModelId(e.currentTarget.value)} />
        <button type="submit" disabled={busy || modelId.trim() === ''}>
          添加模型
        </button>
      </form>
    </section>
  );
}

/** 搜索服务的凭据状态。 */
function searchCredentialText(s: SearchServiceView): string {
  if (!s.credential.hasSecret) return '还没有填写 API Key';
  let origin: string | null = null;
  try {
    origin = new URL(s.baseUrl).origin;
  } catch {
    // 地址无效时按不一致处理
  }
  return origin === s.credential.origin ? 'API Key 已保存在系统凭据管理器' : '服务地址已更改，须重新填写 API Key';
}

function SearchServiceEditor({ service, onDone }: { readonly service: SearchServiceView | null; readonly onDone: () => void }) {
  const save = useApp((s) => s.saveSearchService);
  const busy = useApp((s) => s.busy);
  const [kind, setKind] = useState<SearchKind>(service?.kind ?? 'tavily');
  const [name, setName] = useState(service?.name ?? SEARCH_PRESETS.tavily.label);
  const [baseUrl, setBaseUrl] = useState(service?.baseUrl ?? SEARCH_PRESETS.tavily.baseUrl);
  // API Key 只在提交时交给凭据端口，不进入应用状态；提交后清空。
  const [apiKey, setApiKey] = useState('');
  const choose = (next: SearchKind) => {
    if (name === SEARCH_PRESETS[kind].label || name.trim() === '') setName(SEARCH_PRESETS[next].label);
    if (baseUrl === SEARCH_PRESETS[kind].baseUrl || baseUrl.trim() === '') setBaseUrl(SEARCH_PRESETS[next].baseUrl);
    setKind(next);
  };
  return (
    <form
      className="provider-form"
      aria-label={service === null ? '添加搜索服务' : `编辑搜索服务 ${service.name}`}
      onSubmit={(e) => {
        e.preventDefault();
        const form: SearchServiceForm = { kind, name, baseUrl, apiKey: apiKey.trim() === '' ? null : apiKey };
        void save(service, form).then((done) => {
          setApiKey('');
          if (done) onDone();
        });
      }}
    >
      <label>
        搜索服务
        <select value={kind} onChange={(e) => choose(e.currentTarget.value as SearchKind)}>
          {SEARCH_KINDS.map((k) => (
            <option key={k} value={k}>
              {SEARCH_PRESETS[k].label}
            </option>
          ))}
        </select>
      </label>
      <p className="muted">{SEARCH_PRESETS[kind].hint}</p>
      <label>
        名称
        <input value={name} onChange={(e) => setName(e.currentTarget.value)} />
      </label>
      <label>
        服务地址
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.currentTarget.value)} />
      </label>
      <label>
        API Key{service?.credential.hasSecret === true ? '（留空表示不改）' : ''}
        <input type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.currentTarget.value)} />
      </label>
      <div className="form-actions">
        <button type="submit" className="primary" disabled={busy}>
          保存
        </button>
        <button type="button" onClick={onDone}>
          取消
        </button>
      </div>
    </form>
  );
}

function SearchServiceCard({ service, isDefault }: { readonly service: SearchServiceView; readonly isDefault: boolean }) {
  const remove = useApp((s) => s.deleteSearchService);
  const setDefault = useApp((s) => s.setDefaultSearchService);
  const test = useApp((s) => s.testSearchService);
  const result = useApp((s) => s.searchTests[service.id]);
  const busy = useApp((s) => s.busy);
  const [editing, setEditing] = useState(false);
  if (editing) return <SearchServiceEditor service={service} onDone={() => setEditing(false)} />;
  return (
    <section className="provider-card" aria-label={`搜索服务 ${service.name}`}>
      <header>
        <h3>
          {service.name}
          {isDefault ? <span className="muted">（默认）</span> : null}
        </h3>
        <span className="muted">
          {SEARCH_PRESETS[service.kind].label} · {service.baseUrl} · {searchCredentialText(service)}
        </span>
      </header>
      <div className="form-actions">
        {isDefault ? null : (
          <button type="button" disabled={busy} onClick={() => void setDefault(service.id)}>
            设为默认
          </button>
        )}
        <button type="button" disabled={busy || result === 'testing'} onClick={() => void test(service.id)}>
          {result === 'testing' ? '测试中…' : '测试搜索'}
        </button>
        <button type="button" disabled={busy} onClick={() => setEditing(true)}>
          编辑
        </button>
        <button type="button" className="ghost" disabled={busy} onClick={() => void remove(service)}>
          删除
        </button>
      </div>
      {result !== undefined && result !== 'testing' ? (
        <p className="muted" role="status">
          {result}
        </p>
      ) : null}
    </section>
  );
}

/** 联网搜索（需求 B84）：AI 助手与扫榜拆书的榜单用；读网页不需要服务、不带凭据。 */
function SearchServicesSection() {
  const view = useApp((s) => s.searchServices);
  const [adding, setAdding] = useState(false);
  return (
    <section aria-label="联网搜索">
      <h3>联网搜索</h3>
      <p className="muted">AI 助手与扫榜拆书可以联网搜索公开的网页（榜单、简介、评论、资料）。搜索服务由你自己填 API Key，Tavily 与 Brave Search 都有免费额度；读网页不带任何凭据，只读公网地址，网页里的文字只当材料。</p>
      {view?.services.map((s) => (
        <SearchServiceCard key={s.id} service={s} isDefault={s.id === view.defaultServiceId} />
      ))}
      {view !== null && view.services.length === 0 && !adding ? <p className="muted">还没有搜索服务。</p> : null}
      {adding ? (
        <SearchServiceEditor service={null} onDone={() => setAdding(false)} />
      ) : (
        <button type="button" onClick={() => setAdding(true)}>
          添加搜索服务
        </button>
      )}
    </section>
  );
}

/** 模型服务（需求 B15）：服务、API Key、模型、默认模型与连接测试。应用级设置，不属于某一部作品。 */
export function ModelServicesScreen() {
  const view = useApp((s) => s.modelServices);
  const close = useApp((s) => s.closeModelServices);
  const [adding, setAdding] = useState(false);
  return (
    <div className="model-services">
      <header className="work-bar">
        <button type="button" onClick={close}>
          返回
        </button>
        <h2>模型服务</h2>
      </header>
      <main className="work-main">
        <p className="muted">所有服务都由你自己填写 API Key 接入，复调不提供账号登录。默认模型用于全部 AI 功能。</p>
        {view?.providers.map((p) => (
          <ProviderCard key={p.id} provider={p} />
        ))}
        {view !== null && view.providers.length === 0 && !adding && <p className="muted">还没有模型服务。</p>}
        {adding ? (
          <ProviderEditor provider={null} onDone={() => setAdding(false)} />
        ) : (
          <button type="button" onClick={() => setAdding(true)}>
            添加服务
          </button>
        )}
        <SearchServicesSection />
      </main>
    </div>
  );
}
