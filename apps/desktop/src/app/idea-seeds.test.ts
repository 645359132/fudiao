import { describe, expect, it } from 'vitest';
import { IDEA_POOLS, randomIdea } from './idea-seeds';

/** 依次给出固定的随机数。 */
const sequence = (...values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length]!;
};

describe('随机想法（B67）', () => {
  it('没填类型时随机挑一组，拼出“人物 + 处境，转折”，并给出这组的类型', () => {
    const pool = IDEA_POOLS[0]!;
    expect(randomIdea('', sequence(0))).toEqual({ idea: `${pool.who[0]}${pool.situation[0]}，${pool.twist[0]}`, genre: pool.genre });
    // 随机数接近 1 时取最后一项，不越界。
    const last = IDEA_POOLS.at(-1)!;
    expect(randomIdea('', sequence(0.9999))).toEqual({ idea: `${last.who.at(-1)}${last.situation.at(-1)}，${last.twist.at(-1)}`, genre: last.genre });
  });

  it('填了类型时按类型挑，作者写的类型不改', () => {
    for (const [genre, expected] of [
      ['武侠', '武侠'],
      ['悬疑推理', '古风悬疑'],
      ['现代都市', '都市'],
      ['硬科幻', '科幻'],
    ] as const) {
      const pool = IDEA_POOLS.find((p) => p.genre === expected)!;
      const result = randomIdea(genre, sequence(0.5));
      expect(result.genre).toBe(genre);
      expect(pool.who.some((w) => result.idea.startsWith(w))).toBe(true);
    }
    // 对不上的类型：随机挑一组，类型仍是作者写的。
    expect(randomIdea('赛博朋克', sequence(0)).genre).toBe('赛博朋克');
  });

  it('每一组的人物、处境与转折都不空', () => {
    for (const p of IDEA_POOLS) {
      for (const list of [p.who, p.situation, p.twist]) {
        expect(list.length).toBeGreaterThan(0);
        expect(list.every((x) => x.trim() !== '')).toBe(true);
      }
    }
  });
});
