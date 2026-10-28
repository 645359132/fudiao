import { useRef, useState, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { CHAPTER_TYPE_LABEL, CHAPTER_TYPES, DIALOGUE_LEVEL_LABEL, DIALOGUE_LEVELS, ENDING_STYLE_LABEL, ENDING_STYLES, type ChapterRhythm, type ChapterType, type DialogueLevel, type EndingStyle } from '@fudiao/shared';
import type { Foreshadow, ForeshadowFields, ForeshadowStatus } from '@fudiao/store';
import type { PlanChapterView } from '../app/planning';
import { PipelineBoard, PLAN_VIRTUAL_FROM } from './PipelineBoard';
import { PlanDraftChapters } from './PlanDraftChapters';
import { FORESHADOW_STATUS_LABEL, PLAN_STATUS_LABEL } from '../app/labels';
import { useApp } from './store-context';

const STATUS = FORESHADOW_STATUS_LABEL;
const PROBLEM: Record<string, string> = {
  unknown_foreshadow: '引用了账本中没有的伏笔',
  payoff_before_plant: '回收章节在埋设章节之前',
  foreshadow_closed: '伏笔已回收或废弃，又被安排',
};
const lines = (text: string) => text.split('\n').map((l) => l.trim()).filter((l) => l !== '');

/**
 * 收起时不渲染内容的 details：展开时才建里面的表单与列表。每章一份计划表单（人物与伏笔的勾选框）全部建出来，
 * 200 章的书有四万多个元素、一万多个输入框，点“计划”要等一两秒（作者反馈 2026-10-25）。
 */
function LazyDetails({ summary, children }: { readonly summary: ReactNode; readonly children: () => ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>{summary}</summary>
      {open ? children() : null}
    </details>
  );
}

/** 由大纲生成计划草稿；草稿要作者看过并“采用”后才写入。 */
function DraftSection() {
  const planning = useApp((s) => s.planning);
  const draft = useApp((s) => s.planDraft);
  const drafting = useApp((s) => s.planDrafting);
  const unmatched = useApp((s) => s.planUnmatched);
  const generate = useApp((s) => s.draftPlans);
  const apply = useApp((s) => s.applyPlanDraft);
  const discard = useApp((s) => s.discardPlanDraft);
  const busy = useApp((s) => s.busy);
  const [count, setCount] = useState(Math.max(planning?.chapters.length ?? 0, 10));
  const [words, setWords] = useState(3000);
  const noOutline = (planning?.outline.trim() ?? '') === '';
  return (
    <section aria-label="计划草稿" className="panel-form">
      <h3>由大纲生成计划草稿</h3>
      {noOutline ? <p className="muted">先在作品信息里写下作品大纲。</p> : null}
      <div className="skill-actions">
        <label>
          章数
          <input type="number" min={1} max={100} value={count} onChange={(e) => setCount(Number(e.target.value))} />
        </label>
        <label>
          每章字数
          <input type="number" min={500} step={500} value={words} onChange={(e) => setWords(Number(e.target.value))} />
        </label>
      </div>
      <button type="button" disabled={busy || drafting || noOutline || count < 1} onClick={() => void generate(count, words)}>
        {drafting ? '正在生成…' : '生成计划草稿'}
      </button>
      {unmatched.length > 0 ? <p className="muted">草稿中这些人物还没有设定，没有加入出场人物：{unmatched.join('、')}。</p> : null}
      {draft === null ? null : (
        <div aria-label="草稿内容">
          <PlanDraftChapters draft={draft} withBeats />
          {draft.foreshadows.length > 0 ? <p>新伏笔：{draft.foreshadows.map((f) => f.title).join('、')}</p> : null}
          <p className="muted">采用后，已有的章节按顺序对应草稿的前几章（章名不改），多出的章节在末尾新建；已有的计划会被草稿覆盖。</p>
          <div className="skill-actions">
            <button type="button" disabled={busy} onClick={() => void apply()}>
              采用草稿
            </button>
            <button type="button" onClick={discard}>
              放弃草稿
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function PlanEditor({ item }: { readonly item: PlanChapterView }) {
  const planning = useApp((s) => s.planning);
  const save = useApp((s) => s.savePlan);
  const busy = useApp((s) => s.busy);
  const plan = item.plan;
  const [goal, setGoal] = useState(plan?.goal ?? '');
  const [cast, setCast] = useState<readonly string[]>(plan?.castIds ?? []);
  const [beats, setBeats] = useState((plan?.beats ?? []).join('\n'));
  const [plant, setPlant] = useState<readonly string[]>(plan?.foreshadowPlant ?? []);
  const [payoff, setPayoff] = useState<readonly string[]>(plan?.foreshadowPayoff ?? []);
  const [treatment, setTreatment] = useState(plan?.treatment ?? '');
  const [target, setTarget] = useState(plan?.targetWords === null || plan === null ? '' : String(plan.targetWords));
  // 节奏目标（B87）：三项都没选时为没有。
  const [type, setType] = useState<ChapterType | ''>(plan?.rhythm?.type ?? '');
  const [dialogue, setDialogue] = useState<DialogueLevel | ''>(plan?.rhythm?.dialogue ?? '');
  const [ending, setEnding] = useState<EndingStyle | ''>(plan?.rhythm?.ending ?? '');
  const rhythm: ChapterRhythm | null =
    type === '' && dialogue === '' && ending === '' ? null : { type: type === '' ? 'other' : type, dialogue: dialogue === '' ? 'mid' : dialogue, ending: ending === '' ? 'cliffhanger' : ending };
  const toggle = (list: readonly string[], id: string, on: boolean) => (on ? [...list, id] : list.filter((x) => x !== id));
  const open = (planning?.foreshadows ?? []).filter((f) => f.status !== 'dropped' && f.status !== 'paid_off');
  return (
    <form
      className="panel-form"
      aria-label={`${item.chapter.title}的计划`}
      onSubmit={(e) => {
        e.preventDefault();
        void save(item.chapter.id, {
          goal,
          castIds: cast,
          beats: lines(beats),
          foreshadowPlant: plant,
          foreshadowPayoff: payoff,
          treatment,
          targetWords: target.trim() === '' ? null : Math.max(1, Math.round(Number(target))),
          rhythm,
        });
      }}
    >
      <label>
        本章目标
        <input value={goal} onChange={(e) => setGoal(e.target.value)} />
      </label>
      <fieldset>
        <legend>出场人物</legend>
        {(planning?.characters ?? []).map((c) => (
          <label key={c.id}>
            <input type="checkbox" checked={cast.includes(c.id)} onChange={(e) => setCast(toggle(cast, c.id, e.target.checked))} />
            {c.name}
          </label>
        ))}
      </fieldset>
      <label>
        情节点（每行一条）
        <textarea rows={4} value={beats} onChange={(e) => setBeats(e.target.value)} />
      </label>
      <fieldset>
        <legend>伏笔</legend>
        {open.length === 0 ? <span className="muted">伏笔账本里还没有未回收的伏笔。</span> : null}
        {open.map((f) => (
          <div key={f.id} className="skill-actions">
            <span>{f.title}</span>
            <label>
              <input type="checkbox" checked={plant.includes(f.id)} onChange={(e) => setPlant(toggle(plant, f.id, e.target.checked))} />
              本章埋
            </label>
            <label>
              <input type="checkbox" checked={payoff.includes(f.id)} onChange={(e) => setPayoff(toggle(payoff, f.id, e.target.checked))} />
              本章收
            </label>
          </div>
        ))}
      </fieldset>
      <label>
        详略说明
        <textarea rows={2} value={treatment} onChange={(e) => setTreatment(e.target.value)} />
      </label>
      <label>
        字数
        <input type="number" min={1} value={target} onChange={(e) => setTarget(e.target.value)} />
      </label>
      <div className="skill-actions">
        <label>
          章节类型
          <select value={type} onChange={(e) => setType(e.target.value as ChapterType | '')}>
            <option value="">不定</option>
            {CHAPTER_TYPES.map((t) => (
              <option key={t} value={t}>
                {CHAPTER_TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </label>
        <label>
          对话多少
          <select value={dialogue} onChange={(e) => setDialogue(e.target.value as DialogueLevel | '')}>
            <option value="">不定</option>
            {DIALOGUE_LEVELS.map((d) => (
              <option key={d} value={d}>
                {DIALOGUE_LEVEL_LABEL[d]}
              </option>
            ))}
          </select>
        </label>
        <label>
          章尾收法
          <select value={ending} onChange={(e) => setEnding(e.target.value as EndingStyle | '')}>
            <option value="">不定</option>
            {ENDING_STYLES.map((s) => (
              <option key={s} value={s}>
                {ENDING_STYLE_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <button type="submit" disabled={busy}>
        保存计划
      </button>
    </form>
  );
}

function ForeshadowEditor({ item, onDone }: { readonly item: Foreshadow | null; readonly onDone: () => void }) {
  const planning = useApp((s) => s.planning);
  const add = useApp((s) => s.addForeshadow);
  const update = useApp((s) => s.updateForeshadow);
  const remove = useApp((s) => s.deleteForeshadow);
  const busy = useApp((s) => s.busy);
  const [title, setTitle] = useState(item?.title ?? '');
  const [content, setContent] = useState(item?.content ?? '');
  const [reveal, setReveal] = useState(item?.reveal ?? '');
  const [plantAt, setPlantAt] = useState(item?.plantChapterId ?? '');
  const [payoffAt, setPayoffAt] = useState(item?.payoffChapterId ?? '');
  const [status, setStatus] = useState<ForeshadowStatus>(item?.status ?? 'planned');
  const chapters = planning?.chapters.map((c) => c.chapter) ?? [];
  const fields = (): ForeshadowFields => ({
    title,
    content,
    reveal,
    plantChapterId: plantAt === '' ? null : plantAt,
    plantAnchor: item?.plantAnchor ?? null,
    payoffChapterId: payoffAt === '' ? null : payoffAt,
    payoffAnchor: item?.payoffAnchor ?? null,
    status,
  });
  const chapterSelect = (label: string, value: string, set: (v: string) => void) => (
    <label>
      {label}
      <select value={value} onChange={(e) => set(e.target.value)}>
        <option value="">未定</option>
        {chapters.map((c) => (
          <option key={c.id} value={c.id}>
            {c.title}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <form
      className="panel-form"
      aria-label={item === null ? '新伏笔' : `伏笔“${item.title}”`}
      onSubmit={(e) => {
        e.preventDefault();
        void (item === null ? add(fields()) : update(item.id, fields())).then((done) => done && onDone());
      }}
    >
      <label>
        名称
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label>
        埋设时写什么
        <textarea rows={2} value={content} onChange={(e) => setContent(e.target.value)} />
      </label>
      <label>
        揭晓的内容（回收之前不得说破）
        <textarea rows={2} value={reveal} onChange={(e) => setReveal(e.target.value)} />
      </label>
      {chapterSelect('埋设章节', plantAt, setPlantAt)}
      {chapterSelect('回收章节', payoffAt, setPayoffAt)}
      <label>
        状态
        <select value={status} onChange={(e) => setStatus(e.target.value as ForeshadowStatus)}>
          {(Object.keys(STATUS) as ForeshadowStatus[]).map((s) => (
            <option key={s} value={s}>
              {STATUS[s]}
            </option>
          ))}
        </select>
      </label>
      <div className="skill-actions">
        <button type="submit" disabled={busy || title.trim() === ''}>
          {item === null ? '加入账本' : '保存伏笔'}
        </button>
        {item === null ? null : (
          <button type="button" disabled={busy} onClick={() => void remove(item.id).then((done) => done && onDone())}>
            删除伏笔
          </button>
        )}
      </div>
    </form>
  );
}

function Ledger() {
  const planning = useApp((s) => s.planning);
  const update = useApp((s) => s.updateForeshadow);
  const busy = useApp((s) => s.busy);
  const [editing, setEditing] = useState<string | null>(null);
  const suggestionOf = (id: string) => planning?.foreshadowSuggestions.find((s) => s.foreshadowId === id);
  const chapterTitle = (id: string | null) => planning?.chapters.find((c) => c.chapter.id === id)?.chapter.title ?? '未定';
  return (
    <section aria-label="伏笔账本">
      <h3>伏笔账本</h3>
      <ul className="skill-list">
        {(planning?.foreshadows ?? []).map((f) => (
          <li key={`${f.id}:${f.version}`} className="skill" aria-label={f.title}>
            <div className="skill-head">
              <strong>{f.title}</strong>
              <span className="muted">
                {STATUS[f.status]} · 埋：{chapterTitle(f.plantChapterId)} · 收：{chapterTitle(f.payoffChapterId)}
              </span>
              <button type="button" onClick={() => setEditing(editing === f.id ? null : f.id)}>
                {editing === f.id ? '收起' : '编辑'}
              </button>
            </div>
            {suggestionOf(f.id) === undefined ? null : (
              <FollowUp
                text={`“${chapterTitle(suggestionOf(f.id)?.chapterId ?? null)}”已经写完${suggestionOf(f.id)?.progress ? `，长篇记忆里的进展：${suggestionOf(f.id)?.progress ?? ''}` : ''}`}
                label={`标为${STATUS[suggestionOf(f.id)?.status ?? 'planted']}`}
                disabled={busy}
                onAccept={() =>
                  void update(f.id, {
                    title: f.title,
                    content: f.content,
                    reveal: f.reveal,
                    plantChapterId: f.plantChapterId,
                    plantAnchor: f.plantAnchor,
                    payoffChapterId: f.payoffChapterId,
                    payoffAnchor: f.payoffAnchor,
                    status: suggestionOf(f.id)?.status ?? f.status,
                  })
                }
              />
            )}
            {editing === f.id ? <ForeshadowEditor item={f} onDone={() => setEditing(null)} /> : null}
          </li>
        ))}
      </ul>
      {editing === 'new' ? (
        <ForeshadowEditor item={null} onDone={() => setEditing(null)} />
      ) : (
        <button type="button" onClick={() => setEditing('new')}>
          新伏笔
        </button>
      )}
    </section>
  );
}

/** 账本状态的建议：章节写完了，请作者确认伏笔是否已经埋下或回收。 */
function FollowUp({ text, label, disabled, onAccept }: { readonly text: string; readonly label: string; readonly disabled: boolean; readonly onAccept: () => void }) {
  return (
    <div className="skill-actions" role="group" aria-label="账本状态的建议">
      <span className="muted">{text}</span>
      <button type="button" disabled={disabled} onClick={onAccept}>
        {label}
      </button>
    </div>
  );
}


/** 一章的写作状态与写手操作：写这一章、接着写、回退到写手写入前。 */
function WriterActions({ item }: { readonly item: PlanChapterView }) {
  const writerJob = useApp((s) => s.writerJob);
  const mine = useApp((s) => s.writerJobs.find((j) => j.chapterId === item.chapter.id));
  const write = useApp((s) => s.writeChapters);
  const simulate = useApp((s) => s.simulateChapter);
  const rollback = useApp((s) => s.rollbackWriter);
  const cancel = useApp((s) => s.cancelWriting);
  const busy = useApp((s) => s.busy);
  const [confirming, setConfirming] = useState(false);
  const plan = item.plan;
  if (plan === null) return null;
  const here = mine !== undefined;
  const queued = writerJob?.queued.includes(item.chapter.id) === true;
  const progress = plan.progress;
  return (
    <div className="skill-actions" role="group" aria-label={`${item.chapter.title}的写作`}>
      <span className="muted">
        {mine !== undefined
          ? mine.stage === 'writing'
            ? `写手正在写${mine.total > 0 ? `（${mine.done} / ${mine.total} 段）` : ''}`
            : mine.stage === 'memory'
              ? '已写完，正在整理长篇记忆'
              : mine.stage === 'relations'
                ? '已写完，正在找人物关系的变化'
                : '已写完，正在审核'
          : queued
            ? '排队中'
            : PLAN_STATUS_LABEL[plan.status]}
        {!here && plan.status === 'writing' && progress !== null ? `（已写 ${progress.done} / ${progress.segments.length} 段）` : ''}
      </span>
      {here ? (
        <button type="button" onClick={cancel}>
          停下
        </button>
      ) : null}
      {writerJob === null && (plan.status === 'todo' || plan.status === 'writing') ? (
        <button type="button" disabled={busy} onClick={() => void write([item.chapter.id])}>
          {plan.status === 'writing' ? '接着写' : '写这一章'}
        </button>
      ) : null}
      <button type="button" disabled={busy} title="按本章的计划与出场人物各自知道的事建推演场景，让角色自己走一遍" onClick={() => void simulate(item.chapter.id)}>
        推演这一章
      </button>
      {writerJob === null && progress !== null ? (
        confirming ? (
          <>
            <span>回退后，写手写入的段落与之后的修改都会撤掉；现稿会先存为一个快照。</span>
            <button type="button" disabled={busy} onClick={() => void rollback(item.chapter.id).then(() => setConfirming(false))}>
              确定回退
            </button>
            <button type="button" onClick={() => setConfirming(false)}>
              取消
            </button>
          </>
        ) : (
          <button type="button" disabled={busy} onClick={() => setConfirming(true)}>
            回退到写手写入前
          </button>
        )
      ) : null}
    </div>
  );
}

/** 一章的长篇记忆（B66）：状态、内容与生成、重建。没有正文的章节不显示。 */
function MemoryBlock({ item }: { readonly item: PlanChapterView }) {
  const planning = useApp((s) => s.planning);
  const building = useApp((s) => s.memoryBuilding);
  const writerJob = useApp((s) => s.writerJob);
  // 写手写完一章整理记忆时也算在生成。
  const writerMemory = useApp((s) => s.writerJobs.some((j) => j.chapterId === item.chapter.id && j.stage === 'memory'));
  const build = useApp((s) => s.buildMemory);
  const busy = useApp((s) => s.busy);
  const { memory } = item;
  if (planning === null || (!item.hasText && memory === null)) return null;
  const here = building === item.chapter.id || writerMemory;
  const status = here
    ? '正在生成…'
    : memory === null
      ? '还没有'
      : !item.hasText
        ? '待复核（这一章现在没有正文，写手不会用这份记忆）'
        : memory.status === 'stale'
          ? '待复核（正文在生成记忆之后改过）'
          : '有效';
  const cast = memory === null ? [] : planning.characters.flatMap((c) => (memory.castState[c.id] === undefined ? [] : [{ id: c.id, name: c.name, text: memory.castState[c.id] }]));
  const progress = memory === null ? [] : planning.foreshadows.flatMap((f) => (memory.foreshadowProgress[f.id] === undefined ? [] : [{ id: f.id, name: f.title, text: memory.foreshadowProgress[f.id] }]));
  return (
    <div role="group" aria-label={`${item.chapter.title}的长篇记忆`}>
      <div className="skill-actions">
        <span className="muted">长篇记忆：{status}</span>
        <button type="button" disabled={busy || writerJob !== null || building !== null || !item.hasText} onClick={() => void build(item.chapter.id)}>
          {memory === null ? '生成记忆' : '重建记忆'}
        </button>
      </div>
      {memory !== null ? (
        <LazyDetails summary="查看记忆">
          {() => (
            <>
              <p>{memory.summary}</p>
              {cast.length > 0 ? (
                <ul aria-label="人物状态">
                  {cast.map((c) => (
                    <li key={c.id}>
                      {c.name}：{c.text}
                    </li>
                  ))}
                </ul>
              ) : null}
              {progress.length > 0 ? (
                <ul aria-label="伏笔进展">
                  {progress.map((f) => (
                    <li key={f.id}>
                      {f.name}：{f.text}
                    </li>
                  ))}
                </ul>
              ) : null}
              {memory.openThreads.length > 0 ? (
                <ul aria-label="章尾留给后面的事">
                  {memory.openThreads.map((t, i) => (
                    <li key={i}>{t}</li>
                  ))}
                </ul>
              ) : null}
            </>
          )}
        </LazyDetails>
      ) : null}
    </div>
  );
}

/** 一章的计划、写作与长篇记忆。measure 是虚拟列表量行高用的（章节不多、不虚拟时为 undefined）。 */
function PlanChapterItem({ item, index, foreshadows, measure }: { readonly item: PlanChapterView; readonly index: number; readonly foreshadows: readonly Foreshadow[]; readonly measure: ((el: Element | null) => void) | undefined }) {
  return (
    <li ref={measure} data-index={index} className="skill" aria-label={item.chapter.title}>
      <LazyDetails
        summary={
          <>
            {item.chapter.title}
            {item.plan === null ? <span className="muted">（还没有计划）</span> : <span className="muted">：{item.plan.goal}</span>}
          </>
        }
      >
        {() => <PlanEditor item={item} />}
      </LazyDetails>
      <WriterActions item={item} />
      <MemoryBlock item={item} />
      {item.problems.map((p) => (
        <p key={`${p.code}:${p.foreshadowId}`} className="field-error">
          {PROBLEM[p.code]}：{foreshadows.find((f) => f.id === p.foreshadowId)?.title ?? p.foreshadowId}
        </p>
      ))}
    </li>
  );
}

/**
 * 各章的计划。章数多于 PLAN_VIRTUAL_FROM 时放进一个滚动框，只渲染看得见的几十章，上下用内边距占住其余各章的高度，
 * 每章的实际高度渲染后量出（展开计划表单时会变高）；做法同章节目录。
 */
function ChapterPlanList({ chapters, foreshadows }: { readonly chapters: readonly PlanChapterView[]; readonly foreshadows: readonly Foreshadow[] }) {
  // useVirtualizer 的实例在滚动时原地更新，React Compiler 的缓存会让列表停在旧的范围，这一个组件不交给编译器（同章节目录）。
  'use no memo';
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtual = chapters.length > PLAN_VIRTUAL_FROM;
  const virtualizer = useVirtualizer({
    count: chapters.length,
    enabled: virtual,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 110,
    getItemKey: (i) => chapters[i]?.chapter.id ?? i,
    gap: 16,
    overscan: 4,
    initialRect: { width: 0, height: 800 },
  });
  const items = virtual ? virtualizer.getVirtualItems() : null;
  const shown = items === null ? chapters.map((item, index) => ({ item, index })) : items.flatMap((v) => (chapters[v.index] === undefined ? [] : [{ item: chapters[v.index]!, index: v.index }]));
  const padding = items === null ? undefined : { paddingTop: items[0]?.start ?? 0, paddingBottom: Math.max(0, virtualizer.getTotalSize() - (items.at(-1)?.end ?? 0)) };
  const measure = virtual ? virtualizer.measureElement : undefined;
  return (
    <div className={virtual ? 'plan-scroll' : undefined} ref={scrollRef}>
      <ol className="skill-list" aria-label="章节计划" style={padding}>
        {shown.map(({ item, index }) => (
          <PlanChapterItem key={`${item.chapter.id}:${item.plan?.version ?? 0}`} item={item} index={index} foreshadows={foreshadows} measure={measure} />
        ))}
      </ol>
    </div>
  );
}

/** 成书计划：章节计划与伏笔账本（需求 B63、B65）。 */
export function PlanningPanel() {
  const planning = useApp((s) => s.planning);
  if (planning === null) return <p className="muted">正在读取成书计划…</p>;
  return (
    <section aria-label="成书计划" className="skills">
      <h2>成书计划</h2>
      <DraftSection />
      <PipelineBoard />
      <h3>章节计划</h3>
      {planning.variety.length > 0 ? (
        <ul className="muted" aria-label="计划的均一之处">
          {planning.variety.map((v) => (
            <li key={v.kind}>{v.description}</li>
          ))}
        </ul>
      ) : null}
      <ChapterPlanList chapters={planning.chapters} foreshadows={planning.foreshadows} />
      <Ledger />
    </section>
  );
}
