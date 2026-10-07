import { describe, expect, it } from 'vitest';
import { parseTemplate, render } from './engine';

describe('模板渲染', () => {
  it('替换变量，支持点号路径', () => {
    expect(render('你是{{self.name}}，位于{{self.zone}}。', { self: { name: '主角', zone: '仓库中央' } })).toEqual({
      ok: true,
      value: '你是主角，位于仓库中央。',
    });
  });

  it('列表区块逐项渲染，{{.}} 指当前项', () => {
    expect(render('{{#traits}}[{{.}}]{{/traits}}', { traits: ['谨慎', '多疑'] })).toEqual({ ok: true, value: '[谨慎][多疑]' });
  });

  it('对象区块进入其上下文，并能读取外层变量', () => {
    const out = render('{{#item}}{{name}}属于{{owner}}{{/item}}', { owner: '主角', item: { name: '密信' } });
    expect(out).toEqual({ ok: true, value: '密信属于主角' });
  });

  it('反向区块在空列表、false、null 时渲染', () => {
    expect(render('{{^xs}}无{{/xs}}|{{^f}}否{{/f}}|{{^n}}空{{/n}}|{{^t}}真{{/t}}', { xs: [], f: false, n: null, t: true })).toEqual({
      ok: true,
      value: '无|否|空|',
    });
  });

  it('独占一行的区块标签不留下空行', () => {
    const out = render('开始\n{{#xs}}\n- {{.}}\n{{/xs}}\n结束', { xs: ['甲', '乙'] });
    expect(out).toEqual({ ok: true, value: '开始\n- 甲\n- 乙\n结束' });
  });

  it('支持局部模板', () => {
    const out = render('{{#xs}}{{> item}};{{/xs}}', { xs: [{ n: 1 }, { n: 2 }] }, { item: '#{{n}}' });
    expect(out).toEqual({ ok: true, value: '#1;#2;' });
  });

  it('引用不存在的变量、未闭合的区块、未知的局部模板都是错误', () => {
    expect(render('{{missing}}', {}).ok).toBe(false);
    expect(render('{{#xs}}abc', { xs: [1] }).ok).toBe(false);
    expect(render('{{> nope}}', {}).ok).toBe(false);
  });

  it('值为 null 的变量输出为空，而不是报错', () => {
    expect(render('[{{a.b}}]', { a: { b: null } })).toEqual({ ok: true, value: '[]' });
  });

  it('不对数据做任何转义或解释：数据中的花括号原样输出', () => {
    expect(render('{{text}}', { text: '{{self.name}}' })).toEqual({ ok: true, value: '{{self.name}}' });
  });
});

describe('模板文件', () => {
  const source = [
    '---',
    'id: demo',
    'version: 3',
    'task: character_action',
    'output: ActionProposal',
    '---',
    '@@system cache',
    '通用规则',
    '@@system',
    '本回合：{{round}}',
    '@@user',
    '请行动。',
    '',
  ].join('\n');

  it('解析文件头与分段', () => {
    expect(parseTemplate(source)).toEqual({
      ok: true,
      value: {
        meta: { id: 'demo', version: '3', task: 'character_action', output: 'ActionProposal' },
        segments: [
          { kind: 'system', cache: true, body: '通用规则' },
          { kind: 'system', cache: false, body: '本回合：{{round}}' },
          { kind: 'user', cache: false, body: '请行动。' },
        ],
      },
    });
  });

  it('缺少文件头或必填字段时报错', () => {
    expect(parseTemplate('@@user\n你好').ok).toBe(false);
    expect(parseTemplate('---\nid: x\n---\n@@user\n你好').ok).toBe(false);
  });
});
