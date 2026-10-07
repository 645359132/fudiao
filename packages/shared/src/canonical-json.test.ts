import { describe, expect, it } from 'vitest';
import { canonicalJson } from './canonical-json';

describe('canonicalJson', () => {
  it('对象键按码位排序，与插入顺序无关', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,{"x":2,"y":1}]},"b":1}',
    );
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  it('省略值为 undefined 的属性', () => {
    expect(canonicalJson({ a: undefined, b: '乙' })).toBe('{"b":"乙"}');
  });

  it('数组保持顺序', () => {
    expect(canonicalJson([2, 1])).toBe('[2,1]');
  });

  it('-0 与 0 序列化相同', () => {
    expect(canonicalJson(-0)).toBe('0');
  });

  it('拒绝非有限数', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(RangeError);
  });
});
