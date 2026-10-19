import { describe, expect, it } from 'vitest';
import { MAX_QUOTE_CHARS, parseRankList, trimOverlap } from './benchmark';

describe('读榜单', () => {
  it('空行分开一本；认得“书名：”等字段；没写书名时第一行是书名（去掉名次）；认不出的行接到简介', () => {
    const entries = parseRankList(
      ['1. 夜当', '作者：某甲', '标签：古风 悬疑', '字数: 120 万', '落魄书生深夜当玉。', '', '', '书名：剑来', '简介：少年练剑。', '', '第3名 无名书'].join('\r\n'),
    );
    expect(entries).toEqual([
      { title: '夜当', author: '某甲', tags: '古风 悬疑', words: '120 万', blurb: '落魄书生深夜当玉。' },
      { title: '剑来', author: '', tags: '', words: '', blurb: '少年练剑。' },
      { title: '无名书', author: '', tags: '', words: '', blurb: '' },
    ]);
    expect(parseRankList('  \n\n ')).toEqual([]);
  });
});

describe('复述检查', () => {
  const sample = '林舟推开当铺沉重的木门时，雨水正顺着他的衣角一滴一滴地落在青石板上，钱四从柜台后抬起了眼睛。';

  it('与样章相同、长于上限的连续文字只留前 30 字并接“……”；短的引文不动；空白不影响比较', () => {
    const copied = `开篇：${sample.slice(0, 40)}。节奏很快。`;
    const out = trimOverlap(copied, [sample]);
    expect(out.trimmed).toBe(1);
    expect(out.text).toBe(`开篇：${sample.slice(0, MAX_QUOTE_CHARS)}……。节奏很快。`);
    const short = `引文“${sample.slice(0, 20)}”`;
    expect(trimOverlap(short, [sample])).toEqual({ text: short, trimmed: 0 });
    const spaced = sample.slice(0, 35).split('').join(' ');
    expect(trimOverlap(spaced, [sample]).trimmed).toBe(1);
  });

  it('没有来源或来源太短时原样返回；几处分开计数', () => {
    expect(trimOverlap('任何文字', [])).toEqual({ text: '任何文字', trimmed: 0 });
    expect(trimOverlap('任何文字', ['短'])).toEqual({ text: '任何文字', trimmed: 0 });
    const two = `${sample.slice(0, 32)}；另外，${sample.slice(10, 45)}`;
    expect(trimOverlap(two, [sample]).trimmed).toBe(2);
  });
});
