import { useState } from 'react';
import type { Foreshadow, ForeshadowFields, ForeshadowStatus } from '@fudiao/store';
import type { PlanChapterView } from '../app/planning';
import { useApp } from './store-context';

const STATUS: Record<ForeshadowStatus, string> = { planned: '计划', planted: '已埋', paid_off: '已回收', dropped: '废弃' };
const PROBLEM: Record<string, string> = {
  unknown_foreshadow: '引用了账本中没有的伏笔',
  payoff_before_plant: '回收章节在埋设章节之前',
  foreshadow_closed: '伏笔已回收或废弃，又被安排',
};
const lines = (text: string) => text.split('\n').map((l) => l.trim()).filter((l) => l !== '');

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
          <ol>
            {draft.chapters.map((c, i) => (
              <li key={i}>
                <strong>{c.title}</strong>：{c.goal}
                <ul>
                  {c.beats.map((b, j) => (
                    <li key={j}>{b}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
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
  const [editing, setEditing] = useState<string | null>(null);
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

/** 成书计划：章节计划与伏笔账本（需求 B63、B65）。 */
export function PlanningPanel() {
  const planning = useApp((s) => s.planning);
  if (planning === null) return <p className="muted">正在读取成书计划…</p>;
  return (
    <section aria-label="成书计划" className="skills">
      <h2>成书计划</h2>
      <DraftSection />
      <h3>章节计划</h3>
      <ol className="skill-list">
        {planning.chapters.map((item) => (
          <li key={`${item.chapter.id}:${item.plan?.version ?? 0}`} className="skill" aria-label={item.chapter.title}>
            <details>
              <summary>
                {item.chapter.title}
                {item.plan === null ? <span className="muted">（还没有计划）</span> : <span className="muted">：{item.plan.goal}</span>}
              </summary>
              <PlanEditor item={item} />
            </details>
            {item.problems.map((p) => (
              <p key={`${p.code}:${p.foreshadowId}`} className="field-error">
                {PROBLEM[p.code]}：{planning.foreshadows.find((f) => f.id === p.foreshadowId)?.title ?? p.foreshadowId}
              </p>
            ))}
          </li>
        ))}
      </ol>
      <Ledger />
    </section>
  );
}
