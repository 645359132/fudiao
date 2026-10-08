import { useState } from 'react';
import type { Chapter } from '@fudiao/store';
import { NO_CHAPTERS, useApp } from './store-context';
import { TextForm } from './TextForm';

const DRAG_TYPE = 'application/x-fudiao-chapter';

function ChapterItem({ chapter, index, count }: { readonly chapter: Chapter; readonly index: number; readonly count: number }) {
  const selected = useApp((s) => s.selectedChapterId === chapter.id && s.panel === 'chapter');
  const select = useApp((s) => s.selectChapter);
  const rename = useApp((s) => s.renameChapter);
  const moveUp = useApp((s) => s.moveUp);
  const moveDown = useApp((s) => s.moveDown);
  const drop = useApp((s) => s.dropChapter);
  const trash = useApp((s) => s.trashChapter);
  const busy = useApp((s) => s.busy);
  const [editing, setEditing] = useState(false);
  const [over, setOver] = useState(false);

  return (
    <li
      className={`chapter-item${selected ? ' selected' : ''}${over ? ' drop-target' : ''}`}
      draggable={!editing}
      onDragStart={(e) => e.dataTransfer.setData(DRAG_TYPE, chapter.id)}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(DRAG_TYPE)) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const id = e.dataTransfer.getData(DRAG_TYPE);
        if (id !== '') void drop(id, chapter.id);
      }}
    >
      {editing ? (
        <TextForm label="章节名" initial={chapter.title} submitText="确定" onSubmit={(title) => rename(chapter.id, title)} onCancel={() => setEditing(false)} />
      ) : (
        <>
          <button
            type="button"
            className="chapter-title"
            aria-current={selected ? 'page' : undefined}
            onClick={() => void select(chapter.id)}
            onDoubleClick={() => setEditing(true)}
            onKeyDown={(e) => {
              if (e.key === 'F2') setEditing(true);
            }}
          >
            {chapter.title}
          </button>
          <span className="chapter-actions">
            <button type="button" aria-label={`上移 ${chapter.title}`} disabled={busy || index === 0} onClick={() => void moveUp(chapter.id)}>
              ↑
            </button>
            <button type="button" aria-label={`下移 ${chapter.title}`} disabled={busy || index === count - 1} onClick={() => void moveDown(chapter.id)}>
              ↓
            </button>
            <button type="button" aria-label={`重命名 ${chapter.title}`} disabled={busy} onClick={() => setEditing(true)}>
              改名
            </button>
            <button type="button" aria-label={`移入回收站 ${chapter.title}`} disabled={busy} onClick={() => void trash(chapter.id)}>
              删除
            </button>
          </span>
        </>
      )}
    </li>
  );
}

export function ChapterSidebar() {
  const chapters = useApp((s) => s.work?.chapters ?? NO_CHAPTERS);
  const trashedCount = useApp((s) => s.work?.trashed.length ?? 0);
  const create = useApp((s) => s.createChapter);
  const showPanel = useApp((s) => s.showPanel);
  const busy = useApp((s) => s.busy);
  const [adding, setAdding] = useState(false);

  return (
    <nav className="sidebar" aria-label="章节目录">
      <div className="sidebar-head">
        <h2>章节</h2>
        <button type="button" disabled={busy} onClick={() => setAdding(true)}>
          新建章节
        </button>
      </div>
      {adding && <TextForm label="新章节名" submitText="创建" onSubmit={create} onCancel={() => setAdding(false)} />}
      {chapters.length === 0 ? (
        <p className="muted">还没有章节</p>
      ) : (
        <ol className="chapter-list">
          {chapters.map((c, i) => (
            <ChapterItem key={c.id} chapter={c} index={i} count={chapters.length} />
          ))}
        </ol>
      )}
      <button type="button" className="trash-toggle" onClick={() => void showPanel('trash')}>
        回收站（{trashedCount}）
      </button>
    </nav>
  );
}
