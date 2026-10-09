import { useState } from 'react';
import type { SkillView } from '../app/writing-skills';
import { useApp } from './store-context';

/** 一项技能：启用开关、说明（内置技能显示模板文字，改写后保存为作者的说明）。 */
function SkillItem({ view }: { readonly view: SkillView }) {
  const { skill, builtinText } = view;
  const update = useApp((s) => s.updateWritingSkill);
  const remove = useApp((s) => s.deleteCustomSkill);
  const busy = useApp((s) => s.busy);
  const effective = skill.instruction.trim() === '' ? (builtinText ?? '') : skill.instruction;
  const [text, setText] = useState(effective);
  const modified = builtinText !== null && skill.instruction.trim() !== '';
  const label = builtinText === null ? '自定义' : modified ? '内置（已修改）' : '内置';
  // 与模板文字相同时存为空：之后内置技能升级，作品自动跟上。
  const save = () => void update(skill.id, { instruction: builtinText !== null && text.trim() === builtinText.trim() ? '' : text });

  return (
    <li className="skill" aria-label={skill.name}>
      <div className="skill-head">
        <label>
          <input type="checkbox" checked={skill.enabled} disabled={busy} onChange={(e) => void update(skill.id, { enabled: e.target.checked })} />
          {skill.name}
        </label>
        <span className="muted">{label}</span>
      </div>
      <textarea aria-label={`${skill.name}的说明`} rows={4} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="skill-actions">
        <button type="button" disabled={busy || text.trim() === effective.trim()} onClick={save}>
          保存说明
        </button>
        {modified ? (
          <button type="button" disabled={busy} onClick={() => void update(skill.id, { instruction: '' })}>
            恢复内置说明
          </button>
        ) : null}
        {builtinText === null ? (
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
  const [instruction, setInstruction] = useState('');
  return (
    <form
      className="panel-form"
      aria-label="添加技能"
      onSubmit={(e) => {
        e.preventDefault();
        void add(name, instruction).then((done) => {
          if (done) {
            setName('');
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
        说明（写给写手的要求）
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

/** 写作技能与规避词表（需求 B61、B37）。 */
export function SkillsPanel() {
  const skills = useApp((s) => s.skills);
  if (skills === null) return <p className="muted">正在读取写作技能…</p>;
  return (
    <section aria-label="写作技能" className="skills">
      <h2>写作技能</h2>
      <p className="muted">写手写作时，按下面的顺序运用启用的技能。内置技能可以改写说明，恢复后沿用默认文字；也可以添加自己的技能。</p>
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
