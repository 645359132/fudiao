import { useEffect, useRef } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { chapterExtensions, EntityHighlight, fromDoc, setHighlightEntities, setParagraphSources, setSourceMarksEnabled, SourceMarks, structuralLog, toDoc } from '@fudiao/editor';
import { countWords, ulid } from '@fudiao/shared';
import { AutosaveController, type SaveStatus } from '../app/autosave';
import type { ChapterContent } from '../app/service';
import { useApp } from './store-context';

const newId = () => ulid(Date.now(), crypto.getRandomValues(new Uint8Array(10)));
const plainText = (editor: Editor) => editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n');

const STATUS_TEXT: Record<SaveStatus['kind'], string> = {
  saved: '已保存',
  dirty: '有未保存的修改',
  saving: '保存中……',
  failed: '保存失败',
};

function StatusBar({ editor, title, onSave }: { readonly editor: Editor; readonly title: string; readonly onSave: () => void }) {
  const status = useApp((s) => s.saveStatus);
  const words = useApp((s) => s.wordCount);
  const copyText = useApp((s) => s.copyText);
  const exportText = useApp((s) => s.exportText);
  return (
    <div className="status-bar">
      <span className={`save-status ${status.kind}`} role="status">
        {STATUS_TEXT[status.kind]}
        {status.kind === 'failed' && `：${status.message}`}
      </span>
      {status.kind === 'failed' && (
        <>
          <button type="button" onClick={onSave}>
            重试
          </button>
          <button type="button" onClick={() => void copyText(plainText(editor))}>
            复制全文
          </button>
          <button type="button" onClick={() => void exportText(title, plainText(editor))}>
            导出本章
          </button>
        </>
      )}
      <span className="spacer" />
      <span className="word-count">本章 {words.toLocaleString('zh-CN')} 字</span>
      <button type="button" aria-label="撤销" title="撤销（Ctrl+Z）" onClick={() => editor.chain().focus().undo().run()}>
        ↶
      </button>
      <button type="button" aria-label="重做" title="重做（Ctrl+Y）" onClick={() => editor.chain().focus().redo().run()}>
        ↷
      </button>
    </div>
  );
}

function DraftNotice({ editor, content }: { readonly editor: Editor; readonly content: ChapterContent }) {
  const settle = useApp((s) => s.settleDraft);
  const draft = content.draft;
  if (draft === null) return null;
  return (
    <div className="draft-notice" role="alert">
      <span>发现 {new Date(draft.writtenAt).toLocaleString('zh-CN')} 未保存的编辑。</span>
      <button
        type="button"
        onClick={() => {
          // 载入草稿后按普通编辑处理：标记为未保存并自动保存。
          editor.commands.setContent(toDoc(draft.paragraphs, newId), { emitUpdate: true });
          void settle(false);
        }}
      >
        恢复这些编辑
      </button>
      <button type="button" onClick={() => void settle(true)}>
        丢弃
      </button>
    </div>
  );
}

/** 一章正文的编辑器。编辑状态不经过 React 渲染（关闭按事务重渲染，施工文档第二章）。 */
export function ChapterEditor({ content, title }: { readonly content: ChapterContent; readonly title: string }) {
  const saveChapter = useApp((s) => s.saveChapter);
  const writeDraft = useApp((s) => s.writeDraft);
  const setSaveStatus = useApp((s) => s.setSaveStatus);
  const setWordCount = useApp((s) => s.setWordCount);
  const registerEditor = useApp((s) => s.registerEditor);
  const entities = useApp((s) => s.entities);
  const openEntityDrawer = useApp((s) => s.openEntityDrawer);
  const showSource = useApp((s) => s.library?.preferences.showParagraphSource ?? true);
  // 保存后的段落（来源由保存时推导）；保存成功后状态中的这一份会更新。
  const savedParagraphs = useApp((s) => (s.chapterContent?.chapterId === content.chapterId ? s.chapterContent.saved : content.saved));
  const reveal = useApp((s) => s.reveal);
  const clearReveal = useApp((s) => s.clearReveal);
  const chapterId = content.chapterId;

  const editor = useEditor(
    {
      extensions: [...chapterExtensions({ newId }), EntityHighlight.configure({ onOpen: openEntityDrawer }), SourceMarks],
      content: toDoc(content.saved, newId),
      shouldRerenderOnTransaction: false,
      editorProps: { attributes: { class: 'chapter-text', 'aria-label': '正文', spellcheck: 'false' } },
    },
    [chapterId],
  );

  const controller = useRef<AutosaveController | null>(null);

  useEffect(() => {
    if (editor === null) return;
    const autosave = new AutosaveController(
      {
        snapshot: () => ({ paragraphs: fromDoc(editor.state.doc), edits: structuralLog(editor.state) }),
        isComposing: () => editor.view.composing,
        save: (saved, current, edits) => saveChapter(chapterId, saved, current, edits),
        writeDraft: (paragraphs) => writeDraft(chapterId, paragraphs),
        onStatus: setSaveStatus,
        timers: { set: (fn, ms) => window.setTimeout(fn, ms), clear: (h) => window.clearTimeout(h as number) },
      },
      content.saved,
    );
    controller.current = autosave;
    const count = () => setWordCount(countWords(plainText(editor)));
    const onUpdate = () => {
      autosave.changed();
      count();
    };
    const dom = editor.view.dom;
    const onCompositionEnd = () => autosave.compositionEnded();
    count();
    setSaveStatus({ kind: 'saved' });
    editor.on('update', onUpdate);
    dom.addEventListener('compositionend', onCompositionEnd);
    // 选区位置换成段落标识加段内下标（AI 上下文与选区操作使用）。
    const at = (pos: number) => {
      const resolved = editor.state.doc.resolve(pos);
      const id: unknown = resolved.parent.attrs['id'];
      return resolved.parent.type.name === 'paragraph' && typeof id === 'string' ? { paragraphId: id, offset: resolved.parentOffset } : null;
    };
    const selection = () => {
      const { from, to } = editor.state.selection;
      const start = at(from);
      const end = at(to);
      return start === null || end === null ? null : { from: start, to: end };
    };
    registerEditor({ chapterId, flush: () => autosave.flush(), selection });
    return () => {
      editor.off('update', onUpdate);
      dom.removeEventListener('compositionend', onCompositionEnd);
      registerEditor(null);
      // 离开章节的动作已经先保存；这里只是兜底。
      void autosave.flush().finally(() => autosave.dispose());
    };
  }, [editor, chapterId]);

  // 设定条目变化时重新匹配正文中的名字（只改装饰，不改文档）。
  useEffect(() => {
    if (editor !== null) setHighlightEntities(editor, entities);
  }, [editor, entities]);

  // 查找结果：选中这一处并滚动到可见位置。段落已不在或文字变短时选到段尾。
  useEffect(() => {
    if (editor === null || reveal === null || reveal.chapterId !== chapterId) return;
    let target: { from: number; to: number } | null = null;
    editor.state.doc.forEach((node, pos) => {
      if (target !== null || node.attrs['id'] !== reveal.paragraphId) return;
      const length = node.textContent.length;
      target = { from: pos + 1 + Math.min(reveal.start, length), to: pos + 1 + Math.min(reveal.end, length) };
    });
    if (target !== null) editor.chain().focus().setTextSelection(target).scrollIntoView().run();
    clearReveal();
  }, [editor, reveal, chapterId]);

  // 段落来源色条（只改装饰，不改文档）。输入法组合期间不改动正文的 DOM，组合结束后再更新。
  useEffect(() => {
    if (editor === null) return;
    const apply = () => setParagraphSources(editor, new Map(savedParagraphs.map((p) => [p.id, p.source])));
    if (!editor.view.composing) {
      apply();
      return;
    }
    const dom = editor.view.dom;
    let timer = 0;
    const later = () => {
      timer = window.setTimeout(apply, 0);
    };
    dom.addEventListener('compositionend', later, { once: true });
    return () => {
      dom.removeEventListener('compositionend', later);
      window.clearTimeout(timer);
    };
  }, [editor, savedParagraphs]);
  useEffect(() => {
    if (editor !== null) setSourceMarksEnabled(editor, showSource);
  }, [editor, showSource]);

  if (editor === null) return null;
  return (
    <div
      className="chapter-editor"
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
          e.preventDefault();
          void controller.current?.flush();
        }
      }}
    >
      <DraftNotice editor={editor} content={content} />
      <EditorContent editor={editor} className="chapter-text-wrap" />
      <StatusBar editor={editor} title={title} onSave={() => void controller.current?.flush()} />
    </div>
  );
}
