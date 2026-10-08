import { useState } from 'react';
import { textDiff } from '@fudiao/shared';
import type { Candidate } from '@fudiao/store';
import { OPERATION_LABELS } from '../app/selection-ops';
import { useApp } from './store-context';

/** 与原文的差异：续写只有新增的文字；其余操作逐字标出删除与新增。 */
function Diff({ candidate }: { readonly candidate: Candidate }) {
  if (candidate.operation === 'continue') {
    return (
      <div className="ai-text diff" aria-label="候选稿内容">
        <ins>{candidate.content}</ins>
      </div>
    );
  }
  return (
    <div className="ai-text diff" aria-label="与原文的差异">
      {textDiff(candidate.baseText, candidate.content).map((part, i) =>
        part.kind === 'same' ? <span key={i}>{part.text}</span> : part.kind === 'removed' ? <del key={i}>{part.text}</del> : <ins key={i}>{part.text}</ins>,
      )}
    </div>
  );
}

/**
 * 一份候选稿（需求 B17）：比较、修改、接受或放弃。接受时先保存现稿快照，再写入正文；
 * 原文在生成之后被修改过时不写入，候选稿标为过期。
 */
export function CandidateCard({ candidate }: { readonly candidate: Candidate }) {
  const accept = useApp((s) => s.acceptCandidate);
  const discard = useApp((s) => s.discardCandidate);
  const edit = useApp((s) => s.editCandidate);
  const busy = useApp((s) => s.busy);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(candidate.content);
  const label = `${OPERATION_LABELS[candidate.operation]}的候选稿`;

  return (
    <section className="candidate" aria-label={label}>
      <p className="muted">
        {label}
        {candidate.content !== candidate.generated && '（已修改）'}
      </p>
      {editing ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void edit(candidate.id, draft).then((done) => {
              if (done) setEditing(false);
            });
          }}
        >
          <textarea aria-label="修改候选稿" value={draft} rows={6} onChange={(e) => setDraft(e.currentTarget.value)} />
          <div className="form-actions">
            <button type="submit" disabled={busy || draft.trim() === ''}>
              保存修改
            </button>
            <button
              type="button"
              onClick={() => {
                setDraft(candidate.content);
                setEditing(false);
              }}
            >
              取消
            </button>
          </div>
        </form>
      ) : (
        <>
          <Diff candidate={candidate} />
          <div className="form-actions">
            <button type="button" disabled={busy} onClick={() => void accept(candidate.id)}>
              接受
            </button>
            <button type="button" disabled={busy} onClick={() => setEditing(true)}>
              修改
            </button>
            <button type="button" disabled={busy} onClick={() => void discard(candidate.id)}>
              放弃
            </button>
          </div>
        </>
      )}
    </section>
  );
}
