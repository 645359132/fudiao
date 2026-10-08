import type { AnyExtension, JSONContent } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { UndoRedo } from '@tiptap/extensions';
import type { Node as PmNode } from '@tiptap/pm/model';
import { ParagraphIdentity, type SourceKind } from './paragraph-identity';

/** 编辑器中的一个段落。 */
export type EditorParagraph = { readonly id: string; readonly text: string; readonly source: SourceKind };

/**
 * 正文编辑器的扩展：文档结构为 doc > paragraph+，首版不启用行内样式与硬换行（施工文档第七章）。
 */
export function chapterExtensions(options: { readonly newId?: () => string } = {}): AnyExtension[] {
  return [
    Document,
    Paragraph,
    Text,
    UndoRedo,
    options.newId === undefined ? ParagraphIdentity : ParagraphIdentity.configure({ newId: options.newId }),
  ];
}

/** 库中的段落转为编辑器文档；没有段落时给一个空段落。 */
export function toDoc(paragraphs: readonly EditorParagraph[], newId: () => string): JSONContent {
  const list = paragraphs.length > 0 ? paragraphs : [{ id: newId(), text: '', source: 'handwritten' as const }];
  return {
    type: 'doc',
    content: list.map((p) => ({
      type: 'paragraph',
      attrs: { id: p.id, source: p.source },
      ...(p.text !== '' && { content: [{ type: 'text', text: p.text }] }),
    })),
  };
}

/** 编辑器文档转为段落。还有段落没有标识时（输入法组合尚未结束）返回 null，此时不应保存。 */
export function fromDoc(doc: PmNode): EditorParagraph[] | null {
  const out: EditorParagraph[] = [];
  let complete = true;
  doc.forEach((node) => {
    const id: unknown = node.attrs['id'];
    if (typeof id !== 'string') {
      complete = false;
      return;
    }
    out.push({ id, text: node.textContent, source: (node.attrs['source'] as SourceKind | undefined) ?? 'handwritten' });
  });
  return complete ? out : null;
}
