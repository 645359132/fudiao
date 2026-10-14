import { useState } from 'react';
import type { SkillView } from '../app/writing-skills';
import { useApp } from './store-context';

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
        <span className="muted">{label}</span>
      </div>
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

function AddSkill() {
  const add = useApp((s) => s.addCustomSkill);
  const busy = useApp((s) => s.busy);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [instruction, setInstruction] = useState('');
  return (
    <form
      className="panel-form"
      aria-label="添加技能"
      onSubmit={(e) => {
        e.preventDefault();
        void add(name, instruction, description).then((done) => {
          if (done) {
            setName('');
            setDescription('');
            setInstruction('');
          }
        });
      }}
    >
      <h3>添加自己的技能</h3>
      <label>
        名称
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        适用说明（做什么、什么时候用）
        <input value={description} placeholder="例如：写人物对话时使用" onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label>
        指令（写给写手的要求）
        <textarea rows={3} value={instruction} onChange={(e) => setInstruction(e.target.value)} />
      </label>
      <button type="submit" disabled={busy || name.trim() === '' || instruction.trim() === ''}>
        添加
      </button>
    </form>
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
        技能采用通用的 SKILL.md 格式（name、description 与指令），可以导入别处的技能文件，也可以把任一技能导出。写手写作时按下面的顺序运用启用的技能，每项按它的适用说明使用。内置技能可以改写指令，恢复后沿用默认文字。
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
