import { describe, expect, it } from 'vitest';
import { isChapterHeading, splitText, summarize } from './text-import';

const titles = (text: string, rule: Parameters<typeof splitText>[1] = { kind: 'auto' }) => {
  const r = splitText(text, rule, '雨夜');
  if (!r.ok) throw new Error(r.error);
  return r.value.map((c) => c.title);
};

describe('章节标题识别', () => {
  it.each([
    '第一章 雨夜',
    '第一章：雨夜',
    '第十二章',
    '第一百零三回 当铺',
    '第3章 旧信',
    '第２０章 对峙',
    '第一章雨夜',
    '第二卷 江湖',
    '序章',
    '楔子',
    '尾声 · 归来',
    '番外一 少年时',
    'Chapter 7 The Storm',
    '  第一章 雨夜  ',
  ])('%s 是标题', (line) => {
    expect(isChapterHeading(line)).toBe(true);
  });

  it.each([
    '第三章里他说的话，我到现在还记得。',
    '他翻到第三章，停了下来，望着窗外很久很久都没有说一句话，直到天色渐渐暗了下去。',
    '第一章雨夜，他没有回头。',
    '序是他写的。',
    '雨下得更紧了。',
    '',
  ])('%s 不是标题', (line) => {
    expect(isChapterHeading(line)).toBe(false);
  });
});

describe('拆分正文', () => {
  const novel = ['第一章 雨夜', '　　雨下得更紧了。', '', '　　他没有回头。', '第二章 当铺', '掌柜抬起头。'].join('\r\n');

  it('按标题拆分章节，段落去掉全角缩进与空行', () => {
    const r = splitText(novel, { kind: 'auto' }, '雨夜');
    expect(r).toEqual({
      ok: true,
      value: [
        { title: '第一章 雨夜', paragraphs: ['雨下得更紧了。', '他没有回头。'] },
        { title: '第二章 当铺', paragraphs: ['掌柜抬起头。'] },
      ],
    });
  });

  it('第一个标题之前的文字成为“正文前”一章；没有标题时整篇为一章', () => {
    expect(titles(`作品简介\n${novel}`)).toEqual(['正文前', '第一章 雨夜', '第二章 当铺']);
    expect(titles('雨下得更紧了。\n他没有回头。')).toEqual(['雨夜']);
  });

  it('标题下没有正文时保留空章', () => {
    expect(splitText('第一章\n第二章\n内容', { kind: 'auto' }, 'x')).toEqual({
      ok: true,
      value: [
        { title: '第一章', paragraphs: [] },
        { title: '第二章', paragraphs: ['内容'] },
      ],
    });
  });

  it('Markdown 标题', () => {
    const md = '# 雨夜\n\n## 第一节\n\n雨下得更紧了。\n\n## 第二节\n\n他没有回头。\n#不是标题';
    expect(titles(md, { kind: 'markdown' })).toEqual(['雨夜', '第一节', '第二节']);
    const r = splitText(md, { kind: 'markdown' }, 'x');
    expect(r.ok && r.value[2]?.paragraphs).toEqual(['他没有回头。', '#不是标题']);
  });

  it('不拆分', () => {
    expect(titles(novel, { kind: 'none' })).toEqual(['雨夜']);
  });

  it('自定义正则；无效的正则报错', () => {
    expect(titles('【一】\n甲\n【二】\n乙', { kind: 'custom', pattern: '^【.+】$' })).toEqual(['【一】', '【二】']);
    expect(splitText('甲', { kind: 'custom', pattern: '(' }, 'x').ok).toBe(false);
  });

  it('预览：每章的段数与字数', () => {
    const r = splitText(novel, { kind: 'auto' }, '雨夜');
    if (!r.ok) throw new Error();
    expect(summarize(r.value)).toEqual([
      { title: '第一章 雨夜', paragraphs: 2, words: 13 },
      { title: '第二章 当铺', paragraphs: 1, words: 6 },
    ]);
  });
});

describe('分卷（B68）', () => {
  const split = (text: string, rule: Parameters<typeof splitText>[1] = { kind: 'auto' }) => {
    const r = splitText(text, rule, '雨夜');
    if (!r.ok) throw new Error(r.error);
    return r.value.map((c) => [c.volume ?? null, c.title, c.paragraphs.length]);
  };

  it('文本里有章一级的标题时，“第…卷”是分卷；卷首语成为以卷名为题的一章', () => {
    const text = ['楔子', '旧事。', '第一卷 雨夜', '卷首语。', '第一章 当铺', '甲。', '第二章 赌坊', '乙。', '第二卷 天明', '第三章 渡口', '丙。'].join('\n');
    expect(split(text)).toEqual([
      [null, '楔子', 1],
      ['第一卷 雨夜', '第一卷 雨夜', 1],
      ['第一卷 雨夜', '第一章 当铺', 1],
      ['第一卷 雨夜', '第二章 赌坊', 1],
      ['第二卷 天明', '第三章 渡口', 1],
    ]);
  });

  it('只有“第…卷”没有章一级标题时，卷仍当作章（与以前相同）', () => {
    expect(split(['第一卷 雨夜', '甲。', '第二卷 天明', '乙。'].join('\n'))).toEqual([
      [null, '第一卷 雨夜', 1],
      [null, '第二卷 天明', 1],
    ]);
  });

  it('Markdown 有三级标题时：一级是书名（略过），二级是卷，三级是章', () => {
    const md = ['# 当铺夜谈', '', '## 第一卷', '', '### 第一章', '', '甲。', '', '## 第二卷', '', '### 第二章', '', '乙。'].join('\n');
    expect(split(md, { kind: 'markdown' })).toEqual([
      ['第一卷', '第一章', 1],
      ['第二卷', '第二章', 1],
    ]);
    // 没有三级标题时与以前相同：各级标题都是章。
    expect(split(['## 第一章', '甲。', '## 第二章', '乙。'].join('\n'), { kind: 'markdown' })).toEqual([
      [null, '第一章', 1],
      [null, '第二章', 1],
    ]);
  });

  it('预览带上卷名', () => {
    const r = splitText(['第一卷', '第一章', '甲。'].join('\n'), { kind: 'auto' }, '雨夜');
    if (!r.ok) throw new Error(r.error);
    expect(summarize(r.value)).toEqual([{ title: '第一章', paragraphs: 1, words: 2, volume: '第一卷' }]);
  });
});
