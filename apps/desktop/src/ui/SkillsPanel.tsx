import { useState } from 'react';
import { SKILL_STAGES, type SkillStage } from '@fudiao/shared';
import { SKILL_STAGE_HINT, SKILL_STAGE_LABEL } from '../app/labels';
import type { SkillView } from '../app/writing-skills';
import { Icon } from './Icon';
import { Tip } from './IconButton';
import { useApp } from './store-context';

/** 技能用在哪些阶段（B75）：规划（作品骨架与章节计划）、写章节；至少选一个。 */
function StageChoice({ label, stages, disabled, onChange }: { readonly label: string; readonly stages: readonly SkillStage[]; readonly disabled: boolean; readonly onChange: (stages: SkillStage[]) => void }) {
  return (
    <fieldset className="skill-stages" aria-label={label}>
      {SKILL_STAGES.map((stage) => {
        const on = stages.includes(stage);
        return (
          <label key={stage} title={SKILL_STAGE_HINT[stage]}>
            <input
              type="checkbox"
              checked={on}
              disabled={disabled || (on && stages.length === 1)}
              onChange={(e) => onChange(e.target.checked ? [...stages, stage] : stages.filter((s) => s !== stage))}
            />
            {SKILL_STAGE_LABEL[stage]}
          </label>
        );
      })}
    </fieldset>
  );
}

/** 内置技能的适用说明以“名称：”开头；列表里名称已经在上面一行，去掉它。 */
const shortDescription = (view: SkillView) => {
  const prefix = `${view.skill.name}：`;
  return view.description.startsWith(prefix) ? view.description.slice(prefix.length) : view.description;
};

/** 一项技能在列表里的来历：内置、内置改写过、自定义。 */
const originOf = (view: SkillView) => (view.builtinText === null ? '自定义' : view.skill.instruction.trim() !== '' ? '内置（已修改）' : '内置');

/** 改了还没保存的指令与适用说明（切到别的技能时留着，回来接着改）。 */
type Draft = { readonly text: string; readonly description: string };

/**
 * 列表里的一行：启用开关、名称、一行适用说明、用在哪个阶段。点这一行在右边查看与编辑；
 * 停用的技能淡一些，改了没保存的标出来。
 */
function SkillRow({ view, selected, unsaved, onSelect }: { readonly view: SkillView; readonly selected: boolean; readonly unsaved: boolean; readonly onSelect: () => void }) {
  const update = useApp((s) => s.updateWritingSkill);
  const busy = useApp((s) => s.busy);
  const { skill } = view;
  const origin = originOf(view);
  const describedBy = `skill-row-${skill.id}`;
  return (
    <li className={skill.enabled ? 'skills-row' : 'skills-row off'} aria-label={skill.name} aria-current={selected ? 'true' : undefined}>
      <input
        type="checkbox"
        role="switch"
        className="switch"
        aria-label={`启用${skill.name}`}
        checked={skill.enabled}
        disabled={busy}
        onChange={(e) => void update(skill.id, { enabled: e.target.checked })}
      />
      <button type="button" className="skills-row-main" aria-label={skill.name} aria-describedby={describedBy} onClick={onSelect}>
        <span className="skills-row-title">
          <span className="skills-row-name">{skill.name}</span>
          {unsaved ? <span className="skills-badge warn">未保存</span> : null}
          {origin === '内置' ? null : <span className="skills-badge">{origin === '自定义' ? '自定义' : '已修改'}</span>}
        </span>
        <span id={describedBy} className="skills-row-desc" title={view.description}>
          {shortDescription(view)}
        </span>
      </button>
      <span className="skills-row-stages" title={skill.stages.map((s) => SKILL_STAGE_HINT[s]).join('；')}>
        {skill.stages.map((s) => (
          <span key={s} className="skill-stage">
            {SKILL_STAGE_LABEL[s]}
          </span>
        ))}
      </span>
    </li>
  );
}

/**
 * 右边的详情：适用说明、用在哪个阶段与指令。内置技能的适用说明取自模板，指令显示模板文字，改写后保存为作者的指令，
 * 与模板文字相同时存为空（之后内置技能升级，作品自动跟上）；自定义技能的适用说明与阶段也可以改。每项都可以另存为 SKILL.md。
 */
function SkillDetail({ view, draft, onDraft }: { readonly view: SkillView; readonly draft: Draft | undefined; readonly onDraft: (draft: Draft | null) => void }) {
  const { skill, builtinText } = view;
  const update = useApp((s) => s.updateWritingSkill);
  const remove = useApp((s) => s.deleteCustomSkill);
  const exportSkill = useApp((s) => s.exportSkillMd);
  const busy = useApp((s) => s.busy);
  const custom = builtinText === null;
  const effective = skill.instruction.trim() === '' ? (builtinText ?? '') : skill.instruction;
  const text = draft?.text ?? effective;
  const description = draft?.description ?? view.description;
  const modified = !custom && skill.instruction.trim() !== '';
  const changed = text.trim() !== effective.trim() || (custom && description.trim() !== view.description.trim());
  const edit = (next: Partial<Draft>) => {
    const merged = { text, description, ...next };
    onDraft(merged.text.trim() === effective.trim() && (!custom || merged.description.trim() === view.description.trim()) ? null : merged);
  };
  const save = async () => {
    const done = await update(skill.id, custom ? { instruction: text, description } : { instruction: builtinText !== null && text.trim() === builtinText.trim() ? '' : text });
    if (done) onDraft(null);
  };

  return (
    <section className="skills-detail" aria-label="技能详情">
      <header className="skills-detail-head">
        <div>
          <h3>{skill.name}</h3>
          <p className="muted skills-detail-meta">
            <span>{originOf(view)}</span>
            <code title="SKILL.md 中的 name">{skill.key}</code>
          </p>
        </div>
        <label className="switch-label">
          <input type="checkbox" role="switch" className="switch" checked={skill.enabled} disabled={busy} onChange={(e) => void update(skill.id, { enabled: e.target.checked })} />
          {skill.enabled ? '已启用' : '已停用'}
        </label>
      </header>

      <div className="skills-field">
        <span className="skills-field-label">适用说明</span>
        {custom ? (
          <input aria-label={`${skill.name}的适用说明`} placeholder="做什么、什么时候用，例如：写人物对话时使用" value={description} onChange={(e) => edit({ description: e.target.value })} />
        ) : (
          <p className="skills-field-text">{shortDescription(view)}</p>
        )}
      </div>

      <div className="skills-field">
        <span className="skills-field-label">用在</span>
        {custom ? (
          <StageChoice label={`${skill.name}用在`} stages={skill.stages} disabled={busy} onChange={(stages) => void update(skill.id, { stages })} />
        ) : (
          <p className="skills-field-text">{skill.stages.map((s) => `${SKILL_STAGE_LABEL[s]}（${SKILL_STAGE_HINT[s]}）`).join('；')}</p>
        )}
      </div>

      <label className="skills-field skills-instruction">
        <span className="skills-field-label">
          指令
          {custom ? null : <span className="muted">内置技能可以改写，恢复后沿用默认文字</span>}
        </span>
        <textarea aria-label={`${skill.name}的指令`} rows={14} value={text} onChange={(e) => edit({ text: e.target.value })} />
      </label>

      <footer className="skills-detail-actions">
        <button type="button" className={changed ? 'primary' : undefined} disabled={busy || !changed} onClick={() => void save()}>
          保存
        </button>
        {changed ? (
          <button type="button" className="ghost" disabled={busy} onClick={() => onDraft(null)}>
            放弃改动
          </button>
        ) : null}
        {modified ? (
          <button
            type="button"
            className="ghost"
            disabled={busy}
            onClick={() =>
              void update(skill.id, { instruction: '' }).then((done) => {
                if (done) onDraft(null);
              })
            }
          >
            恢复内置指令
          </button>
        ) : null}
        <span className="spacer" />
        <button type="button" className="ghost" disabled={busy} onClick={() => void exportSkill(skill.id)}>
          <Icon name="download" />
          导出 SKILL.md
        </button>
        {custom ? (
          <button type="button" className="ghost danger-text" disabled={busy} onClick={() => void remove(skill.id)}>
            <Icon name="trash" />
            删除
          </button>
        ) : null}
      </footer>
    </section>
  );
}

/**
 * 新建自己的技能，按 SKILL.md 的标准：逐项填写（名称、标识、适用说明、指令），或者直接粘贴一份 SKILL.md。
 * 适用说明是标准里的必填项（description）：写手按它判断什么时候用这项技能。
 */
function AddSkill({ onDone, onCancel }: { readonly onDone: () => void; readonly onCancel: () => void }) {
  const add = useApp((s) => s.addCustomSkill);
  const importText = useApp((s) => s.importSkillText);
  const busy = useApp((s) => s.busy);
  const [mode, setMode] = useState<'fields' | 'paste'>('fields');
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [description, setDescription] = useState('');
  const [instruction, setInstruction] = useState('');
  const [stages, setStages] = useState<SkillStage[]>(['writing']);
  const [pasted, setPasted] = useState('');
  return (
    <section className="skills-detail panel-form" aria-label="添加技能">
      <header className="skills-detail-head">
        <h3>新建技能</h3>
        <button type="button" className="ghost" onClick={onCancel}>
          取消
        </button>
      </header>
      <div className="kind-tabs" role="tablist" aria-label="添加方式">
        <button type="button" role="tab" aria-selected={mode === 'fields'} onClick={() => setMode('fields')}>
          逐项填写
        </button>
        <button type="button" role="tab" aria-selected={mode === 'paste'} onClick={() => setMode('paste')}>
          粘贴 SKILL.md
        </button>
      </div>
      {mode === 'fields' ? (
        <form
          aria-label="逐项填写技能"
          onSubmit={(e) => {
            e.preventDefault();
            void add(name, instruction, description, key, stages).then((done) => {
              if (done) onDone();
            });
          }}
        >
          <label>
            名称
            <input value={name} placeholder="例如：对话与潜台词" onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            标识（SKILL.md 的 name，可不填）
            <input value={key} placeholder="例如：dialogue-subtext；不填时自动生成" onChange={(e) => setKey(e.target.value)} />
          </label>
          <label>
            适用说明（description：做什么、什么时候用）
            <input value={description} placeholder="例如：写人物对话时使用，让话里带潜台词" onChange={(e) => setDescription(e.target.value)} />
          </label>
          <label>
            指令（可以用 Markdown）
            <textarea rows={8} value={instruction} onChange={(e) => setInstruction(e.target.value)} />
          </label>
          <div className="skills-field">
            <span className="skills-field-label">用在</span>
            <StageChoice label="新技能用在" stages={stages} disabled={busy} onChange={setStages} />
          </div>
          <button type="submit" className="primary" disabled={busy || name.trim() === '' || description.trim() === '' || instruction.trim() === ''}>
            添加
          </button>
        </form>
      ) : (
        <form
          aria-label="粘贴技能"
          onSubmit={(e) => {
            e.preventDefault();
            void importText(pasted).then((done) => {
              if (done) {
                setPasted('');
                onDone();
              }
            });
          }}
        >
          <label>
            SKILL.md 的内容
            <textarea
              rows={12}
              value={pasted}
              placeholder={'---\nname: dialogue-subtext\ndescription: 写人物对话时使用，让话里带潜台词\n---\n\n人物很少直接说出心里话……'}
              onChange={(e) => setPasted(e.target.value)}
            />
          </label>
          <button type="submit" className="primary" disabled={busy || pasted.trim() === ''}>
            导入
          </button>
        </form>
      )}
    </section>
  );
}

function AvoidPhrases({ phrases, custom }: { readonly phrases: readonly string[]; readonly custom: boolean }) {
  const setPhrases = useApp((s) => s.setAvoidPhrases);
  const busy = useApp((s) => s.busy);
  const [text, setText] = useState(phrases.join('\n'));
  return (
    <section className="skills-detail skills-avoid" aria-label="规避表达">
      <header className="skills-detail-head">
        <div>
          <h3>规避表达</h3>
          <p className="muted skills-detail-meta">
            写手会避开这些说法，审核时也会逐处标出。每行一项；清空后保存表示不检查。{custom ? '' : '现在用的是默认词表。'}
          </p>
        </div>
      </header>
      <textarea aria-label="规避表达词表" rows={14} value={text} onChange={(e) => setText(e.target.value)} />
      <footer className="skills-detail-actions">
        <button type="button" className="primary" disabled={busy} onClick={() => void setPhrases(text.split('\n'))}>
          保存词表
        </button>
        {custom ? (
          <button type="button" className="ghost" disabled={busy} onClick={() => void setPhrases(null)}>
            恢复默认词表
          </button>
        ) : null}
      </footer>
    </section>
  );
}

type Filter = 'all' | SkillStage;

/**
 * 写作技能（SKILL.md 格式）与规避词表（需求 B61、B37）。左边是一行一项的列表（开关、名称、一行适用说明、阶段），
 * 右边是选中的那一项的详情与编辑；新建技能也在右边。规划与写章节时按列表顺序运用启用的技能。
 */
export function SkillsPanel() {
  const skills = useApp((s) => s.skills);
  const importSkill = useApp((s) => s.importSkillMd);
  const busy = useApp((s) => s.busy);
  const [tab, setTab] = useState<'skills' | 'avoid'>('skills');
  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [drafts, setDrafts] = useState<Readonly<Record<string, Draft>>>({});
  const [before, setBefore] = useState<ReadonlySet<string>>(new Set());
  if (skills === null) return <p className="muted">正在读取写作技能…</p>;

  const all = skills.skills;
  const count = (f: Filter) => (f === 'all' ? all.length : all.filter((v) => v.skill.stages.includes(f)).length);
  const shown = all.filter((v) => filter === 'all' || v.skill.stages.includes(filter));
  // 选中的没了（删掉、筛掉）时选列表里的第一项；新建或导入后选刚加进来的那一项。
  const added = before.size === 0 ? undefined : all.find((v) => !before.has(v.skill.id));
  const current = shown.find((v) => v.skill.id === (added?.skill.id ?? selected)) ?? shown[0] ?? null;
  const select = (id: string) => {
    setSelected(id);
    setAdding(false);
    setBefore(new Set());
  };
  const startAdding = () => {
    setTab('skills');
    setAdding(true);
    setBefore(new Set(all.map((v) => v.skill.id)));
  };
  const onDraft = (id: string) => (draft: Draft | null) =>
    setDrafts((d) => {
      const next = { ...d };
      if (draft === null) delete next[id];
      else next[id] = draft;
      return next;
    });
  const enabled = all.filter((v) => v.skill.enabled).length;

  return (
    <section aria-label="写作技能" className="skills-page">
      <header className="skills-header">
        <div>
          <h2>写作技能</h2>
          <p className="muted">
            已启用 {enabled} / {all.length} 项 · 规划与写章节时按列表顺序运用启用的技能
          </p>
        </div>
        <div className="skills-header-actions">
          <Tip label="只读取 SKILL.md 本身，不读取它所在文件夹里的其他文件">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setBefore(new Set(all.map((v) => v.skill.id)));
                setAdding(false);
                setTab('skills');
                void importSkill();
              }}
            >
              <Icon name="upload" />
              导入 SKILL.md
            </button>
          </Tip>
          <button type="button" className="primary" disabled={busy} onClick={startAdding}>
            <Icon name="plus" />
            新建技能
          </button>
        </div>
      </header>

      <div className="kind-tabs skills-tabs" role="tablist" aria-label="写作技能的内容">
        <button type="button" role="tab" aria-selected={tab === 'skills'} onClick={() => setTab('skills')}>
          技能
        </button>
        <button type="button" role="tab" aria-selected={tab === 'avoid'} onClick={() => setTab('avoid')}>
          规避表达
        </button>
      </div>

      {tab === 'avoid' ? (
        // 保存或恢复默认后按新的词表重新挂载。
        <AvoidPhrases key={`${skills.avoidPhrasesCustom}:${skills.avoidPhrases.join('|')}`} phrases={skills.avoidPhrases} custom={skills.avoidPhrasesCustom} />
      ) : (
        <div className="skills-layout">
          <div className="skills-list-pane">
            <div className="segmented" role="group" aria-label="按阶段筛选">
              {(['all', ...SKILL_STAGES] as const).map((f) => (
                <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}>
                  {f === 'all' ? '全部' : SKILL_STAGE_LABEL[f]}
                  <span className="segmented-count">{count(f)}</span>
                </button>
              ))}
            </div>
            <ul className="skills-rows" aria-label="技能列表">
              {shown.map((v) => (
                <SkillRow key={v.skill.id} view={v} selected={!adding && current?.skill.id === v.skill.id} unsaved={drafts[v.skill.id] !== undefined} onSelect={() => select(v.skill.id)} />
              ))}
            </ul>
          </div>
          {adding ? (
            <AddSkill onDone={() => setAdding(false)} onCancel={() => setAdding(false)} />
          ) : current === null ? (
            <p className="muted skills-empty">这一类还没有技能。</p>
          ) : (
            <SkillDetail key={`${current.skill.id}:${current.skill.version}`} view={current} draft={drafts[current.skill.id]} onDraft={onDraft(current.skill.id)} />
          )}
        </div>
      )}
    </section>
  );
}
