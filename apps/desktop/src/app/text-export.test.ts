import { describe, expect, it } from 'vitest';
import { toMarkdown, toTxt } from './text-export';
import { splitText } from './text-import';

const chapters = [
  { title: '楔子', paragraphs: ['旧事。'] },
  { title: '第一章 当铺', paragraphs: ['甲。'], volume: '第一卷 雨夜' },
  { title: '第二章 赌坊', paragraphs: ['乙。'], volume: '第一卷 雨夜' },
  { title: '第三章 渡口', paragraphs: ['丙。'], volume: '第二卷 天明' },
];

describe('分卷作品的导出（B68）', () => {
  it('TXT：每卷第一章之前写卷名；导回时分卷与章节照旧', () => {
    const txt = toTxt(chapters);
    expect(txt).toContain('第一卷 雨夜\n\n第一章 当铺\n');
    expect(txt.split('第一卷 雨夜').length - 1).toBe(1);
    const back = splitText(txt, { kind: 'auto' }, '书');
    if (!back.ok) throw new Error(back.error);
    expect(back.value.map((c) => [c.volume ?? null, c.title, c.paragraphs])).toEqual(chapters.map((c) => [c.volume ?? null, c.title, c.paragraphs]));
  });

  it('Markdown：书名一级、卷名二级、章名三级；导回时分卷与章节照旧；没有分卷时与以前相同', () => {
    const md = toMarkdown(chapters, '当铺夜谈');
    expect(md.startsWith('# 当铺夜谈\n\n### 楔子')).toBe(true);
    expect(md).toContain('## 第一卷 雨夜\n\n### 第一章 当铺');
    const back = splitText(md, { kind: 'markdown' }, '书');
    if (!back.ok) throw new Error(back.error);
    expect(back.value.map((c) => [c.volume ?? null, c.title, c.paragraphs])).toEqual(chapters.map((c) => [c.volume ?? null, c.title, c.paragraphs]));
    expect(toMarkdown([{ title: '第一章', paragraphs: ['甲。'] }], '书')).toMatch(/^# 书\n\n## 第一章/);
  });
});
