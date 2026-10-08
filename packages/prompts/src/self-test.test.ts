import { describe, expect, it } from 'vitest';
import { renderSelfTest } from './render';
import { checkSelfTest, SELF_TEST_EXPECTED, SelfTestOutput } from './self-test';

describe('能力自检', () => {
  it('提示词带输出结构；期望内容本身符合结构并能通过比对', () => {
    const prompt = renderSelfTest();
    expect(prompt.ok && prompt.value).toMatchObject({ task: 'self_test', template: { id: 'self_test', version: '1' }, output: { name: 'SelfTestOutput' } });
    // 期望内容的每一项都出现在模板的材料中。
    const text = prompt.ok ? prompt.value.messages.map((m) => m.content).join('') : '';
    for (const word of ['雨夜当铺', '沈砚', '林晚', '旧伞', '铜钥匙', '一封信', '门半掩着']) expect(text).toContain(word);
    expect(SelfTestOutput.safeParse(SELF_TEST_EXPECTED).success).toBe(true);
    expect(checkSelfTest(SELF_TEST_EXPECTED)).toBeNull();
  });

  it('顺序、枚举、物品与线索不符时给出原因；首尾空白不计较', () => {
    const e = SELF_TEST_EXPECTED;
    const [a, b] = e.characters;
    if (a === undefined || b === undefined) throw new Error('样本');
    expect(checkSelfTest({ ...e, scene: ' 雨夜当铺 ' })).toBeNull();
    expect(checkSelfTest({ ...e, characters: [b, a] })).toBe('第 1 个人物不对');
    expect(checkSelfTest({ ...e, characters: [{ ...a, mood: 'angry' }, b] })).toBe('沈砚的情绪不对');
    expect(checkSelfTest({ ...e, characters: [{ ...a, items: ['铜钥匙', '旧伞'] }, b] })).toBe('沈砚的随身物品不对');
    expect(checkSelfTest({ ...e, clues: [{ text: '门半掩着', certain: true }] })).toBe('线索不对');
  });
});
