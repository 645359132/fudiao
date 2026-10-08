import { useState } from 'react';
import type { Fact, FactInput, FactKind, FactModality, FactStatus } from '@fudiao/store';
import { NO_CHAPTERS, useApp } from './store-context';

export const FACT_KIND: Record<FactKind, string> = { world: '世界事实', belief: '人物认知', claim: '人物说法' };
export const FACT_STATUS: Record<FactStatus, string> = { candidate: '候选', confirmed: '已确认', needs_review: '待复核', rejected: '已驳回' };
const MODALITY: Record<FactModality, string> = { observed: '观察', heard: '听闻', inferred: '推测', claimed: '说法' };

const excerpt = (text: string, n = 24) => (text.length > n ? `${text.slice(0, n)}……` : text);

/** 数字输入框的内容转为排序值；空为 null，非数字时返回 undefined 表示无效。 */
const parseOrder = (text: string): number | null | undefined => {
  if (text.trim() === '') return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : undefined;
};

type Draft = {
  kind: FactKind;
  holderId: string;
  content: string;
  modality: FactModality | '';
  confidence: string;
  subjectIds: string[];
  fromChapter: string;
  toChapter: string;
  fromLabel: string;
  fromOrder: string;
  toLabel: string;
  toOrder: string;
  basisEntities: string[];
  basisFacts: string[];
};

const draftOf = (f: Fact | null): Draft => ({
  kind: f?.kind ?? 'world',
  holderId: f?.holderId ?? '',
  content: f?.content ?? '',
  modality: f?.modality ?? '',
  confidence: f?.confidence === null || f?.confidence === undefined ? '' : String(Math.round(f.confidence * 100)),
  subjectIds: [...(f?.subjectIds ?? [])],
  fromChapter: f?.validFromChapterId ?? '',
  toChapter: f?.validToChapterId ?? '',
  fromLabel: f?.validFrom?.label ?? '',
  fromOrder: f?.validFrom?.order?.toString() ?? '',
  toLabel: f?.validTo?.label ?? '',
  toOrder: f?.validTo?.order?.toString() ?? '',
  basisEntities: (f?.basis ?? []).filter((b) => b.type === 'entity').map((b) => b.id),
  basisFacts: (f?.basis ?? []).filter((b) => b.type === 'fact').map((b) => b.id),
});

/** 表单内容转为录入的事实；不合格时返回给作者看的说明。 */
function toInput(d: Draft): FactInput | string {
  const fromOrder = parseOrder(d.fromOrder);
  const toOrder = parseOrder(d.toOrder);
  if (fromOrder === undefined || toOrder === undefined) return '故事时间的排序值须为数字';
  if ((fromOrder !== null && d.fromLabel.trim() === '') || (toOrder !== null && d.toLabel.trim() === '')) return '故事时间填了排序值时须有标签';
  const confidence = d.confidence.trim() === '' ? null : Number(d.confidence) / 100;
  if (confidence !== null && !(confidence >= 0 && confidence <= 1)) return '相信程度为 0 到 100 之间的数';
  const personal = d.kind !== 'world';
  return {
    kind: d.kind,
    holderId: personal && d.holderId !== '' ? d.holderId : null,
    subjectIds: d.subjectIds,
    content: d.content,
    modality: d.kind === 'claim' ? 'claimed' : d.kind === 'belief' && d.modality !== '' ? d.modality : null,
    confidence: d.kind === 'belief' ? confidence : null,
    validFromChapterId: d.fromChapter === '' ? null : d.fromChapter,
    validToChapterId: d.toChapter === '' ? null : d.toChapter,
    validFrom: d.fromLabel.trim() === '' ? null : { label: d.fromLabel, order: fromOrder },
    validTo: d.toLabel.trim() === '' ? null : { label: d.toLabel, order: toOrder },
    basis: [...d.basisEntities.map((id) => ({ type: 'entity' as const, id })), ...d.basisFacts.map((id) => ({ type: 'fact' as const, id }))],
  };
}

function Checklist({ label, items, chosen, onChange }: { readonly label: string; readonly items: readonly { id: string; text: string }[]; readonly chosen: readonly string[]; readonly onChange: (ids: string[]) => void }) {
  return (
    <fieldset className="checklist">
      <legend>{label}</legend>
      {items.length === 0 ? (
        <span className="muted">（无）</span>
      ) : (
        items.map((item) => (
          <label key={item.id} className="radio">
            <input
              type="checkbox"
              checked={chosen.includes(item.id)}
              onChange={(e) => onChange(e.target.checked ? [...chosen, item.id] : chosen.filter((x) => x !== item.id))}
            />
            {item.text}
          </label>
        ))
      )}
    </fieldset>
  );
}

function FactForm({ fact }: { readonly fact: Fact | null }) {
  const entities = useApp((s) => s.entities);
  const facts = useApp((s) => s.facts);
  const chapters = useApp((s) => s.work?.chapters ?? NO_CHAPTERS);
  const save = useApp((s) => s.saveFact);
  const setStatus = useApp((s) => s.setFactStatus);
  const remove = useApp((s) => s.deleteFact);
  const selectFact = useApp((s) => s.selectFact);
  const busy = useApp((s) => s.busy);
  const [d, setD] = useState<Draft>(() => draftOf(fact));
  const [problem, setProblem] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const patch = (p: Partial<Draft>) => setD({ ...d, ...p });
  const characters = entities.filter((e) => e.kind === 'character');

  return (
    <form
      className="panel-form fact-form"
      aria-label="事实内容"
      onSubmit={(e) => {
        e.preventDefault();
        const input = toInput(d);
        if (typeof input === 'string') {
          setProblem(input);
          return;
        }
        setProblem(null);
        void save(fact?.id ?? null, input);
      }}
    >
      {fact !== null && (
        <div className="entity-head">
          <span className={`status-badge ${fact.status}`}>{FACT_STATUS[fact.status]}</span>
          {fact.status === 'needs_review' && <span className="review-reason">{fact.reviewReason}</span>}
          <span className="spacer" />
          {fact.status !== 'confirmed' && (
            <button type="button" disabled={busy} onClick={() => void setStatus(fact.id, 'confirmed')}>
              {fact.status === 'needs_review' ? '复核后确认' : '确认'}
            </button>
          )}
          {fact.status !== 'rejected' && (
            <button type="button" disabled={busy} onClick={() => void setStatus(fact.id, 'rejected')}>
              驳回
            </button>
          )}
          {fact.status !== 'candidate' && fact.status !== 'needs_review' && (
            <button type="button" disabled={busy} onClick={() => void setStatus(fact.id, 'candidate')}>
              设为候选
            </button>
          )}
        </div>
      )}
      <label>
        种类
        <select value={d.kind} onChange={(e) => patch({ kind: e.target.value as FactKind })}>
          {(Object.keys(FACT_KIND) as FactKind[]).map((k) => (
            <option key={k} value={k}>
              {FACT_KIND[k]}
            </option>
          ))}
        </select>
      </label>
      {d.kind !== 'world' && (
        <label>
          持有者
          <select value={d.holderId} onChange={(e) => patch({ holderId: e.target.value })}>
            <option value="">（选择人物）</option>
            {characters.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        内容
        <textarea rows={3} value={d.content} onChange={(e) => patch({ content: e.target.value })} />
      </label>
      {d.kind === 'belief' && (
        <div className="row">
          <label>
            来源方式
            <select value={d.modality} onChange={(e) => patch({ modality: e.target.value as FactModality | '' })}>
              <option value="">（未填）</option>
              {(['observed', 'heard', 'inferred'] as const).map((m) => (
                <option key={m} value={m}>
                  {MODALITY[m]}
                </option>
              ))}
            </select>
          </label>
          <label>
            相信程度（0 至 100）
            <input inputMode="numeric" value={d.confidence} onChange={(e) => patch({ confidence: e.target.value })} />
          </label>
        </div>
      )}
      <fieldset>
        <legend>适用范围</legend>
        <div className="row">
          <label>
            从章节
            <select value={d.fromChapter} onChange={(e) => patch({ fromChapter: e.target.value })}>
              <option value="">（不限）</option>
              {chapters.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            到章节
            <select value={d.toChapter} onChange={(e) => patch({ toChapter: e.target.value })}>
              <option value="">（不限）</option>
              {chapters.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="row">
          <label>
            故事时间起
            <input placeholder="如：第三年春" value={d.fromLabel} onChange={(e) => patch({ fromLabel: e.target.value })} />
          </label>
          <label>
            排序值
            <input aria-label="起始排序值" inputMode="decimal" value={d.fromOrder} onChange={(e) => patch({ fromOrder: e.target.value })} />
          </label>
          <label>
            故事时间止
            <input value={d.toLabel} onChange={(e) => patch({ toLabel: e.target.value })} />
          </label>
          <label>
            排序值
            <input aria-label="结束排序值" inputMode="decimal" value={d.toOrder} onChange={(e) => patch({ toOrder: e.target.value })} />
          </label>
        </div>
        <p className="muted">排序值用于比较先后（例如第三年春记为 3），只写标签时不参与按时间筛选。</p>
      </fieldset>
      <Checklist label="涉及的设定" items={entities.map((e) => ({ id: e.id, text: e.name }))} chosen={d.subjectIds} onChange={(subjectIds) => patch({ subjectIds })} />
      <Checklist
        label="依据的设定（修改后本事实需要复核）"
        items={entities.map((e) => ({ id: e.id, text: e.name }))}
        chosen={d.basisEntities}
        onChange={(basisEntities) => patch({ basisEntities })}
      />
      <Checklist
        label="依据的事实"
        items={facts.filter((f) => f.id !== fact?.id).map((f) => ({ id: f.id, text: excerpt(f.content) }))}
        chosen={d.basisFacts}
        onChange={(basisFacts) => patch({ basisFacts })}
      />
      {problem !== null && <p className="field-error">{problem}</p>}
      <div className="form-actions">
        <button type="submit" disabled={busy || d.content.trim() === ''}>
          {fact === null ? '记录事实' : '保存修改'}
        </button>
        {fact === null ? (
          <button type="button" onClick={() => selectFact(null)}>
            取消
          </button>
        ) : confirmingDelete ? (
          <span className="confirm" role="group" aria-label="确认删除事实">
            <button type="button" onClick={() => void remove(fact.id)}>
              确定删除
            </button>
            <button type="button" onClick={() => setConfirmingDelete(false)}>
              取消
            </button>
          </span>
        ) : (
          <button type="button" onClick={() => setConfirmingDelete(true)}>
            删除事实
          </button>
        )}
      </div>
    </form>
  );
}

/** 事实记录（需求 B11）与待复核（B12）。 */
export function FactsPanel() {
  const facts = useApp((s) => s.facts);
  const entities = useApp((s) => s.entities);
  const selectedId = useApp((s) => s.selectedFactId);
  const select = useApp((s) => s.selectFact);
  const showPanel = useApp((s) => s.showPanel);
  const [kind, setKind] = useState<FactKind | 'all'>('all');
  const [status, setStatus] = useState<FactStatus | 'all'>('all');
  const name = (id: string | null) => entities.find((e) => e.id === id)?.name ?? '';
  const shown = facts.filter((f) => (kind === 'all' || f.kind === kind) && (status === 'all' || f.status === status));
  const pending = facts.filter((f) => f.status === 'needs_review').length;
  const selected = selectedId === 'new' ? null : (facts.find((f) => f.id === selectedId) ?? undefined);

  return (
    <section aria-label="事实" className="settings">
      <div className="history-head">
        <h2>事实</h2>
        {pending > 0 && (
          <button type="button" className="review-count" onClick={() => setStatus('needs_review')}>
            待复核 {pending}
          </button>
        )}
        <button type="button" onClick={() => select('new')}>
          记录新事实
        </button>
        <button type="button" onClick={() => void showPanel('chapter')}>
          返回正文
        </button>
      </div>
      <div className="settings-body">
        <div>
          <div className="kind-tabs" role="tablist" aria-label="事实种类">
            {(['all', 'world', 'belief', 'claim'] as const).map((k) => (
              <button key={k} type="button" role="tab" aria-selected={kind === k} onClick={() => setKind(k)}>
                {k === 'all' ? '全部' : FACT_KIND[k]}
              </button>
            ))}
          </div>
          <label className="radio">
            状态
            <select aria-label="按状态筛选" value={status} onChange={(e) => setStatus(e.target.value as FactStatus | 'all')}>
              <option value="all">全部</option>
              {(Object.keys(FACT_STATUS) as FactStatus[]).map((st) => (
                <option key={st} value={st}>
                  {FACT_STATUS[st]}
                </option>
              ))}
            </select>
          </label>
          {shown.length === 0 ? (
            <p className="muted">{facts.length === 0 ? '还没有记录事实。' : '没有符合的事实。'}</p>
          ) : (
            <ul className="entity-list" aria-label="事实列表">
              {shown.map((f) => (
                <li key={f.id}>
                  <button type="button" aria-current={f.id === selectedId ? 'true' : undefined} onClick={() => select(f.id)}>
                    <span>{excerpt(f.content, 30)}</span>
                    <span className="muted">
                      {FACT_KIND[f.kind]}
                      {f.holderId !== null ? ` · ${name(f.holderId)}` : ''} · <span className={`status-text ${f.status}`}>{FACT_STATUS[f.status]}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {selected === undefined ? (
          <p className="muted">选择一条事实查看与修改，或记录新事实。</p>
        ) : (
          <FactForm key={selected === null ? 'new' : `${selected.id}:${selected.version}:${selected.status}`} fact={selected} />
        )}
      </div>
    </section>
  );
}
