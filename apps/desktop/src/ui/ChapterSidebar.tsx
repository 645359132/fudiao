import { memo, useEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Chapter, Volume } from '@fudiao/store';
import { NO_CHAPTERS, NO_VOLUMES, useApp } from './store-context';
import { TextForm } from './TextForm';

const DRAG_TYPE = 'application/x-fudiao-chapter';

/** 目录的一行：卷的标题、章节或空卷的提示。卷与章节排成一列，长篇时只渲染看得见的几十行。 */
export type TocRow =
  | { readonly kind: 'volume'; readonly key: string; readonly volume: Volume | null; readonly index: number; readonly count: number }
  | { readonly kind: 'chapter'; readonly key: string; readonly chapter: Chapter; readonly index: number; readonly nested: boolean }
  | { readonly kind: 'empty'; readonly key: string; readonly volume: Volume };

/** 按书中顺序排出目录的各行：有卷时先列未分卷的章节，再逐卷列出卷名与本卷的章节。index 是章节在全书中的位置。 */
export function tocRows(chapters: readonly Chapter[], volumes: readonly Volume[]): TocRow[] {
  const chapterRow = (chapter: Chapter, index: number, nested: boolean): TocRow => ({ kind: 'chapter', key: chapter.id, chapter, index, nested });
  if (volumes.length === 0) return chapters.map((c, i) => chapterRow(c, i, false));
  const members = new Map<string | null, { chapter: Chapter; index: number }[]>();
  chapters.forEach((chapter, index) => {
    const list = members.get(chapter.volumeId);
    if (list === undefined) members.set(chapter.volumeId, [{ chapter, index }]);
    else list.push({ chapter, index });
  });
  const rows: TocRow[] = [];
  const loose = members.get(null) ?? [];
  if (loose.length > 0) {
    rows.push({ kind: 'volume', key: 'volume:', volume: null, index: 0, count: 0 });
    for (const m of loose) rows.push(chapterRow(m.chapter, m.index, true));
  }
  volumes.forEach((volume, i) => {
    rows.push({ kind: 'volume', key: `volume:${volume.id}`, volume, index: i, count: volumes.length });
    const list = members.get(volume.id) ?? [];
    if (list.length === 0) rows.push({ kind: 'empty', key: `empty:${volume.id}`, volume });
    for (const m of list) rows.push(chapterRow(m.chapter, m.index, true));
  });
  return rows;
}

/** 超过这么多行时只渲染看得见的部分（施工文档第七章：目录用虚拟列表）；行数少时全部渲染。 */
export const VIRTUAL_FROM = 120;
const ESTIMATED_HEIGHT: Record<TocRow['kind'], number> = { volume: 44, chapter: 32, empty: 22 };

/** 虚拟列表量每行的高度用；全部渲染时为 undefined。 */
type Measure = ((element: HTMLElement | null) => void) | undefined;

type ChapterItemProps = {
  readonly chapter: Chapter;
  readonly index: number;
  readonly count: number;
  readonly nested: boolean;
  readonly row: number;
  readonly measure: Measure;
};

const ChapterItem = memo(function ChapterItem({ chapter, index, count, nested, row, measure }: ChapterItemProps) {
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
      ref={measure}
      data-index={row}
      aria-setsize={count}
      aria-posinset={index + 1}
      className={`chapter-item${nested ? ' nested' : ''}${selected ? ' selected' : ''}${over ? ' drop-target' : ''}`}
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
});

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

const TocRowView = memo(function TocRowView({ row, index, chapterCount, measure }: { readonly row: TocRow; readonly index: number; readonly chapterCount: number; readonly measure: Measure }) {
  switch (row.kind) {
    case 'chapter':
      return <ChapterItem chapter={row.chapter} index={row.index} count={chapterCount} nested={row.nested} row={index} measure={measure} />;
    case 'volume':
      return (
        <li ref={measure} data-index={index} role="none" className={index === 0 ? 'toc-volume first' : 'toc-volume'}>
          <VolumeHead volume={row.volume} index={row.index} count={row.count} />
        </li>
      );
    case 'empty':
      return (
        <li ref={measure} data-index={index} role="none" className="toc-empty muted">
          这一卷还没有章节
        </li>
      );
  }
});

/**
 * 目录的各行。行数超过 VIRTUAL_FROM 时只渲染视野内外的几十行，上下用内边距占住其余行的高度，
 * 每行的实际高度渲染后量出（改名、编辑卷时行会变高）。
 */
function TocList({ rows, chapterCount }: { readonly rows: readonly TocRow[]; readonly chapterCount: number }) {
  // useVirtualizer 的实例在滚动时原地更新，React Compiler 的缓存会让列表停在旧的范围（TanStack Virtual 的已知限制），这一个组件不交给编译器。
  'use no memo';
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtual = rows.length > VIRTUAL_FROM;
  const virtualizer = useVirtualizer({
    count: rows.length,
    enabled: virtual,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => ESTIMATED_HEIGHT[rows[i]?.kind ?? 'chapter'],
    getItemKey: (i) => rows[i]?.key ?? i,
    overscan: 10,
    initialRect: { width: 0, height: 800 },
  });

  // 选中的章节（打开作品、从查找或助手跳过来）不在视野里时滚过去；只在选中的章节变化时滚，作者自己滚开后不拉回来。
  const selected = useApp((s) => (s.panel === 'chapter' ? s.selectedChapterId : null));
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  useEffect(() => {
    if (selected === null) return;
    const i = rowsRef.current.findIndex((r) => r.kind === 'chapter' && r.chapter.id === selected);
    if (i < 0) return;
    if (virtual) virtualizer.scrollToIndex(i, { align: 'auto' });
    else scrollRef.current?.querySelector(`[data-index="${i}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [selected]);

  const items = virtual ? virtualizer.getVirtualItems() : null;
  const shown =
    items === null
      ? rows.map((row, index) => ({ row, index }))
      : items.flatMap((item) => {
          const row = rows[item.index];
          return row === undefined ? [] : [{ row, index: item.index }];
        });
  const padding = items === null ? undefined : { paddingTop: items[0]?.start ?? 0, paddingBottom: Math.max(0, virtualizer.getTotalSize() - (items.at(-1)?.end ?? 0)) };
  const measure = virtual ? virtualizer.measureElement : undefined;
  return (
    <div className="toc-scroll" ref={scrollRef}>
      <ol className="chapter-list" style={padding}>
        {shown.map(({ row, index }) => (
          <TocRowView key={row.key} row={row} index={index} chapterCount={chapterCount} measure={measure} />
        ))}
      </ol>
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
  const rows = tocRows(chapters, volumes);

  return (
    <nav className="toc" aria-label="章节目录">
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
      {rows.length === 0 ? <p className="muted">还没有章节</p> : <TocList rows={rows} chapterCount={chapters.length} />}
      <button type="button" className="trash-toggle" onClick={() => void showPanel('trash')}>
        回收站（{trashedCount}）
      </button>
    </nav>
  );
}
