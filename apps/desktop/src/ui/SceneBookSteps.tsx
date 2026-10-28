import { useState } from 'react';
import type { AdoptionDraft } from '../app/narration';
import { SCENE_BOOK_STAGE_LABEL, sceneBookAdoptionOf, sceneBookChaptersOf, sceneBookCheckOf, type AdoptionSelection, type SceneBookAdoptionEntry, type SceneBookChapter, type WorkflowStepView, type WorkflowView } from '../app/workflows';
import { AdoptionFields, defaultSelection, pendingReviews } from './AdoptionForm';
import { PipelineBoard } from './PipelineBoard';
import { useApp } from './store-context';

type StepProps = { readonly view: WorkflowView; readonly step: WorkflowStepView };

/** 第 1 步：范围里合格的章与跳过的章（原因）。 */
export function SceneBookCheckView({ step }: { readonly step: WorkflowStepView }) {
  const check = sceneBookCheckOf(step);
  if (check === null) return null;
  return (
    <div role="group" aria-label="核对范围">
      <p className="muted">
        {check.chapters.length} 章可以推演：{check.chapters.map((c) => `《${c.title}》`).join('')}
      </p>
      {check.skipped.length === 0 ? null : (
        <ul aria-label="跳过的章">
          {check.skipped.map((c) => (
            <li key={c.chapterId}>
              《{c.title}》：{c.why}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const CHAPTER_STATUS: Readonly<Record<SceneBookChapter['status'], string>> = { pending: '待做', running: '进行中', done: '已写完', failed: '没做成', skipped: '跳过' };

/** 第 2 步：各章做到哪里（看板在上面，与一键成书的写章节相同）。 */
export function SceneBookChaptersView({ view, step }: StepProps) {
  const result = sceneBookChaptersOf(step);
  const openRun = useApp((s) => s.openSimRun);
  const selectChapter = useApp((s) => s.selectChapter);
  const advancing = useApp((s) => s.simAdvancing);
  const current = useApp((s) => s.sceneBookStage);
  const running = useApp((s) => s.workflowAdvancing) === view.run.id;
  return (
    <div role="group" aria-label="逐章推演成章">
      <p className="muted">每章依次建场景、推演、写节拍表、把推演写成的正文直接写进这一章（写入前存快照，可在章节页回退到写手写入前），写手补全其余情节点、整理长篇记忆并审核。一章没做成会重试一次，仍不行就记下、接着做下一章。</p>
      <PipelineBoard />
      {result === null ? null : (
        <table className="source-table" aria-label="各章的推演">
          <thead>
            <tr>
              <th scope="col">章节</th>
              <th scope="col">状态</th>
              <th scope="col">说明</th>
              <th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>
            {result.chapters.map((c) => {
              const stage = running && current?.chapterId === c.chapterId ? SCENE_BOOK_STAGE_LABEL[current.stage] : c.status === 'running' ? `停在${SCENE_BOOK_STAGE_LABEL[c.stage]}` : CHAPTER_STATUS[c.status];
              return (
                <tr key={c.chapterId} aria-label={c.title}>
                  <th scope="row">{c.title}</th>
                  <td>{stage}</td>
                  <td>{c.note}</td>
                  <td>
                    {c.runId === null || c.sceneId === null ? null : (
                      <button type="button" className="link" disabled={advancing} onClick={() => void openRun(c.sceneId!, c.runId!)}>
                        在推演页打开
                      </button>
                    )}
                    {c.paragraphIds.length === 0 ? null : (
                      <button type="button" className="link" onClick={() => void selectChapter(c.chapterId)}>
                        打开这一章
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

const ENTRY_STATUS: Readonly<Record<SceneBookAdoptionEntry['status'], string>> = { pending: '待采纳', adopted: '已采纳', declined: '没有采纳', failed: '没有采纳成' };

/** 一章的草案：展开后读出勾选项，复核后采纳或不采纳。 */
function AdoptionEntry({ view, entry, waiting }: { readonly view: WorkflowView; readonly entry: SceneBookAdoptionEntry; readonly waiting: boolean }) {
  const load = useApp((s) => s.writtenAdoptionDraft);
  const adopt = useApp((s) => s.adoptSceneBookChapter);
  const decline = useApp((s) => s.declineSceneBookChapter);
  const selectChapter = useApp((s) => s.selectChapter);
  const busy = useApp((s) => s.busy);
  const [draft, setDraft] = useState<AdoptionDraft | null>(null);
  const [selection, setSelection] = useState<AdoptionSelection | null>(null);
  const [open, setOpen] = useState(false);
  const pending = draft === null || selection === null ? 0 : pendingReviews(draft, selection);
  const show = async () => {
    setOpen(true);
    if (draft !== null) return;
    const loaded = await load(entry.candidateId);
    if (loaded === null) return;
    setDraft(loaded);
    const initial = defaultSelection(loaded);
    setSelection({ events: [...initial.events], worldFacts: [...initial.worldFacts], beliefs: [...initial.beliefs], reviewed: [...initial.reviewed], confirmLocked: initial.confirmLocked });
  };
  return (
    <li className="wf-adoption-entry" aria-label={entry.title}>
      <div className="form-row">
        <strong>{entry.title}</strong>
        <span className="muted">
          {entry.povName === '' ? '' : `${entry.povName}的视角 · `}
          {ENTRY_STATUS[entry.status]}
          {entry.note === '' ? '' : `：${entry.note}`}
        </span>
        <button type="button" className="link" onClick={() => void selectChapter(entry.chapterId)}>
          打开这一章
        </button>
        {waiting && entry.status !== 'adopted' && !open ? (
          <button type="button" onClick={() => void show()}>
            复核
          </button>
        ) : null}
      </div>
      {open && waiting && entry.status !== 'adopted' ? (
        draft === null || selection === null ? (
          <p className="muted">正在读取…</p>
        ) : (
          <div className="panel-form" role="form" aria-label={`${entry.title}的推演草案`}>
            <AdoptionFields draft={draft} value={selection} onChange={(s) => setSelection({ events: [...s.events], worldFacts: [...s.worldFacts], beliefs: [...s.beliefs], reviewed: [...s.reviewed], confirmLocked: s.confirmLocked })} />
            <div className="form-actions">
              <button
                type="button"
                className="primary"
                disabled={busy || selection.events.length === 0 || pending > 0}
                onClick={() => void adopt(view.run.id, entry.chapterId, { ...selection, worldFacts: selection.worldFacts.filter((k) => selection.events.includes(k)) })}
              >
                采纳这一章
              </button>
              {entry.status === 'pending' ? (
                <button type="button" disabled={busy} onClick={() => void decline(view.run.id, entry.chapterId)}>
                  不采纳
                </button>
              ) : null}
              <button type="button" className="ghost" onClick={() => setOpen(false)}>
                收起
              </button>
            </div>
            {pending > 0 ? <p className="muted">还有 {pending} 条裁决没有复核。</p> : null}
          </div>
        )
      ) : null}
    </li>
  );
}

/** 第 3 步：待采纳的推演草案——逐章复核采纳或不采纳；步骤上方的按钮一键采纳其余的。 */
export function SceneBookAdoptView({ view, step }: StepProps) {
  const adoption = sceneBookAdoptionOf(step);
  const advancing = useApp((s) => s.workflowAdvancing) !== null;
  if (adoption === null) return null;
  const waiting = step.status === 'awaiting_author' && !view.run.abandoned && !advancing;
  const pending = adoption.chapters.filter((c) => c.status === 'pending').length;
  return (
    <div role="group" aria-label="采纳推演草案">
      <p className="muted">正文已经在各章里；这里采纳的是推演里发生的事（故事事件）、同时记为世界事实的，以及视角人物的认知。{waiting && pending > 0 ? `还有 ${pending} 章待采纳：逐章复核，或点“全部采纳其余的”按默认勾选采纳（自动接受的裁决一并视为已复核）。` : ''}</p>
      {adoption.chapters.length === 0 ? (
        <p className="muted">没有待采纳的推演草案。</p>
      ) : (
        <ul className="wf-adoption-list" aria-label="各章的推演草案">
          {adoption.chapters.map((entry) => (
            <AdoptionEntry key={`${entry.chapterId}:${entry.status}`} view={view} entry={entry} waiting={waiting} />
          ))}
        </ul>
      )}
    </div>
  );
}
