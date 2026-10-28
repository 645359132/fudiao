import { useEffect, useState } from 'react';
import type { BeatTreatment, SimSceneFields } from '@fudiao/store';
import { SIM_END_LABEL } from '../app/labels';
import { beatsStepOf, narrateStepOf, sceneStepOf, simStepOf, type BeatsStep, type NarrateStep, type WorkflowStepView, type WorkflowView } from '../app/workflows';
import { AdoptionFields, pendingReviews } from './AdoptionForm';
import { SceneEditor } from './SceneEditor';
import { Timeline } from './SimWorkspace';
import { useApp } from './store-context';
import { useDraftSaver } from './useDraftSaver';

const TREATMENT: Readonly<Record<BeatTreatment, string>> = { expand: '展开', brief: '略写', omit: '省略', flashback: '倒叙', blank: '留白' };

type StepProps = { readonly view: WorkflowView; readonly step: WorkflowStepView };

/** 这次运行的章节与场景（参数里沿用的场景，或第 1 步采用后记下的）。 */
function runRefs(view: WorkflowView): { readonly chapterId: string; readonly sceneId: string | null } {
  const params = view.run.params as { readonly chapterId?: unknown; readonly sceneId?: unknown };
  const sceneStep = view.steps.find((s) => s.key === 'scene');
  const scene = sceneStep === undefined ? null : sceneStepOf(sceneStep);
  return { chapterId: typeof params.chapterId === 'string' ? params.chapterId : '', sceneId: typeof params.sceneId === 'string' ? params.sceneId : (scene?.sceneId ?? null) };
}

/** 推演的运行标识：第 2 步开始后记下的。 */
function simRunIdOf(view: WorkflowView): string | null {
  const simStep = view.steps.find((s) => s.key === 'simulate');
  return simStep === undefined ? null : (simStepOf(simStep)?.runId ?? null);
}

/** 成书页里看这次推演的时间线：没读过（或读的是别的运行）时读一次；推进时状态层随之刷新。 */
function useWorkflowSim(runId: string | null, refresh: unknown) {
  const workflowSim = useApp((s) => s.workflowSim);
  const load = useApp((s) => s.loadWorkflowSim);
  useEffect(() => {
    if (runId !== null) void load(runId);
  }, [runId, refresh, load]);
  return workflowSim !== null && workflowSim.runId === runId ? workflowSim.detail : null;
}

/** 第 1 步：场景草稿，用推演页的场景编辑器核对、修改；保存即存进步骤并采用（保存为推演场景）。 */
export function SceneStepView({ view, step }: StepProps) {
  const scene = sceneStepOf(step);
  const edit = useApp((s) => s.editWorkflowStep);
  const act = useApp((s) => s.workflowStepAction);
  const advancing = useApp((s) => s.workflowAdvancing) === view.run.id;
  if (scene === null) return null;
  const actors = (scene.config as { readonly actors?: readonly { readonly name?: string }[] }).actors ?? [];
  if (step.status !== 'awaiting_author' || view.run.abandoned || advancing) {
    return (
      <p className="muted">
        场景“{scene.title}”：{actors.map((a) => a.name ?? '').join('、')}；{scene.protocol === 'turn_based' ? '轮流对话' : '同时行动'}，回合上限 {scene.maxRounds}。
      </p>
    );
  }
  const initial: SimSceneFields = { chapterId: scene.chapterId, title: scene.title, config: scene.config, protocol: scene.protocol, maxRounds: scene.maxRounds, firstSpeaker: scene.firstSpeaker };
  return (
    <SceneEditor
      id={null}
      initial={initial}
      notes={scene.problems}
      hints={scene.notes}
      submitLabel="采用：保存为推演场景"
      onSave={async (fields) => {
        const saved = await edit(view.run.id, step.idx, { ...scene, ...fields, problems: [] });
        return saved ? act(view.run.id, step.idx, 'adopt') : false;
      }}
    />
  );
}

/** 第 2 步：推演的状态与时间线（全局局面与各角色所见），可到推演页打开。 */
export function SimStepView({ view, step }: StepProps) {
  const sim = simStepOf(step);
  const openRun = useApp((s) => s.openSimRun);
  const advancing = useApp((s) => s.simAdvancing);
  const detail = useWorkflowSim(sim?.runId ?? null, step.status);
  if (sim === null) return step.status === 'running' ? <p className="muted">正在开始推演…</p> : null;
  const { sceneId } = runRefs(view);
  const v = detail?.view;
  const state = v === undefined ? `第 ${sim.round} 回合` : `第 ${v.round} 回合 · ${v.phase === 'Ended' ? `已结束（${SIM_END_LABEL[v.endReason ?? ''] ?? v.endReason ?? ''}）` : v.phase === 'Paused' ? '已暂停' : v.phase === 'AwaitingAuthor' ? '等待作者' : '进行中'} · 已用 $${v.spentUsd.toFixed(3)}`;
  return (
    <div role="group" aria-label="推演">
      <p className="muted">
        {state}
        {sceneId === null ? null : (
          <button type="button" className="link" disabled={advancing} onClick={() => void openRun(sceneId, sim.runId)}>
            在推演页打开
          </button>
        )}
      </p>
      {detail === null || detail.data === null ? null : <Timeline data={detail.data} />}
    </div>
  );
}

const beatsPayload = (d: BeatsStep): BeatsStep => d;

/** 第 3 步：节拍表——改处理方式、说明与文风后采用；换视角或回合范围后重新生成。 */
export function BeatsStepView({ view, step }: StepProps) {
  const [draft, setDraft] = useState<BeatsStep | null>(() => beatsStepOf(step));
  const save = useDraftSaver(view.run.id, step.idx, step.output, draft, beatsPayload);
  const act = useApp((s) => s.workflowStepAction);
  const continueWorkflow = useApp((s) => s.continueWorkflow);
  const busy = useApp((s) => s.busy);
  const advancing = useApp((s) => s.workflowAdvancing) !== null;
  const detail = useWorkflowSim(simRunIdOf(view), null);
  if (draft === null) return null;
  const waiting = step.status === 'awaiting_author' && !view.run.abandoned && !advancing;
  const actors = detail?.cast.actors ?? [];
  const rounds = Math.max(detail?.data?.rounds.length ?? 0, draft.request.toRound);
  const saved = beatsStepOf(step);
  const changed = JSON.stringify(draft) !== JSON.stringify(step.output);
  const requestChanged = JSON.stringify(draft.request) !== JSON.stringify(saved?.request);
  const setBeat = (i: number, patch: Partial<BeatsStep['beats'][number]>) => setDraft({ ...draft, beats: draft.beats.map((b, j) => (j === i ? { ...b, ...patch } : b)) });
  const setRequest = (patch: Partial<BeatsStep['request']>) => setDraft({ ...draft, request: { ...draft.request, ...patch } });
  const regenerate = async () => {
    if (!(await save(draft))) return;
    if (await act(view.run.id, step.idx, 'redo')) continueWorkflow(view.run.id);
  };
  return (
    <div className="panel-form" role="form" aria-label={`${draft.povName}视角的节拍表`}>
      {waiting ? (
        <div className="form-row">
          <label>
            视角
            <select aria-label="视角" value={draft.request.pov} onChange={(e) => setRequest({ pov: e.currentTarget.value })}>
              {actors.some((a) => a.id === draft.request.pov) ? null : <option value={draft.request.pov}>{draft.povName}</option>}
              {actors.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            从第几回合
            <input type="number" min={1} max={rounds} value={draft.request.fromRound} onChange={(e) => setRequest({ fromRound: Number(e.currentTarget.value) })} />
          </label>
          <label>
            到第几回合
            <input type="number" min={1} max={rounds} value={draft.request.toRound} onChange={(e) => setRequest({ toRound: Number(e.currentTarget.value) })} />
          </label>
          <label>
            给节拍表的说明
            <input value={draft.request.notes} onChange={(e) => setRequest({ notes: e.currentTarget.value })} />
          </label>
          <button type="button" disabled={busy || !requestChanged} onClick={() => void regenerate()}>
            重新生成
          </button>
        </div>
      ) : null}
      <table className="source-table" aria-label="节拍">
        <thead>
          <tr>
            <th scope="col">回合</th>
            <th scope="col">{draft.povName}的见闻</th>
            <th scope="col">处理</th>
            <th scope="col">说明</th>
            <th scope="col">暂不向读者揭示</th>
          </tr>
        </thead>
        <tbody>
          {draft.beats.map((b, i) => (
            <tr key={b.ref} aria-label={`节拍 ${i + 1}`}>
              <td>{b.round}</td>
              <td>{b.text}</td>
              <td>
                <select aria-label="处理" disabled={!waiting} value={b.treatment} onChange={(e) => setBeat(i, { treatment: e.currentTarget.value as BeatTreatment })}>
                  {Object.entries(TREATMENT).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <input aria-label="说明" disabled={!waiting} value={b.note} onChange={(e) => setBeat(i, { note: e.currentTarget.value })} />
              </td>
              <td>
                <input type="checkbox" aria-label="暂不向读者揭示" disabled={!waiting} checked={b.withhold} onChange={(e) => setBeat(i, { withhold: e.currentTarget.checked })} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {draft.beats.some((b) => b.treatment === 'omit') ? <p className="muted">标为省略的见闻不写进正文；省略的最早那一回合之后，{draft.povName}的内心片段也不再作为素材。</p> : null}
      <label>
        文风（可不填）
        <input value={draft.style} disabled={!waiting} onChange={(e) => setDraft({ ...draft, style: e.currentTarget.value })} />
      </label>
      {waiting ? (
        <div className="form-actions">
          <button
            type="button"
            className="primary"
            disabled={busy || requestChanged}
            title={requestChanged ? '改了视角或回合范围：先重新生成' : undefined}
            onClick={() => void (async () => (changed && !(await save(draft)) ? false : act(view.run.id, step.idx, 'adopt')))()}
          >
            就按这份节拍表写
          </button>
          <button type="button" disabled={busy || !changed} onClick={() => void save(draft)}>
            保存修改
          </button>
        </div>
      ) : null}
      {detail === null || detail.data === null ? null : (
        <details>
          <summary>推演的时间线</summary>
          <Timeline data={detail.data} />
        </details>
      )}
    </div>
  );
}

const narratePayload = (d: NarrateStep): NarrateStep => d;

/** 第 4 步：推演写成的正文——勾选事件、事实与认知，复核裁决，标出推演已写出的情节点，采纳进本章末尾。 */
export function NarrateStepView({ view, step }: StepProps) {
  const [draft, setDraft] = useState<NarrateStep | null>(() => narrateStepOf(step));
  const save = useDraftSaver(view.run.id, step.idx, step.output, draft, narratePayload);
  const act = useApp((s) => s.workflowStepAction);
  const busy = useApp((s) => s.busy);
  const advancing = useApp((s) => s.workflowAdvancing) !== null;
  const selectChapter = useApp((s) => s.selectChapter);
  if (draft === null) return null;
  const waiting = step.status === 'awaiting_author' && !view.run.abandoned && !advancing;
  const changed = JSON.stringify(draft) !== JSON.stringify(step.output);
  const pending = pendingReviews(draft.draft, draft.selection);
  const toggleBeat = (beat: string, on: boolean) => setDraft({ ...draft, coveredBeats: on ? [...draft.coveredBeats, beat] : draft.coveredBeats.filter((b) => b !== beat) });
  return (
    <div className="panel-form" role="form" aria-label="推演写成的正文">
      <div className="wf-candidate" aria-label="候选稿">
        {draft.text.split('\n').map((p, i) => (
          <p key={i}>{p}</p>
        ))}
      </div>
      {waiting ? (
        <>
          <AdoptionFields
            draft={draft.draft}
            value={draft.selection}
            onChange={(s) => setDraft({ ...draft, selection: { events: [...s.events], worldFacts: [...s.worldFacts], beliefs: [...s.beliefs], reviewed: [...s.reviewed], confirmLocked: s.confirmLocked } })}
          />
          {draft.beats.length === 0 ? null : (
            <fieldset>
              <legend>推演已写出的情节点（其余交给写手接着写）</legend>
              {draft.beats.map((b, i) => (
                <label key={`${i}-${b}`} className="check">
                  <input type="checkbox" checked={draft.coveredBeats.includes(b)} onChange={(e) => toggleBeat(b, e.currentTarget.checked)} />
                  {b}
                </label>
              ))}
            </fieldset>
          )}
          <div className="form-actions">
            <button
              type="button"
              className="primary"
              disabled={busy || draft.selection.events.length === 0 || pending > 0}
              onClick={() => void (async () => (changed && !(await save(draft)) ? false : act(view.run.id, step.idx, 'adopt')))()}
            >
              采纳进本章
            </button>
            <button type="button" disabled={busy || !changed} onClick={() => void save(draft)}>
              保存勾选
            </button>
          </div>
          {pending > 0 ? <p className="muted">还有 {pending} 条裁决没有复核。</p> : null}
        </>
      ) : (
        <button type="button" className="link" onClick={() => void selectChapter(draft.draft.chapterId)}>
          打开这一章
        </button>
      )}
    </div>
  );
}

/** 第 5 步：写手接着采纳的正文补全其余情节点（写入前存快照，可回退到写手写入前）。 */
export function WriteAfterView({ view }: { readonly view: WorkflowView }) {
  const selectChapter = useApp((s) => s.selectChapter);
  const { chapterId } = runRefs(view);
  return (
    <p className="muted">
      写手接着采纳的正文写其余的情节点（写入前存快照，可以在章节页回退到写手写入前），写完整理长篇记忆并审核。
      {chapterId === '' ? null : (
        <button type="button" className="link" onClick={() => void selectChapter(chapterId)}>
          打开这一章
        </button>
      )}
    </p>
  );
}
