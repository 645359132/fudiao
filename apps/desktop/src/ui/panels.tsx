import { useState } from 'react';
import type { Chapter, Project } from '@fudiao/store';
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
  if (chapter === null) return <p className="muted">在左侧选择或新建一个章节。</p>;
  return (
    <section aria-label="章节">
      <h2>{chapter.title}</h2>
      <p className="muted">正文编辑器尚未接入；这里先记录章节梗概与写作备注。</p>
      {/* 以版本作为 key：保存或在别处修改后，表单换成最新内容。 */}
      <ChapterNotes key={`${chapter.id}:${chapter.version}`} chapter={chapter} />
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
