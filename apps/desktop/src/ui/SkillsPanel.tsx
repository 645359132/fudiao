import { useState } from 'react';
import { SKILL_STAGES, type SkillStage } from '@fudiao/shared';
import { SKILL_STAGE_HINT, SKILL_STAGE_LABEL } from '../app/labels';
import type { SkillView } from '../app/writing-skills';
import { useApp } from './store-context';

/** 技能用在哪些阶段（B75）：规划（作品骨架与章节计划）、写章节；至少选一个。 */
function StageChoice({ label, stages, disabled, onChange }: { readonly label: string; readonly stages: readonly SkillStage[]; readonly disabled: boolean; readonly onChange: (stages: SkillStage[]) => void }) {
  return (
    <fieldset className="skill-stages" aria-label={label}>
      <span className="muted">用在</span>
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

const stagesText = (stages: readonly SkillStage[]) => stages.map((s) => SKILL_STAGE_LABEL[s]).join('、');

/**
 * 一项技能（SKILL.md 格式）：启用开关、标识、适用说明与指令。内置技能的适用说明取自模板，指令显示模板文字，
 * 改写后保存为作者的指令；自定义技能的适用说明与指令都可以改。每项都可以另存为 SKILL.md。
 */
function SkillItem({ view }: { readonly view: SkillView }) {
  const { skill, builtinText } = view;
  const update = useApp((s) => s.updateWritingSkill);
  const remove = useApp((s) => s.deleteCustomSkill);
  const exportSkill = useApp((s) => s.exportSkillMd);
  const busy = useApp((s) => s.busy);
  const custom = builtinText === null;
  const effective = skill.instruction.trim() === '' ? (builtinText ?? '') : skill.instruction;
  const [text, setText] = useState(effective);
  const [description, setDescription] = useState(view.description);
  const modified = !custom && skill.instruction.trim() !== '';
  const label = custom ? '自定义' : modified ? '内置（已修改）' : '内置';
  const changed = text.trim() !== effective.trim() || (custom && description.trim() !== view.description.trim());
  // 与模板文字相同时存为空：之后内置技能升级，作品自动跟上。
  const save = () =>
    void update(skill.id, custom ? { instruction: text, description } : { instruction: builtinText !== null && text.trim() === builtinText.trim() ? '' : text });

  return (
    <li className="skill" aria-label={skill.name}>
      <div className="skill-head">
        <label>
          <input type="checkbox" checked={skill.enabled} disabled={busy} onChange={(e) => void update(skill.id, { enabled: e.target.checked })} />
          {skill.name}
        </label>
        <code className="skill-key" title="SKILL.md 中的 name">
          {skill.key}
        </code>
        {custom ? null : (
          <span className="skill-stage" title={skill.stages.map((s) => SKILL_STAGE_HINT[s]).join('；')}>
            用在{stagesText(skill.stages)}
          </span>
        )}
        <span className="muted">{label}</span>
      </div>
      {custom ? <StageChoice label={`${skill.name}用在`} stages={skill.stages} disabled={busy} onChange={(stages) => void update(skill.id, { stages })} /> : null}
      {custom ? (
        <label className="skill-description">
          适用说明
          <input aria-label={`${skill.name}的适用说明`} placeholder="做什么、什么时候用，例如：写人物对话时使用" value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
      ) : (
        <p className="muted skill-description">{view.description}</p>
      )}
      <textarea aria-label={`${skill.name}的指令`} rows={4} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="skill-actions">
        <button type="button" disabled={busy || !changed} onClick={save}>
          保存
        </button>
        {modified ? (
          <button type="button" disabled={busy} onClick={() => void update(skill.id, { instruction: '' })}>
            恢复内置指令
          </button>
        ) : null}
        <button type="button" disabled={busy} onClick={() => void exportSkill(skill.id)}>
          导出 SKILL.md
        </button>
        {custom ? (
          <button type="button" disabled={busy} onClick={() => void remove(skill.id)}>
            删除
          </button>
        ) : null}
      </div>
    </li>
  );
}

/**
 * 添加自己的技能，按 SKILL.md 的标准：逐项填写（名称、标识、适用说明、指令），或者直接粘贴一份 SKILL.md。
 * 适用说明是标准里的必填项（description）：写手按它判断什么时候用这项技能。
 */
function AddSkill() {
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
    <section className="panel-form" aria-label="添加技能">
      <h3>添加自己的技能</h3>
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
              if (done) {
                setName('');
                setKey('');
                setDescription('');
                setInstruction('');
                setStages(['writing']);
              }
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
            <textarea rows={4} value={instruction} onChange={(e) => setInstruction(e.target.value)} />
          </label>
          <StageChoice label="新技能用在" stages={stages} disabled={busy} onChange={setStages} />
          <button type="submit" disabled={busy || name.trim() === '' || description.trim() === '' || instruction.trim() === ''}>
            添加
          </button>
        </form>
      ) : (
        <form
          aria-label="粘贴技能"
          onSubmit={(e) => {
            e.preventDefault();
            void importText(pasted).then((done) => {
              if (done) setPasted('');
            });
          }}
        >
          <label>
            SKILL.md 的内容
            <textarea
              rows={10}
              value={pasted}
              placeholder={'---\nname: dialogue-subtext\ndescription: 写人物对话时使用，让话里带潜台词\n---\n\n人物很少直接说出心里话……'}
              onChange={(e) => setPasted(e.target.value)}
            />
          </label>
          <button type="submit" disabled={busy || pasted.trim() === ''}>
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
    <section className="panel-form" aria-label="规避表达">
      <h3>规避表达</h3>
      <p className="muted">
        写手会避开这些说法，审核时也会逐处标出。每行一项；清空后保存表示不检查。{custom ? '' : '现在用的是默认词表。'}
      </p>
      <textarea aria-label="规避表达词表" rows={8} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="skill-actions">
        <button type="button" disabled={busy} onClick={() => void setPhrases(text.split('\n'))}>
          保存词表
        </button>
        {custom ? (
          <button type="button" disabled={busy} onClick={() => void setPhrases(null)}>
            恢复默认词表
          </button>
        ) : null}
      </div>
    </section>
  );
}

/** 写作技能（SKILL.md 格式）与规避词表（需求 B61、B37）。 */
export function SkillsPanel() {
  const skills = useApp((s) => s.skills);
  const importSkill = useApp((s) => s.importSkillMd);
  const busy = useApp((s) => s.busy);
  if (skills === null) return <p className="muted">正在读取写作技能…</p>;
  return (
    <section aria-label="写作技能" className="skills">
      <h2>写作技能</h2>
      <p className="muted">
        技能采用通用的 SKILL.md 格式（name、description 与指令），可以导入别处的技能文件，也可以把任一技能导出。技能分两个阶段：“规划”的技能在生成作品骨架（大纲与人物）和章节计划时使用，例如雪花写作法；“写章节”的技能交给写手。都按下面的顺序运用启用的技能，每项按它的适用说明使用。内置技能可以改写指令，恢复后沿用默认文字。
      </p>
      <div className="skill-actions">
        <button type="button" disabled={busy} onClick={() => void importSkill()}>
          导入 SKILL.md
        </button>
        <span className="muted">只读取 SKILL.md 本身，不读取它所在文件夹里的其他文件。</span>
      </div>
      <ol className="skill-list">
        {skills.skills.map((v) => (
          <SkillItem key={`${v.skill.id}:${v.skill.version}`} view={v} />
        ))}
      </ol>
      <AddSkill />
      {/* 保存或恢复默认后按新的词表重新挂载。 */}
      <AvoidPhrases key={`${skills.avoidPhrasesCustom}:${skills.avoidPhrases.join('|')}`} phrases={skills.avoidPhrases} custom={skills.avoidPhrasesCustom} />
    </section>
  );
}
