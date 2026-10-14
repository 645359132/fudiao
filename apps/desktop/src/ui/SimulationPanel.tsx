import { useState } from 'react';
import { blankSceneConfig } from '../app/scene-editing';
import { SceneEditor } from './SceneEditor';
import { useApp } from './store-context';

const PROTOCOL = { simultaneous: '同时行动', turn_based: '轮流对话' } as const;

/** 新建场景（B39）：用一段话描述局面生成场景配置草稿，或从空白开始。草稿不保存，修改确认后才保存。 */
function NewScene() {
  const draft = useApp((s) => s.sceneDraft);
  const drafting = useApp((s) => s.sceneDrafting);
  const generate = useApp((s) => s.draftSimScene);
  const useBlank = useApp((s) => s.blankSimScene);
  const discard = useApp((s) => s.discardSceneDraft);
  const chapterId = useApp((s) => s.selectedChapterId);
  const [description, setDescription] = useState('');

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
          initial={{ chapterId, title: draft.title, config: draft.config, protocol: draft.config.actors.length === 2 ? 'turn_based' : 'simultaneous', maxRounds: 8, firstSpeaker: null }}
        />
      </>
    );
  }
  return (
    <div className="panel-form" role="form" aria-label="新建场景">
      <label>
        用一段话描述局面：在哪里、有谁、各自想要什么、谁知道什么
        <textarea rows={6} value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <div className="skill-actions">
        <button type="button" disabled={drafting || description.trim() === ''} onClick={() => void generate(description)}>
          {drafting ? '正在生成…' : '生成场景配置草稿'}
        </button>
        <button type="button" disabled={drafting} onClick={() => useBlank(blankSceneConfig())}>
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
                <button type="button" aria-current={s.id === selected} onClick={() => select(s.id)}>
                  {s.title}
                  <span className="muted">
                    {PROTOCOL[s.protocol]} · {s.maxRounds} 回合
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {scenes.length === 0 ? <p className="muted">还没有推演场景。</p> : null}
          <button type="button" aria-current={selected === 'new'} onClick={() => select('new')}>
            新建场景
          </button>
        </nav>
        <div>
          {selected === 'new' ? (
            <NewScene />
          ) : scene === undefined ? (
            <p className="muted">选一个场景，或新建一个。</p>
          ) : (
            <SceneEditor
              key={`${scene.id}:${scene.version}`}
              id={scene.id}
              initial={{ chapterId: scene.chapterId, title: scene.title, config: scene.config, protocol: scene.protocol, maxRounds: scene.maxRounds, firstSpeaker: scene.firstSpeaker }}
            />
          )}
        </div>
      </div>
    </section>
  );
}
