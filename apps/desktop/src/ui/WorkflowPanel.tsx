import { useEffect, useRef, useState } from 'react';
import { randomIdea } from '../app/idea-seeds';
import { WORKFLOW_STATE_LABEL, WORKFLOW_STEP_STATUS_LABEL } from '../app/labels';
import type { BookSeed } from '../app/quick-book';
import { VOLUME_MODES, type VolumeMode, type VolumeOutline } from '../app/planning';
import { benchmarkAnalysesOf, benchmarkResultOf, bookVolumesOf, castDraftOf, diagnosisOf, FORESHADOW_FINDING_LABEL, findingsOf, openingCompareOf, planDraftOf, reportOf, seedDraftOf, suspectsOf, volumeOutlineOf, MAX_BOOK_CHAPTERS, PLAN_CHAPTERS_PER_CALL, quickBookVolumeIssue, type BookVolumesStep, type WorkflowInfo, type WorkflowKey, type WorkflowQuote, type WorkflowStepView, type WorkflowView } from '../app/workflows';
import { BookSeedFields } from './BookSeedFields';
import { PipelineBoard } from './PipelineBoard';
import { PlanDraftChapters } from './PlanDraftChapters';
import { useApp } from './store-context';

/** 开始表单：一键成书的参数、模式与预算；先估算再开始。模型还不能用时不能开始。 */
function StartForm({ info, modelReady, initialIdea = '', onStarted }: { readonly info: WorkflowInfo; readonly modelReady: boolean; readonly initialIdea?: string; readonly onStarted?: () => void }) {
  const quoteWorkflow = useApp((s) => s.quoteWorkflow);
  const startWorkflow = useApp((s) => s.startWorkflow);
  const advancing = useApp((s) => s.workflowAdvancing);
  const [idea, setIdea] = useState(initialIdea);
  const [genre, setGenre] = useState('');
  const [chapters, setChapters] = useState(info.key === 'opening_polish' ? 3 : 20);
  const [words, setWords] = useState(3000);
  const [volumeMode, setVolumeMode] = useState<VolumeMode>('auto');
  const [volumeCount, setVolumeCount] = useState(3);
  // 总字数框里正在输入的文字：改章数时清掉、离开框时清掉，平时显示按章数算出的数。
  const [totalText, setTotalText] = useState<string | null>(null);
  const [from, setFrom] = useState<string>('');
  const [to, setTo] = useState<string>('');
  const [rereview, setRereview] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [rankText, setRankText] = useState('');
  const [samples, setSamples] = useState<readonly { readonly title: string; readonly text: string }[]>([{ title: '', text: '' }]);
  const startBenchmark = useApp((s) => s.startBenchmark);
  const pickSampleText = useApp((s) => s.pickSampleText);
  const searchWeb = useApp((s) => s.searchWeb);
  const [rankQuery, setRankQuery] = useState('');
  const [searching, setSearching] = useState(false);
  /** 联网搜榜单：搜到的标题与摘要按“一本一段”接到榜单后面，作者再删改。 */
  const searchRank = async () => {
    setSearching(true);
    const hits = await searchWeb(rankQuery);
    setSearching(false);
    if (hits === null || hits.length === 0) return;
    const blocks = hits.map((h) => `${h.title}${h.snippet === '' ? '' : `\n简介：${h.snippet}`}`);
    setRankText([rankText.trim(), ...blocks].filter((b) => b !== '').join('\n\n'));
  };
  const [mode, setMode] = useState<'step' | 'auto'>('step');
  const [budget, setBudget] = useState('');
  const [quote, setQuote] = useState<WorkflowQuote | null>(null);
  // 连按两次“开始”（双击、连按回车）不建两次运行。
  const [submitting, setSubmitting] = useState(false);
  const bookChapters = useApp((s) => s.work?.chapters ?? []);
  const key: WorkflowKey = info.key;
  const params =
    key === 'book_audit'
      ? { from: from === '' ? null : from, to: to === '' ? null : to, rereview }
      : key === 'next_volume'
        ? { chapters, wordsPerChapter: words, instruction }
        : key === 'opening_polish'
          ? { chapters }
          : key === 'cast_completion'
            ? {}
            : key === 'benchmark'
              ? { idea, entries: Math.max(1, samples.filter((x) => x.text.trim() !== '').length) }
              : { idea, genre, chapters, wordsPerChapter: words, volumeMode, volumeCount: volumeMode === 'fixed' ? volumeCount : null };
  const budgetUsd = budget.trim() === '' ? null : Number(budget);
  const touched = () => setQuote(null);
  // 分卷方式与章数搭不搭：不搭时不能开始，提示怎样改。
  const volumeIssue = key === 'quick_book' ? quickBookVolumeIssue({ chapters, volumeMode, volumeCount: volumeMode === 'fixed' ? volumeCount : null }) : null;
  const totalWords = chapters * words;
  return (
    <form
      className="panel-form"
      aria-label={`开始${info.title}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (submitting) return;
        setSubmitting(true);
        const started = key === 'benchmark' ? startBenchmark({ rankText, books: samples, idea, mode, budgetUsd }) : startWorkflow({ workflow: key, params, mode, budgetUsd });
        void started.then(() => onStarted?.()).finally(() => setSubmitting(false));
      }}
    >
      {key === 'benchmark' ? (
        <>
          <p className="muted">榜单可以粘贴，也可以联网搜（要在“模型服务”里配好搜索服务）；样章不自动抓取：把几本对标作品开头几章的样章粘贴进来，或从 TXT 读入。样章只用来拆结构与技法，不随作品导出，拆完就从作品库删除。</p>
          <div className="form-row">
            <label>
              联网搜榜单（例如“起点 月票榜 2026”）
              <input value={rankQuery} onChange={(e) => setRankQuery(e.currentTarget.value)} />
            </label>
            <button type="button" disabled={searching || rankQuery.trim() === ''} onClick={() => void searchRank()}>
              {searching ? '搜索中…' : '搜索并填入榜单'}
            </button>
          </div>
          <label>
            榜单（可不填；一本一段，空行分开，可以写“书名：”“标签：”“字数：”）
            <textarea rows={4} value={rankText} onChange={(e) => setRankText(e.currentTarget.value)} />
          </label>
          {samples.map((x, i) => (
            <fieldset key={i}>
              <legend>样章 {i + 1}</legend>
              <label>
                书名
                <input value={x.title} onChange={(e) => setSamples(samples.map((y, j) => (j === i ? { ...y, title: e.currentTarget.value } : y)))} />
              </label>
              <label>
                样章原文（开头几章）
                <textarea rows={4} value={x.text} onChange={(e) => setSamples(samples.map((y, j) => (j === i ? { ...y, text: e.currentTarget.value } : y)))} />
              </label>
              <div className="form-actions">
                <button
                  type="button"
                  onClick={() =>
                    void pickSampleText().then((picked) => {
                      if (picked !== null) setSamples(samples.map((y, j) => (j === i ? { title: y.title || picked.fileName.replace(/\.(txt|md)$/i, ''), text: picked.text } : y)));
                    })
                  }
                >
                  从 TXT 读入
                </button>
                {samples.length > 1 ? (
                  <button type="button" className="ghost" onClick={() => setSamples(samples.filter((_, j) => j !== i))}>
                    删去这一本
                  </button>
                ) : null}
              </div>
            </fieldset>
          ))}
          <button type="button" onClick={() => setSamples([...samples, { title: '', text: '' }])}>
            再加一本
          </button>
          <label>
            你自己的想法（可不填，开书方向会围绕它）
            <input value={idea} onChange={(e) => setIdea(e.currentTarget.value)} />
          </label>
        </>
      ) : key === 'cast_completion' ? (
        <p className="muted">从各章的长篇记忆里找：说明为空的人物、出场却没有关系的人物，以及正文里有、还没建卡的人物；写成小传与关系的草稿，你勾选后再加进设定与人物关系网。只增不改：锁定的人物不动，已有的说明只在后面补充。</p>
      ) : key === 'opening_polish' ? (
        <>
          <label>
            诊断最前面的几章
            <input type="number" min={1} max={10} value={chapters} onChange={(e) => setChapters(Number(e.currentTarget.value))} />
          </label>
          <p className="muted">先算出几个客观数字（主角第几字出场、对白占多少、前一千字里提到多少设定名），再按开篇的要求逐章诊断；问题列在各章的“审核”里，你处理完再复诊、对比前后。</p>
        </>
      ) : key === 'next_volume' ? (
        <>
          <div className="form-row">
            <label>
              这一卷的章数
              <input type="number" min={1} max={100} value={chapters} onChange={(e) => setChapters(Number(e.currentTarget.value))} />
            </label>
            <label>
              每章字数
              <input type="number" min={500} step={100} value={words} onChange={(e) => setWords(Number(e.currentTarget.value))} />
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
              max={MAX_BOOK_CHAPTERS}
              value={chapters}
              onChange={(e) => {
                setChapters(Number(e.currentTarget.value));
                setTotalText(null);
                touched();
              }}
            />
          </label>
          <label>
            每章字数
            <input
              type="number"
              min={500}
              step={100}
              value={words}
              onChange={(e) => {
                setWords(Number(e.currentTarget.value));
                touched();
              }}
            />
          </label>
          <label>
            总字数（万字）
            <input
              type="number"
              min={0.1}
              step="any"
              value={totalText ?? String(Math.round(totalWords / 1_000) / 10)}
              onBlur={() => setTotalText(null)}
              onChange={(e) => {
                // 改总字数反推章数，每章字数不变。
                setTotalText(e.currentTarget.value);
                const total = Number(e.currentTarget.value) * 10_000;
                if (Number.isFinite(total) && total > 0) setChapters(Math.min(MAX_BOOK_CHAPTERS, Math.max(1, Math.round(total / words))));
                touched();
              }}
            />
          </label>
        </div>
        <div className="form-row">
          <label>
            分卷方式
            <select
              aria-label="分卷方式"
              value={volumeMode}
              onChange={(e) => {
                setVolumeMode(VOLUME_MODES.find((m) => m === e.currentTarget.value) ?? 'auto');
                touched();
              }}
            >
              <option value="auto">自动（按故事段落分，长篇每卷约 20 章）</option>
              <option value="none">不分卷（最多 {PLAN_CHAPTERS_PER_CALL} 章）</option>
              <option value="fixed">指定卷数</option>
            </select>
          </label>
          {volumeMode === 'fixed' ? (
            <label>
              卷数
              <input
                type="number"
                min={1}
                max={200}
                value={volumeCount}
                onChange={(e) => {
                  setVolumeCount(Number(e.currentTarget.value));
                  touched();
                }}
              />
            </label>
          ) : null}
        </div>
        <p className="muted">
          {volumeIssue ?? (chapters > PLAN_CHAPTERS_PER_CALL ? `${chapters} 章先定全书卷纲，再逐卷拆章节计划（每卷不超过 ${PLAN_CHAPTERS_PER_CALL} 章）` : `${chapters} 章一次拆出章节计划`)}
        </p>
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
          {key === 'benchmark' ? '一路做完（对标分析直接存为规划技能）' : key === 'cast_completion' ? '一路做完（草稿全部采用）' : key === 'opening_polish' ? '一路做完（处理问题这一步仍等你）' : key === 'book_audit' ? '一路做完（找到的疑点直接核对）' : key === 'next_volume' ? '一路做完（卷纲与计划直接采用）' : '一路做完（会替换大纲或覆盖计划时仍停下）'}
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
        <button type="submit" className="primary" disabled={!modelReady || submitting || advancing !== null || volumeIssue !== null || (budgetUsd !== null && !(budgetUsd > 0))}>
          开始
        </button>
      </div>
    </form>
  );
}

/**
 * 草稿表单的保存：改过没保存就切到别的步骤（表单卸载）时自动保存，回来时修改还在。
 * 返回保存函数（成功与否）；保存前先记下要保存的内容，卸载时与它比较，刚保存过的不再存一次。
 */
function useDraftSaver<T>(runId: string, idx: number, output: unknown, draft: T | null, payload: (draft: T) => unknown): (draft: T) => Promise<boolean> {
  const edit = useApp((s) => s.editWorkflowStep);
  const latest = useRef<T | null>(draft);
  const saved = useRef(JSON.stringify(output));
  useEffect(() => {
    latest.current = draft;
  }, [draft]);
  useEffect(
    () => () => {
      const d = latest.current;
      if (d === null) return;
      const value = payload(d);
      if (JSON.stringify(value) !== saved.current) void edit(runId, idx, value);
    },
    [edit, runId, idx, payload],
  );
  return async (d: T) => {
    const value = payload(d);
    const before = saved.current;
    saved.current = JSON.stringify(value);
    const ok = await edit(runId, idx, value);
    if (!ok) saved.current = before;
    return ok;
  };
}

const seedPayload = (draft: BookSeed): BookSeed => draft;
const outlinePayload = (draft: VolumeOutline): VolumeOutline => ({ ...draft, mainline: draft.mainline.map((m) => m.trim()).filter((m) => m !== '') });

/** 等作者处理的骨架草稿：改过可以保存，采用时先存修改再采用。 */
function SeedStep({ view, step }: { readonly view: WorkflowView; readonly step: WorkflowStepView }) {
  const [draft, setDraft] = useState<BookSeed | null>(() => seedDraftOf(step));
  const save = useDraftSaver(view.run.id, step.idx, step.output, draft, seedPayload);
  const act = useApp((s) => s.workflowStepAction);
  const busy = useApp((s) => s.busy);
  if (draft === null) return <p className="muted">骨架草稿读不出来，可以重做这一步。</p>;
  const changed = JSON.stringify(draft) !== JSON.stringify(step.output);
  return (
    <div className="panel-form" role="form" aria-label="作品骨架草稿">
      <BookSeedFields seed={draft} onChange={setDraft} />
      <div className="form-actions">
        <button type="button" className="primary" disabled={busy || draft.outline.trim() === ''} onClick={() => void (async () => (changed && !(await save(draft)) ? false : act(view.run.id, step.idx, 'adopt')))()}>
          采用骨架
        </button>
        <button type="button" disabled={busy || !changed} onClick={() => void save(draft)}>
          保存修改
        </button>
      </div>
    </div>
  );
}

/** 等作者处理的卷纲：卷名、梗概、主线、卷末转折可以改，新人物与新伏笔可以删去；采用时先存修改。 */
function OutlineStep({ view, step }: { readonly view: WorkflowView; readonly step: WorkflowStepView }) {
  const [draft, setDraft] = useState<VolumeOutline | null>(() => volumeOutlineOf(step));
  const save = useDraftSaver(view.run.id, step.idx, step.output, draft, outlinePayload);
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
        <button type="button" className="primary" disabled={busy || draft.title.trim() === ''} onClick={() => void (async () => (changed && !(await save(draft)) ? false : act(view.run.id, step.idx, 'adopt')))()}>
          采用卷纲
        </button>
        <button type="button" disabled={busy || !changed} onClick={() => void save(draft)}>
          保存修改
        </button>
      </div>
    </div>
  );
}

const volumesPayload = (draft: BookVolumesStep): BookVolumesStep => ({
  ...draft,
  volumes: draft.volumes.map((v) => ({ ...v, mainline: v.mainline.map((m) => m.trim()).filter((m) => m !== '') })),
});

/** 一键成书的全书卷纲草稿：每卷的卷名、章数、梗概、主线与卷末可以改；采用时按顺序建卷，之后按各卷的章数逐卷拆章。 */
function VolumesStep({ view, step }: { readonly view: WorkflowView; readonly step: WorkflowStepView }) {
  const [draft, setDraft] = useState<BookVolumesStep | null>(() => bookVolumesOf(step));
  const save = useDraftSaver(view.run.id, step.idx, step.output, draft, volumesPayload);
  const act = useApp((s) => s.workflowStepAction);
  const busy = useApp((s) => s.busy);
  if (draft === null) return <p className="muted">卷纲读不出来，可以重做这一步。</p>;
  const patchVolume = (i: number, p: Partial<VolumeOutline>) => setDraft({ ...draft, volumes: draft.volumes.map((v, j) => (j === i ? { ...v, ...p } : v)) });
  const setCount = (i: number, n: number) => setDraft({ ...draft, chapters: draft.chapters.map((c, j) => (j === i ? n : c)) });
  const changed = JSON.stringify(draft) !== JSON.stringify(step.output);
  const total = draft.chapters.reduce((n, c) => n + c, 0);
  const valid = draft.volumes.every((v) => v.title.trim() !== '') && draft.chapters.every((c) => Number.isInteger(c) && c >= 1 && c <= PLAN_CHAPTERS_PER_CALL);
  return (
    <div className="panel-form" role="form" aria-label="全书卷纲草稿">
      <p className="muted">
        共 {draft.volumes.length} 卷、{total} 章；每卷最多 {PLAN_CHAPTERS_PER_CALL} 章。采用后按各卷的章数逐卷拆章节计划。
      </p>
      {draft.volumes.map((v, i) => (
        <fieldset key={i}>
          <legend>第 {i + 1} 卷</legend>
          <div className="form-row">
            <label>
              卷名
              <input aria-label={`第 ${i + 1} 卷卷名`} value={v.title} onChange={(e) => patchVolume(i, { title: e.currentTarget.value })} />
            </label>
            <label>
              章数
              <input aria-label={`第 ${i + 1} 卷章数`} type="number" min={1} max={PLAN_CHAPTERS_PER_CALL} value={draft.chapters[i] ?? 1} onChange={(e) => setCount(i, Number(e.currentTarget.value))} />
            </label>
          </div>
          <label>
            本卷梗概
            <textarea aria-label={`第 ${i + 1} 卷梗概`} rows={2} value={v.summary} onChange={(e) => patchVolume(i, { summary: e.currentTarget.value })} />
          </label>
          <label>
            主线（一行一段）
            <textarea aria-label={`第 ${i + 1} 卷主线`} rows={3} value={v.mainline.join('\n')} onChange={(e) => patchVolume(i, { mainline: e.currentTarget.value.split('\n') })} />
          </label>
          <label>
            卷末转折
            <textarea aria-label={`第 ${i + 1} 卷卷末`} rows={2} value={v.climax} onChange={(e) => patchVolume(i, { climax: e.currentTarget.value })} />
          </label>
          {v.newCharacters.length === 0 ? null : <p className="muted">新人物：{v.newCharacters.map((c) => c.name).join('、')}</p>}
          {v.newForeshadows.length === 0 ? null : <p className="muted">新伏笔：{v.newForeshadows.map((f) => f.title).join('、')}</p>}
          {v.payoffs.length === 0 ? null : <p className="muted">本卷回收：{v.payoffs.join('、')}</p>}
        </fieldset>
      ))}
      <div className="form-actions">
        <button type="button" className="primary" disabled={busy || !valid} onClick={() => void (async () => (changed && !(await save(draft)) ? false : act(view.run.id, step.idx, 'adopt')))()}>
          采用卷纲
        </button>
        <button type="button" disabled={busy || !changed} onClick={() => void save(draft)}>
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
              {x.earlierId === x.laterId ? `${title(x.laterId)}之内` : `${title(x.earlierId)} → ${title(x.laterId)}`}：{x.about}
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

/** 逐本拆解：每本的题材、卖点、开篇钩子、节奏、人物配置与写法。 */
function AnalysesView({ step }: { readonly step: WorkflowStepView }) {
  const analyses = benchmarkAnalysesOf(step);
  if (analyses === null || analyses.length === 0) return null;
  return (
    <div role="group" className="workflow-analyses" aria-label="逐本拆解">
      {analyses.map(({ idx, title, analysis: a }) => (
        <details key={idx} open={analyses.length === 1}>
          <summary>
            《{title}》：{a.genre}
          </summary>
          <p>卖点：{a.sellingPoints.join('；')}</p>
          <p>开篇钩子：{a.hook}</p>
          <p>节奏：{a.pacing.map((p) => `${p.chapter}（${p.role}）`).join(' → ')}</p>
          <p>人物配置：{a.cast.map((c) => `${c.role}：${c.description}`).join('；')}</p>
          <p>核心冲突：{a.conflict}</p>
          <p>章末钩子：{a.chapterHooks}</p>
          <p>写法：{a.techniques.join('；')}</p>
        </details>
      ))}
    </div>
  );
}

/** 对标分析：共性、空位、可借鉴的写法、开书方向（可以直接用一个方向开一键成书）与给规划用的指令。 */
function CompareView({ view, step }: { readonly view: WorkflowView; readonly step: WorkflowStepView }) {
  const result = benchmarkResultOf(step);
  const act = useApp((s) => s.workflowStepAction);
  const prefill = useApp((s) => s.prefillQuickBook);
  const advancing = useApp((s) => s.workflowAdvancing);
  const busy = useApp((s) => s.busy);
  if (result === null) return null;
  const list = (label: string, items: readonly string[]) =>
    items.length === 0 ? null : (
      <>
        <h4>{label}</h4>
        <ul>
          {items.map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
      </>
    );
  return (
    <div role="group" aria-label="对标分析">
      {list('共性的套路', result.common)}
      {list('没被占住的空位', result.gaps)}
      {list('可以借鉴的写法', result.borrow)}
      {result.directions.length === 0 ? null : (
        <>
          <h4>开书方向</h4>
          <ul className="workflow-report">
            {result.directions.map((d, i) => (
              <li key={i}>
                <span>
                  {d.idea}
                  <span className="muted"> · {d.why}</span>
                </span>
                <button
                  type="button"
                  className="link"
                  disabled={busy || advancing !== null}
                  title="填进一键成书的开始表单，章数、字数与卷数由你定"
                  onClick={() => prefill(d.idea)}
                >
                  用这个方向开一键成书
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {result.skill.trim() === '' ? null : (
        <>
          <h4>给规划用的指令</h4>
          <p>{result.skill}</p>
        </>
      )}
      {result.trimmed > 0 ? <p className="muted">{result.trimmed} 处与样章相同的长段文字已截短。</p> : null}
      {step.status === 'awaiting_author' ? (
        <div className="form-actions">
          <button type="button" className="primary" disabled={busy || advancing === view.run.id} onClick={() => void act(view.run.id, step.idx, 'adopt')}>
            存为规划技能
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** 人物补全的草稿：逐项勾选，采用勾选的。 */
function CastStep({ view, step }: { readonly view: WorkflowView; readonly step: WorkflowStepView }) {
  const draft = castDraftOf(step);
  const edit = useApp((s) => s.editWorkflowStep);
  const act = useApp((s) => s.workflowStepAction);
  const busy = useApp((s) => s.busy);
  const chapters = useApp((s) => s.work?.chapters ?? []);
  if (draft === null) return null;
  const waiting = step.status === 'awaiting_author';
  const title = (id: string | null) => (id === null ? '' : `《${chapters.find((c) => c.id === id)?.title ?? ''}》`);
  const toggle = (what: 'characters' | 'relationships', i: number, selected: boolean) =>
    void edit(view.run.id, step.idx, what === 'characters' ? { ...draft, characters: draft.characters.map((c, j) => (j === i ? { ...c, selected } : c)) } : { ...draft, relationships: draft.relationships.map((r, j) => (j === i ? { ...r, selected } : r)) });
  return (
    <div role="group" aria-label="人物补全草稿">
      {draft.characters.length === 0 ? null : (
        <fieldset>
          <legend>人物</legend>
          {draft.characters.map((c, i) => (
            <label key={`${i}-${c.name}`} className="check">
              <input type="checkbox" disabled={!waiting || busy} checked={c.selected} onChange={(e) => toggle('characters', i, e.currentTarget.checked)} />
              <span>
                {c.name}
                {c.entityId === null ? '（新人物）' : '（补小传）'}
                <span className="muted">
                  ：{[c.identity, c.personality, c.motive].filter((x) => x.trim() !== '' && !x.includes('正文未交代')).join('；')}
                  {c.firstChapterId === null ? '' : `；首次出场${title(c.firstChapterId)}`}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
      )}
      {draft.relationships.length === 0 ? null : (
        <fieldset>
          <legend>关系</legend>
          {draft.relationships.map((r, i) => (
            <label key={`${i}-${r.from}-${r.to}-${r.label}`} className="check">
              <input type="checkbox" disabled={!waiting || busy} checked={r.selected} onChange={(e) => toggle('relationships', i, e.currentTarget.checked)} />
              <span>
                {r.mutual ? `${r.from}与${r.to}：${r.label}` : `${r.from}是${r.to}的${r.label}`}
                {r.secret ? '（隐秘）' : ''}
                <span className="muted">
                  {r.fromChapterId === null ? '' : `（${title(r.fromChapterId)}起）`}
                  {r.description === '' ? '' : ` · ${r.description}`}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
      )}
      {waiting ? (
        <div className="form-actions">
          <button type="button" className="primary" disabled={busy} onClick={() => void act(view.run.id, step.idx, 'adopt')}>
            采用勾选的
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** 开篇诊断：各章的问题数与“看审核”。 */
function DiagnosisView({ step }: { readonly step: WorkflowStepView }) {
  const diagnosis = diagnosisOf(step);
  const openReview = useApp((s) => s.openChapterReview);
  if (diagnosis === null) return null;
  return (
    <ul className="workflow-report" aria-label="开篇诊断">
      {diagnosis.chapters.map((c) => (
        <li key={c.chapterId}>
          <span>
            《{c.title}》：{c.issues} 个问题
          </span>
          {c.issues > 0 ? (
            <button type="button" className="link" onClick={() => void openReview(c.chapterId)}>
              看审核
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** 开篇打磨前后的对比：问题数（解决、忽略、新提几条）与几个数字。 */
function OpeningCompareView({ step }: { readonly step: WorkflowStepView }) {
  const compare = openingCompareOf(step);
  if (compare === null) return null;
  const at = (n: number | null) => (n === null ? '没出场' : `第 ${n} 字`);
  return (
    <table className="workflow-compare" aria-label="前后对比">
      <thead>
        <tr>
          <th>章节</th>
          <th>问题</th>
          <th>主角出场</th>
          <th>对白</th>
          <th>前一千字的设定名</th>
        </tr>
      </thead>
      <tbody>
        {compare.rows.map((r) => (
          <tr key={r.chapterId}>
            <td>{r.title}</td>
            <td>
              {r.before.issues} → {r.after.issues}
              {r.changes === undefined ? null : (
                <span className="muted">
                  （解决 {r.changes.resolved}
                  {r.changes.ignored > 0 ? `、忽略 ${r.changes.ignored}` : ''}、新提 {r.changes.added}）
                </span>
              )}
            </td>
            <td>
              {at(r.before.metrics.protagonistAt)} → {at(r.after.metrics.protagonistAt)}
            </td>
            <td>
              {Math.round(r.before.metrics.dialogueRatio * 100)}% → {Math.round(r.after.metrics.dialogueRatio * 100)}%
            </td>
            <td>
              {r.before.metrics.namesInOpening} → {r.after.metrics.namesInOpening}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
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
      {waiting && step.key === 'volumes' && !closed ? <VolumesStep key={`${step.version}`} view={view} step={step} /> : null}
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
      {step.key === 'diagnose' || step.key === 'recheck' ? <DiagnosisView step={step} /> : null}
      {step.key === 'handle' ? <DiagnosisView step={view.steps.find((x) => x.key === 'diagnose') ?? step} /> : null}
      {step.key === 'compare' ? <OpeningCompareView step={step} /> : null}
      {view.run.workflow === 'cast_completion' && step.key === 'draft' ? <CastStep view={view} step={step} /> : null}
      {step.key === 'analyze' ? <AnalysesView step={step} /> : null}
      {view.run.workflow === 'benchmark' && step.key === 'compare' ? <CompareView view={view} step={step} /> : null}
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
        {waiting && step.kind === 'draft' && step.key !== 'seed' && step.key !== 'suspects' && step.key !== 'outline' && step.key !== 'volumes' && !(view.run.workflow === 'cast_completion' && step.key === 'draft') && !(view.run.workflow === 'benchmark' && step.key === 'compare') ? button('采用', 'adopt', true) : null}
        {waiting && step.kind === 'manual' ? button(step.key === 'export' ? '导出' : step.key === 'handle' ? '处理完了，复诊' : '做这一步', 'adopt', true) : null}
        {step.status === 'stale' ? button('保留结果', 'keep', true) : null}
        {step.status !== 'pending' && step.status !== 'running' && !(step.status === 'done' && step.kind === 'draft' && step.changes !== null) ? button('重做这一步', 'redo') : null}
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
  // 扫榜拆书的开书方向带着想法过来：展开一键成书的表单并预填；表单开始或收起后清掉。
  const prefill = useApp((s) => s.quickBookPrefill);
  const clearPrefill = useApp((s) => s.clearQuickBookPrefill);
  const open = prefill !== null ? 'quick_book' : starting;
  // 从“模型服务”回来时重新读取：模型是否可用只在那里改变。
  useEffect(() => {
    if (!modelServicesOpen) void refresh();
  }, [modelServicesOpen, refresh]);
  const selected = runs?.find((v) => v.run.id === selectedId) ?? null;
  const info = catalog.find((w) => w.key === open) ?? null;
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
            <button
              type="button"
              aria-pressed={open === w.key}
              onClick={() => {
                setStarting(open === w.key ? null : w.key);
                clearPrefill();
              }}
            >
              {open === w.key ? '收起' : `新的${w.title}`}
            </button>
          </li>
        ))}
      </ul>
      {info === null ? null : <StartForm key={`${info.key}:${prefill ?? ''}`} info={info} modelReady={modelReady} initialIdea={info.key === 'quick_book' ? (prefill ?? '') : ''} onStarted={clearPrefill} />}
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
