import { useState } from 'react';
import type { SnapshotReason } from '@fudiao/store';
import { countWords } from '@fudiao/shared';
import { useApp } from './store-context';

const REASON: Record<SnapshotReason, string> = {
  manual: '手动保存',
  before_restore: '恢复前自动保存',
  accept_candidate: '接受候选稿前自动保存',
  import: '导入',
  writer: '写手写入前自动保存',
};

const time = (iso: string) => new Date(iso).toLocaleString('zh-CN');

function Preview() {
  const snapshot = useApp((s) => s.previewSnapshot);
  const restore = useApp((s) => s.restoreSnapshot);
  const busy = useApp((s) => s.busy);
  const [confirming, setConfirming] = useState(false);
  if (snapshot === null) return <p className="muted">选择一个快照查看内容。</p>;
  const words = snapshot.paragraphs.reduce((n, p) => n + countWords(p.text), 0);
  return (
    <section aria-label="快照内容" className="snapshot-preview">
      <h3>
        {time(snapshot.createdAt)} · {REASON[snapshot.reason]}
      </h3>
      <p className="muted">
        章节名“{snapshot.title}”，{snapshot.paragraphs.length} 段，{words.toLocaleString('zh-CN')} 字
      </p>
      {confirming ? (
        <div className="confirm" role="group" aria-label="确认恢复">
          <span>恢复后，现在的正文会先存为一个快照，可以再恢复回来。</span>
          <button type="button" disabled={busy} onClick={() => void restore(snapshot.id)}>
            确定恢复
          </button>
          <button type="button" onClick={() => setConfirming(false)}>
            取消
          </button>
        </div>
      ) : (
        <button type="button" disabled={busy} onClick={() => setConfirming(true)}>
          恢复到这个版本
        </button>
      )}
      <div className="snapshot-text chapter-text">
        {snapshot.paragraphs.length === 0 ? <p className="muted">（空章节）</p> : snapshot.paragraphs.map((p) => <p key={p.id}>{p.text}</p>)}
      </div>
    </section>
  );
}

/** 当前章节的版本快照：列表、预览与恢复（B06）。 */
export function HistoryPanel() {
  const snapshots = useApp((s) => s.snapshots);
  const previewId = useApp((s) => s.previewSnapshot?.id ?? null);
  const preview = useApp((s) => s.previewSnapshotById);
  const create = useApp((s) => s.createSnapshot);
  const showPanel = useApp((s) => s.showPanel);
  const title = useApp((s) => s.work?.chapters.find((c) => c.id === s.selectedChapterId)?.title ?? '');
  const busy = useApp((s) => s.busy);
  return (
    <section aria-label="版本快照" className="history">
      <div className="history-head">
        <h2>“{title}”的版本快照</h2>
        <button type="button" disabled={busy} onClick={() => void create()}>
          保存快照
        </button>
        <button type="button" onClick={() => void showPanel('chapter')}>
          返回正文
        </button>
      </div>
      <div className="history-body">
        {snapshots === null || snapshots.length === 0 ? (
          <p className="muted">还没有快照。“保存快照”会记下本章现在的正文。</p>
        ) : (
          <ol className="snapshot-list" aria-label="快照列表">
            {snapshots.map((s) => (
              <li key={s.id}>
                <button type="button" aria-current={s.id === previewId ? 'true' : undefined} onClick={() => void preview(s.id)}>
                  <span>{time(s.createdAt)}</span>
                  <span className="muted">
                    {REASON[s.reason]} · {s.paragraphCount} 段
                  </span>
                </button>
              </li>
            ))}
          </ol>
        )}
        <Preview />
      </div>
    </section>
  );
}
