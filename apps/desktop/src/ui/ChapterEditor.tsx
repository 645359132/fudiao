import { useEffect, useRef } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { chapterExtensions, fromDoc, structuralLog, toDoc } from '@fudiao/editor';
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
  const chapterId = content.chapterId;

  const editor = useEditor(
    {
      extensions: chapterExtensions({ newId }),
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
    registerEditor({ chapterId, flush: () => autosave.flush() });
    return () => {
      editor.off('update', onUpdate);
      dom.removeEventListener('compositionend', onCompositionEnd);
      registerEditor(null);
      // 离开章节的动作已经先保存；这里只是兜底。
      void autosave.flush().finally(() => autosave.dispose());
    };
  }, [editor, chapterId]);

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
