import { describe, expect, it } from 'vitest';
import { MAX_QUOTE_CHARS, overlapTrimmer, parseRankList, sliceChars, trimOverlap } from './benchmark';

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

  it('没有空行、一行一本的榜单按行分本（允许一行表头）；一行里制表符分开的几格，第一格是书名', () => {
    const entries = parseRankList(['榜单', '1. 夜当\t某甲\t古风', '2、剑来', '第3名 无名书\t作者：某乙'].join('\n'));
    expect(entries).toEqual([
      { title: '夜当', author: '', tags: '', words: '', blurb: '某甲 古风' },
      { title: '剑来', author: '', tags: '', words: '', blurb: '' },
      { title: '无名书', author: '某乙', tags: '', words: '', blurb: '' },
    ]);
    // 有空行时仍按段分本，段里的行是简介。
    expect(parseRankList('1. 夜当\n2. 不是书名\n\n3. 剑来').map((e) => e.title)).toEqual(['夜当', '剑来']);
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

  it('按字（码点）计数与截取：表情符号与扩展区的字不被切成半个；检查器只建一次窗口集合', () => {
    const source = `😀${'一二三四五六七八九十'.repeat(4)}`;
    const trim = overlapTrimmer([source], 10);
    const out = trim(`引：${source}`);
    expect(out.trimmed).toBe(1);
    expect([...out.text].slice(0, 12).join('')).toBe(`引：😀一二三四五六七八九`);
    expect(trim('别的话').trimmed).toBe(0);
    expect(sliceChars('😀一二', 0, 2)).toBe('😀一');
  });

  it('没有来源或来源太短时原样返回；几处分开计数', () => {
    expect(trimOverlap('任何文字', [])).toEqual({ text: '任何文字', trimmed: 0 });
    expect(trimOverlap('任何文字', ['短'])).toEqual({ text: '任何文字', trimmed: 0 });
    const two = `${sample.slice(0, 32)}；另外，${sample.slice(10, 45)}`;
    expect(trimOverlap(two, [sample]).trimmed).toBe(2);
  });
});
