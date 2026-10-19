import { useEffect, useState } from 'react';
import { randomIdea } from '../app/idea-seeds';
import { WORKFLOW_STATE_LABEL, WORKFLOW_STEP_STATUS_LABEL } from '../app/labels';
import type { BookSeed } from '../app/quick-book';
import type { VolumeOutline } from '../app/planning';
import { FORESHADOW_FINDING_LABEL, findingsOf, planDraftOf, reportOf, seedDraftOf, suspectsOf, volumeOutlineOf, type WorkflowInfo, type WorkflowKey, type WorkflowQuote, type WorkflowStepView, type WorkflowView } from '../app/workflows';
import { BookSeedFields } from './BookSeedFields';
import { PipelineBoard } from './PipelineBoard';
import { PlanDraftChapters } from './PlanDraftChapters';
import { useApp } from './store-context';

/** 开始表单：一键成书的参数、模式与预算；先估算再开始。模型还不能用时不能开始。 */
function StartForm({ info, modelReady }: { readonly info: WorkflowInfo; readonly modelReady: boolean }) {
  const quoteWorkflow = useApp((s) => s.quoteWorkflow);
  const startWorkflow = useApp((s) => s.startWorkflow);
  const advancing = useApp((s) => s.workflowAdvancing);
  const [idea, setIdea] = useState('');
  const [genre, setGenre] = useState('');
  const [chapters, setChapters] = useState(20);
  const [words, setWords] = useState(3000);
  const [from, setFrom] = useState<string>('');
  const [to, setTo] = useState<string>('');
  const [rereview, setRereview] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [mode, setMode] = useState<'step' | 'auto'>('step');
  const [budget, setBudget] = useState('');
  const [quote, setQuote] = useState<WorkflowQuote | null>(null);
  const bookChapters = useApp((s) => s.work?.chapters ?? []);
  const key: WorkflowKey = info.key;
  const params =
    key === 'book_audit'
      ? { from: from === '' ? null : from, to: to === '' ? null : to, rereview }
      : key === 'next_volume'
        ? { chapters, wordsPerChapter: words, instruction }
        : { idea, genre, chapters, wordsPerChapter: words };
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
      {key === 'next_volume' ? (
        <>
          <div className="form-row">
            <label>
              这一卷的章数
              <input type="number" min={1} max={100} value={chapters} onChange={(e) => setChapters(Number(e.currentTarget.value))} />
            </label>
            <label>
              每章字数
              <input type="number" min={500} step={500} value={words} onChange={(e) => setWords(Number(e.currentTarget.value))} />
            </label>
          </div>
          <label>
            给这一卷的要求（可不填）
            <textarea rows={2} value={instruction} onChange={(e) => setInstruction(e.currentTarget.value)} />
          </label>
          <p className="muted">接着已经写好的章节往下写：先读最近几章的长篇记忆与没有回收的伏笔，规划下一卷，再只给这一卷拆章，前面的章节不动。</p>
        </>
      ) : key === 'book_audit' ? (
        <>
          <div className="form-row">
            <label>
              从
              <select value={from} onChange={(e) => setFrom(e.currentTarget.value)}>
                <option value="">第一章</option>
                {bookChapters.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </select>
            </label>
            <label>
              到
              <select value={to} onChange={(e) => setTo(e.currentTarget.value)}>
                <option value="">最后一章</option>
                {bookChapters.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="check">
            <input type="checkbox" checked={rereview} onChange={(e) => setRereview(e.currentTarget.checked)} />
            已审过的章节也重新审核
          </label>
          <p className="muted">只体检已经有正文的章节。跨章的疑点先由各章的长篇记忆找出，再逐条读两章的原文确认，问题列在后一章的“审核”里。</p>
        </>
      ) : (
        <>
        <div className="book-idea-head">
          <label htmlFor="workflow-idea">一句话的想法</label>
          <button
            type="button"
            className="link"
            title="从人物、处境与转折中随机拼一句，可以接着改；填了类型时按类型挑"
            onClick={() => {
              // 随机只用来给作者一个起点，不进入推演，不需要可复现。
              const next = randomIdea(genre, Math.random);
              setIdea(next.idea);
              setGenre(next.genre);
              touched();
            }}
          >
            随机生成
          </button>
        </div>
        <textarea
          id="workflow-idea"
          rows={2}
          placeholder="没有想法？随机生成一个"
          value={idea}
          onChange={(e) => {
            setIdea(e.currentTarget.value);
            touched();
          }}
        />
        <p className="muted">已有大纲时可以不写，开始后跳过“大纲与人物”这一步。</p>
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
        </>
      )}
      <fieldset>
        <legend>做法</legend>
        <label className="check">
          <input type="radio" name="workflow-mode" checked={mode === 'step'} onChange={() => setMode('step')} />
          每步停下给我看（草稿改过再采用）
        </label>
        <label className="check">
          <input type="radio" name="workflow-mode" checked={mode === 'auto'} onChange={() => setMode('auto')} />
          {key === 'book_audit' ? '一路做完（找到的疑点直接核对）' : key === 'next_volume' ? '一路做完（卷纲与计划直接采用）' : '一路做完（会替换大纲或覆盖计划时仍停下）'}
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
        <button type="submit" className="primary" disabled={!modelReady || advancing !== null || (budgetUsd !== null && !(budgetUsd > 0))}>
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

/** 等作者处理的卷纲：卷名、梗概、主线、卷末转折可以改，新人物与新伏笔可以删去；采用时先存修改。 */
function OutlineStep({ view, step }: { readonly view: WorkflowView; readonly step: WorkflowStepView }) {
  const [draft, setDraft] = useState<VolumeOutline | null>(() => volumeOutlineOf(step));
  const edit = useApp((s) => s.editWorkflowStep);
  const act = useApp((s) => s.workflowStepAction);
  const busy = useApp((s) => s.busy);
  if (draft === null) return <p className="muted">卷纲读不出来，可以重做这一步。</p>;
  const patch = (p: Partial<VolumeOutline>) => setDraft({ ...draft, ...p });
  const changed = JSON.stringify(draft) !== JSON.stringify(step.output);
  return (
    <div className="panel-form" role="form" aria-label="卷纲草稿">
      <label>
        卷名
        <input value={draft.title} onChange={(e) => patch({ title: e.currentTarget.value })} />
      </label>
      <label>
        本卷梗概
        <textarea rows={2} value={draft.summary} onChange={(e) => patch({ summary: e.currentTarget.value })} />
      </label>
      <label>
        主线（一行一段）
        <textarea rows={4} value={draft.mainline.join('\n')} onChange={(e) => patch({ mainline: e.currentTarget.value.split('\n') })} />
      </label>
      <label>
        卷末转折
        <textarea rows={2} value={draft.climax} onChange={(e) => patch({ climax: e.currentTarget.value })} />
      </label>
      {draft.newCharacters.length === 0 ? null : (
        <fieldset>
          <legend>新人物</legend>
          {draft.newCharacters.map((c, i) => (
            <div key={i} className="book-character">
              <span>
                {c.name}
                <span className="muted">：{c.description}</span>
              </span>
              <button type="button" className="ghost" aria-label={`删去新人物 ${c.name}`} onClick={() => patch({ newCharacters: draft.newCharacters.filter((_, j) => j !== i) })}>
                删去
              </button>
            </div>
          ))}
        </fieldset>
      )}
      {draft.newForeshadows.length === 0 ? null : (
        <fieldset>
          <legend>新伏笔</legend>
          {draft.newForeshadows.map((f, i) => (
            <div key={i} className="book-character">
              <span>
                {f.title}
                <span className="muted">：{f.content}（揭晓：{f.reveal}）</span>
              </span>
              <button type="button" className="ghost" aria-label={`删去新伏笔 ${f.title}`} onClick={() => patch({ newForeshadows: draft.newForeshadows.filter((_, j) => j !== i) })}>
                删去
              </button>
            </div>
          ))}
        </fieldset>
      )}
      {draft.payoffs.length === 0 ? null : <p className="muted">本卷要回收的伏笔：{draft.payoffs.join('、')}</p>}
      <div className="form-actions">
        <button
          type="button"
          className="primary"
          disabled={busy || draft.title.trim() === ''}
          onClick={() => void (async () => (changed && !(await edit(view.run.id, step.idx, { ...draft, mainline: draft.mainline.map((m) => m.trim()).filter((m) => m !== '') })) ? false : act(view.run.id, step.idx, 'adopt')))()}
        >
          采用卷纲
        </button>
        <button type="button" disabled={busy || !changed} onClick={() => void edit(view.run.id, step.idx, { ...draft, mainline: draft.mainline.map((m) => m.trim()).filter((m) => m !== '') })}>
          保存修改
        </button>
      </div>
    </div>
  );
}

/** 等作者确认的跨章疑点：用不着核对的可以删去，确认后逐条读两章的原文。 */
function SuspectsStep({ view, step }: { readonly view: WorkflowView; readonly step: WorkflowStepView }) {
  const draft = suspectsOf(step);
  const edit = useApp((s) => s.editWorkflowStep);
  const act = useApp((s) => s.workflowStepAction);
  const busy = useApp((s) => s.busy);
  const titleOf = useApp((s) => s.work?.chapters ?? []);
  if (draft === null) return null;
  const title = (id: string) => `《${titleOf.find((c) => c.id === id)?.title ?? ''}》`;
  const waiting = step.status === 'awaiting_author';
  return (
    <div role="group" aria-label="跨章疑点">
      <ol className="workflow-suspects">
        {draft.suspects.map((x, i) => (
          <li key={`${x.earlierId}-${x.laterId}-${i}`}>
            <span>
              {title(x.earlierId)} → {title(x.laterId)}：{x.about}
            </span>
            {waiting ? (
              <button type="button" className="ghost" disabled={busy} aria-label={`删去疑点 ${i + 1}`} onClick={() => void edit(view.run.id, step.idx, { ...draft, suspects: draft.suspects.filter((_, j) => j !== i) })}>
                删去
              </button>
            ) : null}
          </li>
        ))}
      </ol>
      {waiting ? (
        <div className="form-actions">
          <button type="button" className="primary" disabled={busy} onClick={() => void act(view.run.id, step.idx, 'adopt')}>
            确认，逐条核对
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** 体检报告：有待处理问题的章节，点开它的审核。 */
function AuditReportView({ step }: { readonly step: WorkflowStepView }) {
  const report = reportOf(step);
  const openReview = useApp((s) => s.openChapterReview);
  if (report === null) return null;
  const rows = report.chapters.filter((c) => c.pending > 0);
  if (rows.length === 0) return <p>范围内的章节没有待处理的审核问题。</p>;
  return (
    <ul className="workflow-report" aria-label="体检报告">
      {rows.map((r) => (
        <li key={r.chapterId}>
          <span>
            《{r.title}》：{r.pending} 条待处理
          </span>
          <button type="button" className="link" onClick={() => void openReview(r.chapterId)}>
            看审核
          </button>
        </li>
      ))}
    </ul>
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
  const findings = step.key === 'foreshadow' ? findingsOf(step) : null;
  const chapters = useApp((s) => s.work?.chapters ?? []);
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
      {step.key === 'suspects' ? <SuspectsStep view={view} step={step} /> : null}
      {waiting && step.key === 'outline' && !closed ? <OutlineStep key={`${step.version}`} view={view} step={step} /> : null}
      {findings === null || findings.length === 0 ? null : (
        <ul aria-label="伏笔核对">
          {findings.map((f) => (
            <li key={f.foreshadowId}>
              {f.title}：{FORESHADOW_FINDING_LABEL[f.problem]}
              {f.chapterId === null ? '' : `（《${chapters.find((c) => c.id === f.chapterId)?.title ?? ''}》）`}
            </li>
          ))}
        </ul>
      )}
      {step.key === 'report' ? <AuditReportView step={step} /> : null}
      {step.key === 'write' ? (
        <>
          <p className="muted">
            每章写完整理长篇记忆并审核；也可以在下面的成书进度里自己排定章节。
            <button type="button" className="link" onClick={() => void openPlanning()}>
              查看与修改计划
            </button>
          </p>
          <PipelineBoard />
        </>
      ) : null}
      <div className="form-actions">
        {waiting && step.kind === 'draft' && step.key !== 'seed' && step.key !== 'suspects' && step.key !== 'outline' ? button('采用', 'adopt', true) : null}
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

/** 默认模型能不能用，以及这部作品走到了哪里（大纲、人物、计划、写完的章数）。 */
function BookStatus() {
  const status = useApp((s) => s.quickBook);
  const openModelServices = useApp((s) => s.openModelServices);
  const showPanel = useApp((s) => s.showPanel);
  if (status === null) return <p className="muted">正在读取…</p>;
  const { model } = status;
  return (
    <div className="book-status" aria-label="作品现状">
      {model.ready ? (
        <p>已连接：{model.name}</p>
      ) : (
        <p>
          {model.problem}。
          {model.name === null ? '在“模型服务”里添加服务、填写 API Key、获取模型列表，运行能力自检后设为默认模型。' : '打开“模型服务”，对这个模型运行能力自检；通不过时换一个模型设为默认。'}
          <button type="button" className="link" onClick={() => void openModelServices()}>
            设置模型服务
          </button>
        </p>
      )}
      <p className="muted">
        {status.outline ? `大纲已写好，人物 ${status.characters} 个` : '还没有大纲'}；{status.chapters} 章，{status.planned} 章有计划，已写 {status.written} 章
        {status.pendingIssues > 0 ? `，待处理的审核问题 ${status.pendingIssues} 条` : ''}。
        <button type="button" className="link" onClick={() => void showPanel('info')}>
          查看或修改作品信息
        </button>
      </p>
    </div>
  );
}

/**
 * 成书（B67、B78）：写作工作流——选一个工作流，软件按固定的步骤依次做；每步的结果在这里看、改、采用，
 * 可以停下、接着做、重做或跳过一步。推进在后台进行，可以离开这一页。还没有运行时展开“一键成书”的开始表单。
 */
export function WorkflowPanel() {
  const catalog = useApp((s) => s.workflowCatalog);
  const runs = useApp((s) => s.workflows);
  const selectedId = useApp((s) => s.workflowId);
  const select = useApp((s) => s.selectWorkflow);
  const modelReady = useApp((s) => s.quickBook?.model.ready ?? false);
  const modelServicesOpen = useApp((s) => s.modelServicesOpen);
  const refresh = useApp((s) => s.refreshQuickBook);
  const [starting, setStarting] = useState<WorkflowKey | null>(runs !== null && runs.length > 0 ? null : 'quick_book');
  // 从“模型服务”回来时重新读取：模型是否可用只在那里改变。
  useEffect(() => {
    if (!modelServicesOpen) void refresh();
  }, [modelServicesOpen, refresh]);
  const selected = runs?.find((v) => v.run.id === selectedId) ?? null;
  const info = catalog.find((w) => w.key === starting) ?? null;
  return (
    <section className="workflow-page" aria-label="成书">
      <h2>成书</h2>
      <p className="muted">选一个写作工作流，软件按固定的步骤依次做；每步的结果都可以看、改、采用，随时停下，关掉软件后也能接着做。</p>
      <BookStatus />
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
      {info === null ? null : <StartForm key={info.key} info={info} modelReady={modelReady} />}
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
