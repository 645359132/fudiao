import { describe, expect, it } from 'vitest';
import { renderSelectionEdit, type SelectionEditInput } from './render';

const base: SelectionEditInput = {
  operation: 'rewrite',
  materials: [
    { title: '设定：沈砚', text: '沈砚：当铺掌柜的旧友' },
    { title: '本章的梗概与备注', text: '梗概：沈砚回到当铺' },
  ],
  before: '雨下得更紧了。',
  selection: '他推开门。',
  after: '柜台后没有人。',
  length: 300,
  instruction: '',
};

const render = (input: Partial<SelectionEditInput>) => {
  const r = renderSelectionEdit({ ...base, ...input });
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

describe('选区操作的提示词', () => {
  it('材料放在可缓存的系统提示中，前后文与选中的文字在用户消息中；不要求结构化输出', () => {
    const p = render({});
    expect(p).toMatchObject({ task: 'selection_edit', template: { id: 'selection_edit', version: '1' } });
    expect(p.output).toBeUndefined();
    expect(p.system[1]).toMatchObject({ cache: true });
    expect(p.system[1]?.text).toContain('【设定：沈砚】\n沈砚：当铺掌柜的旧友');
    const user = p.messages[0]?.content ?? '';
    expect(user).toContain('前文：\n雨下得更紧了。');
    expect(user).toContain('需要处理的文字：\n他推开门。');
    expect(user).toContain('后文：\n柜台后没有人。');
    expect(user).toContain('请改写需要处理的文字');
    expect(user).not.toContain('作者的要求');
  });

  it('五种操作各有自己的要求；续写没有选中的文字时接着前文写', () => {
    expect(render({ operation: 'expand', length: 120 }).messages[0]?.content).toContain('扩写需要处理的文字到约 120 字');
    expect(render({ operation: 'shorten', length: 40 }).messages[0]?.content).toContain('缩写需要处理的文字到约 40 字');
    expect(render({ operation: 'polish' }).messages[0]?.content).toContain('请润色');
    const cont = render({ operation: 'continue', selection: '', after: '' }).messages[0]?.content ?? '';
    expect(cont).toContain('请接着前文往下写约 300 字');
    expect(cont).not.toContain('选中的文字');
    expect(cont).not.toContain('后文');
    expect(render({ operation: 'continue' }).messages[0]?.content).toContain('请接着选中的文字往下写');
  });

  it('作者的要求与材料原样放入，不当作模板解释；没有材料时说明', () => {
    const p = render({ instruction: '  语气更冷一些 {{secret}} ', materials: [] });
    expect(p.messages[0]?.content).toContain('作者的要求：语气更冷一些 {{secret}}');
    expect(p.system[1]?.text).toContain('（没有其他材料）');
  });
});
