// @vitest-environment jsdom
import { Editor } from '@tiptap/core';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { chapterExtensions, fromDoc, toDoc } from './document';
import { setParagraphSources, setSourceMarksEnabled, SourceMarks, sourceMarksKey } from './source-marks';

const editors: Editor[] = [];
afterEach(() => {
  for (const e of editors.splice(0)) e.destroy();
});

function setup(texts: string[]) {
  let n = 0;
  const newId = () => `n${++n}`;
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [...chapterExtensions({ newId }), SourceMarks],
    content: toDoc(texts.map((text, i) => ({ id: `p${i}`, text, source: 'handwritten' as const })), newId),
  });
  editors.push(editor);
  return editor;
}

const marked = (editor: Editor) =>
  (sourceMarksKey.getState(editor.state)?.decorations.find() ?? []).map((d) => [editor.state.doc.nodeAt(d.from)?.attrs['id'] as string, (d.spec as { source: string }).source]);

describe('段落来源色条', () => {
  it('按段落标识标出 AI 参与的段落，手写段落不标；文档不变', () => {
    const editor = setup(['雨很大。', '他没有回头。', '她站在门口。']);
    const before = fromDoc(editor.state.doc);
    setParagraphSources(
      editor,
      new Map([
        ['p0', 'ai_generated'],
        ['p1', 'handwritten'],
        ['p2', 'mixed'],
      ]),
    );
    expect(marked(editor)).toEqual([
      ['p0', 'ai_generated'],
      ['p2', 'mixed'],
    ]);
    expect(fromDoc(editor.state.doc)).toEqual(before);
    expect(editor.view.dom.querySelector('p.source-mixed')?.getAttribute('data-source-label')).toBe('混合');
  });

  it('编辑时色条随段落移动；关闭后不显示，再打开恢复', () => {
    const editor = setup(['雨很大。', '他没有回头。']);
    setParagraphSources(editor, new Map([['p1', 'ai_modified']]));
    editor.commands.insertContentAt(0, { type: 'paragraph', attrs: { id: 'x' }, content: [{ type: 'text', text: '新的一段' }] });
    expect(marked(editor)).toEqual([['p1', 'ai_modified']]);
    setSourceMarksEnabled(editor, false);
    expect(marked(editor)).toEqual([]);
    setSourceMarksEnabled(editor, true);
    expect(marked(editor)).toEqual([['p1', 'ai_modified']]);
  });

  it('拆分后撤销：色条仍在原段落上', () => {
    const editor = setup(['雨很大。他没有回头。']);
    setParagraphSources(editor, new Map([['p0', 'ai_generated']]));
    editor.commands.setTextSelection(5);
    editor.commands.splitBlock();
    expect(editor.state.doc.childCount).toBe(2);
    editor.commands.undo();
    expect(editor.state.doc.childCount).toBe(1);
    expect(marked(editor)).toEqual([['p0', 'ai_generated']]);
  });

  it('来源没有变化时不发事务', () => {
    const editor = setup(['雨很大。']);
    setParagraphSources(editor, new Map([['p0', 'ai_generated']]));
    const state = editor.state;
    setParagraphSources(editor, new Map([['p0', 'ai_generated']]));
    expect(editor.state).toBe(state);
  });

  it('载入来源不进入撤销历史', () => {
    const editor = setup(['雨很大。']);
    setParagraphSources(editor, new Map([['p0', 'ai_generated']]));
    expect(editor.can().undo()).toBe(false);
  });
});

describe('段落来源色条的增量更新', () => {
  it('段内打字只做映射；任意一串打字、拆段、跨段删除与撤销之后，色条与按段落标识重建的结果一致', () => {
    const sources = new Map([
      ['p0', 'ai_generated' as const],
      ['p2', 'mixed' as const],
    ]);
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.record({ op: fc.constant('type' as const), at: fc.nat() }),
            fc.record({ op: fc.constant('split' as const), at: fc.nat() }),
            fc.record({ op: fc.constant('delete' as const), at: fc.nat(), length: fc.integer({ min: 1, max: 10 }) }),
            fc.record({ op: fc.constant('undo' as const) }),
          ),
          { maxLength: 12 },
        ),
        (ops) => {
          const editor = setup(['雨很大。', '他没有回头。', '她站在门口。']);
          setParagraphSources(editor, sources);
          for (const o of ops) {
            const size = editor.state.doc.content.size;
            const pos = (n: number) => 1 + (n % Math.max(1, size - 1));
            if (o.op === 'type') editor.commands.insertContentAt(pos(o.at), '字');
            else if (o.op === 'split') editor.chain().setTextSelection(pos(o.at)).splitBlock().run();
            else if (o.op === 'delete') editor.commands.deleteRange({ from: pos(o.at), to: Math.min(pos(o.at) + o.length, size - 1) });
            else editor.commands.undo();
          }
          const expected: [string, string][] = [];
          editor.state.doc.forEach((node) => {
            const source = sources.get(node.attrs['id'] as string);
            if (source !== undefined) expected.push([node.attrs['id'] as string, source]);
          });
          expect(marked(editor)).toEqual(expected);
        },
      ),
      { numRuns: 150 },
    );
    // 随机编辑 150 次，整套测试并行时较慢：上限放宽到 30 秒。
  }, 30_000);
});
