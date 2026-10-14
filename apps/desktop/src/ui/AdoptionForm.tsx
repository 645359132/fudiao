import { useState } from 'react';
import type { AdoptionDraft } from '../app/narration';
import { useApp } from './store-context';

const toggle = (list: readonly string[], key: string, on: boolean) => (on ? [...list, key] : list.filter((k) => k !== key));

/**
 * 采纳推演写成的正文（B29、B55）：选定这段正文讲述的事件（默认是视角角色察觉到的），哪些同时记为世界事实、
 * 视角角色的哪些见闻记为他的认知；自动接受的裁决逐条复核后才能采纳；涉及锁定设定时由作者核对。
 */
export function AdoptionForm({ draft }: { readonly draft: AdoptionDraft }) {
  const adopt = useApp((s) => s.adoptCandidate);
  const close = useApp((s) => s.closeAdoption);
  const busy = useApp((s) => s.busy);
  const [events, setEvents] = useState(() => draft.events.filter((e) => e.seenByPov).map((e) => e.key));
  const [worldFacts, setWorldFacts] = useState<readonly string[]>([]);
  const [beliefs, setBeliefs] = useState<readonly string[]>([]);
  const [reviewed, setReviewed] = useState<readonly string[]>([]);
  const [confirmLocked, setConfirmLocked] = useState(false);

  const povEntity = draft.entities.find((e) => e.key === draft.povKey)?.entityId ?? null;
  const unmatched = draft.entities.filter((e) => e.entityId === null);
  const locked = draft.entities.filter((e) => e.locked);
  const pending = draft.reviews.filter((r) => !reviewed.includes(r.requestId)).length;

  return (
    <form
      className="adoption"
      aria-label="采纳推演草案"
      onSubmit={(e) => {
        e.preventDefault();
        void adopt({ candidateId: draft.candidateId, events, worldFacts: worldFacts.filter((k) => events.includes(k)), beliefs, reviewed, confirmLocked });
      }}
    >
      {draft.reviews.length > 0 && (
        <fieldset>
          <legend>自动接受的裁决：逐条复核后才能采纳</legend>
          {draft.reviews.map((r) => (
            <label key={r.requestId}>
              <input type="checkbox" checked={reviewed.includes(r.requestId)} onChange={(e) => setReviewed(toggle(reviewed, r.requestId, e.currentTarget.checked))} />
              已复核：第 {r.round} 回合 · {r.rationale}
            </label>
          ))}
        </fieldset>
      )}

      <fieldset>
        <legend>这段正文讲述的事件</legend>
        {draft.events.length === 0 && <p className="muted">所选回合里没有发生的事。</p>}
        {draft.events.map((e) => (
          <div key={e.key} className="adoption-event">
            <label>
              <input type="checkbox" checked={events.includes(e.key)} onChange={(x) => setEvents(toggle(events, e.key, x.currentTarget.checked))} />
              第 {e.round} 回合 · {e.summary}
              {!e.seenByPov && <span className="muted">（{draft.povName}没有察觉）</span>}
              {e.adoptedEventId !== null && <span className="muted">（已采纳过：关联到同一个故事事件）</span>}
            </label>
            <label>
              <input
                type="checkbox"
                aria-label={`记为世界事实：${e.summary}`}
                disabled={!events.includes(e.key)}
                checked={events.includes(e.key) && worldFacts.includes(e.key)}
                onChange={(x) => setWorldFacts(toggle(worldFacts, e.key, x.currentTarget.checked))}
              />
              同时记为世界事实
            </label>
          </div>
        ))}
      </fieldset>

      {draft.beliefs.length > 0 && (
        <fieldset>
          <legend>记为{draft.povName}的认知</legend>
          {povEntity === null && <p className="muted">“{draft.povName}”没有对应的人物设定：先在“设定”里建这个人物，才能记他的认知。</p>}
          {draft.beliefs.map((b) => (
            <label key={b.ref}>
              <input type="checkbox" disabled={povEntity === null} checked={beliefs.includes(b.ref)} onChange={(e) => setBeliefs(toggle(beliefs, b.ref, e.currentTarget.checked))} />
              {b.text}
            </label>
          ))}
        </fieldset>
      )}

      {unmatched.length > 0 && <p className="muted">对不上设定、不写进事件与事实的：{unmatched.map((e) => e.name).join('、')}</p>}
      {locked.length > 0 && (
        <label>
          <input type="checkbox" checked={confirmLocked} onChange={(e) => setConfirmLocked(e.currentTarget.checked)} />
          我已核对涉及锁定设定的内容（{locked.map((e) => e.entityName ?? e.name).join('、')}）
        </label>
      )}

      <div className="form-actions">
        <button type="submit" disabled={busy || events.length === 0 || pending > 0}>
          采纳
        </button>
        <button type="button" onClick={close}>
          取消
        </button>
      </div>
      {pending > 0 && <p className="muted">还有 {pending} 条裁决没有复核。</p>}
    </form>
  );
}
