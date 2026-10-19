import { useState } from 'react';
import { WORKFLOW_STATE_LABEL, WORKFLOW_STEP_STATUS_LABEL } from '../app/labels';
import type { BookSeed } from '../app/quick-book';
import { planDraftOf, seedDraftOf, type WorkflowInfo, type WorkflowKey, type WorkflowQuote, type WorkflowStepView, type WorkflowView } from '../app/workflows';
import { BookSeedFields } from './BookSeedFields';
import { PlanDraftChapters } from './PlanDraftChapters';
import { useApp } from './store-context';

/** 开始表单：一键成书的参数、模式与预算；先估算再开始。 */
function StartForm({ info }: { readonly info: WorkflowInfo }) {
  const quoteWorkflow = useApp((s) => s.quoteWorkflow);
  const startWorkflow = useApp((s) => s.startWorkflow);
  const advancing = useApp((s) => s.workflowAdvancing);
  const [idea, setIdea] = useState('');
  const [genre, setGenre] = useState('');
  const [chapters, setChapters] = useState(20);
  const [words, setWords] = useState(3000);
  const [mode, setMode] = useState<'step' | 'auto'>('step');
  const [budget, setBudget] = useState('');
  const [quote, setQuote] = useState<WorkflowQuote | null>(null);
  const key: WorkflowKey = info.key;
  const params = { idea, genre, chapters, wordsPerChapter: words };
  const budgetUsd = budget.trim() === '' ? null : Number(budget);
  const touched = () => setQuote(null);
  return (
    <form
      className="panel-form"
      aria-label={`开始${info.title}`}
      onSubmit={(e) => {
        e.preventDefault();
        void startWorkflow({ workflow: key, params, mode, budgetUsd });
      }}
    >
      <label>
        一句话的想法（已有大纲时可以不写，跳过“大纲与人物”）
        <textarea
          rows={2}
          value={idea}
          onChange={(e) => {
            setIdea(e.currentTarget.value);
            touched();
          }}
        />
      </label>
      <div className="form-row">
        <label>
          类型（可不填）
          <input value={genre} onChange={(e) => setGenre(e.currentTarget.value)} />
        </label>
        <label>
          章数
          <input
            type="number"
            min={1}
            max={300}
            value={chapters}
            onChange={(e) => {
              setChapters(Number(e.currentTarget.value));
              touched();
            }}
          />
        </label>
        <label>
          每章字数
          <input
            type="number"
            min={500}
            step={500}
            value={words}
            onChange={(e) => {
              setWords(Number(e.currentTarget.value));
              touched();
            }}
          />
        </label>
      </div>
      <fieldset>
        <legend>做法</legend>
        <label className="check">
          <input type="radio" name="workflow-mode" checked={mode === 'step'} onChange={() => setMode('step')} />
          每步停下给我看（草稿改过再采用）
        </label>
        <label className="check">
          <input type="radio" name="workflow-mode" checked={mode === 'auto'} onChange={() => setMode('auto')} />
          一路做完（会替换大纲或覆盖计划时仍停下）
        </label>
      </fieldset>
      <label>
        费用上限（美元，可不填）
        <input inputMode="decimal" value={budget} onChange={(e) => setBudget(e.currentTarget.value)} />
      </label>
      <p className="muted" aria-live="polite">
        {quote === null
          ? '开始前可以先估算用量与费用。'
          : `预计约 ${quote.calls} 次调用、${Math.round((quote.inputTokens + quote.outputTokens) / 1000)} 千 Token，${quote.costUsd === null ? `${quote.model ?? '默认模型'}没有配置价格，费用未知（预算上限因此不起作用）` : `约 $${quote.costUsd.toFixed(2)}（${quote.model ?? ''}）`}。思考的多少因模型而异，只作参考。`}
      </p>
      <div className="form-actions">
        <button type="button" onClick={() => void quoteWorkflow(key, params).then(setQuote)}>
          估算费用
        </button>
        <button type="submit" className="primary" disabled={advancing !== null || (budgetUsd !== null && !(budgetUsd > 0))}>
          开始
        </button>
      </div>
    </form>
  );
}

/** 等作者处理的骨架草稿：改过可以保存，采用时先存修改再采用。 */
function SeedStep({ view, step }: { readonly view: WorkflowView; readonly step: WorkflowStepView }) {
  const [draft, setDraft] = useState<BookSeed | null>(() => seedDraftOf(step));
  const edit = useApp((s) => s.editWorkflowStep);
  const act = useApp((s) => s.workflowStepAction);
  const busy = useApp((s) => s.busy);
  if (draft === null) return <p className="muted">骨架草稿读不出来，可以重做这一步。</p>;
  const changed = JSON.stringify(draft) !== JSON.stringify(step.output);
  return (
    <div className="panel-form" role="form" aria-label="作品骨架草稿">
      <BookSeedFields seed={draft} onChange={setDraft} />
      <div className="form-actions">
        <button
          type="button"
          className="primary"
          disabled={busy || draft.outline.trim() === ''}
          onClick={() => void (async () => (changed && !(await edit(view.run.id, step.idx, draft)) ? false : act(view.run.id, step.idx, 'adopt')))()}
        >
          采用骨架
        </button>
        <button type="button" disabled={busy || !changed} onClick={() => void edit(view.run.id, step.idx, draft)}>
          保存修改
        </button>
      </div>
    </div>
  );
}

/** 一步的结果与操作。 */
function StepDetail({ view, step }: { readonly view: WorkflowView; readonly step: WorkflowStepView }) {
  const act = useApp((s) => s.workflowStepAction);
  const openPlanning = useApp((s) => s.openPlanning);
  const busy = useApp((s) => s.busy);
  const advancing = useApp((s) => s.workflowAdvancing) === view.run.id;
  const closed = view.run.abandoned || advancing;
  const waiting = step.status === 'awaiting_author';
  const plan = step.key === 'plan' ? planDraftOf(step) : null;
  const button = (label: string, action: 'adopt' | 'skip' | 'redo' | 'keep' | 'withdraw', primary = false) => (
    <button type="button" className={primary ? 'primary' : undefined} disabled={busy || closed} onClick={() => void act(view.run.id, step.idx, action)}>
      {label}
    </button>
  );
  return (
    <section className="workflow-detail" aria-label={`第 ${step.idx + 1} 步：${step.label}`}>
      <h3>
        第 {step.idx + 1} 步：{step.label}
        <span className={`workflow-chip status-${step.status}`}>{WORKFLOW_STEP_STATUS_LABEL[step.status]}</span>
      </h3>
      {step.note === '' ? null : <p>{step.note}</p>}
      {step.usage === null ? null : (
        <p className="muted">
          用量：输入 {step.usage.input.toLocaleString()}、输出 {step.usage.output.toLocaleString()} Token
          {step.usage.cost > 0 ? `，$${step.usage.cost.toFixed(4)}` : ''}
          {step.usage.unknown > 0 ? `（${step.usage.unknown} 次费用未知）` : ''}
        </p>
      )}
      {waiting && step.key === 'seed' && !closed ? <SeedStep key={`${step.version}`} view={view} step={step} /> : null}
      {plan === null ? null : <PlanDraftChapters draft={plan} withBeats={false} />}
      {step.key === 'write' ? (
        <p>
          <button type="button" className="ghost" onClick={() => void openPlanning()}>
            打开计划页看成书进度
          </button>
        </p>
      ) : null}
      <div className="form-actions">
        {waiting && step.kind === 'draft' && step.key !== 'seed' ? button('采用', 'adopt', true) : null}
        {waiting && step.kind === 'manual' ? button(step.key === 'export' ? '导出' : '做这一步', 'adopt', true) : null}
        {step.status === 'stale' ? button('保留结果', 'keep', true) : null}
        {step.status !== 'pending' && step.status !== 'running' ? button('重做这一步', 'redo') : null}
        {['pending', 'interrupted', 'failed', 'awaiting_author', 'stale'].includes(step.status) ? button('跳过', 'skip') : null}
        {step.status === 'done' && step.kind === 'draft' && step.changes !== null ? button('撤回这次采用', 'withdraw') : null}
      </div>
    </section>
  );
}

/** 一次运行：步骤列表、选中的一步与运行的操作。 */
function RunView({ view }: { readonly view: WorkflowView }) {
  const continueWorkflow = useApp((s) => s.continueWorkflow);
  const stopWorkflow = useApp((s) => s.stopWorkflow);
  const abandon = useApp((s) => s.abandonWorkflow);
  const advancing = useApp((s) => s.workflowAdvancing);
  const progress = useApp((s) => s.workflowProgress);
  const busy = useApp((s) => s.busy);
  const current = view.steps.find((s) => s.status !== 'done' && s.status !== 'skipped') ?? view.steps.at(-1);
  // 作者点开的一步；推进到了新的一步时改为显示新的那一步。
  const [picked, setPicked] = useState<{ readonly idx: number; readonly at: number | undefined } | null>(null);
  const shown = view.steps[picked !== null && picked.at === current?.idx ? picked.idx : (current?.idx ?? 0)];
  const running = advancing === view.run.id;
  return (
    <section className="workflow-run" aria-label={`运行：${view.run.title}`}>
      <header className="workflow-run-head">
        <h3>{view.run.title}</h3>
        <span className={`workflow-chip state-${view.state}`}>{WORKFLOW_STATE_LABEL[view.state]}</span>
        <span className="muted">
          {view.run.mode === 'step' ? '每步停下' : '一路做完'}
          {view.spent.cost > 0 ? ` · 已用 $${view.spent.cost.toFixed(3)}` : ''}
          {view.run.budgetUsd === null ? '' : ` · 上限 $${view.run.budgetUsd}`}
        </span>
      </header>
      {running && progress !== null ? <p aria-live="polite">{progress}</p> : null}
      <div className="form-actions">
        {running ? (
          <button type="button" onClick={stopWorkflow}>
            停下
          </button>
        ) : view.state !== 'ready' && view.state !== 'paused' ? null : (
          <button type="button" className="primary" disabled={busy || advancing !== null} onClick={() => continueWorkflow(view.run.id)}>
            {view.state === 'ready' ? '开始' : '继续'}
          </button>
        )}
        {view.state === 'abandoned' || running ? null : (
          <button type="button" className="ghost" disabled={busy} onClick={() => void abandon(view.run.id)}>
            放弃这次运行
          </button>
        )}
      </div>
      <div className="workflow-body">
        <ol className="workflow-steps" aria-label="步骤">
          {view.steps.map((s) => (
            <li key={s.key}>
              <button type="button" className="workflow-step" aria-current={shown?.idx === s.idx ? 'step' : undefined} data-status={s.status} onClick={() => setPicked({ idx: s.idx, at: current?.idx })}>
                <span className="book-step-n">{s.status === 'done' ? '✓' : s.idx + 1}</span>
                <span>
                  {s.label}
                  <span className="muted"> · {WORKFLOW_STEP_STATUS_LABEL[s.status]}</span>
                </span>
              </button>
            </li>
          ))}
        </ol>
        {shown === undefined ? null : <StepDetail view={view} step={shown} />}
      </div>
    </section>
  );
}

/**
 * 写作工作流（B78）：选一个工作流，软件按固定的步骤依次做；每步的结果在这里看、改、采用，
 * 可以停下、接着做、重做或跳过一步。推进在后台进行，可以离开这一页。
 */
export function WorkflowPanel() {
  const catalog = useApp((s) => s.workflowCatalog);
  const runs = useApp((s) => s.workflows);
  const selectedId = useApp((s) => s.workflowId);
  const select = useApp((s) => s.selectWorkflow);
  const [starting, setStarting] = useState<WorkflowKey | null>(null);
  const selected = runs?.find((v) => v.run.id === selectedId) ?? null;
  const info = catalog.find((w) => w.key === starting) ?? null;
  return (
    <section className="workflow-page" aria-label="写作工作流">
      <h2>写作工作流</h2>
      <p className="muted">选一个工作流，软件按固定的步骤依次做；每步的结果都可以看、改、采用，随时停下，关掉软件后也能接着做。</p>
      <ul className="workflow-cards" aria-label="可用的工作流">
        {catalog.map((w) => (
          <li key={w.key} className="workflow-card">
            <strong>{w.title}</strong>
            <span className="muted">{w.description}</span>
            <button type="button" aria-pressed={starting === w.key} onClick={() => setStarting(starting === w.key ? null : w.key)}>
              {starting === w.key ? '收起' : `新的${w.title}`}
            </button>
          </li>
        ))}
      </ul>
      {info === null ? null : <StartForm key={info.key} info={info} />}
      {runs === null || runs.length === 0 ? null : (
        <>
          <label className="workflow-pick">
            运行
            <select value={selected?.run.id ?? ''} onChange={(e) => select(e.currentTarget.value || null)}>
              {runs.map((v) => (
                <option key={v.run.id} value={v.run.id}>
                  {v.run.title}（{WORKFLOW_STATE_LABEL[v.state]}）
                </option>
              ))}
            </select>
          </label>
          {selected === null ? null : <RunView key={selected.run.id} view={selected} />}
        </>
      )}
    </section>
  );
}
