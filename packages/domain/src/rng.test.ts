import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { drawInt, seedRng, type RngState } from './rng';

const sequence = (rng: RngState, bound: number, n: number): number[] => {
  const out: number[] = [];
  let state = rng;
  for (let i = 0; i < n; i++) {
    const { value, rng: next } = drawInt(state, bound);
    out.push(value);
    state = next;
  }
  return out;
};

describe('可记录的随机数', () => {
  it('同一种子得到同一序列', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffffffff }), (seed) => {
        expect(sequence(seedRng(seed), 1000, 20)).toEqual(sequence(seedRng(seed), 1000, 20));
      }),
    );
  });

  it('抽取值落在 [0, bound) 内', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 0xffffffff }),
        fc.integer({ min: 1, max: 0xffffffff }),
        (seed, bound) => {
          for (const v of sequence(seedRng(seed), bound, 10)) {
            expect(Number.isInteger(v)).toBe(true);
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThan(bound);
          }
        },
      ),
    );
  });

  it('抽取不修改传入的状态', () => {
    const rng = seedRng(42);
    const copy = [...rng];
    drawInt(rng, 6);
    expect([...rng]).toEqual(copy);
  });

  it('状态是可序列化的 4 个 uint32', () => {
    const rng = seedRng(7);
    expect(rng).toHaveLength(4);
    for (const w of rng) expect(w >>> 0).toBe(w);
  });

  it('与 xoshiro128** 参考实现一致', () => {
    expect(sequence([1, 2, 3, 4], 0x1_0000_0000, 6)).toEqual([
      11520, 0, 5927040, 70819200, 2031721883, 1637235492,
    ]);
  });

  // 固定算法的输出：改动算法会让同一种子在新旧版本中给出不同的推演，需要显式确认。
  it('算法输出固定', () => {
    expect(sequence(seedRng(20261007), 100, 8)).toMatchInlineSnapshot(`
      [
        93,
        26,
        3,
        16,
        25,
        10,
        93,
        78,
      ]
    `);
  });
});
