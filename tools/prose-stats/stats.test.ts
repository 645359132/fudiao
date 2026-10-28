import { describe, expect, it } from 'vitest';
import { corpusText, generateCorpus } from '../bench/corpus';
import { compareReports, formatReport } from './report';
import { splitChapters } from './split';
import { bookStats } from './stats';

const book = `第1卷 塞上飞雪

塞北残灯

\u3000\u3000塞北的狂风裹着沙雪，拍在羊皮窗纸上。
\u3000\u3000沈孤舟垂着眼，右手搭在算盘上。“掌柜的，还有房吗？”
\u3000\u3000“没有。”他没有抬头。

古玉冷痕

\u3000\u3000天亮之前雪停了。沈孤舟推开门，门外站着一个人。
\u3000\u3000“你是谁？”

第2卷 关山飞度

第三章 恶客临门

\u3000\u3000三个汉子闯了进来。
\u3000\u3000刀落在地上。
`;

describe('文风统计脚本（B87）', () => {
  it('按卷与章拆开：单独一行的章名、“第N章”都认；段落去掉缩进', () => {
    const chapters = splitChapters(book);
    expect(chapters.map((c) => [c.volume, c.title, c.paragraphs.length])).toEqual([
      ['第1卷 塞上飞雪', '塞北残灯', 3],
      ['第1卷 塞上飞雪', '古玉冷痕', 2],
      ['第2卷 关山飞度', '第三章 恶客临门', 2],
    ]);
    expect(chapters[0]?.paragraphs[0]).toBe('塞北的狂风裹着沙雪，拍在羊皮窗纸上。');
    expect(splitChapters('\u3000\u3000没有标题的一段。\n\u3000\u3000第二段。')).toEqual([{ title: '全文', volume: null, paragraphs: ['没有标题的一段。', '第二段。'] }]);
  });

  it('性能基准的测试集 TXT 能拆成同样多的章', () => {
    const corpus = generateCorpus({ name: '小', chapters: 5, charsPerChapter: 1_200 });
    const chapters = splitChapters(corpusText(corpus));
    expect(chapters).toHaveLength(5);
    expect(chapters.map((c) => c.paragraphs.length)).toEqual(corpus.map((c) => c.paragraphs.length));
  });

  it('整本书的数字齐全，报告各节都有', () => {
    const chapters = splitChapters(book);
    const s = bookStats(chapters, { names: ['沈孤舟'] });
    expect(s.chapters).toBe(3);
    expect(s.words).toBeGreaterThan(50);
    expect(s.chapterWords.count).toBe(3);
    expect(s.titleLengths).toEqual({ 4: 2, 8: 1 });
    expect(s.dialogue.overall).toBeGreaterThan(0);
    expect(s.dialogue.byVolume.map((v) => v.chapters)).toEqual([2, 1]);
    expect(s.dialogue.lowest).toHaveLength(3);
    expect(s.endings.freeze).toBe(1);
    expect(s.endings.dialogue).toBe(2);
    expect(s.rows.map((r) => r.index)).toEqual([1, 2, 3]);
    expect(s.terms.some((t) => t.term.includes('孤舟'))).toBe(false);
    const report = formatReport('测试', s);
    for (const heading of ['## 总览', '## 章名字数', '## 对话占比', '## 章尾方式', '## 高频实词', '## 句首模板', '## 跨章重复的片段']) expect(report).toContain(heading);
    expect(report).toContain('| 章数 | 3 |');
    const compare = compareReports(s, s);
    expect(compare).toContain('| 对话占比 |');
    expect(compare.split('\n')).toHaveLength(12);
  });

  it('跨章重复的片段按出现的章数排列', () => {
    const tic = (title: string, line: string) => `${title}\n\n\u3000\u3000铁门${line}，他没有回头。\n\u3000\u3000门外有人。\n\n`;
    const s = bookStats(splitChapters(`${tic('一', '发出令人牙酸的声响')}${tic('二', '的响动令人牙酸')}${tic('三', '令人牙酸地响着')}`), {});
    expect(s.crossChapter.map((t) => [t.term, t.chapters, t.count])).toContainEqual(['令人牙酸', 3, 3]);
    // 三章各一次的“出令人牙”左边总是“发”、右边总是“酸”，只是更长说法的一截，合起来之后去掉。
    expect(s.crossChapter.some((t) => t.term === '出令人牙' || t.term === '人牙酸的')).toBe(false);
    expect(s.openings.some((o) => o.term === '铁门' && o.chapters === 3)).toBe(true);
  });
});
