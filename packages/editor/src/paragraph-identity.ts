// 段落标识扩展（施工文档第四章“段落标识与锚点”、DESIGN_PATTERNS“编辑器扩展”）。
// 每个段落有稳定的标识；拆分、合并、粘贴、撤销之后，标识按下面的规则继承，供锚点、来源与事件关联使用。
import { Extension } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Mapping, ReplaceAroundStep, ReplaceStep } from '@tiptap/pm/transform';
import type { EditorView } from '@tiptap/pm/view';
import { ulid } from '@fudiao/shared';

export type SourceKind = 'handwritten' | 'ai_generated' | 'ai_modified' | 'mixed';

/** 自本次载入以来的结构变化：拆分出的段落及其来源，被合并的段落及并入的段落。 */
export type StructuralLog = {
  readonly splits: readonly { readonly id: string; readonly from: string }[];
  readonly merges: readonly { readonly removed: string; readonly into: string }[];
};

export type ParagraphIdentityOptions = {
  /** 新段落的标识；测试中注入可预测的生成器。 */
  readonly newId: () => string;
};

type IdentityState = { readonly log: StructuralLog };

const EMPTY_LOG: StructuralLog = { splits: [], merges: [] };
export const paragraphIdentityKey = new PluginKey<IdentityState>('paragraphIdentity');

const defaultId = () => ulid(Date.now(), crypto.getRandomValues(new Uint8Array(10)));

function topLevel(doc: PmNode): { node: PmNode; pos: number }[] {
  const out: { node: PmNode; pos: number }[] = [];
  doc.forEach((node, pos) => out.push({ node, pos }));
  return out;
}

const idOf = (node: PmNode): string | null => {
  const id: unknown = node.attrs['id'];
  return typeof id === 'string' ? id : null;
};

/**
 * 合并按步骤判断，不靠文本猜测：替换范围删掉了某段的开头、没删掉它的结尾，这一段的剩余内容就并入了
 * 替换起点所在的段落（ProseMirror 保留起点一侧的节点及其属性）。
 */
function mergesIn(tr: Transaction): { removed: string; into: string }[] {
  const merges: { removed: string; into: string }[] = [];
  tr.steps.forEach((step, i) => {
    if (!(step instanceof ReplaceStep || step instanceof ReplaceAroundStep)) return;
    const { from, to } = step as unknown as { from: number; to: number };
    if (to <= from) return;
    const doc = tr.docs[i];
    if (doc === undefined) return;
    const $from = doc.resolve(from);
    if ($from.depth < 1) return;
    const into = idOf($from.node(1));
    if (into === null) return;
    for (const { node, pos } of topLevel(doc)) {
      const removed = idOf(node);
      if (removed === null || removed === into) continue;
      if (from <= pos && to > pos && to < pos + node.nodeSize) merges.push({ removed, into });
    }
  });
  return merges;
}

export const ParagraphIdentity = Extension.create<ParagraphIdentityOptions>({
  name: 'paragraphIdentity',

  addOptions() {
    return { newId: defaultId };
  },

  addGlobalAttributes() {
    return [
      {
        types: ['paragraph'],
        attributes: {
          id: {
            default: null,
            // 拆分时先复制到两段，再由下面的规则决定哪一段保留。
            keepOnSplit: true,
            parseHTML: (el) => el.getAttribute('data-id'),
            renderHTML: (attrs) => (typeof attrs['id'] === 'string' ? { 'data-id': attrs['id'] } : {}),
          },
          source: {
            default: 'handwritten',
            keepOnSplit: true,
            parseHTML: (el) => el.getAttribute('data-source') ?? 'handwritten',
            renderHTML: (attrs) => ({ 'data-source': attrs['source'] as string }),
          },
        },
      },
    ];
  },

  addProseMirrorPlugins() {
    const newId = this.options.newId;
    // 本次载入以来出现过的标识：剪切后粘贴、撤销恢复的段落沿用原标识；其他章节粘贴来的标识重新生成。
    const known = new Set<string>();
    let view: EditorView | null = null;
    let seeded = false;

    const assign = (trs: readonly Transaction[], oldState: EditorState, newState: EditorState): Transaction | null => {
      if (!seeded) {
        for (const { node } of topLevel(oldState.doc)) {
          const id = idOf(node);
          if (id !== null) known.add(id);
        }
        seeded = true;
      }
      // 输入法组合期间不改动文档；组合结束后的下一个事务再补。
      if (view?.composing === true) return null;

      const mapping = new Mapping();
      for (const t of trs) mapping.appendMapping(t.mapping);
      const oldPos = new Map<string, { pos: number; text: string }>();
      for (const { node, pos } of topLevel(oldState.doc)) {
        const id = idOf(node);
        // 只记第一次出现：输入法组合期间推迟补标识时，旧文档里可能已有重复。
        if (id !== null && !oldPos.has(id)) oldPos.set(id, { pos, text: node.textContent });
      }

      const nodes = topLevel(newState.doc);
      const groups = new Map<string, number[]>();
      nodes.forEach(({ node }, i) => {
        const id = idOf(node);
        if (id !== null) groups.set(id, [...(groups.get(id) ?? []), i]);
      });

      // 每个标识选出保留它的一段：原段落映射到的位置；若那一段为空而另一段有文字（在段首回车），由有文字的一段保留。
      const keeper = new Map<string, number>();
      for (const [id, indices] of groups) {
        const old = oldPos.get(id);
        if (old === undefined && !known.has(id)) continue;
        let keep = indices[0] ?? 0;
        if (old !== undefined) {
          const mapped = mapping.map(old.pos, -1);
          keep = indices.find((i) => nodes[i]?.pos === mapped) ?? keep;
          if (nodes[keep]?.node.textContent === '' && old.text !== '') keep = indices.find((i) => nodes[i]?.node.textContent !== '') ?? keep;
        }
        keeper.set(id, keep);
      }

      const tr = newState.tr;
      const splits: { id: string; from: string }[] = [];
      nodes.forEach(({ node, pos }, i) => {
        const id = idOf(node);
        if (id !== null && keeper.get(id) === i) return;
        const fresh = newId();
        known.add(fresh);
        tr.setNodeAttribute(pos, 'id', fresh);
        if (id !== null && keeper.has(id)) splits.push({ id: fresh, from: id });
      });
      for (const { node } of nodes) {
        const id = idOf(node);
        if (id !== null) known.add(id);
      }
      if (!tr.docChanged) return null;
      // 与触发它的编辑同属一个撤销步骤：重做时恢复同一个标识。
      return tr.setMeta(paragraphIdentityKey, { splits });
    };

    return [
      new Plugin<IdentityState>({
        key: paragraphIdentityKey,
        state: {
          init: () => ({ log: EMPTY_LOG }),
          apply(tr, value) {
            const merges = tr.docChanged ? mergesIn(tr) : [];
            const meta = tr.getMeta(paragraphIdentityKey) as { splits: StructuralLog['splits'] } | undefined;
            if (merges.length === 0 && meta === undefined) return value;
            return {
              log: {
                splits: [...value.log.splits, ...(meta?.splits ?? [])],
                merges: [...value.log.merges, ...merges],
              },
            };
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
        appendTransaction(trs, oldState, newState) {
          if (!trs.some((t) => t.docChanged)) return null;
          return assign(trs, oldState, newState);
        },
      }),
    ];
  },
});

/** 当前的结构变化记录（保存时交给保存计划）。 */
export const structuralLog = (state: EditorState): StructuralLog => paragraphIdentityKey.getState(state)?.log ?? EMPTY_LOG;
