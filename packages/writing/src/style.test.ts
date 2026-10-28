import { describe, expect, it } from 'vitest';
import {
  chapterStyle,
  collocations,
  describeLedger,
  dialogueRatio,
  endingKind,
  maskNames,
  mtld,
  narrationSentences,
  openingTemplates,
  paragraphStats,
  sentenceStats,
  stats,
  styleLedger,
  termCounts,
} from './style';

const names = ['沈孤舟', '楚晚晴'];
const repeat = (text: string, n: number) => Array.from({ length: n }, () => text);

describe('文风统计（B87）：基本数字', () => {
  it('均值、标准差与变异系数；空的为 0', () => {
    expect(stats([])).toEqual({ count: 0, mean: 0, sd: 0, cv: 0 });
    const s = stats([10, 20, 30]);
    expect(s.count).toBe(3);
    expect(s.mean).toBe(20);
    expect(s.sd).toBeCloseTo(8.165, 3);
    expect(s.cv).toBeCloseTo(0.408, 3);
  });

  it('名字换成遮罩字，长的先换，名字的子串也不算', () => {
    expect(maskNames('沈孤舟看着楚晚晴。孤舟二字。', names)).toBe('□□□看着□□□。孤舟二字。');
    expect(maskNames('张三丰与张三', ['张三', '张三丰'])).toBe('□□□与□□');
  });

  it('对白占比按引号里的字算；叙述句子按句末标点切', () => {
    expect(dialogueRatio(['他说：“不是我，是她。”然后走了。'])).toBeCloseTo(5 / 11);
    expect(dialogueRatio([])).toBe(0);
    // 对白里的句号遮住了，“他说……她没有动”是一句。
    expect(narrationSentences(['风停了。他说：“走吧。”她没有动！为什么？'])).toEqual(['风停了', '他说：“⁣⁣⁣”她没有动', '为什么']);
    const s = sentenceStats(['风停了。门外有人在等，等了很久很久也没有走。']);
    expect(s.count).toBe(2);
    expect(s.mean).toBe((3 + 16) / 2);
    expect(paragraphStats(['风停了。', '', '门外有人。']).count).toBe(2);
  });

  it('MTLD：重复的文字比变化的文字低，同一段文字的结果与长度无关', () => {
    const varied = '塞北的狂风裹挟着粗砺的沙雪拍在残破的羊皮窗纸上发出擂鼓般的钝响客栈大堂深处柜台后的桐油灯只剩黄豆大一圈光晕';
    const same = '风风雨雨风风雨雨风风雨雨风风雨雨风风雨雨风风雨雨风风雨雨风风雨雨风风雨雨风风雨雨风风雨雨风风雨雨';
    expect(mtld(varied)).toBeGreaterThan(mtld(same));
    expect(mtld(same)).toBeLessThan(10);
    expect(mtld('太短')).toBe(2);
    expect(mtld(varied, 'bigram')).toBeGreaterThan(mtld(same, 'bigram'));
  });
});

describe('文风统计（B87）：高频实词、固定搭配与句首', () => {
  it('高频实词不含名字与虚字，只是更长说法一截的片段去掉', () => {
    const texts = [...repeat('沈孤舟握紧生铁断刀。', 4), '他把生铁断刀横在膝上。', '极阳真气顺着心脉上行。', '一股极阳真气撞上心脉。', '极阳真气散了，心脉发烫。', '他的手上的血。他的手上的血。'];
    const terms = termCounts(texts, names);
    const byTerm = Object.fromEntries(terms.map((t) => [t.term, t.count]));
    expect(byTerm['生铁断刀']).toBe(5);
    // “生铁”右边总是“断”、“极阳真”右边总是“气”：只是更长说法的一截；“心脉”左右都变化过，是一个词。
    expect(byTerm['生铁']).toBeUndefined();
    expect(byTerm['极阳真气']).toBe(3);
    expect(byTerm['极阳真']).toBeUndefined();
    expect(byTerm['心脉']).toBe(3);
    // 名字、含虚字的搭配都不算。
    expect(terms.some((t) => t.term.includes('孤舟'))).toBe(false);
    expect(byTerm['他的']).toBeUndefined();
    expect(byTerm['上的']).toBeUndefined();
    // 对白里的词不算；出现一次的也列（账本要合起来看）。
    expect(termCounts(['“生铁断刀。生铁断刀。生铁断刀。”'], names)).toEqual([]);
    expect(termCounts(['喉头腥甜。'], names).map((t) => [t.term, t.count])).toContainEqual(['喉头腥甜', 1]);
  });

  it('“微不可察”这样带一个虚字的四字说法算实词', () => {
    expect(termCounts(['他微不可察地点头。', '那是微不可察的一瞬。', '她微不可察地摇头。'], []).map((t) => [t.term, t.count])).toContainEqual(['微不可察', 3]);
    // 右边总是“地”时，它只是“微不可察地”的一截。
    expect(termCounts(repeat('他微不可察地点头。', 3), []).some((t) => t.term === '微不可察')).toBe(false);
  });

  it('固定搭配：四到八字的片段在一章里重复三次以上，留最长的', () => {
    const texts = [...repeat('铁门发出一声闷响。', 3), '雨停了。'];
    expect(collocations(texts, names).map((t) => [t.term, t.count])).toEqual([['铁门发出一声闷响', 3]]);
    expect(collocations(['铁门发出一声闷响。', '木门发出一声闷响。', '石门发出一声闷响。'], names).map((t) => [t.term, t.count])).toEqual([['门发出一声闷响', 3]]);
    expect(collocations(['发出一声闷响。发出一声闷响。'], names)).toEqual([]);
  });

  it('句首模板：以名字开头的记名字加两个字，其余记前两个字', () => {
    const texts = ['沈孤舟没有回头。沈孤舟没有说话。沈孤舟抬手。头顶是雪。头顶是风。“沈孤舟没有错。”'];
    expect(openingTemplates(texts, names).filter((o) => o.count >= 2)).toEqual([
      { term: '沈孤舟没有', count: 2 },
      { term: '头顶', count: 2 },
    ]);
    expect(openingTemplates(texts, names)).toContainEqual({ term: '沈孤舟抬手', count: 1 });
  });
});

describe('文风统计（B87）：章尾与账本', () => {
  it('章尾分类', () => {
    expect(endingKind(['他走进雨里。', '“等等。”'])).toBe('dialogue');
    expect(endingKind(['他为什么不回头？'])).toBe('question');
    expect(endingKind(['门外传来脚步声……'])).toBe('ellipsis');
    expect(endingKind(['刀落在地上。'])).toBe('freeze');
    expect(endingKind(['风雪更大，遮天蔽日地压了下来，铁无伤握刀的手臂猛然抬起，暴风中响起了弩机机括被扳动的第一声脆响。'])).toBe('narration');
    expect(endingKind(['他走了。', '命运的齿轮开始转动。'])).toBe('summary');
    expect(endingKind([])).toBe('narration');
  });

  it('一章的数字齐全', () => {
    const s = chapterStyle(['沈孤舟推开门。“谁？”', '柜台后没有人。'], names);
    expect(s.words).toBe(13);
    expect(s.ending).toBe('freeze');
    // 只有对白的句子不算叙述句。
    expect(s.sentences.count).toBe(2);
    expect(s.dialogueRatio).toBeCloseTo(1 / 13);
  });

  it('账本只看最近几章；用得太多要在一半以上的章里出现并超过次数门槛', () => {
    const contexts = ['铁门发出令人牙酸的声响', '那声音令人牙酸', '令人牙酸，他皱眉', '刮擦声令人牙酸得很', '门轴令人牙酸地响', '又是令人牙酸的一声', '听着令人牙酸', '令人牙酸的刮擦', '铁片令人牙酸地刮过', '令人牙酸之后是寂静'];
    const tic = (i: number) => [`第${i}章开头。`, `${contexts[i - 1] ?? ''}。沈孤舟没有回头。沈孤舟没有说话。`, '他握紧断刀，又握紧断刀，断刀在手。', '他走了。'];
    const chapters = Array.from({ length: 10 }, (_, i) => ({ title: `第${i + 1}章`, paragraphs: tic(i + 1) }));
    const ledger = styleLedger(chapters, names, { window: 8 });
    expect(ledger.chapters).toHaveLength(8);
    expect(ledger.chapters[0]?.title).toBe('第3章');
    // “令人牙酸”八章各一次：三字以上的说法 ≥ max(3, 6) 次就算。
    expect(ledger.overused).toContainEqual({ term: '令人牙酸', count: 8, chapters: 8 });
    expect(ledger.overused).toContainEqual({ term: '握紧断刀', count: 16, chapters: 8 });
    // “断刀”八章各三次共 24 次 ≥ max(10, 24)，排在三字以上的说法后面。
    expect(ledger.overused.at(-1)).toEqual({ term: '断刀', count: 24, chapters: 8 });
    expect(ledger.overusedOpenings).toEqual([{ term: '沈孤舟没有', count: 16, chapters: 8 }]);
    expect(ledger.endings).toEqual(Array.from({ length: 8 }, () => 'freeze'));
    const text = describeLedger(ledger);
    expect(text.lines).toHaveLength(8);
    expect(text.lines[0]).toMatch(/^《第3章》：\d+ 字，对话 0%，句长变异 [\d.]+，收尾：一句短的定格；多用：/);
    expect(text.overused).toContain('“令人牙酸”（8 章 8 次）');
    expect(text.overused).toContain('句子以“沈孤舟没有……”开头（16 次）');
    expect(text.endings).toEqual(Array.from({ length: 8 }, () => '一句短的定格'));
  });

  it('只有一两章时也能算；没有正文的章不算', () => {
    const ledger = styleLedger([{ title: '一', paragraphs: ['他走了。'] }, { title: '空', paragraphs: ['', ' '] }], names);
    expect(ledger.chapters.map((c) => c.title)).toEqual(['一']);
    expect(ledger.overused).toEqual([]);
    expect(styleLedger([], names).words).toBe(0);
  });
});
