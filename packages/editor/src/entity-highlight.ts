// 正文中的设定名高亮（需求 B09、施工文档第七章）：只用装饰层，不改动文档；Ctrl + 点击打开设定。
import { Extension, type Editor } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { createEntityMatcher, type MatchableEntity } from './entity-matcher';

type Matcher = ReturnType<typeof createEntityMatcher>;
type HighlightState = { readonly matcher: Matcher; readonly decorations: DecorationSet; readonly stale: boolean };

export const entityHighlightKey = new PluginKey<HighlightState>('entityHighlight');

export type EntityHighlightOptions = {
  /** Ctrl（或 Command）+ 点击高亮的名字时调用。 */
  readonly onOpen: (entityId: string) => void;
};

/** 一段里的高亮。段落里只有文字节点，段内字符串下标加上段落内容的起点就是文档位置。 */
function paragraphDecorations(node: PmNode, pos: number, matcher: Matcher): Decoration[] {
  return matcher
    .find(node.textContent)
    .map((m) => Decoration.inline(pos + 1 + m.from, pos + 1 + m.to, { class: `entity entity-${m.kind}`, title: m.name, 'data-entity-id': m.entityId }, { entityId: m.entityId }));
}

function build(doc: PmNode, matcher: Matcher): DecorationSet {
  const decorations: Decoration[] = [];
  doc.forEach((node, pos) => decorations.push(...paragraphDecorations(node, pos, matcher)));
  return DecorationSet.create(doc, decorations);
}

/** 事务改动涉及的顶层段落（在新文档中的起点）。 */
function touchedParagraphs(tr: Transaction): number[] {
  const doc = tr.doc;
  const starts = new Set<number>();
  tr.mapping.maps.forEach((map, i) => {
    const after = tr.mapping.slice(i + 1);
    map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      const from = Math.min(after.map(newStart, -1), doc.content.size);
      const to = Math.min(after.map(newEnd, 1), doc.content.size);
      const $from = doc.resolve(from);
      let index = Math.min($from.index(0), doc.childCount - 1);
      let offset = $from.posAtIndex(index, 0);
      while (index < doc.childCount && offset <= to) {
        starts.add(offset);
        offset += doc.child(index).nodeSize;
        index += 1;
      }
    });
  });
  return [...starts];
}

/** 只重新匹配改动涉及的段落，其余的高亮随文档映射（每次按键只动一段，长章节也不必整章重扫）。 */
function refresh(tr: Transaction, decorations: DecorationSet, matcher: Matcher): DecorationSet {
  let set = decorations.map(tr.mapping, tr.doc);
  for (const pos of touchedParagraphs(tr)) {
    const node = tr.doc.nodeAt(pos);
    if (node === null) continue;
    set = set.remove(set.find(pos, pos + node.nodeSize)).add(tr.doc, paragraphDecorations(node, pos, matcher));
  }
  return set;
}

export const EntityHighlight = Extension.create<EntityHighlightOptions>({
  name: 'entityHighlight',

  addOptions() {
    return { onOpen: () => undefined };
  },

  addProseMirrorPlugins() {
    const onOpen = this.options.onOpen;
    let view: EditorView | null = null;
    const composing = () => view?.composing === true;

    return [
      new Plugin<HighlightState>({
        key: entityHighlightKey,
        state: {
          init: () => ({ matcher: createEntityMatcher([]), decorations: DecorationSet.empty, stale: false }),
          apply(tr, value) {
            const entities = tr.getMeta(entityHighlightKey) as readonly MatchableEntity[] | undefined;
            const matcher = entities === undefined ? value.matcher : createEntityMatcher(entities);
            if (entities === undefined && !tr.docChanged && !value.stale) return value;
            // 输入法组合期间只随文档映射已有的装饰，组合结束后再重新匹配，避免打断组合输入。
            if (composing()) return { matcher, decorations: value.decorations.map(tr.mapping, tr.doc), stale: true };
            // 设定换了、或组合输入期间积压了改动时整章重新匹配；平常的编辑只重新匹配改动的段落。
            if (entities !== undefined || value.stale) return { matcher, decorations: build(tr.doc, matcher), stale: false };
            return { matcher, decorations: refresh(tr, value.decorations, matcher), stale: false };
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
          decorations: (state) => entityHighlightKey.getState(state)?.decorations ?? DecorationSet.empty,
          handleClick(v, pos, event) {
            if (!event.ctrlKey && !event.metaKey) return false;
            const found = entityHighlightKey.getState(v.state)?.decorations.find(pos, pos) ?? [];
            const entityId = (found[0]?.spec as { entityId?: string } | undefined)?.entityId;
            if (entityId === undefined) return false;
            onOpen(entityId);
            return true;
          },
        },
      }),
    ];
  },
});

/** 换一组设定条目后重新匹配。不进入撤销历史。 */
export function setHighlightEntities(editor: Editor, entities: readonly MatchableEntity[]): void {
  editor.view.dispatch(editor.state.tr.setMeta(entityHighlightKey, entities).setMeta('addToHistory', false));
}
