import { useState } from 'react';
import type { Chapter, Volume } from '@fudiao/store';
import { NO_CHAPTERS, NO_VOLUMES, useApp } from './store-context';
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

/** 卷名与本卷简介的编辑。 */
function VolumeEditor({ volume, onDone }: { readonly volume: Volume; readonly onDone: () => void }) {
  const update = useApp((s) => s.updateVolume);
  const busy = useApp((s) => s.busy);
  const [title, setTitle] = useState(volume.title);
  const [summary, setSummary] = useState(volume.summary);
  return (
    <form
      className="volume-editor"
      aria-label={`编辑 ${volume.title}`}
      onSubmit={(e) => {
        e.preventDefault();
        void update(volume.id, { title, summary }).then((done) => {
          if (done) onDone();
        });
      }}
    >
      <input aria-label="卷名" value={title} onChange={(e) => setTitle(e.target.value)} />
      <textarea aria-label="本卷简介" rows={3} placeholder="这一卷讲什么（写手写本卷的章节时参考）" value={summary} onChange={(e) => setSummary(e.target.value)} />
      <div className="form-actions">
        <button type="submit" disabled={busy || title.trim() === ''}>
          保存
        </button>
        <button type="button" onClick={onDone}>
          取消
        </button>
      </div>
    </form>
  );
}

/** 一卷的标题行：可以把章节拖到这里移入本卷；新建本卷的章节、调整卷的顺序、编辑与删除。 */
function VolumeHead({ volume, index, count }: { readonly volume: Volume | null; readonly index: number; readonly count: number }) {
  const drop = useApp((s) => s.dropChapterOnVolume);
  const createIn = useApp((s) => s.createChapterIn);
  const up = useApp((s) => s.moveVolumeUp);
  const down = useApp((s) => s.moveVolumeDown);
  const remove = useApp((s) => s.deleteVolume);
  const busy = useApp((s) => s.busy);
  const [over, setOver] = useState(false);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const title = volume?.title ?? '未分卷';
  return (
    <div
      className={`volume-head${over ? ' drop-target' : ''}`}
      aria-label={`卷：${title}`}
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
        if (id !== '') void drop(id, volume?.id ?? null);
      }}
    >
      {volume !== null && editing ? (
        <VolumeEditor volume={volume} onDone={() => setEditing(false)} />
      ) : (
        <>
          <span className="volume-title" title={volume?.summary || undefined}>
            {title}
          </span>
          {volume === null ? null : (
            <span className="chapter-actions">
              <button type="button" aria-label={`在 ${title} 末尾新建章节`} disabled={busy} onClick={() => setAdding(true)}>
                ＋章
              </button>
              <button type="button" aria-label={`上移 ${title}`} disabled={busy || index === 0} onClick={() => void up(volume.id)}>
                ↑
              </button>
              <button type="button" aria-label={`下移 ${title}`} disabled={busy || index === count - 1} onClick={() => void down(volume.id)}>
                ↓
              </button>
              <button type="button" aria-label={`编辑 ${title}`} disabled={busy} onClick={() => setEditing(true)}>
                编辑
              </button>
              <button type="button" aria-label={`删除 ${title}`} disabled={busy} onClick={() => void remove(volume.id)}>
                删除
              </button>
            </span>
          )}
        </>
      )}
      {adding && volume !== null && (
        <TextForm label="新章节名" submitText="创建" onSubmit={(t) => createIn(volume.id, t)} onCancel={() => setAdding(false)} />
      )}
    </div>
  );
}

export function ChapterSidebar() {
  const chapters = useApp((s) => s.work?.chapters ?? NO_CHAPTERS);
  const volumes = useApp((s) => s.work?.volumes ?? NO_VOLUMES);
  const trashedCount = useApp((s) => s.work?.trashed.length ?? 0);
  const create = useApp((s) => s.createChapter);
  const createVolume = useApp((s) => s.createVolume);
  const showPanel = useApp((s) => s.showPanel);
  const busy = useApp((s) => s.busy);
  const [adding, setAdding] = useState(false);
  const [addingVolume, setAddingVolume] = useState(false);
  const index = new Map(chapters.map((c, i) => [c.id, i]));
  const item = (c: Chapter) => <ChapterItem key={c.id} chapter={c} index={index.get(c.id) ?? 0} count={chapters.length} />;
  const loose = chapters.filter((c) => c.volumeId === null);

  return (
    <nav className="sidebar" aria-label="章节目录">
      <div className="sidebar-head">
        <h2>章节</h2>
        <button type="button" disabled={busy} onClick={() => setAdding(true)}>
          新建章节
        </button>
        <button type="button" disabled={busy} title="一部作品可以分若干卷，一卷有若干章" onClick={() => setAddingVolume(true)}>
          新建卷
        </button>
      </div>
      {adding && <TextForm label="新章节名" submitText="创建" onSubmit={create} onCancel={() => setAdding(false)} />}
      {addingVolume && (
        <TextForm label="新卷名" submitText="创建" onSubmit={createVolume} onCancel={() => setAddingVolume(false)} />
      )}
      {chapters.length === 0 && volumes.length === 0 ? (
        <p className="muted">还没有章节</p>
      ) : volumes.length === 0 ? (
        <ol className="chapter-list">{chapters.map(item)}</ol>
      ) : (
        <div className="volume-list">
          {loose.length > 0 ? (
            <section className="volume" aria-label="未分卷">
              <VolumeHead volume={null} index={0} count={0} />
              <ol className="chapter-list">{loose.map(item)}</ol>
            </section>
          ) : null}
          {volumes.map((v, i) => {
            const members = chapters.filter((c) => c.volumeId === v.id);
            return (
              <section key={v.id} className="volume" aria-label={v.title}>
                <VolumeHead volume={v} index={i} count={volumes.length} />
                {members.length === 0 ? <p className="muted volume-empty">这一卷还没有章节</p> : <ol className="chapter-list">{members.map(item)}</ol>}
              </section>
            );
          })}
        </div>
      )}
      <button type="button" className="trash-toggle" onClick={() => void showPanel('trash')}>
        回收站（{trashedCount}）
      </button>
    </nav>
  );
}
