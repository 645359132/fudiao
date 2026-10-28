import { useState } from 'react';
import { blankSceneConfig } from '../app/scene-editing';
import { SceneEditor } from './SceneEditor';
import { SimWorkspace } from './SimWorkspace';
import { useApp } from './store-context';

const PROTOCOL = { simultaneous: '同时行动', turn_based: '轮流对话' } as const;

/**
 * 新建场景（B39）：用一段话描述局面生成场景配置草稿，或按某一章的章节计划生成（B39 补充：角色就是出场人物，
 * 带上各自知道的事；描述是补充说明），或从空白开始。草稿不保存，修改确认后才保存。
 */
function NewScene() {
  const draft = useApp((s) => s.sceneDraft);
  const drafting = useApp((s) => s.sceneDrafting);
  const generate = useApp((s) => s.draftSimScene);
  const useBlank = useApp((s) => s.blankSimScene);
  const discard = useApp((s) => s.discardSceneDraft);
  const selectedChapterId = useApp((s) => s.selectedChapterId);
  const chapters = useApp((s) => s.work?.chapters ?? []);
  const [description, setDescription] = useState('');
  const [chapterId, setChapterId] = useState(selectedChapterId);

  if (draft !== null) {
    return (
      <>
        <div className="skill-actions">
          <span className="muted">这是还没有保存的场景配置草稿。</span>
          <button type="button" onClick={discard}>
            放弃草稿
          </button>
        </div>
        <SceneEditor
          key={draft.serial}
          id={null}
          notes={draft.problems}
          hints={draft.notes}
          initial={{ chapterId: draft.chapterId, title: draft.title, config: draft.config, protocol: draft.config.actors.length === 2 ? 'turn_based' : 'simultaneous', maxRounds: 8, firstSpeaker: null }}
        />
      </>
    );
  }
  const byChapter = chapterId !== null;
  return (
    <div className="panel-form" role="form" aria-label="新建场景">
      <label>
        按某一章的章节计划生成（可选）：角色就是这一章的出场人物，带上各自知道的事
        <select value={chapterId ?? ''} onChange={(e) => setChapterId(e.target.value === '' ? null : e.target.value)}>
          <option value="">不按章节</option>
          {chapters.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </select>
      </label>
      <label>
        {byChapter ? '补充说明（可选）：这一章的计划之外，还想让局面怎样' : '用一段话描述局面：在哪里、有谁、各自想要什么、谁知道什么'}
        <textarea rows={6} value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <div className="skill-actions">
        <button type="button" disabled={drafting || (description.trim() === '' && !byChapter)} onClick={() => void generate({ description, chapterId })}>
          {drafting ? '正在生成…' : '生成场景配置草稿'}
        </button>
        <button type="button" disabled={drafting} onClick={() => useBlank(blankSceneConfig(), chapterId)}>
          从空白开始
        </button>
      </div>
    </div>
  );
}

/** 角色推演（需求 B22 起）：推演场景的列表与编辑。运行与时间线在推演工作区（M4-04）。 */
export function SimulationPanel() {
  const scenes = useApp((s) => s.simScenes);
  const selected = useApp((s) => s.simSceneId);
  const select = useApp((s) => s.selectSimScene);
  const tab = useApp((s) => s.simTab);
  const showTab = useApp((s) => s.showSimTab);
  if (scenes === null) return <p className="muted">正在读取推演场景…</p>;
  const scene = scenes.find((s) => s.id === selected);
  return (
    <section aria-label="角色推演" className="skills">
      <h2>角色推演</h2>
      <div className="sim-layout">
        <nav aria-label="推演场景">
          <ul className="sim-scenes">
            {scenes.map((s) => (
              <li key={s.id}>
                <button type="button" aria-current={s.id === selected} onClick={() => void select(s.id)}>
                  {s.title}
                  <span className="muted">
                    {PROTOCOL[s.protocol]} · {s.maxRounds} 回合
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {scenes.length === 0 ? <p className="muted">还没有推演场景。</p> : null}
          <button type="button" aria-current={selected === 'new'} onClick={() => void select('new')}>
            新建场景
          </button>
        </nav>
        <div>
          {selected === 'new' ? (
            <NewScene />
          ) : scene === undefined ? (
            <p className="muted">选一个场景，或新建一个。</p>
          ) : (
            <>
              <div className="skill-actions" role="tablist" aria-label="场景">
                <button type="button" role="tab" aria-selected={tab === 'config'} onClick={() => showTab('config')}>
                  场景配置
                </button>
                <button type="button" role="tab" aria-selected={tab === 'runs'} onClick={() => showTab('runs')}>
                  推演
                </button>
              </div>
              {tab === 'runs' ? (
                <SimWorkspace />
              ) : (
                <SceneEditor
                  key={`${scene.id}:${scene.version}`}
                  id={scene.id}
                  initial={{ chapterId: scene.chapterId, title: scene.title, config: scene.config, protocol: scene.protocol, maxRounds: scene.maxRounds, firstSpeaker: scene.firstSpeaker }}
                />
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
