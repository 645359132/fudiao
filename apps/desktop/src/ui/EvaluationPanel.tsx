import { useState } from 'react';
import type { EvaluationScores } from '@fudiao/store';
import { EVALUATION_ITEMS, type SimEvaluationView } from '../app/sim-evaluation';
import { useApp } from './store-context';

const usd = (v: number) => `$${v.toFixed(4)}`;
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} 秒`;
const EMPTY: EvaluationScores = { characters: null, intel: null, twist: null, adopt: null, edits: null };

function EvaluationForm({ view }: { readonly view: SimEvaluationView }) {
  const save = useApp((s) => s.saveSimEvaluation);
  const busy = useApp((s) => s.busy);
  const answers = view.evaluation?.answers;
  const [scores, setScores] = useState<EvaluationScores>(answers?.scores ?? EMPTY);
  const [twistNote, setTwistNote] = useState(answers?.twistNote ?? '');
  const [note, setNote] = useState(answers?.note ?? '');
  const { measured } = view;

  return (
    <form
      className="panel-form"
      aria-label="推演评价"
      onSubmit={(e) => {
        e.preventDefault();
        void save({ scores, twistNote, note });
      }}
    >
      {view.scope === 'batch' && <p className="muted">这次推演属于一组批量推演（{view.runIds.length} 次），整组评价一次。</p>}
      {!view.ready && <p className="muted">{view.scope === 'batch' ? '整组结束后才能评价。' : '推演结束后才能评价。'}</p>}
      <p className="muted">
        调用 {measured.calls} 次，费用 {usd(measured.costUsd)}
        {measured.unknownCostCalls > 0 && `（另有 ${measured.unknownCostCalls} 次费用未知）`}，模型响应共 {seconds(measured.modelMs)}。
      </p>
      <p className="muted">{view.adopted.length === 0 ? '还没有采纳进作品的事件。' : `采纳进作品的事件：${view.adopted.map((e) => e.summary).join('；')}`}</p>
      {EVALUATION_ITEMS.map((item) => (
        <label key={item.key}>
          {item.label}
          <select
            value={scores[item.key] ?? ''}
            onChange={(e) => {
              const v = e.currentTarget.value;
              setScores({ ...scores, [item.key]: v === '' ? null : Number(v) });
            }}
          >
            <option value="">不评</option>
            {Array.from({ length: item.max - item.min + 1 }, (_, i) => item.min + i).map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
      ))}
      <label>
        可采用的转折（是哪一处）
        <textarea rows={2} value={twistNote} onChange={(e) => setTwistNote(e.currentTarget.value)} />
      </label>
      <label>
        其他
        <textarea rows={2} value={note} onChange={(e) => setNote(e.currentTarget.value)} />
      </label>
      <div className="form-actions">
        <button type="submit" disabled={busy || !view.ready}>
          保存评价
        </button>
        {view.evaluation !== null && <span className="muted">已保存（第 {view.evaluation.version} 版）</span>}
      </div>
    </form>
  );
}

/**
 * 推演评价（B46）：推演结束后的简短评价——人物是否可信、有无可采用的转折、是否采纳及采纳的事件；
 * 评分项与 M0 评价表相同。打开时读取，费用、耗时与采纳的事件按此刻的记录列出，保存时一并记下。
 */
export function EvaluationPanel({ runId }: { readonly runId: string }) {
  const view = useApp((s) => (s.simEvaluation?.runId === runId ? s.simEvaluation : null));
  const load = useApp((s) => s.loadSimEvaluation);
  return (
    <details
      onToggle={(e) => {
        if (e.currentTarget.open) void load();
      }}
    >
      <summary>推演评价</summary>
      {view === null ? null : <EvaluationForm key={`${view.evaluation?.version ?? 0}:${view.ready}`} view={view} />}
    </details>
  );
}
