import { describe, expect, it } from 'vitest';
import { guessProtagonist, openingMetrics } from './opening';

const people = [
  { id: 'lin', name: '林舟', aliases: ['林相公'] },
  { id: 'qian', name: '钱四', aliases: [] },
];

describe('开篇的客观数字', () => {
  it('字数、主角第一次出现在第几字（只数汉字、字母与数字）、对白占比、前一千字里提到几次设定名、最长的一段', () => {
    const m = openingMetrics(
      [
        { text: '雨下了一夜。' },
        { text: '林相公推开门，钱四抬起头。' },
        { text: '“当什么？”钱四问。' },
      ],
      { id: 'lin', name: '林舟', aliases: ['林相公'] },
      ['林舟', '林相公', '钱四', '当铺'],
    );
    expect(m.words).toBe(5 + 11 + 6);
    // “雨下了一夜”5 个字之后。
    expect(m.protagonistAt).toBe(5);
    // 对白“当什么”3 个字。
    expect(m.dialogueRatio).toBeCloseTo(3 / 22);
    expect(m.namesInOpening).toBe(3);
    expect(m.longestParagraph).toBe(11);
  });

  it('主角没有出现时为 null；没有主角时也为 null；空章各项为 0', () => {
    expect(openingMetrics([{ text: '雨下了一夜。' }], { id: 'lin', name: '林舟', aliases: [] }, []).protagonistAt).toBeNull();
    expect(openingMetrics([{ text: '雨下了一夜。' }], null, []).protagonistAt).toBeNull();
    expect(openingMetrics([], null, [])).toEqual({ words: 0, protagonistAt: null, dialogueRatio: 0, namesInOpening: 0, longestParagraph: 0 });
  });

  it('主角按前几章里出现的次数推断，次数相同取先出现的；没有人物出现时为 null', () => {
    expect(guessProtagonist(['钱四开门。林舟进来，林相公坐下。'], people)?.id).toBe('lin');
    expect(guessProtagonist(['钱四。林舟。'], people)?.id).toBe('qian');
    expect(guessProtagonist(['雨。'], people)).toBeNull();
  });

  it('名字互相包含时按最长的算：“张三丰”出现的地方不算“张三”，“林舟”里的“林”不算别名出现', () => {
    const cast = [
      { id: 'a', name: '张三', aliases: [] },
      { id: 'b', name: '张三丰', aliases: [] },
      { id: 'lin', name: '林舟', aliases: ['林'] },
    ];
    expect(guessProtagonist(['张三丰来了，张三丰走了，张三丰又来了。张三看着。'], cast)?.id).toBe('b');
    const m = openingMetrics([{ text: '张三丰来了，林舟跟在后面。' }], cast[2]!, ['张三', '张三丰', '林舟', '林']);
    // 主角在“张三丰来了，”5 个字之后第一次出现；前一千字里的名字只有“张三丰”与“林舟”两处。
    expect(m.protagonistAt).toBe(5);
    expect(m.namesInOpening).toBe(2);
  });
});
