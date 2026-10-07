import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compareStoryTime, isStoryTime, withinStoryRange, type StoryTime } from './story-time';

const at = (order: number | null, label = ''): StoryTime => ({ label, order });

describe('故事时间', () => {
  it('按排序键比较，标签不参与', () => {
    expect(compareStoryTime(at(1, '第三年春'), at(2, '第一年冬'))).toBe(-1);
    expect(compareStoryTime(at(2), at(1))).toBe(1);
    expect(compareStoryTime(at(1.5, '甲'), at(1.5, '乙'))).toBe(0);
  });

  it('任一方没有排序键时不可比较', () => {
    expect(compareStoryTime(at(null, '很久以前'), at(1))).toBeNull();
    expect(compareStoryTime(at(1), at(null))).toBeNull();
  });

  it('区间两端包含在内，可以缺省', () => {
    expect(withinStoryRange(at(2), at(1), at(3))).toBe(true);
    expect(withinStoryRange(at(1), at(1), at(3))).toBe(true);
    expect(withinStoryRange(at(3), at(1), at(3))).toBe(true);
    expect(withinStoryRange(at(4), at(1), at(3))).toBe(false);
    expect(withinStoryRange(at(0), at(1))).toBe(false);
    expect(withinStoryRange(at(0), undefined, at(3))).toBe(true);
    expect(withinStoryRange(at(0))).toBe(true);
  });

  it('自身或用到的区间端点没有排序键时不可判断', () => {
    expect(withinStoryRange(at(null), at(1), at(3))).toBeNull();
    expect(withinStoryRange(at(2), at(null), at(3))).toBeNull();
    expect(withinStoryRange(at(null))).toBeNull();
  });

  it('排序键必须是有限数', () => {
    expect(isStoryTime(at(1))).toBe(true);
    expect(isStoryTime(at(null))).toBe(true);
    expect(isStoryTime(at(Number.NaN))).toBe(false);
    expect(isStoryTime(at(Number.POSITIVE_INFINITY))).toBe(false);
  });

  it('比较是反对称的，且与区间判断一致', () => {
    const order = fc.option(fc.double({ noNaN: true, noDefaultInfinity: true }), { nil: null });
    fc.assert(
      fc.property(order, order, (a, b) => {
        const ab = compareStoryTime(at(a), at(b));
        const ba = compareStoryTime(at(b), at(a));
        if (ab === null || ba === null) return ab === ba;
        if (ab !== -ba) return false;
        return withinStoryRange(at(a), at(b)) === (ab >= 0);
      }),
    );
  });
});
