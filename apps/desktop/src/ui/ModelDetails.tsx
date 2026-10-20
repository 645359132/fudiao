import { useState } from 'react';
import type { ConnectionReport, ListedModel, LlmError } from '@fudiao/llm';
import type { StoredCapabilities, StoredModel } from '@fudiao/store';
import { builtinModel } from '../app/builtin-models';
import { useApp } from './store-context';

const ERROR_HINT: Partial<Record<LlmError['code'], string>> = {
  auth: 'API Key 无效或没有权限',
  rate_limited: '请求过于频繁或额度不足',
  network: '连不上服务，请检查地址、网络与代理设置',
  bad_request: '请求被拒绝，请检查模型名称',
  server: '服务暂时不可用',
};

function describeReport(r: ConnectionReport | 'testing'): string {
  if (r === 'testing') return '测试中……';
  if (r.ok) return `连接正常：${r.latencyMs.toLocaleString('zh-CN')} 毫秒，模型 ${r.servedModel}`;
  return `连接失败：${ERROR_HINT[r.error.code] ?? '未知错误'}（${r.error.message}）`;
}

type StructuredMode = StoredCapabilities['structuredOutput'];

const STRUCTURED: Record<StructuredMode, string> = {
  native: '按 JSON Schema 约束（原生）',
  json_object: '只保证合法 JSON',
  prompt: '提示词约束',
  none: '不用于结构化任务',
};
const MODES = Object.keys(STRUCTURED) as StructuredMode[];

function selfTestText(m: StoredModel): string {
  if (m.selfTest === null) return '未自检';
  const at = new Date(m.selfTest.at).toLocaleString('zh-CN');
  return m.selfTest.status === 'passed' ? `自检通过（${at}）` : `自检未通过（${at}）：${m.selfTest.reason ?? ''}`;
}

const priceText = (m: StoredModel) =>
  m.prices === null
    ? '价格未配置，费用记为未知'
    : `每百万 Token：输入 ${m.prices.input} 美元，输出 ${m.prices.output} 美元${m.prices.webSearch === undefined ? '' : `；联网搜索每千次 ${m.prices.webSearch} 美元`}`;

const optionalNumber = (v: string) => (v.trim() === '' ? undefined : Number(v));

/** 作者覆盖模型的能力与价格（B56）。改结构化输出方式后须重新自检。 */
function ModelEditor({ model, onDone }: { readonly model: StoredModel; readonly onDone: () => void }) {
  const save = useApp((s) => s.updateModel);
  const busy = useApp((s) => s.busy);
  const c = model.capabilities;
  const p = model.prices;
  const [displayName, setDisplayName] = useState(model.displayName);
  const [structuredOutput, setStructured] = useState<StructuredMode>(c.structuredOutput);
  const [promptCaching, setCaching] = useState(c.promptCaching);
  const [reasoning, setReasoning] = useState(c.reasoningControl === 'effort');
  const [webSearch, setWebSearch] = useState(c.webSearch);
  const [contextWindow, setContext] = useState(String(c.contextWindow));
  const [maxOutput, setMaxOutput] = useState(String(c.maxOutputTokens));
  const [input, setInput] = useState(p === null ? '' : String(p.input));
  const [output, setOutput] = useState(p === null ? '' : String(p.output));
  const [cacheRead, setCacheRead] = useState(p?.cacheRead === undefined ? '' : String(p.cacheRead));
  const [cacheWrite, setCacheWrite] = useState(p?.cacheWrite === undefined ? '' : String(p.cacheWrite));
  const [searchPrice, setSearchPrice] = useState(p?.webSearch === undefined ? '' : String(p.webSearch));

  const submit = () => {
    const inputPrice = optionalNumber(input);
    const outputPrice = optionalNumber(output);
    const read = optionalNumber(cacheRead);
    const write = optionalNumber(cacheWrite);
    const perSearch = optionalNumber(searchPrice);
    const prices =
      inputPrice === undefined || outputPrice === undefined
        ? null
        : {
            input: inputPrice,
            output: outputPrice,
            ...(read !== undefined && { cacheRead: read }),
            ...(write !== undefined && { cacheWrite: write }),
            ...(perSearch !== undefined && { webSearch: perSearch }),
          };
    const capabilities: StoredCapabilities = {
      ...c,
      structuredOutput,
      promptCaching,
      reasoningControl: reasoning ? 'effort' : 'none',
      webSearch,
      contextWindow: Number(contextWindow),
      maxOutputTokens: Number(maxOutput),
    };
    void save(model.id, { displayName, capabilities, prices }).then((done) => {
      if (done) onDone();
    });
  };

  return (
    <li>
      <form
        className="provider-form"
        aria-label={`编辑模型 ${model.displayName}`}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label>
          显示名称
          <input value={displayName} onChange={(e) => setDisplayName(e.currentTarget.value)} />
        </label>
        <label>
          结构化输出
          <select value={structuredOutput} onChange={(e) => setStructured(MODES.find((m) => m === e.currentTarget.value) ?? 'prompt')}>
            {MODES.map((k) => (
              <option key={k} value={k}>
                {STRUCTURED[k]}
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={promptCaching} onChange={(e) => setCaching(e.currentTarget.checked)} />
          支持提示词缓存
        </label>
        <label className="check">
          <input type="checkbox" checked={reasoning} onChange={(e) => setReasoning(e.currentTarget.checked)} />
          支持思考深度控制
        </label>
        <label className="check">
          <input type="checkbox" checked={webSearch} onChange={(e) => setWebSearch(e.currentTarget.checked)} />
          模型自带的联网搜索（Anthropic 与 OpenAI 官方接口的服务端搜索工具）
        </label>
        <label>
          上下文长度（Token）
          <input type="number" min={1} value={contextWindow} onChange={(e) => setContext(e.currentTarget.value)} />
        </label>
        <label>
          最大输出（Token）
          <input type="number" min={1} value={maxOutput} onChange={(e) => setMaxOutput(e.currentTarget.value)} />
        </label>
        <fieldset>
          <legend>价格（每百万 Token，美元；输入与输出都填写才计算费用）</legend>
          <label>
            输入
            <input type="number" min={0} step="any" value={input} onChange={(e) => setInput(e.currentTarget.value)} />
          </label>
          <label>
            输出
            <input type="number" min={0} step="any" value={output} onChange={(e) => setOutput(e.currentTarget.value)} />
          </label>
          <label>
            缓存读取
            <input type="number" min={0} step="any" value={cacheRead} onChange={(e) => setCacheRead(e.currentTarget.value)} />
          </label>
          <label>
            缓存写入
            <input type="number" min={0} step="any" value={cacheWrite} onChange={(e) => setCacheWrite(e.currentTarget.value)} />
          </label>
          <label>
            联网搜索（每千次）
            <input type="number" min={0} step="any" value={searchPrice} onChange={(e) => setSearchPrice(e.currentTarget.value)} />
          </label>
        </fieldset>
        {structuredOutput !== c.structuredOutput && <p className="muted">改了结构化输出方式，保存后需要重新自检。</p>}
        <div className="form-actions">
          <button type="submit" disabled={busy}>
            保存
          </button>
          <button type="button" onClick={onDone}>
            取消
          </button>
        </div>
      </form>
    </li>
  );
}

export function ModelRow({ model, isDefault }: { readonly model: StoredModel; readonly isDefault: boolean }) {
  const test = useApp((s) => s.testConnection);
  const report = useApp((s) => s.connectionTests[model.id]);
  const selfTest = useApp((s) => s.runSelfTest);
  const selfTesting = useApp((s) => s.selfTesting.includes(model.id));
  const setDefault = useApp((s) => s.setDefaultModel);
  const remove = useApp((s) => s.deleteModel);
  const applyBuiltin = useApp((s) => s.applyBuiltinModel);
  const kind = useApp((s) => s.modelServices?.providers.find((p) => p.id === model.providerId)?.kind);
  const busy = useApp((s) => s.busy);
  const [editing, setEditing] = useState(false);
  // 内置表里有这个模型、而记下的能力或价格与它不同（例如早先添加时内置表还没有它）。
  const builtin = kind === undefined ? undefined : builtinModel(kind, model.modelId);
  const outdated =
    builtin !== undefined &&
    (Object.entries(builtin.capabilities).some(([k, v]) => model.capabilities[k as keyof typeof model.capabilities] !== v) ||
      JSON.stringify(builtin.prices ?? null) !== JSON.stringify(model.prices));
  if (editing) return <ModelEditor model={model} onDone={() => setEditing(false)} />;
  return (
    <li className="model-row">
      <span className="model-name">{model.displayName}</span>
      {isDefault ? (
        <span className="badge">默认模型</span>
      ) : (
        <button type="button" disabled={busy} onClick={() => void setDefault(model.id)}>
          设为默认
        </button>
      )}
      <button type="button" disabled={report === 'testing'} onClick={() => void test(model.id)}>
        连接测试
      </button>
      <button type="button" disabled={selfTesting} onClick={() => void selfTest(model.id)}>
        {selfTesting ? '自检中……' : '能力自检'}
      </button>
      <button type="button" onClick={() => setEditing(true)}>
        能力与价格
      </button>
      {outdated ? (
        <button type="button" disabled={busy} title="按服务官方文档核实过的能力与价格，例如可以调节思考深度" onClick={() => void applyBuiltin(model.id)}>
          采用内置的能力与价格
        </button>
      ) : null}
      <button type="button" disabled={busy} aria-label={`删除模型 ${model.displayName}`} onClick={() => void remove(model.id)}>
        删除
      </button>
      <span className="model-facts" role="note" aria-label={`${model.displayName} 的能力`}>
        {model.modelId === model.displayName ? '' : `${model.modelId} · `}结构化输出：{STRUCTURED[model.capabilities.structuredOutput]}
        {model.capabilities.webSearch ? ' · 自带联网搜索' : ''} · {selfTestText(model)} · {priceText(model)}
      </span>
      {report !== undefined && (
        <span className={report !== 'testing' && !report.ok ? 'report failed' : 'report'} role="status" aria-label={`${model.displayName} 的连接测试`}>
          {describeReport(report)}
        </span>
      )}
    </li>
  );
}

/** 从服务获取到的模型中选择添加；已添加的不再列出。 */
export function ListedModels({ providerId, listed, added }: { readonly providerId: string; readonly listed: readonly ListedModel[]; readonly added: ReadonlySet<string> }) {
  const add = useApp((s) => s.addListedModel);
  const busy = useApp((s) => s.busy);
  const [filter, setFilter] = useState('');
  const rest = listed.filter((m) => !added.has(m.id) && m.id.toLowerCase().includes(filter.trim().toLowerCase()));
  return (
    <div className="listed-models">
      {listed.length > 20 && <input aria-label="筛选模型" placeholder="筛选模型" value={filter} onChange={(e) => setFilter(e.currentTarget.value)} />}
      {rest.length === 0 ? (
        <p className="muted">没有可添加的模型。</p>
      ) : (
        <ul aria-label="服务提供的模型">
          {rest.slice(0, 200).map((m) => (
            <li key={m.id}>
              <span className="model-name">{m.displayName ?? m.id}</span>
              {m.displayName !== null && <span className="muted">{m.id}</span>}
              <button type="button" disabled={busy} aria-label={`添加 ${m.id}`} onClick={() => void add(providerId, m)}>
                添加
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
