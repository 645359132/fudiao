// 段落来源色条（需求 B33）：按段落标识给 AI 参与的段落加节点装饰，不改动文档。
// 来源由保存时推导（packages/store 的 paragraph-source），保存后由界面传入；尚未保存的新段落没有色条。
import { Extension, type Editor } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import type { SourceKind } from './paragraph-identity';

export const SOURCE_LABELS: Readonly<Record<SourceKind, string>> = {
  handwritten: '手写',
  ai_generated: 'AI 生成',
  ai_modified: 'AI 生成后修改',
  mixed: '混合',
};

type MarksState = { readonly sources: ReadonlyMap<string, SourceKind>; readonly enabled: boolean; readonly decorations: DecorationSet };
type MarksMeta = { readonly sources?: ReadonlyMap<string, SourceKind>; readonly enabled?: boolean };

export const sourceMarksKey = new PluginKey<MarksState>('sourceMarks');

function build(doc: PmNode, sources: ReadonlyMap<string, SourceKind>, enabled: boolean): DecorationSet {
  if (!enabled || sources.size === 0) return DecorationSet.empty;
  const decorations: Decoration[] = [];
  doc.forEach((node, pos) => {
    const source = sources.get(node.attrs['id'] as string);
    if (source === undefined || source === 'handwritten') return;
    decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: `source source-${source}`, 'data-source-label': SOURCE_LABELS[source] }, { source }));
  });
  return DecorationSet.create(doc, decorations);
}

export const SourceMarks = Extension.create({
  name: 'sourceMarks',

  addProseMirrorPlugins() {
    let view: EditorView | null = null;
    return [
      new Plugin<MarksState>({
        key: sourceMarksKey,
        state: {
          init: () => ({ sources: new Map(), enabled: true, decorations: DecorationSet.empty }),
          apply(tr, value) {
            const meta = tr.getMeta(sourceMarksKey) as MarksMeta | undefined;
            if (meta === undefined && !tr.docChanged) return value;
            const sources = meta?.sources ?? value.sources;
            const enabled = meta?.enabled ?? value.enabled;
            // 拆分、合并与撤销会让映射后的节点装饰失效，所以按段落标识重建；输入法组合期间只做映射。
            if (meta === undefined && view?.composing === true) return { ...value, decorations: value.decorations.map(tr.mapping, tr.doc) };
            return { sources, enabled, decorations: build(tr.doc, sources, enabled) };
          },
        },
        view(v) {
          view = v;
          return {
            update(next) {
              view = next;
            },
            destroy() {
              view = null;
            },
          };
        },
        props: {
          decorations: (state) => sourceMarksKey.getState(state)?.decorations ?? DecorationSet.empty,
        },
      }),
    ];
  },
});

/** 传入保存后的段落来源。来源没有变化时不发事务（每次保存后都会调用）。不进入撤销历史。 */
export function setParagraphSources(editor: Editor, sources: ReadonlyMap<string, SourceKind>): void {
  const before = sourceMarksKey.getState(editor.state)?.sources;
  if (before !== undefined && before.size === sources.size && [...sources].every(([id, kind]) => before.get(id) === kind)) return;
  editor.view.dispatch(editor.state.tr.setMeta(sourceMarksKey, { sources } satisfies MarksMeta).setMeta('addToHistory', false));
}

/** 显示或隐藏来源色条（设置中的“显示段落来源”）。 */
export function setSourceMarksEnabled(editor: Editor, enabled: boolean): void {
  editor.view.dispatch(editor.state.tr.setMeta(sourceMarksKey, { enabled } satisfies MarksMeta).setMeta('addToHistory', false));
}
