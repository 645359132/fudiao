import { useState } from 'react';
import { PROVIDER_KINDS, type ProviderKind } from '@fudiao/store';
import { PROVIDER_PRESETS, type ProviderForm, type ProviderView } from '../app/model-services';
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
      </main>
    </div>
  );
}
