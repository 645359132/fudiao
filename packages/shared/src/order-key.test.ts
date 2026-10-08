import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isOrderKey, keyBetween, keysBetween } from './order-key';

// SQLite 的 TEXT 默认按字节比较；键只含 ASCII，与 JavaScript 的字符串比较一致。
const byteOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

describe('分数索引排序键', () => {
  it('空列表的第一个键', () => {
    expect(keyBetween(null, null)).toBe('a0');
  });

  it('在两端与两键之间生成新键', () => {
    const first = keyBetween(null, null);
    const after = keyBetween(first, null);
    const before = keyBetween(null, first);
    const middle = keyBetween(first, after);
    expect([before, first, middle, after]).toEqual([before, first, middle, after].sort(byteOrder));
    for (const k of [before, first, middle, after]) expect(isOrderKey(k)).toBe(true);
  });

  it('参数顺序不对或键无效时报错', () => {
    expect(() => keyBetween('a1', 'a0')).toThrow();
    expect(() => keyBetween('a0', 'a0')).toThrow();
    expect(() => keyBetween('a10', null)).toThrow();
    expect(() => keyBetween('!', null)).toThrow();
  });

  it('连续追加与连续前插时键长增长缓慢', () => {
    let last: string | null = null;
    let first: string | null = null;
    for (let i = 0; i < 5_000; i++) last = keyBetween(last, null);
    for (let i = 0; i < 5_000; i++) first = keyBetween(null, first);
    expect(last?.length).toBeLessThanOrEqual(4);
    expect(first?.length).toBeLessThanOrEqual(4);
  });

  it('批量生成的键严格有序且落在区间内', () => {
    for (const [a, b] of [
      [null, null],
      ['a0', null],
      [null, 'a0'],
      ['a0', 'a1'],
    ] as const) {
      const keys = keysBetween(a, b, 50);
      expect(keys).toHaveLength(50);
      expect([...keys].sort(byteOrder)).toEqual(keys);
      expect(new Set(keys).size).toBe(50);
      if (a !== null) expect(byteOrder(a, keys[0] ?? '')).toBe(-1);
      if (b !== null) expect(byteOrder(keys.at(-1) ?? '', b)).toBe(-1);
    }
  });

  it('任意位置反复插入后，顺序与插入意图一致', () => {
    fc.assert(
      fc.property(fc.array(fc.nat(), { minLength: 1, maxLength: 200 }), (positions) => {
        const keys: string[] = [];
        for (const p of positions) {
          const i = p % (keys.length + 1);
          const k = keyBetween(keys[i - 1] ?? null, keys[i] ?? null);
          if (!isOrderKey(k)) return false;
          keys.splice(i, 0, k);
        }
        const sorted = [...keys].sort(byteOrder);
        return sorted.every((k, i) => k === keys[i]) && new Set(keys).size === keys.length;
      }),
    );
  });

  it('在同一处反复插入时键长线性增长但有上界', () => {
    let a = keyBetween(null, null);
    const b = keyBetween(a, null);
    let k = b;
    for (let i = 0; i < 200; i++) k = keyBetween(a, k);
    expect(k.length).toBeLessThanOrEqual(2 + Math.ceil(200 / 5));
    a = k;
    expect(isOrderKey(a)).toBe(true);
  });
});
