// @vitest-environment jsdom
import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';
import { chapterExtensions, fromDoc, toDoc } from './document';
import { EntityHighlight, entityHighlightKey, setHighlightEntities } from './entity-highlight';

const editors: Editor[] = [];
afterEach(() => {
  for (const e of editors.splice(0)) e.destroy();
});

const entities = [
  { id: 'shen', kind: 'character', name: '沈砚', aliases: ['沈先生'] },
  { id: 'shop', kind: 'location', name: '当铺', aliases: [] },
];

function setup(texts: string[], opened: string[] = []) {
  let n = 0;
  const newId = () => `n${++n}`;
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [...chapterExtensions({ newId }), EntityHighlight.configure({ onOpen: (id) => opened.push(id) })],
    content: toDoc(texts.map((text, i) => ({ id: `p${i}`, text, source: 'handwritten' as const })), newId),
  });
  editors.push(editor);
  return editor;
}

const highlighted = (editor: Editor) =>
  (entityHighlightKey.getState(editor.state)?.decorations.find() ?? []).map((d) => [editor.state.doc.textBetween(d.from, d.to), (d.spec as { entityId: string }).entityId]);

describe('设定名高亮', () => {
  it('设定条目载入后高亮正文中的名字与别名，文档不变', () => {
    const editor = setup(['沈砚走进当铺。', '沈先生没有回头。']);
    const before = fromDoc(editor.state.doc);
    setHighlightEntities(editor, entities);
    expect(highlighted(editor)).toEqual([
      ['沈砚', 'shen'],
      ['当铺', 'shop'],
      ['沈先生', 'shen'],
    ]);
    expect(fromDoc(editor.state.doc)).toEqual(before);
    expect(editor.view.dom.querySelector('[data-entity-id="shop"]')?.textContent).toBe('当铺');
  });

  it('编辑后重新匹配；撤销不会撤回高亮的载入', () => {
    const editor = setup(['雨夜']);
    setHighlightEntities(editor, entities);
    editor.commands.insertContentAt(3, '，当铺');
    expect(highlighted(editor)).toEqual([['当铺', 'shop']]);
    editor.commands.undo();
    expect(highlighted(editor)).toEqual([]);
    expect(entityHighlightKey.getState(editor.state)?.matcher.find('当铺')).toHaveLength(1);
  });

  it('输入法组合期间不重新匹配，组合结束后补上', () => {
    const editor = setup(['雨夜']);
    setHighlightEntities(editor, entities);
    let composing = true;
    Object.defineProperty(editor.view, 'composing', { get: () => composing, configurable: true });
    editor.commands.insertContentAt(3, '当铺');
    expect(highlighted(editor)).toEqual([]);
    composing = false;
    editor.commands.setTextSelection(1);
    expect(highlighted(editor)).toEqual([['当铺', 'shop']]);
  });

  it('Ctrl + 点击高亮的名字时打开设定；普通点击不打开', () => {
    const opened: string[] = [];
    const editor = setup(['沈砚走进当铺。'], opened);
    setHighlightEntities(editor, entities);
    const click = (ctrlKey: boolean, pos: number) =>
      editor.view.someProp('handleClick', (f) => f(editor.view, pos, new MouseEvent('click', { ctrlKey })));
    expect(click(false, 2)).toBeFalsy();
    expect(click(true, 2)).toBe(true);
    expect(click(true, 4)).toBeFalsy();
    expect(opened).toEqual(['shen']);
  });
});
