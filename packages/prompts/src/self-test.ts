// 能力自检（B57）的输出结构与期望内容。期望值来自 self_test 模板中的材料，模板改动时须同步修改这里并提升模板版本。
import { z } from 'zod';

export const SelfTestOutput = z.object({
  scene: z.string(),
  characters: z.array(z.object({ name: z.string(), mood: z.enum(['calm', 'tense', 'angry']), items: z.array(z.string()) })),
  clues: z.array(z.object({ text: z.string(), certain: z.boolean() })),
});
export type SelfTestOutput = z.infer<typeof SelfTestOutput>;

export const SELF_TEST_EXPECTED: SelfTestOutput = {
  scene: '雨夜当铺',
  characters: [
    { name: '沈砚', mood: 'calm', items: ['旧伞', '铜钥匙'] },
    { name: '林晚', mood: 'tense', items: ['一封信'] },
  ],
  clues: [{ text: '门半掩着', certain: false }],
};

const same = (a: string, b: string) => a.trim() === b.trim();

/** 比对自检输出与期望内容：字段齐全、枚举与顺序正确；字符串只忽略首尾空白。返回不符的原因，相符时为 null。 */
export function checkSelfTest(value: SelfTestOutput): string | null {
  const e = SELF_TEST_EXPECTED;
  if (!same(value.scene, e.scene)) return '场景名不对';
  if (value.characters.length !== e.characters.length) return '人物数量不对';
  for (const [i, want] of e.characters.entries()) {
    const got = value.characters[i];
    if (got === undefined || !same(got.name, want.name)) return `第 ${i + 1} 个人物不对`;
    if (got.mood !== want.mood) return `${want.name}的情绪不对`;
    if (got.items.length !== want.items.length || got.items.some((x, k) => !same(x, want.items[k] ?? ''))) return `${want.name}的随身物品不对`;
  }
  if (value.clues.length !== 1 || !same(value.clues[0]?.text ?? '', e.clues[0]?.text ?? '') || value.clues[0]?.certain !== false) return '线索不对';
  return null;
}
