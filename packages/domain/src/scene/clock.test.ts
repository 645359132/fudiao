import { describe, expect, it } from 'vitest';
import { buildCharacterView } from '../cognition/view';
import { A, P, warehouse, warehouseSpec } from '../testing/warehouse';
import { initialState } from '../world';
import { clockAt } from './clock';
import { parseScene } from './validate';

const timed = warehouse((s) => {
  s.clock = [
    { fromRound: 1, label: '三更' },
    { fromRound: 4, label: '四更' },
    { fromRound: 7, label: '五更，天快亮了' },
  ];
});

describe('场景时钟', () => {
  it('按回合给出当时的时辰，保持到下一个时点', () => {
    expect([1, 3, 4, 6, 7, 20].map((r) => clockAt(timed, r))).toEqual(['三更', '三更', '四更', '四更', '五更，天快亮了', '五更，天快亮了']);
  });

  it('第一个时点之前与没有时钟的场景都没有时辰', () => {
    const late = warehouse((s) => {
      s.clock = [{ fromRound: 3, label: '巡夜人经过' }];
    });
    expect(clockAt(late, 2)).toBeNull();
    expect(clockAt(warehouse(), 5)).toBeNull();
  });

  it('时点须按回合递增', () => {
    const spec = warehouseSpec();
    spec.clock = [
      { fromRound: 4, label: '四更' },
      { fromRound: 4, label: '又是四更' },
    ];
    const result = parseScene(spec);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContainEqual(expect.objectContaining({ code: 'invalid_order', path: ['clock', 1] }));
  });

  it('时辰是在场的人都能感知的公开信息，进入每个人的视图', () => {
    const state = { ...initialState(timed, 1), round: 5 };
    expect(buildCharacterView(timed, state, P).time).toBe('四更');
    expect(buildCharacterView(timed, state, A).time).toBe('四更');
    expect(buildCharacterView(warehouse(), state, P).time).toBeNull();
  });
});
