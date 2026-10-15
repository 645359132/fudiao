import { useEffect, useState } from 'react';
import type { Chapter, Project } from '@fudiao/store';
import { ChapterEditor } from './ChapterEditor';
import { AiWriteDrawer } from './AiWriteDrawer';
import { ContextDrawer } from './ContextDrawer';
import { ReviewDrawer } from './ReviewDrawer';
import { EntityDrawer } from './SettingsPanel';
import { Icon } from './Icon';
import { IconButton, Tip } from './IconButton';
import { chapterLock } from '../state/store';
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
  const chapterId = chapter?.id ?? null;
  const loaded = content !== null && content.chapterId === chapterId;
  // 正文只读的原因（写手在写或修订、助手在工作）：写入会与编辑器里的修改冲突，结束后重新载入。
  const lock = useApp((s) => chapterLock(s, chapterId));

  useEffect(() => {
    if (chapterId !== null && !loaded) void loadChapter(chapterId);
  }, [chapterId, loaded, loadChapter]);

  if (chapter === null) return <p className="muted">在左侧选择或新建一个章节。</p>;
  return (
    <section aria-label="章节" className="chapter-panel">
      <div className="chapter-head">
        <h2>{chapter.title}</h2>
        {/* 常用的三项带文字，其余只留图标，悬停时显示说明。 */}
        <div className="chapter-tools" role="toolbar" aria-label="本章工具">
          <Tip label="对选中的文字续写、改写、扩写、缩写或润色">
            <button type="button" className="ghost" disabled={busy} onClick={() => void openAiWrite()}>
              <Icon name="wand" />
              AI 写作
            </button>
          </Tip>
          <Tip label="按本章的计划由写手写出正文，接在本章末尾">
            <button type="button" className="ghost" disabled={busy || writerJob !== null} onClick={() => void writeChapters([chapter.id])}>
              <Icon name="writer" />
              让写手写这一章
            </button>
          </Tip>
          <Tip label="检查本章与设定、事实、伏笔和章节计划不一致的地方">
            <button type="button" className="ghost" disabled={busy} onClick={() => void openReview()}>
              <Icon name="review" />
              审核
            </button>
          </Tip>
          <span className="tool-divider" aria-hidden="true" />
          <IconButton icon="layers" label="AI 上下文" tip="AI 上下文：查看 AI 会用到的章节、设定与事实" disabled={busy} onClick={() => void openContext()} />
          <IconButton icon="bookmark" label="保存快照" tip="保存快照：给本章现在的正文存一个版本" disabled={busy} onClick={() => void createSnapshot()} />
          <IconButton icon="history" label="版本快照" tip="版本快照：查看、预览与恢复本章的历史版本" disabled={busy} onClick={() => void openHistory()} />
          <IconButton icon="download" label="导出 TXT" tip="把本章已保存的正文导出为 TXT" disabled={busy} onClick={() => void exportChapter(chapter.id, 'txt')} />
        </div>
      </div>
      {lock === 'revise' ? (
        <div className="writer-banner" role="status" aria-label="写手修订">
          <span>写手正在修订这一章的一段，完成之前正文只读。</span>
        </div>
      ) : null}
      {lock === 'writer' && writerJob !== null ? (
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
      {lock === 'assistant' ? (
        <div className="writer-banner" role="status" aria-label="助手工作中">
          <span>AI 助手正在操作作品，完成之前正文只读。</span>
        </div>
      ) : null}
      {/* 恢复快照后版次加一，编辑器换成恢复后的内容。 */}
      <div className="chapter-with-drawer">
        {!loaded ? (
          <p className="muted">正在载入……</p>
        ) : lock !== null ? (
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
