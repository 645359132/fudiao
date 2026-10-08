// @vitest-environment jsdom
import { Editor } from '@tiptap/core';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { chapterExtensions, fromDoc, toDoc, type EditorParagraph } from './document';
import { structuralLog } from './paragraph-identity';

// jsdom 没有 ClipboardEvent；ProseMirror 的 pasteText、pasteHTML 只用它构造一个粘贴事件。
if (typeof globalThis.ClipboardEvent === 'undefined') {
  class ClipboardEventPolyfill extends Event {
    readonly clipboardData: DataTransfer | null = null;
  }
  (globalThis as { ClipboardEvent?: unknown }).ClipboardEvent = ClipboardEventPolyfill;
}

const editors: Editor[] = [];
afterEach(() => {
  for (const e of editors.splice(0)) e.destroy();
});

function setup(...texts: string[]) {
  let n = 0;
  const newId = () => `n${++n}`;
  const paragraphs: EditorParagraph[] = texts.map((text, i) => ({ id: `p${i + 1}`, text, source: 'handwritten' }));
  const editor = new Editor({ extensions: chapterExtensions({ newId }), content: toDoc(paragraphs, newId) });
  editors.push(editor);
  return editor;
}

/** 第 i 段（从 0 起）正文中第 offset 个字符之前的位置。 */
function at(editor: Editor, i: number, offset: number): number {
  let result = -1;
  editor.state.doc.forEach((_, pos, index) => {
    if (index === i) result = pos + 1 + offset;
  });
  return result;
}

const ids = (editor: Editor) => fromDoc(editor.state.doc)?.map((p) => p.id);
const texts = (editor: Editor) => fromDoc(editor.state.doc)?.map((p) => p.text);
const log = (editor: Editor) => structuralLog(editor.state);

describe('段落标识：拆分', () => {
  it('在段中回车：前半段保留标识，后半段获得新标识并记录来源', () => {
    const editor = setup('雨下得更紧了', '他没有回头');
    editor.chain().setTextSelection(at(editor, 0, 3)).splitBlock().run();
    expect(texts(editor)).toEqual(['雨下得', '更紧了', '他没有回头']);
    expect(ids(editor)).toEqual(['p1', 'n1', 'p2']);
    expect(log(editor).splits).toEqual([{ id: 'n1', from: 'p1' }]);
  });

  it('在段尾回车：原段落保留标识，新的空段落获得新标识', () => {
    const editor = setup('雨下得更紧了');
    editor.chain().setTextSelection(at(editor, 0, 6)).splitBlock().run();
    expect(texts(editor)).toEqual(['雨下得更紧了', '']);
    expect(ids(editor)).toEqual(['p1', 'n1']);
  });

  it('在段首回车：带文字的一段保留标识，锚点不失效', () => {
    const editor = setup('雨下得更紧了');
    editor.chain().setTextSelection(at(editor, 0, 0)).splitBlock().run();
    expect(texts(editor)).toEqual(['', '雨下得更紧了']);
    expect(ids(editor)).toEqual(['n1', 'p1']);
  });
});

describe('段落标识：合并与删除', () => {
  it('在段首退格：本段并入上一段', () => {
    const editor = setup('甲', '乙', '丙');
    editor.chain().setTextSelection(at(editor, 1, 0)).joinBackward().run();
    expect(texts(editor)).toEqual(['甲乙', '丙']);
    expect(ids(editor)).toEqual(['p1', 'p3']);
    expect(log(editor).merges).toEqual([{ removed: 'p2', into: 'p1' }]);
  });

  it('在段尾按删除键：下一段并入本段', () => {
    const editor = setup('甲', '乙');
    editor.chain().setTextSelection(at(editor, 0, 1)).joinForward().run();
    expect(ids(editor)).toEqual(['p1']);
    expect(log(editor).merges).toEqual([{ removed: 'p2', into: 'p1' }]);
  });

  it('跨段选中删除：中间整段删除，末段的剩余部分并入首段', () => {
    const editor = setup('甲甲', '乙乙', '丙丙', '丁丁');
    editor.chain().setTextSelection({ from: at(editor, 0, 1), to: at(editor, 2, 1) }).deleteSelection().run();
    expect(texts(editor)).toEqual(['甲丙', '丁丁']);
    expect(ids(editor)).toEqual(['p1', 'p4']);
    expect(log(editor).merges).toEqual([{ removed: 'p3', into: 'p1' }]);
  });
});

describe('段落标识：粘贴、移动与撤销', () => {
  it('粘贴多行纯文本：每行一段，各有新标识', () => {
    const editor = setup('甲');
    editor.commands.setTextSelection(at(editor, 0, 1));
    editor.view.pasteText('乙\n丙\n丁');
    const result = fromDoc(editor.state.doc) ?? [];
    expect(result.map((p) => p.text)).toEqual(['甲乙', '丙', '丁']);
    expect(new Set(result.map((p) => p.id)).size).toBe(3);
    expect(result[0]?.id).toBe('p1');
  });

  it('粘贴复制来的段落：原段落保留标识，副本获得新标识；其他章节的标识重新生成', () => {
    const editor = setup('甲', '乙');
    editor.commands.setTextSelection(at(editor, 1, 1));
    editor.view.pasteHTML('<p data-id="p1">甲</p><p data-id="other-chapter">外来</p>');
    const result = fromDoc(editor.state.doc) ?? [];
    expect(result.filter((p) => p.id === 'p1')).toHaveLength(1);
    expect(result[0]?.id).toBe('p1');
    expect(result.some((p) => p.id === 'other-chapter')).toBe(false);
    expect(new Set(result.map((p) => p.id)).size).toBe(result.length);
  });

  it('剪切后粘贴到别处（移动）：沿用原标识', () => {
    const editor = setup('甲', '乙', '丙');
    editor.chain().setTextSelection({ from: at(editor, 1, 0) - 1, to: at(editor, 1, 1) + 1 }).deleteSelection().run();
    expect(ids(editor)).toEqual(['p1', 'p3']);
    editor.commands.insertContentAt(editor.state.doc.content.size, '<p data-id="p2">乙</p>');
    expect(ids(editor)).toEqual(['p1', 'p3', 'p2']);
  });

  it('撤销与重做拆分：标识随之恢复，重做得到同一个新标识', () => {
    const editor = setup('甲乙');
    editor.chain().setTextSelection(at(editor, 0, 1)).splitBlock().run();
    expect(ids(editor)).toEqual(['p1', 'n1']);
    editor.commands.undo();
    expect(ids(editor)).toEqual(['p1']);
    expect(texts(editor)).toEqual(['甲乙']);
    editor.commands.redo();
    expect(ids(editor)).toEqual(['p1', 'n1']);
  });
});

describe('段落标识：输入法组合', () => {
  it('组合期间不改动文档，组合结束后的下一个事务补上标识', () => {
    const editor = setup('甲乙');
    let composing = true;
    Object.defineProperty(editor.view, 'composing', { get: () => composing, configurable: true });
    editor.chain().setTextSelection(at(editor, 0, 1)).splitBlock().run();
    // 组合期间两段暂时同一标识，不能保存。
    expect(editor.state.doc.child(1).attrs['id']).toBe('p1');
    composing = false;
    editor.commands.insertContentAt(at(editor, 1, 1), '丙');
    expect(ids(editor)).toEqual(['p1', 'n1']);
  });

  it('有段落没有标识时 fromDoc 返回 null', () => {
    const editor = setup('甲');
    const doc = editor.schema.nodeFromJSON({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '无标识' }] }] });
    expect(fromDoc(doc)).toBeNull();
  });
});

describe('段落标识：任意编辑', () => {
  it('任意的拆分、合并、删除、输入、撤销与重做之后，每段都有标识且互不相同', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.integer({ min: 0, max: 6 }), fc.nat(), fc.nat()), { maxLength: 30 }),
        (ops) => {
          const editor = setup('甲乙丙', '丁戊', '己庚辛壬');
          for (const [kind, a, b] of ops) {
            const size = editor.state.doc.content.size;
            const p = 1 + (a % Math.max(1, size - 1));
            const q = 1 + (b % Math.max(1, size - 1));
            const chain = editor.chain().setTextSelection(Math.min(p, q));
            if (kind === 0) chain.splitBlock().run();
            else if (kind === 1) chain.joinBackward().run();
            else if (kind === 2) chain.joinForward().run();
            else if (kind === 3) editor.chain().setTextSelection({ from: Math.min(p, q), to: Math.max(p, q) }).deleteSelection().run();
            else if (kind === 4) chain.insertContent('字').run();
            else if (kind === 5) editor.commands.undo();
            else editor.commands.redo();
            const list = fromDoc(editor.state.doc);
            if (list === null || new Set(list.map((x) => x.id)).size !== list.length) return false;
          }
          return true;
        },
      ),
      { numRuns: 150 },
    );
  });
});
