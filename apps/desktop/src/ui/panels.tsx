import { useEffect, useState } from 'react';
import type { Chapter, Project } from '@fudiao/store';
import { ChapterEditor } from './ChapterEditor';
import { AiWriteDrawer } from './AiWriteDrawer';
import { ContextDrawer } from './ContextDrawer';
import { ReviewDrawer } from './ReviewDrawer';
import { EntityDrawer } from './SettingsPanel';
import { NO_CHAPTERS, useApp } from './store-context';

function ChapterNotes({ chapter }: { readonly chapter: Chapter }) {
  const save = useApp((s) => s.updateChapterNotes);
  const busy = useApp((s) => s.busy);
  const [summary, setSummary] = useState(chapter.summary);
  const [notes, setNotes] = useState(chapter.notes);
  const changed = summary !== chapter.summary || notes !== chapter.notes;
  return (
    <form
      className="panel-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save(chapter.id, { summary, notes });
      }}
    >
      <label>
        章节梗概
        <textarea rows={4} value={summary} onChange={(e) => setSummary(e.target.value)} />
      </label>
      <label>
        写作备注
        <textarea rows={6} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>
      <button type="submit" disabled={busy || !changed}>
        保存梗概与备注
      </button>
    </form>
  );
}

export function ChapterPanel() {
  const chapter = useApp((s) => s.work?.chapters.find((c) => c.id === s.selectedChapterId) ?? null);
  const content = useApp((s) => s.chapterContent);
  const loadChapter = useApp((s) => s.loadChapter);
  const revision = useApp((s) => s.contentRevision);
  const createSnapshot = useApp((s) => s.createSnapshot);
  const openHistory = useApp((s) => s.openHistory);
  const openContext = useApp((s) => s.openContext);
  const openAiWrite = useApp((s) => s.openAiWrite);
  const exportChapter = useApp((s) => s.exportChapter);
  const busy = useApp((s) => s.busy);
  const writerJob = useApp((s) => s.writerJob);
  const writeChapters = useApp((s) => s.writeChapters);
  const cancelWriting = useApp((s) => s.cancelWriting);
  const openReview = useApp((s) => s.openReview);
  const review = useApp((s) => s.review);
  const chapterId = chapter?.id ?? null;
  const loaded = content !== null && content.chapterId === chapterId;
  // 写手正在写这一章时正文只读：写手把段落接在章末，编辑器里的修改会与它冲突。
  const writingHere = writerJob !== null && writerJob.chapterId === chapterId;
  // 写手修订一段时同样只读，写入后重新载入。
  const revisingHere = review !== null && review.revisingId !== null && review.chapterId === chapterId;
  // AI 助手工作时正文只读：助手可能新建、移动章节或让写手写这一章，结束后重新载入。
  const assistantRunning = useApp((s) => s.assistantRunning);

  useEffect(() => {
    if (chapterId !== null && !loaded) void loadChapter(chapterId);
  }, [chapterId, loaded, loadChapter]);

  if (chapter === null) return <p className="muted">在左侧选择或新建一个章节。</p>;
  return (
    <section aria-label="章节" className="chapter-panel">
      <div className="chapter-head">
        <h2>{chapter.title}</h2>
        <button type="button" disabled={busy} onClick={() => void createSnapshot()}>
          保存快照
        </button>
        <button type="button" disabled={busy} onClick={() => void openHistory()}>
          版本快照
        </button>
        <button type="button" disabled={busy} title="把本章已保存的正文导出为 TXT" onClick={() => void exportChapter(chapter.id, 'txt')}>
          导出 TXT
        </button>
        <button type="button" disabled={busy} title="对选中的文字续写、改写、扩写、缩写或润色" onClick={() => void openAiWrite()}>
          AI 写作
        </button>
        <button type="button" disabled={busy} title="查看 AI 会用到的章节、设定与事实" onClick={() => void openContext()}>
          AI 上下文
        </button>
        <button type="button" disabled={busy || writerJob !== null} title="按本章的计划由写手写出正文，接在本章末尾" onClick={() => void writeChapters([chapter.id])}>
          让写手写这一章
        </button>
        <button type="button" disabled={busy} title="检查本章与设定、事实、伏笔和章节计划不一致的地方" onClick={() => void openReview()}>
          审核
        </button>
      </div>
      {revisingHere ? (
        <div className="writer-banner" role="status" aria-label="写手修订">
          <span>写手正在修订这一章的一段，完成之前正文只读。</span>
        </div>
      ) : null}
      {writingHere ? (
        <div className="writer-banner" role="status" aria-label="写手进度">
          <span>
            {writerJob.stage === 'writing'
              ? `写手正在写这一章${writerJob.total > 0 ? `（已写 ${writerJob.done} / ${writerJob.total} 段）` : ''}`
              : writerJob.stage === 'memory'
                ? '这一章已写完，正在整理长篇记忆'
                : '这一章已写完，正在审核'}
            ，完成之前正文只读。
          </span>
          <button type="button" onClick={cancelWriting}>
            停下
          </button>
        </div>
      ) : null}
      {assistantRunning && !writingHere && !revisingHere ? (
        <div className="writer-banner" role="status" aria-label="助手工作中">
          <span>AI 助手正在操作作品，完成之前正文只读。</span>
        </div>
      ) : null}
      {/* 恢复快照后版次加一，编辑器换成恢复后的内容。 */}
      <div className="chapter-with-drawer">
        {!loaded ? (
          <p className="muted">正在载入……</p>
        ) : writingHere || revisingHere || assistantRunning ? (
          <div className="chapter-text" aria-label="正文（只读）">
            {content.saved.map((p) => (
              <p key={p.id}>{p.text}</p>
            ))}
          </div>
        ) : (
          <ChapterEditor key={`${chapter.id}:${revision}`} content={content} title={chapter.title} />
        )}
        <EntityDrawer />
        <AiWriteDrawer />
        <ContextDrawer />
        <ReviewDrawer />
      </div>
      <details className="chapter-notes">
        <summary>梗概与写作备注</summary>
        {/* 以版本作为 key：保存或在别处修改后，表单换成最新内容。 */}
        <ChapterNotes key={`${chapter.id}:${chapter.version}`} chapter={chapter} />
      </details>
    </section>
  );
}

function InfoForm({ project }: { readonly project: Project }) {
  const save = useApp((s) => s.updateWorkInfo);
  const busy = useApp((s) => s.busy);
  const [title, setTitle] = useState(project.title);
  const [genre, setGenre] = useState(project.genre);
  const [synopsis, setSynopsis] = useState(project.synopsis);
  const [outline, setOutline] = useState(project.outline);
  const [totalWords, setTotalWords] = useState(project.goals.totalWords?.toString() ?? '');
  const [goalNote, setGoalNote] = useState(project.goals.note);
  const words = totalWords.trim() === '' ? null : Number(totalWords);
  const wordsValid = words === null || (Number.isInteger(words) && words > 0);
  return (
    <form
      className="panel-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!wordsValid) return;
        void save({ title, genre, synopsis, outline, goals: { totalWords: words, note: goalNote } });
      }}
    >
      <label>
        作品名
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label>
        题材
        <input value={genre} onChange={(e) => setGenre(e.target.value)} />
      </label>
      <label>
        作品简介
        <textarea rows={4} value={synopsis} onChange={(e) => setSynopsis(e.target.value)} />
      </label>
      <label>
        作品大纲
        <textarea rows={8} value={outline} onChange={(e) => setOutline(e.target.value)} />
      </label>
      <fieldset>
        <legend>写作目标</legend>
        <label>
          目标字数
          <input inputMode="numeric" value={totalWords} aria-invalid={!wordsValid} onChange={(e) => setTotalWords(e.target.value)} />
        </label>
        {!wordsValid && <span className="field-error">目标字数须为正整数，或留空</span>}
        <label>
          说明
          <input value={goalNote} onChange={(e) => setGoalNote(e.target.value)} />
        </label>
      </fieldset>
      <button type="submit" disabled={busy || title.trim() === '' || !wordsValid}>
        保存作品信息
      </button>
    </form>
  );
}

export function WorkInfoPanel() {
  const project = useApp((s) => s.work?.project ?? null);
  if (project === null) return null;
  return (
    <section aria-label="作品信息">
      <h2>作品信息</h2>
      <InfoForm key={`${project.id}:${project.version}`} project={project} />
    </section>
  );
}

export function TrashPanel() {
  const trashed = useApp((s) => s.work?.trashed ?? NO_CHAPTERS);
  const restore = useApp((s) => s.restoreChapter);
  const busy = useApp((s) => s.busy);
  return (
    <section aria-label="回收站">
      <h2>回收站</h2>
      {trashed.length === 0 ? (
        <p className="muted">回收站是空的。</p>
      ) : (
        <ul className="trash-list">
          {trashed.map((c) => (
            <li key={c.id}>
              <span>{c.title}</span>
              <span className="muted">{c.trashedAt === null ? '' : `移入于 ${new Date(c.trashedAt).toLocaleString('zh-CN')}`}</span>
              <button type="button" aria-label={`恢复 ${c.title}`} disabled={busy} onClick={() => void restore(c.id)}>
                恢复
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
